import os from 'node:os';
import { initializeWorker } from '../apps/worker/src/initialize.js';
import { migrate } from '../packages/db/src/index.js';
import { importSeed } from '../packages/seed/src/import.js';
import { ensureTestDatabase, resetTestSchemas } from '../packages/test-fixtures/src/database.js';

export const syntheticBenchmarkValueProfile = JSON.stringify([
  {
    key: 'reuse_leverage',
    raw: 50,
    confidence: 0.35,
    coverage: 1,
    applicability: 'applicable',
    state: 'present',
    reasons: ['Synthetic performance fixture; not knowledge evidence.'],
    missing: [],
    evidenceIds: [],
  },
  {
    key: 'adoption_ease',
    raw: null,
    confidence: 0,
    coverage: 0,
    applicability: 'applicable',
    state: 'missing',
    reasons: [],
    missing: ['Synthetic fixture.'],
    evidenceIds: [],
  },
  {
    key: 'maturity',
    raw: null,
    confidence: 0,
    coverage: 0,
    applicability: 'applicable',
    state: 'missing',
    reasons: [],
    missing: ['Synthetic fixture.'],
    evidenceIds: [],
  },
  {
    key: 'provenance_clarity',
    raw: 50,
    confidence: 0.35,
    coverage: 1,
    applicability: 'applicable',
    state: 'present',
    reasons: ['Synthetic performance fixture; not knowledge evidence.'],
    missing: [],
    evidenceIds: [],
  },
]);

export function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.ceil(ordered.length * fraction) - 1]!.toFixed(2));
}

export function latencySummary(values: number[]): {
  p50: number;
  p95: number;
  min: number;
  max: number;
} {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Number(Math.min(...values).toFixed(2)),
    max: Number(Math.max(...values).toFixed(2)),
  };
}

export async function ensureDedicatedBenchmarkDatabase(databaseUrl: string): Promise<void> {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Discovery benchmark only resets a dedicated database ending in _test.');
  }
  await ensureTestDatabase();
}

export async function rebuildBenchmarkDatabase(databaseUrl: string): Promise<void> {
  await resetTestSchemas();
  await migrate(databaseUrl);
  await initializeWorker(databaseUrl);
  await importSeed(databaseUrl);
}

export function benchmarkEnvironment(postgresql: string): {
  platform: string;
  cpu: string;
  logicalCpus: number;
  memoryBytes: number;
  node: string;
  postgresql: string;
} {
  return {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unavailable',
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    node: process.version,
    postgresql,
  };
}
