import pg from 'pg';
import { databaseUrl } from './config.js';

const { Pool } = pg;

export function createPool(connectionString = databaseUrl()): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    application_name: 'maestro-ai',
    statement_timeout: 15_000,
    // Maestro issues bounded OLTP-style queries. PostgreSQL's default JIT threshold can be
    // crossed by the faceted UNION/lateral plans even when they return only tens of rows, making
    // compilation substantially slower than execution on a local database.
    options: '-c jit=off',
  });
}
