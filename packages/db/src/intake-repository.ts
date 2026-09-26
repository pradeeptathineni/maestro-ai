import type { Pool, PoolClient } from 'pg';
import type { IntakeBody } from '../../contracts/src/index.js';
import {
  hashCanonical,
  newOpaqueId,
  normalizeConsiderUrl,
  UrlPolicyError,
} from '../../domain/src/index.js';
import type { GitHubMetadataAdapter, MetadataAdapterResult } from '../../adapters/src/index.js';
import { ConflictError, DomainValidationError, NotFoundError } from './errors.js';

type JsonRow = Record<string, unknown>;

export interface IntakeReceipt {
  id: string;
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
  state: string;
  failureCode: string | null;
  retryDisposition: string | null;
  duplicate: boolean;
  duplicateReason?: 'idempotency_key' | 'normalized_url' | 'strong_identity';
  duplicateProviderId?: string;
  strongIdentity?: { scheme: string; value: string };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function appendEvent(
  client: PoolClient,
  intakeId: string,
  state: string,
  safeDetail: string,
  correlationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.intake_events (id, intake_id, state, safe_detail, correlation_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [newOpaqueId(), intakeId, state, safeDetail, correlationId],
  );
}

async function existingReceipt(
  client: PoolClient | Pool,
  workspaceId: string,
  where: 'normalized_url' | 'idempotency_key' | 'strong_identity',
  value: string,
): Promise<IntakeReceipt | null> {
  const result = await client.query<{
    id: string;
    originalUrl: string;
    normalizedUrl: string;
    hostname: string;
    state: string;
    failureCode: string | null;
    retryDisposition: string | null;
    strongIdentityScheme: string | null;
    strongIdentityValue: string | null;
    resolvedProviderId: string | null;
  }>(
    `SELECT i.id, i.original_url AS "originalUrl", i.normalized_url AS "normalizedUrl",
            i.hostname, i.state, i.failure_code AS "failureCode",
            i.retry_disposition AS "retryDisposition",
            i.strong_identity_scheme AS "strongIdentityScheme",
            i.strong_identity_value AS "strongIdentityValue",
            source.resolved_provider_id AS "resolvedProviderId"
     FROM ops.intakes i
     LEFT JOIN ops.intake_sources source ON source.intake_id = i.id
     WHERE i.workspace_id = $1 AND ${
       where === 'strong_identity'
         ? "i.strong_identity_scheme || ':' || i.strong_identity_value"
         : `i.${where}`
     } = $2`,
    [workspaceId, value],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    originalUrl: row.originalUrl,
    normalizedUrl: row.normalizedUrl,
    hostname: row.hostname,
    state: row.state,
    failureCode: row.failureCode,
    retryDisposition: row.retryDisposition,
    duplicate: true,
    duplicateReason: where,
    duplicateProviderId: row.resolvedProviderId ?? undefined,
    strongIdentity:
      row.strongIdentityScheme && row.strongIdentityValue
        ? { scheme: row.strongIdentityScheme, value: row.strongIdentityValue }
        : undefined,
  };
}

export async function createIntake(
  pool: Pool,
  workspaceId: string,
  input: IntakeBody,
  correlationId: string,
): Promise<IntakeReceipt> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.idempotencyKey) {
      const idempotent = await existingReceipt(
        client,
        workspaceId,
        'idempotency_key',
        input.idempotencyKey,
      );
      if (idempotent) {
        await appendEvent(
          client,
          idempotent.id,
          'duplicate',
          'Repeated idempotency key.',
          correlationId,
        );
        await client.query('COMMIT');
        return { ...idempotent, duplicateReason: 'idempotency_key' };
      }
    }

    let normalized: ReturnType<typeof normalizeConsiderUrl> | null = null;
    let policyError: UrlPolicyError | null = null;
    try {
      normalized = normalizeConsiderUrl(input.url);
    } catch (error) {
      if (error instanceof UrlPolicyError) policyError = error;
      else throw error;
    }

    const originalUrl = input.url.trim();
    const normalizedUrl =
      normalized?.normalizedUrl ?? `rejected:${hashCanonical({ originalUrl }).slice(0, 48)}`;
    const duplicate = await existingReceipt(client, workspaceId, 'normalized_url', normalizedUrl);
    if (duplicate) {
      await appendEvent(
        client,
        duplicate.id,
        'duplicate',
        'Exact normalized URL match.',
        correlationId,
      );
      await client.query('COMMIT');
      return { ...duplicate, duplicateReason: 'normalized_url' };
    }
    if (normalized?.strongIdentity) {
      const duplicateIdentity = await existingReceipt(
        client,
        workspaceId,
        'strong_identity',
        `${normalized.strongIdentity.scheme}:${normalized.strongIdentity.value}`,
      );
      if (duplicateIdentity) {
        await appendEvent(
          client,
          duplicateIdentity.id,
          'duplicate',
          'Strong identity matches an existing intake.',
          correlationId,
        );
        await client.query('COMMIT');
        return { ...duplicateIdentity, duplicateReason: 'strong_identity' };
      }
    }

    const intakeId = newOpaqueId();
    const hostname = normalized?.hostname ?? '';
    let duplicateProviderId: string | undefined;
    if (normalized?.strongIdentity) {
      const identity = await client.query<{ providerId: string }>(
        `SELECT provider_id AS "providerId" FROM catalog.provider_identities
         WHERE scheme = $1 AND normalized_value = $2 AND valid_to IS NULL`,
        [normalized.strongIdentity.scheme, normalized.strongIdentity.value],
      );
      duplicateProviderId = identity.rows[0]?.providerId;
    }
    const state = policyError
      ? 'rejected_invalid'
      : duplicateProviderId
        ? 'duplicate'
        : normalized?.fetchDisposition === 'allowlisted_metadata'
          ? 'queued'
          : 'manual_review_required';
    const failureCode = policyError?.code ?? null;
    const retryDisposition = policyError
      ? 'terminal'
      : state === 'manual_review_required'
        ? 'manual'
        : 'none';
    await client.query(
      `INSERT INTO ops.intakes
         (id, workspace_id, original_url, normalized_url, hostname, note, found_by,
          strong_identity_scheme, strong_identity_value, state, failure_code,
          retry_disposition, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        intakeId,
        workspaceId,
        originalUrl,
        normalizedUrl,
        hostname,
        input.note ?? null,
        input.foundBy,
        normalized?.strongIdentity?.scheme ?? null,
        normalized?.strongIdentity?.value ?? null,
        state,
        failureCode,
        retryDisposition,
        input.idempotencyKey ?? null,
      ],
    );
    await client.query(
      `INSERT INTO ops.intake_sources
         (id, intake_id, workspace_id, submitted_uri, normalized_uri,
          trust_boundary, handling_status, resolved_provider_id, curated_at)
       VALUES ($1, $2, $3, $4, $5, 'remote_untrusted', $6, $7, $8)`,
      [
        newOpaqueId(),
        intakeId,
        workspaceId,
        originalUrl,
        normalizedUrl,
        policyError ? 'rejected' : 'quarantined',
        duplicateProviderId ?? null,
        duplicateProviderId ? new Date().toISOString() : null,
      ],
    );
    const safeDetail = policyError
      ? policyError.message
      : duplicateProviderId
        ? 'Strong identity matches an existing catalog provider.'
        : state === 'queued'
          ? 'Captured and queued for the allowlisted metadata adapter.'
          : 'Captured safely; this host requires manual review.';
    await appendEvent(client, intakeId, state, safeDetail, correlationId);
    if (state === 'queued') {
      await client.query(
        `INSERT INTO ops.outbox (id, operation_key, task_name, payload)
         VALUES ($1, $2, 'consider_url_metadata_v1', $3)`,
        [newOpaqueId(), `intake:${intakeId}:metadata:v1`, json({ intakeId, workspaceId })],
      );
    }
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, correlation_id,
          after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'intake.submit', 'intake', $3, $4, $5, $6)`,
      [
        newOpaqueId(),
        workspaceId,
        intakeId,
        correlationId,
        hashCanonical({ normalizedUrl, state, foundBy: input.foundBy }),
        json({ hostname, state, hasNote: Boolean(input.note), foundBy: input.foundBy }),
      ],
    );
    await client.query('COMMIT');
    return {
      id: intakeId,
      originalUrl,
      normalizedUrl,
      hostname,
      state,
      failureCode,
      retryDisposition,
      duplicate: Boolean(duplicateProviderId),
      duplicateReason: duplicateProviderId ? 'strong_identity' : undefined,
      duplicateProviderId,
      strongIdentity: normalized?.strongIdentity,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') {
      if (input.idempotencyKey) {
        const idempotent = await existingReceipt(
          pool,
          workspaceId,
          'idempotency_key',
          input.idempotencyKey,
        );
        if (idempotent) return { ...idempotent, duplicateReason: 'idempotency_key' };
      }
      const duplicate = await existingReceipt(
        pool,
        workspaceId,
        'normalized_url',
        intakeStorageKey(input.url),
      );
      if (duplicate) return duplicate;
      try {
        const identity = normalizeConsiderUrl(input.url).strongIdentity;
        if (identity) {
          const duplicateIdentity = await existingReceipt(
            pool,
            workspaceId,
            'strong_identity',
            `${identity.scheme}:${identity.value}`,
          );
          if (duplicateIdentity) {
            return { ...duplicateIdentity, duplicateReason: 'strong_identity' };
          }
        }
      } catch {
        // Invalid URLs have already been checked through their rejected storage key.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function intakeStorageKey(input: string): string {
  try {
    return normalizeConsiderUrl(input).normalizedUrl;
  } catch {
    const originalUrl = input.trim();
    return `rejected:${hashCanonical({ originalUrl }).slice(0, 48)}`;
  }
}

export async function listIntakes(pool: Pool, workspaceId: string): Promise<unknown[]> {
  const result = await pool.query<JsonRow>(
    `SELECT i.id, i.original_url AS "originalUrl", i.normalized_url AS "normalizedUrl",
            i.hostname, i.found_by AS "foundBy", i.state, i.failure_code AS "failureCode",
            i.retry_disposition AS "retryDisposition", i.revision,
            i.created_at AS "createdAt", i.updated_at AS "updatedAt",
            i.strong_identity_scheme AS "strongIdentityScheme",
            i.strong_identity_value AS "strongIdentityValue",
            source.handling_status AS "handlingStatus",
            source.minimal_metadata AS "minimalMetadata",
            source.resolved_provider_id AS "resolvedProviderId"
     FROM ops.intakes i
     JOIN ops.intake_sources source ON source.intake_id = i.id
     WHERE i.workspace_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
    [workspaceId],
  );
  return result.rows;
}

export async function getIntake(
  pool: Pool,
  workspaceId: string,
  intakeId: string,
): Promise<JsonRow | null> {
  const intake = await pool.query<JsonRow>(
    `SELECT i.id, i.original_url AS "originalUrl", i.normalized_url AS "normalizedUrl",
            i.hostname, i.note, i.found_by AS "foundBy", i.state,
            i.failure_code AS "failureCode", i.retry_disposition AS "retryDisposition",
            i.revision, i.created_at AS "createdAt", i.updated_at AS "updatedAt",
            source.handling_status AS "handlingStatus",
            source.minimal_metadata AS "minimalMetadata",
            source.content_digest AS "contentDigest",
            source.resolved_provider_id AS "resolvedProviderId", source.curated_at AS "curatedAt"
     FROM ops.intakes i JOIN ops.intake_sources source ON source.intake_id = i.id
     WHERE i.id = $1 AND i.workspace_id = $2`,
    [intakeId, workspaceId],
  );
  if (!intake.rowCount) return null;
  const events = await pool.query<JsonRow>(
    `SELECT state, safe_detail AS detail, correlation_id AS "correlationId",
            created_at AS "createdAt"
     FROM ops.intake_events WHERE intake_id = $1 ORDER BY created_at, id`,
    [intakeId],
  );
  return { ...intake.rows[0], events: events.rows };
}

export interface ProcessIntakeResult {
  state: 'identity_candidates_ready' | 'fetch_failed';
  retryDisposition: 'none' | 'transient' | 'terminal';
  failureCode: string | null;
  adapterResult: MetadataAdapterResult;
}

export async function processIntakeMetadata(
  pool: Pool,
  intakeId: string,
  adapter: GitHubMetadataAdapter,
  correlationId = newOpaqueId(),
): Promise<ProcessIntakeResult> {
  const lockClient = await pool.connect();
  const operationKey = `intake:${intakeId}:metadata:v1`;
  const lock = await lockClient.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [operationKey],
  );
  if (!lock.rows[0]!.acquired) {
    lockClient.release();
    throw new ConflictError('This intake is already being processed.');
  }
  try {
    return await processIntakeMetadataLocked(pool, intakeId, adapter, correlationId);
  } finally {
    await lockClient
      .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [operationKey])
      .catch(() => undefined);
    lockClient.release();
  }
}

async function processIntakeMetadataLocked(
  pool: Pool,
  intakeId: string,
  adapter: GitHubMetadataAdapter,
  correlationId: string,
): Promise<ProcessIntakeResult> {
  const startClient = await pool.connect();
  let identity: string;
  let attempt: number;
  try {
    await startClient.query('BEGIN');
    const intake = await startClient.query<{
      state: string;
      identityScheme: string | null;
      identityValue: string | null;
    }>(
      `SELECT state, strong_identity_scheme AS "identityScheme",
              strong_identity_value AS "identityValue"
       FROM ops.intakes WHERE id = $1 FOR UPDATE`,
      [intakeId],
    );
    if (!intake.rowCount) throw new NotFoundError('Intake not found.');
    const row = intake.rows[0]!;
    if (row.identityScheme !== 'github_repository' || !row.identityValue) {
      throw new DomainValidationError('No supported metadata adapter exists for this intake.');
    }
    if (!['queued', 'fetch_failed', 'fetching_metadata'].includes(row.state)) {
      throw new ConflictError(`Intake in state ${row.state} cannot be processed.`);
    }
    identity = row.identityValue;
    await startClient.query(
      `UPDATE ops.job_attempts
       SET state = 'transient_failure', error_code = 'interrupted_before_finalize',
           next_action = 'bounded_retry', finished_at = now()
       WHERE operation_key = $1 AND state = 'started' AND finished_at IS NULL`,
      [`intake:${intakeId}:metadata:v1`],
    );
    const attemptResult = await startClient.query<{ nextAttempt: number }>(
      `SELECT COALESCE(max(attempt), 0)::int + 1 AS "nextAttempt"
       FROM ops.job_attempts WHERE operation_key = $1`,
      [`intake:${intakeId}:metadata:v1`],
    );
    attempt = attemptResult.rows[0]!.nextAttempt;
    await startClient.query(
      `INSERT INTO ops.job_attempts
         (id, operation_key, task_name, input_hash, adapter_version, attempt, state, started_at)
       VALUES ($1, $2, 'consider_url_metadata_v1', $3, $4, $5, 'started', now())`,
      [
        newOpaqueId(),
        `intake:${intakeId}:metadata:v1`,
        hashCanonical({ intakeId, identity }),
        adapter.version,
        attempt,
      ],
    );
    await startClient.query(
      `UPDATE ops.intakes SET state = 'fetching_metadata', revision = revision + 1,
              updated_at = now(), failure_code = NULL, retry_disposition = 'none'
       WHERE id = $1`,
      [intakeId],
    );
    await appendEvent(
      startClient,
      intakeId,
      'fetching_metadata',
      `Allowlisted adapter attempt ${attempt} started.`,
      correlationId,
    );
    await startClient.query('COMMIT');
  } catch (error) {
    await startClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    startClient.release();
  }

  let adapterResult: MetadataAdapterResult;
  try {
    adapterResult = await adapter.fetch(identity);
  } catch {
    adapterResult = { kind: 'transient_failure', code: 'upstream' };
  }
  const finishClient = await pool.connect();
  try {
    await finishClient.query('BEGIN');
    if (adapterResult.kind === 'success') {
      await finishClient.query(
        `UPDATE ops.intakes SET state = 'identity_candidates_ready', revision = revision + 1,
                updated_at = now(), failure_code = NULL, retry_disposition = 'none'
         WHERE id = $1`,
        [intakeId],
      );
      await finishClient.query(
        `UPDATE ops.intake_sources SET handling_status = 'normalized', content_digest = $2,
                minimal_metadata = $3 WHERE intake_id = $1`,
        [intakeId, adapterResult.digest, json(adapterResult.metadata)],
      );
      await finishClient.query(
        `UPDATE ops.job_attempts SET state = 'succeeded', finished_at = now(), next_action = 'human_review'
         WHERE operation_key = $1 AND attempt = $2`,
        [`intake:${intakeId}:metadata:v1`, attempt],
      );
      await appendEvent(
        finishClient,
        intakeId,
        'identity_candidates_ready',
        adapterResult.retrieval === 'live_github_api'
          ? 'Bounded GitHub metadata is ready for human review.'
          : 'Strong identity is ready; live network retrieval is disabled.',
        correlationId,
      );
      await finishClient.query('COMMIT');
      return {
        state: 'identity_candidates_ready',
        retryDisposition: 'none',
        failureCode: null,
        adapterResult,
      };
    }
    const exhausted = adapterResult.kind === 'transient_failure' && attempt >= 3;
    const transient = adapterResult.kind === 'transient_failure' && !exhausted;
    const retryDisposition = transient ? 'transient' : 'terminal';
    const failureCode = exhausted ? `${adapterResult.code}_retry_exhausted` : adapterResult.code;
    await finishClient.query(
      `UPDATE ops.intakes SET state = 'fetch_failed', revision = revision + 1,
              updated_at = now(), failure_code = $2, retry_disposition = $3
       WHERE id = $1`,
      [intakeId, failureCode, retryDisposition],
    );
    await finishClient.query(
      `UPDATE ops.job_attempts SET state = $3, error_code = $4, finished_at = now(),
              next_action = $5
       WHERE operation_key = $1 AND attempt = $2`,
      [
        `intake:${intakeId}:metadata:v1`,
        attempt,
        transient ? 'transient_failure' : 'terminal_failure',
        failureCode,
        transient ? 'bounded_retry' : 'manual_review',
      ],
    );
    await appendEvent(
      finishClient,
      intakeId,
      'fetch_failed',
      transient
        ? 'Metadata retrieval failed transiently; a bounded retry is available.'
        : 'Metadata retrieval stopped safely; continue with manual review.',
      correlationId,
    );
    await finishClient.query('COMMIT');
    return { state: 'fetch_failed', retryDisposition, failureCode, adapterResult };
  } catch (error) {
    await finishClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    finishClient.release();
  }
}

export async function retryIntake(
  pool: Pool,
  workspaceId: string,
  intakeId: string,
  correlationId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const intake = await client.query<{
      revision: number;
      state: string;
      retryDisposition: string | null;
    }>(
      `SELECT revision, state, retry_disposition AS "retryDisposition"
       FROM ops.intakes WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [intakeId, workspaceId],
    );
    if (!intake.rowCount) throw new NotFoundError('Intake not found.');
    const row = intake.rows[0]!;
    if (row.state !== 'fetch_failed' || row.retryDisposition !== 'transient') {
      throw new ConflictError('Only transient metadata failures may be retried.');
    }
    const revision = row.revision + 1;
    await client.query(
      `UPDATE ops.intakes SET state = 'queued', revision = $2, updated_at = now(),
              failure_code = NULL, retry_disposition = 'none' WHERE id = $1`,
      [intakeId, revision],
    );
    await client.query(
      `INSERT INTO ops.outbox (id, operation_key, task_name, payload)
       VALUES ($1, $2, 'consider_url_metadata_v1', $3)
       ON CONFLICT (operation_key) DO NOTHING`,
      [
        newOpaqueId(),
        `intake:${intakeId}:metadata:v1:retry:${revision}`,
        json({ intakeId, workspaceId }),
      ],
    );
    await appendEvent(
      client,
      intakeId,
      'queued',
      'Human requested a bounded retry.',
      correlationId,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function curateIntake(
  pool: Pool,
  workspaceId: string,
  intakeId: string,
  providerId: string,
  action: 'attach' | 'merge_duplicate',
  correlationId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [intake, provider] = await Promise.all([
      client.query<{ state: string }>(
        'SELECT state FROM ops.intakes WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [intakeId, workspaceId],
      ),
      client.query('SELECT id FROM catalog.providers WHERE id = $1', [providerId]),
    ]);
    if (!intake.rowCount) throw new NotFoundError('Intake not found.');
    if (!provider.rowCount) throw new NotFoundError('Provider not found.');
    const currentState = intake.rows[0]!.state;
    if (
      !['manual_review_required', 'identity_candidates_ready', 'fetch_failed'].includes(
        currentState,
      )
    ) {
      throw new ConflictError(`Intake in state ${currentState} cannot be curated.`);
    }
    const state = action === 'merge_duplicate' ? 'merged_duplicate' : 'curated';
    await client.query(
      `UPDATE ops.intakes SET state = $2, revision = revision + 1, updated_at = now(),
              retry_disposition = 'none' WHERE id = $1`,
      [intakeId, state],
    );
    await client.query(
      `UPDATE ops.intake_sources SET resolved_provider_id = $2, curated_at = now(),
              handling_status = 'reviewed' WHERE intake_id = $1`,
      [intakeId, providerId],
    );
    await appendEvent(
      client,
      intakeId,
      state,
      'Human attached the intake to a reviewed provider.',
      correlationId,
    );
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, correlation_id,
          safe_metadata)
       VALUES ($1, $2, 'human', 'intake.curate', 'intake', $3, $4, $5)`,
      [newOpaqueId(), workspaceId, intakeId, correlationId, json({ providerId, action })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
