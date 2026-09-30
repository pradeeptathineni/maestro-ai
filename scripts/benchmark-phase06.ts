import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { initializeWorker } from '../apps/worker/src/initialize.js';
import {
  createExplorerSession,
  createPool,
  getExplorerResultPage,
  listResearchCorpus,
  migrate,
} from '../packages/db/src/index.js';
import { importSeed, localWorkspaceId } from '../packages/seed/src/import.js';
import {
  ensureTestDatabase,
  resetTestSchemas,
  testDatabaseUrl,
} from '../packages/test-fixtures/src/database.js';
import { emitJsonReport } from './write-json-report.js';

const syntheticCount = 10_000;

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.ceil(ordered.length * fraction) - 1]!.toFixed(2));
}

async function insertSyntheticCorpus(pool: ReturnType<typeof createPool>): Promise<void> {
  const valueProfile = JSON.stringify([
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO catalog.providers
         (id, kind, canonical_name, description, lifecycle_state, visibility, revision)
       SELECT ('81000000' || substr(md5('phase06-perf-provider:' || n::text), 9))::uuid,
              'synthetic_fixture', 'Synthetic context candidate ' || lpad(n::text, 5, '0'),
              'Synthetic metadata row for local query performance only.',
              'unknown', 'global', 1
       FROM generate_series(1, $1) AS fixture(n)`,
      [syntheticCount],
    );
    await client.query(
      `INSERT INTO catalog.provider_display_revisions
         (id, provider_id, revision, kind, canonical_name, description, lifecycle_state,
          capture_state, display_hash, effective_at)
       SELECT ('82000000' || substr(md5('phase06-perf-display:' || n::text), 9))::uuid,
              ('81000000' || substr(md5('phase06-perf-provider:' || n::text), 9))::uuid,
              1, 'synthetic_fixture',
              'Synthetic context candidate ' || lpad(n::text, 5, '0'),
              'Synthetic metadata row for local query performance only.',
              'unknown', 'observed',
              md5('phase06-perf-display:' || n::text) || md5('phase06-perf-display-2:' || n::text),
              now()
       FROM generate_series(1, $1) AS fixture(n)`,
      [syntheticCount],
    );
    await client.query(
      `INSERT INTO catalog.knowledge_projections
         (id, provider_id, provider_revision, projection_version, publication_state,
          kind_profile, preferred_label, summary, search_text, aliases, capability_keys,
          value_profile, projection_hash, indexed_at)
       SELECT ('83000000' || substr(md5('phase06-perf-projection:' || n::text), 9))::uuid,
              ('81000000' || substr(md5('phase06-perf-provider:' || n::text), 9))::uuid,
              1, 'synthetic-performance-v1', 'proposed', 'synthetic_fixture',
              'Synthetic context candidate ' || lpad(n::text, 5, '0'),
              'Synthetic metadata row for local query performance only.',
              'ai context repository synthetic performance candidate ' || n::text,
              ARRAY['synthetic-' || n::text], ARRAY['synthetic-context-fixture'],
              $2::jsonb,
              md5('phase06-perf-projection:' || n::text) || md5('phase06-perf-projection-2:' || n::text),
              now()
       FROM generate_series(1, $1) AS fixture(n)`,
      [syntheticCount, valueProfile],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const databaseUrl = testDatabaseUrl();
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Discovery benchmark only resets a dedicated database ending in _test.');
  }
  await ensureTestDatabase();
  await resetTestSchemas();
  await migrate(databaseUrl);
  await initializeWorker(databaseUrl);
  await importSeed(databaseUrl);
  const pool = createPool(databaseUrl);
  try {
    const realKnowledgeCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM catalog.knowledge_projections',
    );
    await insertSyntheticCorpus(pool);
    const latencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const session = (await createExplorerSession(pool, localWorkspaceId, {
        query: 'ai context repository synthetic performance',
      })) as {
        resultSetId: string;
        counts: { assessed: number; available: number; truncated: number };
      };
      await getExplorerResultPage(pool, localWorkspaceId, session.resultSetId, {
        limit: 50,
        sort: 'signal',
      });
      latencies.push(performance.now() - started);
    }
    const corpusLatencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await listResearchCorpus(pool, localWorkspaceId, {
        query: 'ai context repository synthetic performance',
        limit: 12,
      });
      corpusLatencies.push(performance.now() - started);
    }
    const plan = await pool.query<{ 'QUERY PLAN': Array<Record<string, unknown>> }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT kp.id, kp.provider_id, pdr.id
      FROM catalog.knowledge_projections kp
      JOIN catalog.provider_display_revisions pdr
        ON pdr.provider_id = kp.provider_id AND pdr.revision = kp.provider_revision
      WHERE kp.publication_state <> 'withdrawn'
        AND (kp.expires_at IS NULL OR kp.expires_at > now())
      ORDER BY kp.preferred_label, kp.id
    `);
    const sizes = await pool.query<{ databaseBytes: string; projectionBytes: string }>(`
      SELECT pg_database_size(current_database())::text AS "databaseBytes",
             pg_total_relation_size('catalog.knowledge_projections')::text AS "projectionBytes"
    `);
    const postgresql = await pool.query<{ version: string }>('SELECT version()');
    const report = {
      benchmarkId: 'phase07-search-and-corpus-10k-v1',
      executedAt: new Date().toISOString(),
      dataset: {
        syntheticRecords: syntheticCount,
        realKnowledgeRecords: Number(realKnowledgeCount.rows[0]!.count),
        statement:
          'Synthetic rows measure local query mechanics only and are not evidence or knowledge-quality data.',
      },
      environment: {
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model ?? 'unavailable',
        logicalCpus: os.cpus().length,
        memoryBytes: os.totalmem(),
        node: process.version,
        postgresql: postgresql.rows[0]!.version,
      },
      path: 'create immutable cached query snapshot and serialize first 50 results',
      samples: latencies.length,
      coldMs: Number(latencies[0]!.toFixed(2)),
      warmMs: {
        p50: percentile(latencies.slice(1), 0.5),
        p95: percentile(latencies.slice(1), 0.95),
        min: Number(Math.min(...latencies.slice(1)).toFixed(2)),
        max: Number(Math.max(...latencies.slice(1)).toFixed(2)),
      },
      corpusSearch: {
        path: 'score and serialize the first 12 matches from the combined local research corpus',
        samples: corpusLatencies.length,
        coldMs: Number(corpusLatencies[0]!.toFixed(2)),
        warmMs: {
          p50: percentile(corpusLatencies.slice(1), 0.5),
          p95: percentile(corpusLatencies.slice(1), 0.95),
          min: Number(Math.min(...corpusLatencies.slice(1)).toFixed(2)),
          max: Number(Math.max(...corpusLatencies.slice(1)).toFixed(2)),
        },
      },
      target: {
        warmP95Ms: 500,
        snapshotPassed: percentile(latencies.slice(1), 0.95) <= 500,
        corpusPassed: percentile(corpusLatencies.slice(1), 0.95) <= 500,
        passed:
          percentile(latencies.slice(1), 0.95) <= 500 &&
          percentile(corpusLatencies.slice(1), 0.95) <= 500,
      },
      storage: {
        databaseBytes: Number(sizes.rows[0]!.databaseBytes),
        projectionRelationBytes: Number(sizes.rows[0]!.projectionBytes),
      },
      queryPlan: plan.rows[0]!['QUERY PLAN'][0],
      modelCalls: 0,
      networkCalls: 0,
    };
    await emitJsonReport(report, 'MAESTRO_BENCHMARK_REPORT_PATH');
    if (!report.target.passed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
