import type { Pool } from 'pg';
import type { JobQueue } from '../../../packages/domain/src/index.js';

export interface DispatchResult {
  dispatched: number;
  failed: number;
}

export async function dispatchOutbox(
  pool: Pool,
  queue: JobQueue,
  batchSize = 20,
): Promise<DispatchResult> {
  const client = await pool.connect();
  let dispatched = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const rows = await client.query<{
      id: string;
      operationKey: string;
      taskName: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `SELECT id, operation_key AS "operationKey", task_name AS "taskName", payload, attempts
       FROM ops.outbox
       WHERE state = 'pending' AND available_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT $1`,
      [batchSize],
    );
    for (const row of rows.rows) {
      try {
        await queue.enqueue(row.taskName, row.payload, {
          operationKey: row.operationKey,
          maxAttempts: 3,
        });
        await client.query(
          `UPDATE ops.outbox SET state = 'dispatched', dispatched_at = now(),
                  attempts = attempts + 1, last_error_code = NULL
           WHERE id = $1`,
          [row.id],
        );
        dispatched += 1;
      } catch {
        const attempts = row.attempts + 1;
        await client.query(
          `UPDATE ops.outbox SET state = $2, attempts = $3::integer,
                  available_at = now() + make_interval(
                    secs => LEAST(300, power(2::numeric, $3::numeric)::integer)
                  ),
                  last_error_code = 'queue_unavailable'
           WHERE id = $1`,
          [row.id, attempts >= 3 ? 'failed' : 'pending', attempts],
        );
        failed += 1;
      }
    }
    await client.query('COMMIT');
    return { dispatched, failed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
