import { initializeWorker } from '../../../apps/worker/src/initialize.js';
import { migrate } from '../../db/src/migrate.js';
import { importSeed } from '../../seed/src/import.js';
import { ensureTestDatabase, resetTestSchemas, testDatabaseUrl } from './database.js';

export async function setup(): Promise<void> {
  await ensureTestDatabase();
  await resetTestSchemas();
  await migrate(testDatabaseUrl());
  await initializeWorker(testDatabaseUrl());
  await importSeed(testDatabaseUrl());
  await importSeed(testDatabaseUrl());
}
