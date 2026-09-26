import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hashCanonical, replayDecisionReceipt } from '../../domain/src/index.js';
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
import { migrate } from './migrate.js';
import { checkSchemaDefinitions } from './schema-check.js';
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
    ]);
    expect(migrations.rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
  });

  it('imports the source manifest idempotently with exact reviewed counts', async () => {
    const first = await importSeed(testDatabaseUrl());
    const second = await importSeed(testDatabaseUrl());
    expect(second).toEqual(first);
    expect(second.counts).toMatchObject({
      providers: 12,
      sources: 27,
      claims: 24,
      evidence_items: 24,
      score_runs: 12,
      projects: 1,
      needs: 1,
      candidates: 3,
    });
  });

  it('replays every stored score without a mismatch', async () => {
    expect(await replayStoredScores(pool)).toEqual({ checked: 12, mismatches: [] });
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
    expect(await checkSchemaDefinitions(pool)).toEqual({ checkedTables: 43, errors: [] });
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
});
