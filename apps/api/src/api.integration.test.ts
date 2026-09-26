import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { GitHubMetadataAdapter } from '../../../packages/adapters/src/index.js';
import {
  createIntake,
  createPool,
  getIntake,
  processIntakeMetadata,
  retryIntake,
} from '../../../packages/db/src/index.js';
import { localWorkspaceId, referenceNeedId } from '../../../packages/seed/src/import.js';
import { testDatabaseUrl } from '../../../packages/test-fixtures/src/database.js';
import { buildApp } from './app.js';

const hostHeaders = { host: '127.0.0.1:4310' };
const mutationHeaders = {
  ...hostHeaders,
  origin: 'http://127.0.0.1:5173',
  'content-type': 'application/json',
  'x-maestro-request': '1',
};

describe('local HTTP boundary and critical flows', () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = createPool(testDatabaseUrl());
    app = await buildApp({
      pool,
      logger: false,
      config: {
        host: '127.0.0.1',
        port: 4310,
        allowedHosts: new Set(['127.0.0.1:4310', 'localhost:4310']),
        allowedOrigins: new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:4310']),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('serves the catalog, provenance detail, and private comparison separately', async () => {
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/providers?limit=50',
      headers: hostHeaders,
    });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json<{
      items: Array<{ id: string; name: string }>;
      total: number;
    }>();
    expect(catalogBody.total).toBe(12);
    expect(catalogBody.items).toHaveLength(12);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/providers/${catalogBody.items[0]!.id}`,
      headers: hostHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ executionAvailability: { available: false } });
    expect(
      detail.json<{ claims: unknown[]; score: unknown }>().claims.length,
    ).toBeGreaterThanOrEqual(2);
    expect(detail.json<{ score: { dimensions: unknown[] } }>().score.dimensions).toHaveLength(5);

    const needs = await app.inject({ method: 'GET', url: '/api/v1/needs', headers: hostHeaders });
    expect(needs.statusCode).toBe(200);
    expect(needs.json<{ items: Array<{ id: string }> }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: referenceNeedId })]),
    );
    const comparison = await app.inject({
      method: 'GET',
      url: `/api/v1/needs/${referenceNeedId}`,
      headers: hostHeaders,
    });
    expect(comparison.statusCode).toBe(200);
    const candidates = comparison.json<{
      candidates: Array<{ eligibility: string; optionKind: string }>;
    }>().candidates;
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eligibility: 'unknown_blocked' }),
        expect.objectContaining({ eligibility: 'ineligible' }),
        expect.objectContaining({ eligibility: 'eligible', optionKind: 'status_quo' }),
      ]),
    );
  });

  it('reports readiness only while the local worker heartbeat is current', async () => {
    await pool.query('DELETE FROM ops.worker_heartbeats');
    const unavailable = await app.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
      headers: hostHeaders,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ status: 'not_ready', workerActive: false });

    await pool.query(
      `INSERT INTO ops.worker_heartbeats (worker_key, adapter_version, started_at, last_seen_at)
       VALUES ('local-intake-worker', 'integration', now(), now())`,
    );
    const ready = await app.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
      headers: hostHeaders,
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', workerActive: true, providers: 12 });
  });

  it('enforces Host, Origin, JSON, and explicit mutation headers', async () => {
    const invalidHost = await app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers: { host: 'attacker.example' },
    });
    expect(invalidHost.statusCode).toBe(421);

    const invalidOrigin = await app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers: { ...hostHeaders, origin: 'https://attacker.example' },
    });
    expect(invalidOrigin.statusCode).toBe(403);

    const missingBoundary = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: { ...hostHeaders, 'content-type': 'application/json' },
      payload: { url: 'https://example.com', foundBy: 'test' },
    });
    expect(missingBoundary.statusCode).toBe(403);

    const wrongMedia = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: { ...hostHeaders, 'x-maestro-request': '1', 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(wrongMedia.statusCode).toBe(415);

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: { url: '', foundBy: '' },
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json()).toMatchObject({ code: 'request_validation_failed' });

    for (const payload of [
      { url: `https://example.com/${'a'.repeat(2049)}`, foundBy: 'integration' },
      { url: 'https://example.com/tool', note: 'n'.repeat(2001), foundBy: 'integration' },
      { url: 'https://example.com/tool', foundBy: 'f'.repeat(101) },
    ]) {
      const oversized = await app.inject({
        method: 'POST',
        url: '/api/v1/intakes',
        headers: mutationHeaders,
        payload,
      });
      expect(oversized.statusCode).toBe(400);
      expect(oversized.json()).toMatchObject({ code: 'request_validation_failed' });
    }
  });

  it('persists new, exact duplicate, manual-review, and invalid URL paths safely', async () => {
    const suffix = randomUUID();
    const url = `https://github.com/maestro-integration/${suffix}?utm_source=test#readme`;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: { url, note: 'Integration evidence', foundBy: 'integration' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ state: 'queued', duplicate: false });
    expect(first.json<{ normalizedUrl: string }>().normalizedUrl).not.toContain('utm_source');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: { url: `https://github.com/maestro-integration/${suffix}`, foundBy: 'integration' },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({
      id: first.json<{ id: string }>().id,
      duplicate: true,
      duplicateReason: 'normalized_url',
    });

    const manual = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: {
        url: `https://example.com/${suffix}`,
        note: '<script>globalThis.compromised = true</script>',
        foundBy: 'integration',
      },
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json()).toMatchObject({
      state: 'manual_review_required',
      retryDisposition: 'manual',
    });
    const provider = await pool.query<{ id: string }>('SELECT id FROM catalog.providers LIMIT 1');
    const curated = await app.inject({
      method: 'POST',
      url: `/api/v1/intakes/${manual.json<{ id: string }>().id}/curate`,
      headers: mutationHeaders,
      payload: { providerId: provider.rows[0]!.id, action: 'attach' },
    });
    expect(curated.statusCode).toBe(200);
    const curatedDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/intakes/${manual.json<{ id: string }>().id}`,
      headers: hostHeaders,
    });
    expect(curatedDetail.json()).toMatchObject({
      state: 'curated',
      resolvedProviderId: provider.rows[0]!.id,
      note: '<script>globalThis.compromised = true</script>',
    });
    const audit = await pool.query<{ safeMetadata: Record<string, unknown> }>(
      `SELECT safe_metadata AS "safeMetadata" FROM ops.audit_events
       WHERE object_id = $1 AND action = 'intake.submit'`,
      [manual.json<{ id: string }>().id],
    );
    expect(JSON.stringify(audit.rows[0]!.safeMetadata)).not.toContain('compromised');

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: { url: 'https://127.0.0.1/admin', foundBy: 'integration' },
    });
    expect(blocked.statusCode).toBe(201);
    expect(blocked.json()).toMatchObject({
      state: 'rejected_invalid',
      failureCode: 'blocked_host',
      retryDisposition: 'terminal',
    });
    expect(blocked.json<{ normalizedUrl: string }>().normalizedUrl).toMatch(/^rejected:[a-f0-9]+$/);

    const unsupportedScheme = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: { url: 'http://example.com/tool', foundBy: 'integration' },
    });
    expect(unsupportedScheme.statusCode).toBe(201);
    expect(unsupportedScheme.json()).toMatchObject({
      state: 'rejected_invalid',
      failureCode: 'unsupported_scheme',
      retryDisposition: 'terminal',
    });
  });

  it('detects a strong identity already present in the catalog', async () => {
    const identity = await pool.query<{ value: string; providerId: string }>(
      `SELECT normalized_value AS value, provider_id AS "providerId"
       FROM catalog.provider_identities
       WHERE scheme = 'github_repository' LIMIT 1`,
    );
    const receipt = await app.inject({
      method: 'POST',
      url: '/api/v1/intakes',
      headers: mutationHeaders,
      payload: {
        url: `https://github.com/${identity.rows[0]!.value}.git?utm_campaign=x`,
        foundBy: 'integration',
      },
    });
    expect(receipt.statusCode).toBe(201);
    expect(receipt.json()).toMatchObject({
      state: 'duplicate',
      duplicate: true,
      duplicateReason: 'strong_identity',
      duplicateProviderId: identity.rows[0]!.providerId,
    });
  });

  it('collapses a concurrent exact-URL race through the database constraint', async () => {
    const url = `https://github.com/maestro-race/${randomUUID()}`;
    const [first, second] = await Promise.all([
      createIntake(pool, localWorkspaceId, { url, foundBy: 'race-a' }, randomUUID()),
      createIntake(pool, localWorkspaceId, { url, foundBy: 'race-b' }, randomUUID()),
    ]);
    expect(first.id).toBe(second.id);
    expect([first.duplicate, second.duplicate]).toContain(true);
    const count = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM ops.intakes WHERE normalized_url = $1',
      [first.normalizedUrl],
    );
    expect(count.rows[0]!.count).toBe(1);
  });

  it('records bounded transient and terminal adapter failures and supports deliberate retry', async () => {
    const transientReceipt = await createIntake(
      pool,
      localWorkspaceId,
      { url: `https://github.com/maestro-transient/${randomUUID()}`, foundBy: 'integration' },
      randomUUID(),
    );
    const transientAdapter: GitHubMetadataAdapter = {
      key: 'github-metadata',
      version: 'github-metadata-v1',
      async fetch() {
        return { kind: 'transient_failure', code: 'timeout' };
      },
    };
    expect(await processIntakeMetadata(pool, transientReceipt.id, transientAdapter)).toMatchObject({
      state: 'fetch_failed',
      failureCode: 'timeout',
      retryDisposition: 'transient',
    });
    await retryIntake(pool, localWorkspaceId, transientReceipt.id, randomUUID());
    expect(await getIntake(pool, localWorkspaceId, transientReceipt.id)).toMatchObject({
      state: 'queued',
      retryDisposition: 'none',
    });

    const terminalReceipt = await createIntake(
      pool,
      localWorkspaceId,
      { url: `https://github.com/maestro-terminal/${randomUUID()}`, foundBy: 'integration' },
      randomUUID(),
    );
    const terminalAdapter: GitHubMetadataAdapter = {
      key: 'github-metadata',
      version: 'github-metadata-v1',
      async fetch() {
        return { kind: 'terminal_failure', code: 'too_large' };
      },
    };
    expect(await processIntakeMetadata(pool, terminalReceipt.id, terminalAdapter)).toMatchObject({
      state: 'fetch_failed',
      failureCode: 'too_large',
      retryDisposition: 'terminal',
    });
    await expect(
      pool.query(
        `UPDATE ops.job_attempts SET error_code = 'rewritten'
         WHERE operation_key = $1 AND state = 'terminal_failure'`,
        [`intake:${terminalReceipt.id}:metadata:v1`],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      retryIntake(pool, localWorkspaceId, terminalReceipt.id, randomUUID()),
    ).rejects.toThrow(/Only transient/);
  });

  it('finalizes an interrupted worker attempt before starting its bounded replacement', async () => {
    const receipt = await createIntake(
      pool,
      localWorkspaceId,
      { url: `https://github.com/maestro-interrupted/${randomUUID()}`, foundBy: 'integration' },
      randomUUID(),
    );
    const operationKey = `intake:${receipt.id}:metadata:v1`;
    await pool.query(
      `INSERT INTO ops.job_attempts
         (id, operation_key, task_name, input_hash, adapter_version, attempt, state, started_at)
       VALUES ($1, $2, 'consider_url_metadata_v1', $3, 'github-metadata-v1', 1, 'started', now())`,
      [randomUUID(), operationKey, 'a'.repeat(64)],
    );
    const successAdapter: GitHubMetadataAdapter = {
      key: 'github-metadata',
      version: 'github-metadata-v1',
      async fetch() {
        return {
          kind: 'success',
          metadata: { recovered: true },
          digest: 'b'.repeat(64),
          retrieval: 'offline_identity',
        };
      },
    };
    await expect(processIntakeMetadata(pool, receipt.id, successAdapter)).resolves.toMatchObject({
      state: 'identity_candidates_ready',
    });
    const attempts = await pool.query<{ attempt: number; state: string; errorCode: string | null }>(
      `SELECT attempt, state, error_code AS "errorCode" FROM ops.job_attempts
       WHERE operation_key = $1 ORDER BY attempt`,
      [operationKey],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, state: 'transient_failure', errorCode: 'interrupted_before_finalize' },
      { attempt: 2, state: 'succeeded', errorCode: null },
    ]);
  });

  it('publishes no install, execution, model-routing, or orchestration route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/openapi.json',
      headers: hostHeaders,
    });
    const paths = Object.keys(response.json<{ paths: Record<string, unknown> }>().paths);
    expect(paths.sort()).toEqual(
      [
        '/api/v1/decisions/{id}',
        '/api/v1/domains',
        '/api/v1/health/live',
        '/api/v1/health/ready',
        '/api/v1/intakes',
        '/api/v1/intakes/{id}',
        '/api/v1/intakes/{id}/curate',
        '/api/v1/intakes/{id}/retry',
        '/api/v1/needs',
        '/api/v1/needs/{id}',
        '/api/v1/needs/{id}/candidates',
        '/api/v1/needs/{id}/decisions',
        '/api/v1/providers',
        '/api/v1/providers/{id}',
        '/api/v1/score-runs/replay',
        '/api/v1/verification',
        '/api/v1/workspace',
        '/api/v1/workspaces/{workspaceId}/projects',
      ].sort(),
    );
    expect(
      paths.some((path) =>
        /install|execute|invoke|route-model|orchestrat|sandbox|deploy|pipeline|run-control/.test(
          path,
        ),
      ),
    ).toBe(false);
  });
});
