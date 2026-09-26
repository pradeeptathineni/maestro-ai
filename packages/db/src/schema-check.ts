import { fileURLToPath } from 'node:url';
import { getTableColumns, is, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import * as definitions from './schema.js';
import { createPool } from './client.js';

export interface SchemaCheckResult {
  checkedTables: number;
  errors: string[];
}

export async function checkSchemaDefinitions(pool: Pool): Promise<SchemaCheckResult> {
  const declared = new Map<string, Set<string>>();
  for (const value of Object.values(definitions)) {
    if (!is(value, Table)) continue;
    const table = value as AnyPgTable;
    const config = getTableConfig(table);
    const key = `${config.schema ?? 'public'}.${config.name}`;
    const columnNames = Object.values(getTableColumns(table)).map((column) => column.name);
    declared.set(key, new Set<string>(columnNames));
  }

  const physical = await pool.query<{
    schemaName: string;
    tableName: string;
    columnName: string;
  }>(`
    SELECT table_schema AS "schemaName", table_name AS "tableName",
           column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema IN ('catalog', 'workspace', 'ops')
    ORDER BY table_schema, table_name, ordinal_position
  `);
  const actual = new Map<string, Set<string>>();
  for (const row of physical.rows) {
    const key = `${row.schemaName}.${row.tableName}`;
    const columns = actual.get(key) ?? new Set<string>();
    columns.add(row.columnName);
    actual.set(key, columns);
  }

  const errors: string[] = [];
  for (const [table, columns] of declared) {
    const actualColumns = actual.get(table);
    if (!actualColumns) {
      errors.push(`Declared table ${table} is missing from PostgreSQL.`);
      continue;
    }
    for (const column of columns) {
      if (!actualColumns.has(column)) errors.push(`Declared column ${table}.${column} is missing.`);
    }
    for (const column of actualColumns) {
      if (!columns.has(column)) errors.push(`PostgreSQL column ${table}.${column} is undeclared.`);
    }
  }
  const migrationOnly = new Set(['ops.schema_migrations']);
  for (const table of actual.keys()) {
    if (!declared.has(table) && !migrationOnly.has(table)) {
      errors.push(`PostgreSQL table ${table} has no Drizzle declaration.`);
    }
  }
  return { checkedTables: declared.size, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try {
    const result = await checkSchemaDefinitions(pool);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.errors.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
