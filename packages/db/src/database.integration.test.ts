import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hashCanonical, replayDecisionReceipt } from '../../domain/src/index.js';
import { calculateQuerySignalV1, type QueryValueInput } from '../../scoring/src/index.js';
import {
  importSeed,
  localWorkspaceId,
  referenceNeedId,
  referenceProjectContextId,
  referenceProjectId,
} from '../../seed/src/import.js';
import { testDatabaseUrl } from '../../test-fixtures/src/database.js';
import { listProviders, replayStoredScores } from './catalog-repository.js';
import { createPool } from './client.js';
import {
  getEntityCorpusIntelligence,
  recordCorroboration,
  recordEntityMetricObservation,
  recordSourceReliability,
} from './corpus-intelligence-repository.js';
import { migrate } from './migrate.js';
import { checkSchemaDefinitions } from './schema-check.js';
import { requestDiscovery } from './discovery-repository.js';
import { createExplorerSession } from './explorer-repository.js';
import {
  addCandidate,
  createNeed,
  getDecision,
  getNeedComparison,
  recordDecision,
  reviseNeed,
} from './workspace-repository.js';

describe('reviewed PostgreSQL contract', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(testDatabaseUrl());
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies every migration and preserves its content hash on replay', async () => {
    await migrate(testDatabaseUrl());
    const migrations = await pool.query<{ filename: string; sha256: string }>(
      'SELECT filename, sha256 FROM ops.schema_migrations ORDER BY filename',
    );
    expect(migrations.rows.map((row) => row.filename)).toEqual([
      '0001_initial.sql',
      '0002_complete_v0_contract.sql',
      '0003_intake_curation_link.sql',
      '0004_worker_readiness.sql',
      '0005_finalize_job_attempts.sql',
      '0006_guard_job_attempt_finalization.sql',
      '0007_independent_review_hardening.sql',
      '0008_strong_identity_intake_deduplication.sql',
      '0009_phase06_integrity_authoring.sql',
      '0010_intelligence_explorer.sql',
      '0011_bounded_discovery.sql',
      '0012_query_privacy_control.sql',
      '0013_query_value_projection_cache.sql',
      '0014_semantic_adapter_configuration.sql',
      '0015_discovery_intelligence.sql',
      '0016_faceted_knowledge.sql',
      '0017_research_planner.sql',
      '0018_retrieval_fabric.sql',
      '0019_intrinsic_signal.sql',
      '0020_corpus_intelligence.sql',
      '0021_history_chain_integrity.sql',
      '0022_current_knowledge_views.sql',
    ]);
    expect(migrations.rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
  });

  it('imports the source manifest idempotently while preserving additive authored data', async () => {
    const first = await importSeed(testDatabaseUrl());
    const second = await importSeed(testDatabaseUrl());
    expect(second).toEqual(first);
    expect(second.counts.score_runs).toBe(12);
    expect(second.counts.providers).toBeGreaterThanOrEqual(20);
    expect(second.counts.sources).toBeGreaterThanOrEqual(35);
    expect(second.counts.claims).toBeGreaterThanOrEqual(32);
    expect(second.counts.evidence_items).toBeGreaterThanOrEqual(32);
    expect(second.counts.projects).toBeGreaterThanOrEqual(1);
    expect(second.counts.needs).toBeGreaterThanOrEqual(1);
    expect(second.counts.candidates).toBeGreaterThanOrEqual(3);
    const documentSubjects = await pool.query<{ total: number; logical: number }>(
      `SELECT count(*)::int AS total,
              count(DISTINCT (document_id, provider_id, capability_definition_id,
                              relation_type))::int AS logical
       FROM catalog.knowledge_document_subjects`,
    );
    expect(documentSubjects.rows[0]!.total).toBe(documentSubjects.rows[0]!.logical);
    expect(documentSubjects.rows[0]!.total).toBeGreaterThan(0);
  });

  it('projects one effective current row while retaining append-only predecessors', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const assignment = await client.query<{
        id: string;
        entityId: string;
        facetKey: string;
        replacementConceptId: string;
      }>(`
        SELECT assignment.id, assignment.entity_id AS "entityId",
               assignment.facet_key AS "facetKey",
               replacement.id AS "replacementConceptId"
        FROM catalog.current_entity_facet_assignments assignment
        JOIN catalog.concepts replacement
          ON replacement.facet_key = assignment.facet_key
         AND replacement.id <> assignment.concept_id
        ORDER BY assignment.id, replacement.id
        LIMIT 1
      `);
      expect(assignment.rowCount).toBe(1);
      const successorAssignmentId = randomUUID();
      await client.query(
        `INSERT INTO catalog.entity_facet_assignments
           (id, entity_id, concept_id, facet_key, origin, confidence, rationale,
            source_observation_id, evidence_item_ids, valid_from, supersedes_id)
         SELECT $1, entity_id, $2, facet_key, 'manual', confidence,
                'Append-only current-view integration fixture.', source_observation_id,
                evidence_item_ids, now() - interval '1 second', id
         FROM catalog.entity_facet_assignments WHERE id = $3`,
        [successorAssignmentId, assignment.rows[0]!.replacementConceptId, assignment.rows[0]!.id],
      );
      const currentAssignments = await client.query<{ id: string }>(
        `SELECT id FROM catalog.current_entity_facet_assignments
         WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[assignment.rows[0]!.id, successorAssignmentId]],
      );
      expect(currentAssignments.rows).toEqual([{ id: successorAssignmentId }]);

      const entities = await client.query<{ id: string }>(
        'SELECT id FROM catalog.knowledge_entities ORDER BY id LIMIT 2',
      );
      const predecessorRelationshipId = randomUUID();
      const successorRelationshipId = randomUUID();
      await client.query(
        `INSERT INTO catalog.knowledge_relationships
           (id, subject_entity_id, relation_type, object_entity_id, direction,
            evidence_basis, confidence, revision_scope, valid_from, state)
         VALUES ($1, $2, 'fixture_relation', $3, 'directed', $4, 0.5, $5,
                 now() - interval '2 seconds', 'proposed')`,
        [
          predecessorRelationshipId,
          entities.rows[0]!.id,
          entities.rows[1]!.id,
          JSON.stringify({ fixture: true }),
          JSON.stringify({ fixture: true }),
        ],
      );
      await client.query(
        `INSERT INTO catalog.knowledge_relationships
           (id, subject_entity_id, relation_type, object_entity_id, direction,
            evidence_basis, confidence, revision_scope, valid_from, state, supersedes_id)
         VALUES ($1, $2, 'fixture_relation', $3, 'directed', $4, 0.75, $5,
                 now() - interval '1 second', 'reviewed', $6)`,
        [
          successorRelationshipId,
          entities.rows[0]!.id,
          entities.rows[1]!.id,
          JSON.stringify({ fixture: true, correction: true }),
          JSON.stringify({ fixture: true }),
          predecessorRelationshipId,
        ],
      );
      const currentRelationships = await client.query<{ id: string }>(
        `SELECT id FROM catalog.current_knowledge_relationships
         WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[predecessorRelationshipId, successorRelationshipId]],
      );
      expect(currentRelationships.rows).toEqual([{ id: successorRelationshipId }]);

      const scheme = await client.query<{
        id: string;
        schemeKey: string;
        version: number;
        title: string;
      }>(`
        SELECT id, scheme_key AS "schemeKey", version, title
        FROM catalog.current_concept_schemes ORDER BY scheme_key LIMIT 1
      `);
      const successorSchemeId = randomUUID();
      await client.query(
        `INSERT INTO catalog.concept_schemes
           (id, scheme_key, version, title, status, supersedes_id)
         VALUES ($1, $2, $3, $4, 'active', $5)`,
        [
          successorSchemeId,
          scheme.rows[0]!.schemeKey,
          scheme.rows[0]!.version + 1,
          scheme.rows[0]!.title,
          scheme.rows[0]!.id,
        ],
      );
      const currentScheme = await client.query<{ id: string }>(
        'SELECT id FROM catalog.current_concept_schemes WHERE scheme_key = $1',
        [scheme.rows[0]!.schemeKey],
      );
      expect(currentScheme.rows).toEqual([{ id: successorSchemeId }]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('replays every stored score without a mismatch', async () => {
    expect(await replayStoredScores(pool)).toEqual({ checked: 12, mismatches: [] });
  });

  it('keeps the generated query-value cache identical to query-signal-v1', async () => {
    const projections = await pool.query<{
      id: string;
      valueProfile: QueryValueInput[];
      valueConservative: number;
      evidenceCoverage: number;
      policyVersion: string;
    }>(`
      SELECT id, value_profile AS "valueProfile",
             query_value_conservative::float8 AS "valueConservative",
             query_evidence_coverage::float8 AS "evidenceCoverage",
             query_value_policy_version AS "policyVersion"
      FROM catalog.knowledge_projections
      ORDER BY id
    `);

    expect(projections.rowCount).toBeGreaterThanOrEqual(61);
    for (const projection of projections.rows) {
      const calculated = calculateQuerySignalV1({
        relevanceOrdinal: 'direct',
        relevanceMethod: 'rule',
        dimensions: projection.valueProfile,
        provisional: false,
      });
      expect(projection.policyVersion).toBe('query-signal-v1');
      expect(projection.valueConservative).toBeCloseTo(calculated.valueConservative, 6);
      expect(projection.evidenceCoverage).toBeCloseTo(calculated.evidenceCoverage, 6);
    }
  });

  it('detects a stored score whose input hash cannot be reproduced', async () => {
    const client = await pool.connect();
    const scoreRunId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO catalog.score_runs
           (id, provider_id, provider_version_id, domain_node_id, policy_id, input_hash,
            central, uncertainty, evidence_coverage, lower_bound, band, evidence_ids, generated_at)
         SELECT $1, provider_id, provider_version_id, domain_node_id, policy_id, $2,
                central, uncertainty, evidence_coverage, lower_bound, band, evidence_ids,
                generated_at + interval '1 second'
         FROM catalog.score_runs ORDER BY id LIMIT 1`,
        [scoreRunId, '0'.repeat(64)],
      );
      const dimensions = await client.query<{ id: string }>(
        'SELECT id FROM catalog.dimension_scores ORDER BY id LIMIT 5',
      );
      const sourceRun = await client.query<{ id: string }>(
        'SELECT id FROM catalog.score_runs WHERE id <> $1 ORDER BY id LIMIT 1',
        [scoreRunId],
      );
      const sourceDimensions = await client.query<{ id: string }>(
        'SELECT id FROM catalog.dimension_scores WHERE score_run_id = $1 ORDER BY id',
        [sourceRun.rows[0]!.id],
      );
      expect(dimensions.rowCount).toBeGreaterThanOrEqual(5);
      for (const dimension of sourceDimensions.rows) {
        await client.query(
          `INSERT INTO catalog.dimension_scores
             (id, score_run_id, dimension_key, raw, adjusted, confidence, coverage, prior,
              state, reasons, missing, evidence_ids)
           SELECT $1, $2, dimension_key, raw, adjusted, confidence, coverage, prior,
                  state, reasons, missing, evidence_ids
           FROM catalog.dimension_scores WHERE id = $3`,
          [randomUUID(), scoreRunId, dimension.id],
        );
      }
      const replay = await replayStoredScores(client as unknown as Pool);
      expect(replay.mismatches).toContainEqual({
        scoreRunId,
        reason: 'Stored input hash cannot be reproduced.',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('keeps reviewed SQL and Drizzle table/column declarations aligned', async () => {
    expect(await checkSchemaDefinitions(pool)).toEqual({ checkedTables: 96, errors: [] });
  });

  it('projects every historical provider and document into the faceted knowledge model', async () => {
    const counts = await pool.query<{
      providers: number;
      documents: number;
      entities: number;
      entityRevisions: number;
      documentRevisions: number;
      evidenceBearingRelationships: number;
      relationships: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM catalog.providers) AS providers,
        (SELECT count(*)::int FROM catalog.knowledge_documents) AS documents,
        (SELECT count(*)::int FROM catalog.knowledge_entities) AS entities,
        (SELECT count(*)::int FROM catalog.knowledge_entity_revisions) AS "entityRevisions",
        (SELECT count(*)::int FROM catalog.knowledge_document_revisions) AS "documentRevisions",
        (SELECT count(*)::int FROM catalog.knowledge_relationships
          WHERE evidence_basis <> '{}'::jsonb) AS "evidenceBearingRelationships",
        (SELECT count(*)::int FROM catalog.knowledge_relationships) AS relationships
    `);
    expect(counts.rows[0]).toMatchObject({
      entities: counts.rows[0]!.providers + counts.rows[0]!.documents,
      entityRevisions: counts.rows[0]!.providers + counts.rows[0]!.documents,
      documentRevisions: counts.rows[0]!.documents,
      evidenceBearingRelationships: counts.rows[0]!.relationships,
    });

    const facets = await pool.query<{ facetKey: string; total: number }>(`
      SELECT facet_key AS "facetKey", count(*)::int AS total
      FROM catalog.concepts
      GROUP BY facet_key
      ORDER BY facet_key
    `);
    expect(facets.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ facetKey: 'entity_class', total: 7 }),
        expect.objectContaining({ facetKey: 'domain' }),
        expect.objectContaining({ facetKey: 'capability' }),
        expect.objectContaining({ facetKey: 'document_type', total: 5 }),
      ]),
    );
  });

  it('keeps source assessments, trend history, and corroboration append-only', async () => {
    const fixture = await pool.query<{
      entityId: string;
      sourceId: string;
      observationId: string;
      evidenceId: string;
    }>(`
      SELECT entity.id AS "entityId", observation.source_id AS "sourceId",
             observation.id AS "observationId", evidence.id AS "evidenceId"
      FROM catalog.knowledge_entities entity
      JOIN catalog.provider_evidence_bindings binding ON binding.provider_id = entity.provider_id
      JOIN catalog.evidence_items evidence ON evidence.id = binding.evidence_item_id
      JOIN catalog.source_observations observation ON observation.id = evidence.source_observation_id
      ORDER BY entity.id, observation.observed_at DESC LIMIT 1
    `);
    const item = fixture.rows[0]!;
    const reliabilityId = await recordSourceReliability(pool, {
      sourceId: item.sourceId,
      authorityClass: 'primary',
      availabilityState: 'available',
      rightsState: 'allowed',
      reliabilityScore: 0.8,
      evidenceBasis: { basis: 'integration fixture, not a live source claim' },
      sourceObservationIds: [item.observationId],
      observedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await recordEntityMetricObservation(pool, {
      knowledgeEntityId: item.entityId,
      metricKey: 'attention',
      rawValue: 10,
      rawUnit: 'mentions',
      normalizedValue: 35,
      cohortKey: 'fixture:implementations',
      normalizationPolicyVersion: 'fixture-percentile-v1',
      normalizationDetail: { method: 'fixture' },
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-08-01T00:00:00.000Z'),
      independenceGroup: 'fixture-primary',
      sourceObservationId: item.observationId,
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await recordEntityMetricObservation(pool, {
      knowledgeEntityId: item.entityId,
      metricKey: 'attention',
      rawValue: 20,
      rawUnit: 'mentions',
      normalizedValue: 65,
      cohortKey: 'fixture:implementations',
      normalizationPolicyVersion: 'fixture-percentile-v1',
      normalizationDetail: { method: 'fixture' },
      windowStart: new Date('2026-08-01T00:00:00.000Z'),
      windowEnd: new Date('2026-09-01T00:00:00.000Z'),
      independenceGroup: 'fixture-primary',
      sourceObservationId: item.observationId,
      observedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const corroboration = await recordCorroboration(pool, {
      knowledgeEntityId: item.entityId,
      predicate: 'fixture-capability',
      applicabilityScope: 'integration fixture only',
      evidence: [
        {
          sourceId: item.sourceId,
          independenceGroup: 'publisher',
          role: 'primary',
          direction: 'supports',
        },
        {
          sourceId: 'fixture-independent',
          independenceGroup: 'independent-lab',
          role: 'independent',
          direction: 'supports',
        },
      ],
      sourceObservationIds: [item.observationId],
      evidenceItemIds: [item.evidenceId],
      observedAt: new Date('2026-09-01T00:00:01.000Z'),
    });
    expect(corroboration.state).toBe('corroborated');
    const intelligence = (await getEntityCorpusIntelligence(pool, item.entityId)) as {
      trendHistory: unknown[];
      corroboration: Array<{ state: string }>;
      sourceReliability: Array<{ authorityClass: string }>;
    };
    expect(intelligence.trendHistory).toHaveLength(2);
    expect(intelligence.corroboration).toContainEqual(
      expect.objectContaining({ state: 'corroborated' }),
    );
    expect(intelligence.sourceReliability).toContainEqual(
      expect.objectContaining({ authorityClass: 'primary' }),
    );
    await expect(
      pool.query(
        `UPDATE catalog.source_reliability_assessments
         SET reliability_score = 0.9 WHERE id = $1`,
        [reliabilityId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('binds history links to one logical owner at the database boundary', async () => {
    const revisions = await pool.query<{
      id: string;
      entityId: string;
      revision: number;
      entityClassConceptId: string;
      label: string;
      summary: string;
      lifecycleState: string;
    }>(`
      SELECT DISTINCT ON (entity_id)
             id, entity_id AS "entityId", revision,
             entity_class_concept_id AS "entityClassConceptId",
             preferred_label AS label, summary, lifecycle_state AS "lifecycleState"
      FROM catalog.knowledge_entity_revisions
      ORDER BY entity_id, revision DESC, id
      LIMIT 2
    `);
    const [first, second] = revisions.rows;
    expect(first!.entityId).not.toBe(second!.entityId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO catalog.knowledge_entity_revisions
             (id, entity_id, revision, entity_class_concept_id, preferred_label,
              summary, lifecycle_state, predecessor_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            randomUUID(),
            second!.entityId,
            second!.revision + 10_000,
            second!.entityClassConceptId,
            second!.label,
            second!.summary,
            second!.lifecycleState,
            first!.id,
            'a'.repeat(64),
          ],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'knowledge_entity_revisions_predecessor_same_entity_fkey',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    await createExplorerSession(pool, localWorkspaceId, {
      query: 'history owner constraint fixture',
    });
    const signal = await pool.query<{ id: string; entityId: string }>(
      `SELECT id, knowledge_entity_id AS "entityId"
       FROM catalog.intrinsic_signal_runs ORDER BY id LIMIT 1`,
    );
    const otherRevision = await pool.query<{ id: string }>(
      `SELECT id FROM catalog.knowledge_entity_revisions
       WHERE entity_id <> $1 ORDER BY id LIMIT 1`,
      [signal.rows[0]!.entityId],
    );
    const signalClient = await pool.connect();
    try {
      await signalClient.query('BEGIN');
      await expect(
        signalClient.query(
          `INSERT INTO catalog.intrinsic_signal_runs
             (id, knowledge_entity_id, entity_revision_id, policy_id, policy_version,
              profile, input_hash, dimension_inputs, central, uncertainty, conservative,
              signal_display, display_state, band, evidence_confidence,
              evidence_confidence_detail, trend_policy_version, trend_state,
              trend_window_start, trend_window_end, trend_detail, evidence_ids, generated_at)
           SELECT $1, knowledge_entity_id, $2, policy_id, policy_version, profile, $3,
                  dimension_inputs, central, uncertainty, conservative, signal_display,
                  display_state, band, evidence_confidence, evidence_confidence_detail,
                  trend_policy_version, trend_state, trend_window_start, trend_window_end,
                  trend_detail, evidence_ids, generated_at
           FROM catalog.intrinsic_signal_runs WHERE id = $4`,
          [randomUUID(), otherRevision.rows[0]!.id, 'b'.repeat(64), signal.rows[0]!.id],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'intrinsic_signal_runs_revision_same_entity_fkey',
      });
    } finally {
      await signalClient.query('ROLLBACK').catch(() => undefined);
      signalClient.release();
    }
  });

  it('serializes concurrent source-assessment appends into one lineage', async () => {
    const fixture = await pool.query<{ sourceId: string; observationId: string }>(`
      SELECT source_id AS "sourceId", id AS "observationId"
      FROM catalog.source_observations ORDER BY id LIMIT 1
    `);
    const item = fixture.rows[0]!;
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        recordSourceReliability(pool, {
          sourceId: item.sourceId,
          authorityClass: 'unknown',
          availabilityState: 'unknown',
          rightsState: 'unknown',
          reliabilityScore: null,
          evidenceBasis: { fixture: 'concurrent-lineage', index },
          sourceObservationIds: [item.observationId],
          observedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
        }),
      ),
    );
    const lineage = await pool.query<{ id: string; predecessorId: string | null }>(
      `SELECT id, predecessor_id AS "predecessorId"
       FROM catalog.source_reliability_assessments WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const idSet = new Set(ids);
    expect(
      lineage.rows.filter((row) => row.predecessorId && idSet.has(row.predecessorId)),
    ).toHaveLength(ids.length - 1);
    expect(new Set(lineage.rows.map((row) => row.predecessorId)).size).toBe(ids.length);
  });

  it('persists a bounded open-world plan for an unseen domain without a query-specific rule', async () => {
    const session = (await createExplorerSession(pool, localWorkspaceId, {
      query: 'lichen spectroscopy field notebook',
    })) as {
      id: string;
      interpretation: {
        interpretationMethod: string;
        coverageState: string;
        resolvedConcepts: unknown[];
      };
      plan: {
        policyVersion: string;
        stopReason: string;
        budgets: { maximumPasses: number; maximumExternalCalls: number };
        routes: Array<{ adapterKey: string; state: string; reason: string }>;
        secondPass: { state: string; routes: unknown[] };
      };
    };
    expect(session.interpretation).toMatchObject({
      interpretationMethod: 'deterministic-v3',
      coverageState: 'outside_maintained_coverage',
      resolvedConcepts: [],
    });
    expect(session.plan).toMatchObject({
      policyVersion: 'research-plan-v2',
      stopReason: 'second_pass_exhausted',
      budgets: { maximumPasses: 2, maximumExternalCalls: 6 },
    });
    expect(session.plan.routes.find((route) => route.adapterKey === 'searxng')).toMatchObject({
      state: 'planned',
      reason: expect.any(String),
    });
    expect(session.plan.secondPass).toMatchObject({ state: 'completed' });

    const persisted = await pool.query<{
      stopReason: string;
      plannedPasses: number;
      budgets: { maximumPasses: number };
      coverage: { needsSecondPass: boolean };
    }>(
      `SELECT stop_reason AS "stopReason", planned_passes AS "plannedPasses", budgets,
              coverage_assessment AS coverage
       FROM workspace.query_plans WHERE query_session_id = $1`,
      [session.id],
    );
    expect(persisted.rows[0]).toEqual({
      stopReason: 'second_pass_exhausted',
      plannedPasses: 2,
      budgets: expect.objectContaining({ maximumPasses: 2 }),
      coverage: expect.objectContaining({ needsSecondPass: true }),
    });
  });

  it('rejects weak generic overlap as proof of local open-world coverage', async () => {
    const session = (await createExplorerSession(pool, localWorkspaceId, {
      query: 'xylophagous beetle stridulation framework',
    })) as {
      interpretation: { coverageState: string };
      plan: { secondPass: { state: string } };
      retrieval: {
        passes: number;
        stopReason: string;
        firstPassCoverage: { candidateCount: number };
      };
    };
    expect(session).toMatchObject({
      interpretation: { coverageState: 'outside_maintained_coverage' },
      plan: { secondPass: { state: 'completed' } },
      retrieval: {
        passes: 2,
        stopReason: 'second_pass_exhausted',
        firstPassCoverage: { candidateCount: 0 },
      },
    });
  });

  it('freezes one candidate pool while persisting retriever, fusion, and rerank lineage', async () => {
    const session = (await createExplorerSession(pool, localWorkspaceId, {
      query: 'code context compression approaches',
    })) as {
      resultSetId: string;
      retrieval: {
        candidatePoolHash: string;
        fusionPolicy: string;
        rerankPolicy: string;
        passes: number;
        retrievers: Array<{ key: string; passIndex: number; returned: number }>;
      };
    };
    expect(session.retrieval).toMatchObject({
      candidatePoolHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      fusionPolicy: 'normalized-weighted-fusion-v1',
      rerankPolicy: 'structured-rerank-v1',
    });
    expect(session.retrieval.retrievers.length).toBeGreaterThanOrEqual(2);

    const lineage = await pool.query<{
      runs: number;
      hits: number;
      fusions: number;
      compared: number;
      intrinsic: number;
      bandedMatches: number;
      signalPolicy: string;
      poolHash: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM workspace.query_retrieval_runs
           WHERE result_set_id = $1) AS runs,
         (SELECT count(*)::int FROM workspace.query_retrieval_hits hit
           JOIN workspace.query_retrieval_runs run ON run.id = hit.retrieval_run_id
           WHERE run.result_set_id = $1) AS hits,
         (SELECT count(*)::int FROM workspace.query_candidate_fusions
           WHERE result_set_id = $1) AS fusions,
         (SELECT count(*)::int FROM workspace.query_candidate_fusions
           WHERE result_set_id = $1
             AND reciprocal_rank > 0 AND normalized_weighted_rank > 0
             AND reciprocal_rerank_position > 0
             AND normalized_weighted_rerank_position > 0) AS compared,
         (SELECT count(*)::int FROM catalog.intrinsic_signal_runs signal
           WHERE signal.id IN (
             SELECT intrinsic_signal_run_id FROM workspace.query_result_items
               WHERE result_set_id = $1
             UNION
             SELECT intrinsic_signal_run_id FROM workspace.query_document_results
               WHERE result_set_id = $1
           )) AS intrinsic,
         (SELECT count(*)::int FROM workspace.query_candidate_fusions
           WHERE result_set_id = $1 AND match_band IS NOT NULL) AS "bandedMatches",
         (SELECT signal_policy_version FROM workspace.query_result_sets WHERE id = $1)
           AS "signalPolicy",
         (SELECT candidate_pool_hash FROM workspace.query_result_sets WHERE id = $1) AS "poolHash"`,
      [session.resultSetId],
    );
    expect(lineage.rows[0]).toMatchObject({
      runs: session.retrieval.retrievers.length,
      hits: expect.any(Number),
      fusions: expect.any(Number),
      compared: expect.any(Number),
      intrinsic: expect.any(Number),
      bandedMatches: expect.any(Number),
      signalPolicy: 'intrinsic-signal-v3',
      poolHash: session.retrieval.candidatePoolHash,
    });
    expect(lineage.rows[0]!.hits).toBeGreaterThan(0);
    expect(lineage.rows[0]!.fusions).toBeGreaterThan(0);
    expect(lineage.rows[0]!.compared).toBe(lineage.rows[0]!.fusions);
    expect(lineage.rows[0]!.intrinsic).toBeGreaterThan(0);
    expect(lineage.rows[0]!.bandedMatches).toBe(lineage.rows[0]!.fusions);
    const intrinsic = await pool.query<{ id: string }>(
      `SELECT id FROM catalog.intrinsic_signal_runs ORDER BY created_at DESC LIMIT 1`,
    );
    await expect(
      pool.query(`UPDATE catalog.intrinsic_signal_runs SET band = 'rewritten' WHERE id = $1`, [
        intrinsic.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps first-class knowledge documents and their query results immutable', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const document = await client.query<{ id: string }>(
        'SELECT id FROM catalog.knowledge_documents ORDER BY id LIMIT 1',
      );
      await expect(
        client.query(
          'UPDATE catalog.knowledge_documents SET summary = summary || $2 WHERE id = $1',
          [document.rows[0]!.id, ' rewritten'],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('keeps the public catalog independent of private workspace foreign keys', async () => {
    const result = await pool.query<{ constraintName: string }>(`
      SELECT rc.constraint_name AS "constraintName"
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc
        ON tc.constraint_catalog = rc.constraint_catalog
       AND tc.constraint_schema = rc.constraint_schema
       AND tc.constraint_name = rc.constraint_name
      JOIN information_schema.table_constraints target
        ON target.constraint_catalog = rc.unique_constraint_catalog
       AND target.constraint_schema = rc.unique_constraint_schema
       AND target.constraint_name = rc.unique_constraint_name
      WHERE tc.table_schema = 'catalog' AND target.table_schema = 'workspace'
    `);
    expect(result.rows).toEqual([]);
  });

  it('enforces active identity uniqueness and preserves reversible resolution events', async () => {
    const identities = await pool.query<{
      providerId: string;
      scheme: string;
      normalizedValue: string;
    }>(
      `SELECT provider_id AS "providerId", scheme, normalized_value AS "normalizedValue"
       FROM catalog.provider_identities ORDER BY provider_id LIMIT 2`,
    );
    const existing = identities.rows[0]!;
    const otherProvider = identities.rows.find((row) => row.providerId !== existing.providerId)!;
    await expect(
      pool.query(
        `INSERT INTO catalog.provider_identities
           (id, provider_id, scheme, normalized_value, display_value, confidence,
            is_canonical, valid_from)
         VALUES ($1, $2, $3, $4, $4, 1, false, now())`,
        [randomUUID(), otherProvider.providerId, existing.scheme, existing.normalizedValue],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const mergeId = randomUUID();
    const revertId = randomUUID();
    await pool.query(
      `INSERT INTO catalog.identity_resolution_events
         (id, identity_scheme, identity_value, from_provider_id, to_provider_id,
          resolution_type, rationale, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, 'merged', 'Integration merge candidate.', NULL),
              ($6, $2, $3, $5, $4, 'reverted', 'Integration reversal.', $1)`,
      [
        mergeId,
        existing.scheme,
        `integration:${randomUUID()}`,
        existing.providerId,
        otherProvider.providerId,
        revertId,
      ],
    );
    const chain = await pool.query<{
      id: string;
      resolutionType: string;
      supersedesId: string | null;
    }>(
      `SELECT id, resolution_type AS "resolutionType", supersedes_id AS "supersedesId"
       FROM catalog.identity_resolution_events WHERE id IN ($1, $2) ORDER BY created_at, id`,
      [mergeId, revertId],
    );
    expect(chain.rows).toEqual(
      expect.arrayContaining([
        { id: mergeId, resolutionType: 'merged', supersedesId: null },
        { id: revertId, resolutionType: 'reverted', supersedesId: mergeId },
      ]),
    );
    await expect(
      pool.query(
        "UPDATE catalog.identity_resolution_events SET rationale = 'rewritten' WHERE id = $1",
        [mergeId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('allows private evidence in private fit without leaking it into the public catalog', async () => {
    const canary = `PRIVATE_WORKSPACE_CANARY_${randomUUID()}`;
    const privateSourceId = randomUUID();
    const privateEvidenceId = randomUUID();
    await pool.query(
      `INSERT INTO workspace.private_sources
         (id, workspace_id, canonical_uri, title, owner, source_type)
       VALUES ($1, $2, $3, $4, 'integration-test', 'private_note')`,
      [privateSourceId, localWorkspaceId, `private://${privateSourceId}`, canary],
    );
    await pool.query(
      `INSERT INTO workspace.private_evidence_items
         (id, workspace_id, source_id, project_context_id, evidence_type, producer,
          result, applicability_scope, limitations, observed_at)
       VALUES ($1, $2, $3, $4, 'local_trial', 'integration-test', $5,
               'reference project context only', '{}', now())`,
      [privateEvidenceId, localWorkspaceId, privateSourceId, referenceProjectContextId, { canary }],
    );
    const candidate = await pool.query<{ id: string }>(
      `SELECT id FROM workspace.candidates
       WHERE need_id = $1 AND option_kind = 'status_quo' LIMIT 1`,
      [referenceNeedId],
    );
    const fitHash = hashCanonical({
      candidateId: candidate.rows[0]!.id,
      privateEvidenceId,
      policyVersion: 'project-fit-v1',
    });
    await pool.query(
      `INSERT INTO workspace.fit_assessments
         (id, workspace_id, candidate_id, need_id, project_context_id, policy_version,
          eligibility, gate_results, preference_result, rationale, evidence_ids,
          input_hash, author_type, review_state, generated_at)
       SELECT $1, workspace_id, candidate_id, need_id, project_context_id, policy_version,
              eligibility, gate_results, preference_result,
              rationale || ARRAY['Private local evidence was scoped to this fit only.'],
              evidence_ids || $2::uuid, $3, 'rule', 'reviewed', now()
       FROM workspace.fit_assessments
       WHERE candidate_id = $4 ORDER BY generated_at DESC, id DESC LIMIT 1`,
      [randomUUID(), privateEvidenceId, fitHash, candidate.rows[0]!.id],
    );

    const comparison = (await getNeedComparison(pool, localWorkspaceId, referenceNeedId)) as {
      candidates: Array<{ id: string; fitEvidenceIds: string[] }>;
    };
    expect(
      comparison.candidates.find((item) => item.id === candidate.rows[0]!.id)?.fitEvidenceIds,
    ).toContain(privateEvidenceId);
    const catalog = await listProviders(pool, { search: canary, limit: 50 });
    expect(catalog.total).toBe(0);
    expect(JSON.stringify(await listProviders(pool, { limit: 50 }))).not.toContain(canary);
  });

  it('uses full-text and trigram catalog search with visible match explanations', async () => {
    const fullText = await listProviders(pool, { search: 'infrastructure as code', limit: 50 });
    expect(fullText.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Terraform',
          matchedFields: expect.arrayContaining(['full_text']),
        }),
      ]),
    );

    const typo = await listProviders(pool, { search: 'Terrafom', limit: 50 });
    expect(typo.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Terraform',
          matchedFields: expect.arrayContaining(['name_trigram']),
        }),
      ]),
    );
  });

  it('enforces workspace ownership at the database boundary', async () => {
    const foreignWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspace.workspaces (id, name) VALUES ($1, 'Isolation test')", [
      foreignWorkspaceId,
    ]);
    try {
      await expect(
        pool.query(
          `INSERT INTO workspace.project_contexts
             (id, workspace_id, project_id, revision, snapshot_hash, context_document, created_at)
           VALUES ($1, $2, $3, 99, $4, '{}', now())`,
          [randomUUID(), foreignWorkspaceId, referenceProjectId, 'a'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await pool.query('DELETE FROM workspace.workspaces WHERE id = $1', [foreignWorkspaceId]);
    }
  });

  it('records a replayable decision and rejects historical mutation', async () => {
    const candidate = await pool.query<{ id: string }>(
      `SELECT id FROM workspace.candidates
       WHERE need_id = $1 AND option_kind = 'status_quo' LIMIT 1`,
      [referenceNeedId],
    );
    const recorded = (await recordDecision(pool, localWorkspaceId, referenceNeedId, {
      outcome: 'trial',
      selectedCandidateId: candidate.rows[0]!.id,
      rationale: 'Preserve the baseline while measuring a bounded alternative.',
      conditions: ['No remote source transfer.', 'Review representative task quality.'],
    })) as { id: string; receipt: Parameters<typeof replayDecisionReceipt>[0]; inputHash: string };
    expect(replayDecisionReceipt(recorded.receipt)).toBe(true);
    expect(recorded.receipt.inputHash).toBe(recorded.inputHash);
    expect(await getDecision(pool, localWorkspaceId, recorded.id)).toMatchObject({
      id: recorded.id,
      outcome: 'trial',
      receiptVerified: true,
    });
    await expect(
      pool.query("UPDATE workspace.decisions SET rationale = 'rewritten' WHERE id = $1", [
        recorded.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query("UPDATE workspace.candidates SET label = 'rewritten' WHERE id = $1", [
        candidate.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query(
        `UPDATE workspace.candidate_components
         SET provider_id = (SELECT id FROM catalog.providers WHERE id <> provider_id LIMIT 1)
         WHERE candidate_id = (SELECT id FROM workspace.candidates
                               WHERE need_id = $1 AND option_kind = 'provider' LIMIT 1)`,
        [referenceNeedId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query("UPDATE catalog.score_policies SET code_revision = 'rewritten'"),
    ).rejects.toMatchObject({ code: '55000' });
    const audit = await pool.query<{ action: string; afterHash: string }>(
      `SELECT action, after_hash AS "afterHash" FROM ops.audit_events
       WHERE object_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [recorded.id],
    );
    expect(audit.rows[0]).toEqual({ action: 'decision.record', afterHash: recorded.inputHash });
  });

  it('creates immutable need revisions and rejects a stale optimistic update', async () => {
    const input = {
      projectId: referenceProjectId,
      title: `Revision integration ${randomUUID()}`,
      desiredOutcome: 'Prove revision conflicts without rewriting a prior need.',
      successCriteria: ['Prior revision remains loadable.'],
      requiredCapabilityKeys: ['context-output-optimization'],
      constraints: [
        {
          key: 'macos',
          label: 'macOS support required',
          kind: 'hard_gate' as const,
          unknownHandling: 'block' as const,
        },
      ],
    };
    const created = (await createNeed(pool, localWorkspaceId, input)) as { id: string };
    const candidate = (await addCandidate(pool, localWorkspaceId, created.id, {
      optionKind: 'status_quo',
      label: 'Revision-test baseline',
    })) as { id: string };
    const comparison = (await getNeedComparison(pool, localWorkspaceId, created.id)) as {
      candidates: Array<{
        id: string;
        eligibility: string;
        gateResults: Array<{ state: string; evidenceIds: string[] }>;
      }>;
    };
    expect(comparison.candidates.find((item) => item.id === candidate.id)).toMatchObject({
      eligibility: 'unknown_blocked',
      gateResults: [{ state: 'unknown', evidenceIds: [] }],
    });
    const policyAudit = await pool.query<{ action: string; afterHash: string }>(
      `SELECT action, after_hash AS "afterHash" FROM ops.audit_events
       WHERE object_id = $1 AND action = 'policy.run'`,
      [candidate.id],
    );
    expect(policyAudit.rows[0]).toMatchObject({ action: 'policy.run' });
    expect(policyAudit.rows[0]!.afterHash).toMatch(/^[a-f0-9]{64}$/);
    const next = (await reviseNeed(pool, localWorkspaceId, created.id, {
      ...input,
      expectedRevision: 1,
      title: `${input.title} revised`,
    })) as { id: string; revision: number };
    expect(next).toMatchObject({ revision: 2 });
    await expect(
      reviseNeed(pool, localWorkspaceId, created.id, { ...input, expectedRevision: 1 }),
    ).rejects.toThrow(/newer need revision/i);
    await expect(
      pool.query("UPDATE workspace.needs SET title = 'rewritten' WHERE id = $1", [created.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('binds provider versions and need contexts to their owning records', async () => {
    const constraints = await pool.query<{ constraintName: string }>(`
      SELECT conname AS "constraintName" FROM pg_constraint
      WHERE conname IN (
        'component_version_provider_fk',
        'score_version_provider_fk',
        'fit_need_context_workspace_fk',
        'decision_need_context_workspace_fk'
      ) ORDER BY conname
    `);
    expect(constraints.rows.map((row) => row.constraintName)).toEqual([
      'component_version_provider_fk',
      'decision_need_context_workspace_fk',
      'fit_need_context_workspace_fk',
      'score_version_provider_fk',
    ]);

    const need = await pool.query<{ snapshotHash: string }>(
      `SELECT pc.snapshot_hash AS "snapshotHash"
       FROM workspace.needs n JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
       WHERE n.id = $1`,
      [referenceNeedId],
    );
    await expect(
      pool.query(
        `INSERT INTO workspace.candidates
           (id, workspace_id, need_id, option_kind, label, context_snapshot_hash, discovery_origin)
         VALUES ($1, $2, $3, 'status_quo', $4, $5, 'integration')`,
        [randomUUID(), localWorkspaceId, referenceNeedId, randomUUID(), 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(need.rows[0]!.snapshotHash).toMatch(/^[a-f0-9]{64}$/);

    const ownership = await pool.query<{
      versionId: string;
      versionOwnerId: string;
      otherProviderId: string;
    }>(`
      SELECT pv.id AS "versionId", pv.provider_id AS "versionOwnerId",
             other.id AS "otherProviderId"
      FROM catalog.provider_versions pv
      JOIN LATERAL (
        SELECT id FROM catalog.providers WHERE id <> pv.provider_id ORDER BY id LIMIT 1
      ) other ON true
      ORDER BY pv.id LIMIT 1
    `);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidateId = randomUUID();
      await client.query(
        `INSERT INTO workspace.candidates
           (id, workspace_id, need_id, option_kind, label, context_snapshot_hash, discovery_origin)
         VALUES ($1, $2, $3, 'provider', $4, $5, 'integration')`,
        [candidateId, localWorkspaceId, referenceNeedId, randomUUID(), need.rows[0]!.snapshotHash],
      );
      await expect(
        client.query(
          `INSERT INTO workspace.candidate_components
             (id, workspace_id, candidate_id, provider_id, provider_version_id, role)
           VALUES ($1, $2, $3, $4, $5, 'primary')`,
          [
            randomUUID(),
            localWorkspaceId,
            candidateId,
            ownership.rows[0]!.otherProviderId,
            ownership.rows[0]!.versionId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('atomically enforces the shared external-call boundary without intent quotas', async () => {
    const workspaceId = randomUUID();
    await pool.query('INSERT INTO workspace.workspaces (id, name) VALUES ($1, $2)', [
      workspaceId,
      'Discovery allocation integration fixture',
    ]);
    const session = (await createExplorerSession(pool, workspaceId, {
      query: 'ai context engineering tools',
    })) as { id: string };
    await pool.query(
      `UPDATE ops.source_adapter_configs
       SET enabled = true, daily_call_limit = 100
       WHERE adapter_key = 'github'`,
    );
    await pool.query('DELETE FROM ops.adapter_daily_budgets WHERE budget_date = current_date');

    try {
      const inputs = [
        ...Array.from({ length: 37 }, (_, index) => ({ intent: 'deepen' as const, index })),
        ...Array.from({ length: 27 }, (_, index) => ({ intent: 'explore' as const, index })),
      ];
      const results = (await Promise.all(
        inputs.map(({ intent, index }) =>
          requestDiscovery(pool, workspaceId, session.id, {
            adapterKey: 'github',
            approvedPublicQuery: `bounded ${intent} fixture ${index}`,
            idempotencyKey: `${intent}-${index}-${randomUUID()}`,
            intent,
          }),
        ),
      )) as Array<{ state: string; intent: string }>;

      expect(results.filter((result) => result.state === 'queued')).toHaveLength(60);
      expect(results.filter((result) => result.state === 'budget_denied')).toHaveLength(4);

      const budget = await pool.query<{ reserved: number; denied: number }>(
        `SELECT reserved_calls AS reserved, denied_calls AS denied
         FROM ops.adapter_daily_budgets
         WHERE adapter_key = 'github' AND budget_date = current_date`,
      );
      expect(budget.rows[0]).toEqual({ reserved: 60, denied: 4 });
      const operations = await pool.query<{ state: string; calls: number }>(
        `SELECT state, sum(reserved_calls)::int AS calls
         FROM ops.discovery_operations WHERE workspace_id = $1
         GROUP BY state ORDER BY state`,
        [workspaceId],
      );
      expect(operations.rows).toEqual(
        expect.arrayContaining([
          { state: 'queued', calls: 60 },
          { state: 'budget_denied', calls: 0 },
        ]),
      );
    } finally {
      await pool.query(
        `UPDATE ops.source_adapter_configs SET enabled = false, daily_call_limit = 20
         WHERE adapter_key = 'github'`,
      );
    }
  });
});
