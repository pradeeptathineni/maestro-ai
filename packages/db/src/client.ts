import pg from 'pg';
import { databaseUrl } from './config.js';

const { Pool } = pg;

export function createPool(connectionString = databaseUrl()): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    application_name: 'maestro-ai',
    statement_timeout: 15_000,
  });
}
