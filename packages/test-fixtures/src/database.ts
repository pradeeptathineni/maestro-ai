import { Pool } from 'pg';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://maestro:maestro@127.0.0.1:54329/maestro_test';
}

export async function ensureTestDatabase(): Promise<void> {
  const target = new URL(testDatabaseUrl());
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL must name a simple dedicated test database.');
  }
  const administrative = new URL(target);
  administrative.pathname = '/postgres';
  const pool = new Pool({ connectionString: administrative.toString() });
  try {
    const existing = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (!existing.rowCount) await pool.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await pool.end();
  }
}

export async function resetTestSchemas(): Promise<void> {
  const pool = new Pool({ connectionString: testDatabaseUrl() });
  try {
    await pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS ops CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS workspace CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS catalog CASCADE');
  } finally {
    await pool.end();
  }
}
