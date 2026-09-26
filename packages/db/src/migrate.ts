import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './client.js';

export async function migrate(connectionString?: string): Promise<void> {
  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [730_026]);
    await client.query('CREATE SCHEMA IF NOT EXISTS ops');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ops.schema_migrations (
        filename text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
    const files = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const filename of files) {
      const sql = await readFile(join(migrationDirectory, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM ops.schema_migrations WHERE filename = $1',
        [filename],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`Applied migration ${filename} has changed.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO ops.schema_migrations (filename, sha256) VALUES ($1, $2)', [
          filename,
          sha256,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [730_026]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  process.stdout.write('Migrations are current.\n');
}
