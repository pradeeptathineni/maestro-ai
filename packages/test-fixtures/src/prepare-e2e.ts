import { initializeWorker } from '../../../apps/worker/src/initialize.js';
import { migrate } from '../../db/src/migrate.js';
import { importSeed } from '../../seed/src/import.js';
import { ensureTestDatabase, resetTestSchemas, testDatabaseUrl } from './database.js';

await ensureTestDatabase();
await resetTestSchemas();
await migrate(testDatabaseUrl());
await initializeWorker(testDatabaseUrl());
await importSeed(testDatabaseUrl());
process.stdout.write('Fresh e2e database is ready.\n');
