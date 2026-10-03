import { run } from 'graphile-worker';
import {
  createGraphileJobQueue,
  createGitHubMetadataAdapter,
} from '../../../packages/adapters/src/index.js';
import {
  createPool,
  databaseUrl,
  recoverDueWatches,
  recoverStaleDiscoveryOperations,
} from '../../../packages/db/src/index.js';
import { dispatchOutbox } from './outbox.js';
import { createTaskList } from './tasks.js';

const connectionString = databaseUrl();
const pool = createPool(connectionString);
const queue = await createGraphileJobQueue(connectionString);
await queue.migrate();

const adapter = createGitHubMetadataAdapter({
  allowNetwork: process.env.MAESTRO_ALLOW_NETWORK_FETCH === 'true',
});
const runner = await run({
  connectionString,
  concurrency: 2,
  pollInterval: 500,
  noHandleSignals: true,
  taskList: createTaskList(pool, adapter),
});

await pool.query(
  `INSERT INTO ops.worker_heartbeats (worker_key, adapter_version, started_at, last_seen_at)
   VALUES ('local-intake-worker', 'graphile-worker-0.18.0', now(), now())
   ON CONFLICT (worker_key) DO UPDATE SET adapter_version = EXCLUDED.adapter_version,
     started_at = EXCLUDED.started_at, last_seen_at = EXCLUDED.last_seen_at`,
);

let stopping = false;
const dispatch = async (): Promise<void> => {
  if (stopping) return;
  await dispatchOutbox(pool, queue).catch((error: unknown) => {
    process.stderr.write(
      `Outbox dispatch failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
};
const recoverSchedules = async (): Promise<void> => {
  if (stopping) return;
  await Promise.all([
    recoverDueWatches(pool),
    recoverStaleDiscoveryOperations(pool),
  ]).catch((error: unknown) => {
    process.stderr.write(
      `Recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
};
await recoverSchedules();
await dispatch();
const timer = setInterval(() => void dispatch(), 500);
const recoveryTimer = setInterval(() => void recoverSchedules(), 30_000);
const heartbeatTimer = setInterval(() => {
  void pool
    .query(
      "UPDATE ops.worker_heartbeats SET last_seen_at = now() WHERE worker_key = 'local-intake-worker'",
    )
    .catch(() => undefined);
}, 5_000);

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(recoveryTimer);
  clearInterval(heartbeatTimer);
  await runner.stop(signal);
  await queue.release();
  await pool.end();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
await runner.promise;
