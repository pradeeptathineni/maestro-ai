import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import type { JobQueue } from '../../domain/src/index.js';

export interface ReleasableJobQueue extends JobQueue {
  migrate(): Promise<void>;
  release(): Promise<void>;
}

export async function createGraphileJobQueue(
  connectionString: string,
): Promise<ReleasableJobQueue> {
  const workerUtils: WorkerUtils = await makeWorkerUtils({ connectionString });
  return {
    async migrate(): Promise<void> {
      await workerUtils.migrate();
    },
    async enqueue(taskName, payload, options): Promise<{ jobId: string }> {
      const job = await workerUtils.addJob(taskName, payload, {
        jobKey: options.operationKey,
        jobKeyMode: 'replace',
        maxAttempts: options.maxAttempts,
      });
      return { jobId: job.id };
    },
    async release(): Promise<void> {
      await workerUtils.release();
    },
  };
}
