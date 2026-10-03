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
  recordCorroboration,
  recordEntityMetricObservation,
  recordSourceReliability,
} from './corpus-intelligence-repository.js';
import { migrate } from './migrate.js';
import { checkSchemaDefinitions } from './schema-check.js';
import { requestDiscovery } from './discovery-repository.js';
import { ConflictError, DomainValidationError } from './errors.js';
import { createExplorerSession } from './explorer-repository.js';
import {
  furnishKnowledgeDocumentWithClient,
  furnishKnowledgeOption,
} from './authoring-repository.js';
import { inTransaction } from './transaction.js';
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
      '0016_research_skill_v1.sql',
      '0017_research_planner.sql',
      '0017_research_run_integrity.sql',
      '0018_research_child_terminal_guard.sql',
      '0018_retrieval_fabric.sql',
      '0019_intrinsic_signal.sql',
      '0019_research_result_set_binding.sql',
      '0020_corpus_intelligence.sql',
      '0020_research_child_serialization.sql',
      '0021_history_chain_integrity.sql',
      '0022_current_knowledge_views.sql',
      '0023_ai_development_tools_domain.sql',
      '0024_shared_match_and_discovery_links.sql',
      '0025_typed_signal_normalization.sql',
      '0026_evidence_bound_corroboration.sql',
      '0028_typed_discovery_admission.sql',
      '0030_precomputed_search_vectors.sql',
      '0031_corroboration_entity_binding.sql',
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
    expect(await checkSchemaDefinitions(pool)).toEqual({ checkedTables: 103, errors: [] });
  });

  it('keeps JIT disabled for bounded local request queries', async () => {
    const result = await pool.query<{ jit: string }>('SHOW jit');
    expect(result.rows).toEqual([{ jit: 'off' }]);
  });

  it('keeps capability metadata immutable within one schema version', async () => {
    const suffix = randomUUID();
    const capabilityKey = `immutable-capability-${suffix}`;
    const base = {
      kind: 'practice' as const,
      description: 'A stable capability definition used by multiple attributed options.',
      sourceTitle: 'Capability immutability fixture',
      sourceOwner: 'Maestro integration fixture',
      capabilityKey,
      capabilityName: 'Stable fixture capability',
      searchTerms: ['stable', 'capability'],
      limitations: ['Integration fixture only.'],
      reviewState: 'proposed' as const,
    };
    await furnishKnowledgeOption(pool, localWorkspaceId, {
      ...base,
      name: `First immutable option ${suffix}`,
      canonicalUrl: `https://example.com/immutable-capability/${suffix}/first`,
    });
    await furnishKnowledgeOption(pool, localWorkspaceId, {
      ...base,
      name: `Second immutable option ${suffix}`,
      canonicalUrl: `https://example.com/immutable-capability/${suffix}/second`,
    });
    await expect(
      furnishKnowledgeOption(pool, localWorkspaceId, {
        ...base,
        name: `Conflicting immutable option ${suffix}`,
        canonicalUrl: `https://example.com/immutable-capability/${suffix}/conflict`,
        capabilityName: 'Rewritten fixture capability',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const stored = await pool.query<{
      name: string;
      description: string;
      preferredLabel: string;
      labels: string[];
      providerCount: number;
    }>(
      `SELECT definition.name, definition.description,
              concept.preferred_label AS "preferredLabel",
              array_agg(DISTINCT label.label ORDER BY label.label) AS labels,
              count(DISTINCT capability.provider_id)::int AS "providerCount"
       FROM catalog.capability_definitions definition
       JOIN catalog.concepts concept ON concept.id = definition.id
       JOIN catalog.concept_labels label ON label.concept_id = concept.id
       JOIN catalog.provider_capabilities capability
         ON capability.capability_definition_id = definition.id
       WHERE definition.stable_key = $1 AND definition.schema_version = 1
       GROUP BY definition.id, concept.id`,
      [capabilityKey],
    );
    expect(stored.rows).toEqual([
      {
        name: base.capabilityName,
        description: base.description,
        preferredLabel: base.capabilityName,
        labels: [base.capabilityName],
        providerCount: 2,
      },
    ]);

    const documentCapabilityKey = `immutable-document-capability-${suffix}`;
    const documentBase = {
      summary: 'A stable document capability definition reused without mutation.',
      documentKind: 'article',
      sourceTitle: 'Document capability immutability fixture',
      publisher: 'Maestro integration fixture',
      capabilityKey: documentCapabilityKey,
      capabilityName: 'Stable document fixture capability',
      searchTerms: ['stable', 'document', 'capability'],
      limitations: ['Integration fixture only.'],
      reviewState: 'proposed' as const,
    };
    const furnishDocument = (input: Parameters<typeof furnishKnowledgeDocumentWithClient>[2]) =>
      inTransaction(pool, (client) =>
        furnishKnowledgeDocumentWithClient(client, localWorkspaceId, input),
      );
    await furnishDocument({
      ...documentBase,
      title: `First immutable document ${suffix}`,
      canonicalUrl: `https://example.com/immutable-document-capability/${suffix}/first`,
    });
    await furnishDocument({
      ...documentBase,
      title: `Second immutable document ${suffix}`,
      canonicalUrl: `https://example.com/immutable-document-capability/${suffix}/second`,
    });
    const countsBeforeConflict = await pool.query<{ documents: number; providers: number }>(
      `SELECT (SELECT count(*)::int FROM catalog.knowledge_documents) AS documents,
              (SELECT count(*)::int FROM catalog.providers) AS providers`,
    );
    await expect(
      furnishDocument({
        ...documentBase,
        title: `Conflicting-name document ${suffix}`,
        canonicalUrl: `https://example.com/immutable-document-capability/${suffix}/name-conflict`,
        capabilityName: 'Rewritten document fixture capability',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      furnishDocument({
        ...documentBase,
        title: `Conflicting-description document ${suffix}`,
        canonicalUrl: `https://example.com/immutable-document-capability/${suffix}/description-conflict`,
        summary: 'A conflicting rewrite of immutable capability metadata.',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const documentStored = await pool.query<{
      name: string;
      description: string;
      preferredLabel: string;
      labels: string[];
      documentCount: number;
    }>(
      `SELECT definition.name, definition.description,
              concept.preferred_label AS "preferredLabel",
              array_agg(DISTINCT label.label ORDER BY label.label) AS labels,
              count(DISTINCT subject.document_id)::int AS "documentCount"
       FROM catalog.capability_definitions definition
       JOIN catalog.concepts concept ON concept.id = definition.id
       JOIN catalog.concept_labels label ON label.concept_id = concept.id
       JOIN catalog.knowledge_document_subjects subject
         ON subject.capability_definition_id = definition.id
       WHERE definition.stable_key = $1 AND definition.schema_version = 1
       GROUP BY definition.id, concept.id`,
      [documentCapabilityKey],
    );
    expect(documentStored.rows).toEqual([
      {
        name: documentBase.capabilityName,
        description: documentBase.summary,
        preferredLabel: documentBase.capabilityName,
        labels: [documentBase.capabilityName],
        documentCount: 2,
      },
    ]);
    const countsAfterConflict = await pool.query<{ documents: number; providers: number }>(
      `SELECT (SELECT count(*)::int FROM catalog.knowledge_documents) AS documents,
              (SELECT count(*)::int FROM catalog.providers) AS providers`,
    );
    expect(countsAfterConflict.rows).toEqual(countsBeforeConflict.rows);
  });

  it('makes metric retries idempotent only for identical immutable inputs', async () => {
    const binding = await pool.query<{
      knowledgeEntityId: string;
      sourceObservationId: string;
      observationAt: Date;
    }>(
      `SELECT binding.knowledge_entity_id AS "knowledgeEntityId",
              evidence.source_observation_id AS "sourceObservationId",
              observation.observed_at AS "observationAt"
       FROM catalog.knowledge_entity_evidence_bindings binding
       JOIN catalog.evidence_items evidence ON evidence.id = binding.evidence_item_id
       JOIN catalog.source_observations observation ON observation.id = evidence.source_observation_id
       ORDER BY binding.created_at, binding.id
       LIMIT 1`,
    );
    const row = binding.rows[0]!;
    const observedAt = new Date(
      Math.max(Date.now(), row.observationAt.getTime() + 24 * 60 * 60 * 1000),
    );
    const input = {
      knowledgeEntityId: row.knowledgeEntityId,
      metricKey: `idempotent-fixture-${randomUUID()}`,
      intrinsicDimension: 'reach' as const,
      direction: 'higher_is_better' as const,
      rawValue: 42,
      rawUnit: 'events',
      aggregation: 'snapshot' as const,
      windowStart: new Date(observedAt.getTime() - 2 * 24 * 60 * 60 * 1000),
      windowEnd: new Date(observedAt.getTime() - 24 * 60 * 60 * 1000),
      sourceObservationId: row.sourceObservationId,
      observedAt,
    };
    const [first, concurrentRetry] = await Promise.all([
      recordEntityMetricObservation(pool, input),
      recordEntityMetricObservation(pool, input),
    ]);
    expect(concurrentRetry).toBe(first);
    await expect(recordEntityMetricObservation(pool, input)).resolves.toBe(first);

    const conflictingInputs = [
      { ...input, intrinsicDimension: 'impact' as const },
      { ...input, direction: 'lower_is_better' as const },
      { ...input, rawValue: 43 },
      { ...input, rawUnit: 'occurrences' },
      { ...input, aggregation: 'total' as const },
      { ...input, observedAt: new Date(observedAt.getTime() + 1_000) },
    ];
    for (const conflict of conflictingInputs) {
      await expect(recordEntityMetricObservation(pool, conflict)).rejects.toBeInstanceOf(
        ConflictError,
      );
    }
    const persisted = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM catalog.entity_metric_observations
       WHERE knowledge_entity_id = $1 AND metric_key = $2 AND source_observation_id = $3
         AND window_start = $4 AND window_end = $5`,
      [
        input.knowledgeEntityId,
        input.metricKey,
        input.sourceObservationId,
        input.windowStart,
        input.windowEnd,
      ],
    );
    expect(persisted.rows[0]!.count).toBe(1);
  });

  it('binds corroboration to the exact current entity revision, predicate, and scope', async () => {
    const bindings = await pool.query<{
      knowledgeEntityId: string;
      entityRevisionId: string;
      evidenceItemId: string;
      predicate: string;
      applicabilityScope: string;
      sourceObservationId: string;
      sourceId: string;
      sourceOwner: string;
      observationAt: Date;
    }>(
      `SELECT binding.knowledge_entity_id AS "knowledgeEntityId",
              binding.entity_revision_id AS "entityRevisionId",
              binding.evidence_item_id AS "evidenceItemId", binding.predicate,
              binding.applicability_scope AS "applicabilityScope",
              evidence.source_observation_id AS "sourceObservationId",
              observation.source_id AS "sourceId", source.owner AS "sourceOwner",
              observation.observed_at AS "observationAt"
       FROM catalog.knowledge_entity_evidence_bindings binding
       JOIN catalog.evidence_items evidence ON evidence.id = binding.evidence_item_id
       JOIN catalog.source_observations observation ON observation.id = evidence.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       WHERE binding.entity_revision_id = (
         SELECT revision.id FROM catalog.knowledge_entity_revisions revision
         WHERE revision.entity_id = binding.knowledge_entity_id
         ORDER BY revision.revision DESC, revision.created_at DESC, revision.id DESC
         LIMIT 1
       )
       ORDER BY binding.created_at, binding.id`,
    );
    const supported = bindings.rows[0]!;
    const other = bindings.rows.find(
      (row) => row.knowledgeEntityId !== supported.knowledgeEntityId,
    )!;
    const observedAt = new Date(
      Math.max(Date.now(), supported.observationAt.getTime() + 24 * 60 * 60 * 1000),
    );
    const reliabilityAssessmentId = await recordSourceReliability(pool, {
      sourceId: supported.sourceId,
      authorityClass: 'primary',
      availabilityState: 'available',
      rightsState: 'allowed',
      reliabilityScore: 0.9,
      evidenceBasis: { fixture: 'exact-entity-corroboration' },
      sourceObservationIds: [supported.sourceObservationId],
      observedAt,
    });
    const exact = {
      knowledgeEntityId: supported.knowledgeEntityId,
      predicate: supported.predicate,
      applicabilityScope: supported.applicabilityScope,
      evidence: [
        {
          sourceObservationId: supported.sourceObservationId,
          evidenceItemId: supported.evidenceItemId,
          direction: 'supports' as const,
        },
      ],
      observedAt,
    };
    await expect(recordCorroboration(pool, exact)).resolves.toMatchObject({
      state: 'primary_only',
    });
    await expect(
      recordCorroboration(pool, { ...exact, knowledgeEntityId: other.knowledgeEntityId }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    await expect(
      recordCorroboration(pool, {
        ...exact,
        applicabilityScope: `${exact.applicabilityScope}:other`,
      }),
    ).rejects.toBeInstanceOf(DomainValidationError);

    await pool.query(
      `INSERT INTO catalog.knowledge_entity_revisions
         (id, entity_id, revision, entity_class_concept_id, entity_class_facet_key,
          preferred_label, summary, lifecycle_state, source_observation_id, predecessor_id,
          content_hash, created_at)
       SELECT $1, entity_id, revision + 1, entity_class_concept_id, entity_class_facet_key,
              preferred_label, summary, lifecycle_state, source_observation_id, id,
              $2, $3
       FROM catalog.knowledge_entity_revisions
       WHERE id = $4`,
      [
        randomUUID(),
        hashCanonical({ supersedes: supported.entityRevisionId }),
        new Date(),
        supported.entityRevisionId,
      ],
    );
    await expect(
      recordCorroboration(pool, { ...exact, observedAt: new Date(Date.now() + 1_000) }),
    ).rejects.toBeInstanceOf(DomainValidationError);

    const tamperedAssessmentId = randomUUID();
    const independenceGroup = `owner:${supported.sourceOwner
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/\s+/g, '-')}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO catalog.corroboration_assessments
           (id, knowledge_entity_id, policy_version, predicate, applicability_scope, state,
            primary_source_count, independent_source_count, community_source_count,
            source_observation_ids, evidence_item_ids, rationale, observed_at)
         VALUES ($1, $2, 'corroboration-v2', $3, $4, 'primary_only', 1, 0, 0,
                 ARRAY[$5]::uuid[], ARRAY[$6]::uuid[], 'Tampering fixture.', $7)`,
        [
          tamperedAssessmentId,
          other.knowledgeEntityId,
          supported.predicate,
          supported.applicabilityScope,
          supported.sourceObservationId,
          supported.evidenceItemId,
          new Date(Date.now() + 2_000),
        ],
      );
      await client.query(
        `INSERT INTO catalog.corroboration_source_bindings
           (assessment_id, source_observation_id, source_id,
            source_reliability_assessment_id, source_role, independence_group, direction)
         VALUES ($1, $2, $3, $4, 'primary', $5, 'supports')`,
        [
          tamperedAssessmentId,
          supported.sourceObservationId,
          supported.sourceId,
          reliabilityAssessmentId,
          independenceGroup,
        ],
      );
      await client.query(
        `INSERT INTO catalog.corroboration_evidence_bindings
           (assessment_id, evidence_item_id, source_observation_id, direction)
         VALUES ($1, $2, $3, 'supports')`,
        [tamperedAssessmentId, supported.evidenceItemId, supported.sourceObservationId],
      );
      await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
        code: '23514',
        constraint: 'corroboration_entity_evidence_binding',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
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
