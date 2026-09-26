import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { JobQueue } from '../../../packages/domain/src/index.js';
import { createIntake, createPool } from '../../../packages/db/src/index.js';
import { localWorkspaceId } from '../../../packages/seed/src/import.js';
import { testDatabaseUrl } from '../../../packages/test-fixtures/src/database.js';
import { dispatchOutbox } from './outbox.js';

describe('transactional outbox seam', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(testDatabaseUrl());
  });

  afterAll(async () => {
    await pool.end();
  });

  it('dispatches each pending operation with its idempotency key', async () => {
    const receipt = await createIntake(
      pool,
      localWorkspaceId,
      { url: `https://github.com/maestro-outbox/${randomUUID()}`, foundBy: 'integration' },
      randomUUID(),
    );
    const enqueued: Array<{ taskName: string; payload: unknown; operationKey: string }> = [];
    const queue: JobQueue = {
      async enqueue(taskName, payload, options) {
        enqueued.push({ taskName, payload, operationKey: options.operationKey });
        return { jobId: randomUUID() };
      },
    };
    const first = await dispatchOutbox(pool, queue, 100);
    expect(first.dispatched).toBeGreaterThan(0);
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        taskName: 'consider_url_metadata_v1',
        operationKey: `intake:${receipt.id}:metadata:v1`,
      }),
    );
    const second = await dispatchOutbox(pool, queue, 100);
    expect(second).toEqual({ dispatched: 0, failed: 0 });
  });

  it('stops retrying a queue-unavailable operation after the bounded third attempt', async () => {
    const operationKey = `integration:queue-failure:${randomUUID()}`;
    await pool.query(
      `INSERT INTO ops.outbox (id, operation_key, task_name, payload)
       VALUES ($1, $2, 'consider_url_metadata_v1', '{}')`,
      [randomUUID(), operationKey],
    );
    const unavailableQueue: JobQueue = {
      async enqueue() {
        throw new Error('queue unavailable');
      },
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await pool.query('UPDATE ops.outbox SET available_at = now() WHERE operation_key = $1', [
        operationKey,
      ]);
      await dispatchOutbox(pool, unavailableQueue, 100);
    }
    const result = await pool.query<{ state: string; attempts: number; lastErrorCode: string }>(
      `SELECT state, attempts, last_error_code AS "lastErrorCode"
       FROM ops.outbox WHERE operation_key = $1`,
      [operationKey],
    );
    expect(result.rows[0]).toEqual({
      state: 'failed',
      attempts: 3,
      lastErrorCode: 'queue_unavailable',
    });
  });
});
