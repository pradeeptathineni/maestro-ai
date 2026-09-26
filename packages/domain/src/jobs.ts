/** Operational queue seam for bounded v0 background work. This is not a product run. */
export interface JobQueue {
  enqueue(
    taskName: string,
    payload: Record<string, unknown>,
    options: { operationKey: string; maxAttempts: number },
  ): Promise<{ jobId: string }>;
}
