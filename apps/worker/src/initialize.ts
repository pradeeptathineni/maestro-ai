import { fileURLToPath } from 'node:url';
import { createGraphileJobQueue } from '../../../packages/adapters/src/index.js';
import { databaseUrl } from '../../../packages/db/src/index.js';

export async function initializeWorker(connectionString = databaseUrl()): Promise<void> {
  const queue = await createGraphileJobQueue(connectionString);
  try {
    await queue.migrate();
  } finally {
    await queue.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initializeWorker();
  process.stdout.write('Graphile Worker schema is current.\n');
}
