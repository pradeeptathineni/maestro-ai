import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { interpretQuery } from '../packages/domain/src/index.js';
import {
  createExplorerSession,
  createPool,
  getExplorerResultPage,
  listResearchCorpus,
  loadQueryKnowledge,
} from '../packages/db/src/index.js';
import { localWorkspaceId } from '../packages/seed/src/import.js';
import { testDatabaseUrl } from '../packages/test-fixtures/src/database.js';
import {
  benchmarkEnvironment,
  ensureDedicatedBenchmarkDatabase,
  latencySummary,
  rebuildBenchmarkDatabase,
  syntheticBenchmarkValueProfile,
} from './benchmark-utils.js';
import { emitJsonReport } from './write-json-report.js';

const syntheticCount = 25_000;
const samples = 15;
const query = 'distributed tracing telemetry sampling storage';
const snapshotWarmP95TargetMs = 1_500;
const corpusWarmP95TargetMs = 750;

async function insertSyntheticCorpus(pool: ReturnType<typeof createPool>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    await client.query(
      `INSERT INTO catalog.providers
         (id, kind, canonical_name, description, lifecycle_state, visibility, revision)
       SELECT ('91000000' || substr(md5('phase08-perf-provider:' || n::text), 9))::uuid,
              'synthetic_fixture', 'Synthetic tracing candidate ' || lpad(n::text, 5, '0'),
              'Synthetic metadata row for local query performance only.',
              'unknown', 'global', 1
       FROM generate_series(1, $1) AS fixture(n)`,
      [syntheticCount],
    );
    await client.query(
      `INSERT INTO catalog.provider_display_revisions
         (id, provider_id, revision, kind, canonical_name, description, lifecycle_state,
          capture_state, display_hash, effective_at)
       SELECT ('92000000' || substr(md5('phase08-perf-display:' || n::text), 9))::uuid,
              ('91000000' || substr(md5('phase08-perf-provider:' || n::text), 9))::uuid,
              1, 'synthetic_fixture',
              'Synthetic tracing candidate ' || lpad(n::text, 5, '0'),
              'Synthetic metadata row for local query performance only.',
              'unknown', 'observed',
              md5('phase08-perf-display:' || n::text) || md5('phase08-perf-display-2:' || n::text),
              now()
       FROM generate_series(1, $1) AS fixture(n)`,
      [syntheticCount],
    );
    await client.query(
      `INSERT INTO catalog.knowledge_projections
         (id, provider_id, provider_revision, projection_version, publication_state,
          kind_profile, preferred_label, summary, search_text, aliases, capability_keys,
          value_profile, projection_hash, indexed_at)
       SELECT ('93000000' || substr(md5('phase08-perf-projection:' || n::text), 9))::uuid,
              ('91000000' || substr(md5('phase08-perf-provider:' || n::text), 9))::uuid,
              1, 'synthetic-performance-v1', 'proposed', 'synthetic_fixture',
              'Synthetic tracing candidate ' || lpad(n::text, 5, '0'),
              'Synthetic metadata row for local query performance only.',
              'distributed tracing telemetry sampling storage performance candidate ' || n::text,
              ARRAY['synthetic-tracing-' || n::text], ARRAY['synthetic-telemetry-fixture'],
              $2::jsonb,
              md5('phase08-perf-projection:' || n::text) || md5('phase08-perf-projection-2:' || n::text),
              now()
       FROM generate_series(1, $1) AS fixture(n)`,
      [syntheticCount, syntheticBenchmarkValueProfile],
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
  const reuseFixture = process.env.MAESTRO_BENCHMARK_REUSE_FIXTURE === 'true';
  await ensureDedicatedBenchmarkDatabase(databaseUrl);
  if (!reuseFixture) {
    await rebuildBenchmarkDatabase(databaseUrl);
  }
  const pool = createPool(databaseUrl);
  try {
    const knowledgeCounts = await pool.query<{ real: number; synthetic: number }>(
      `SELECT
         count(*) FILTER (WHERE projection_version <> 'synthetic-performance-v1')::int AS real,
         count(*) FILTER (WHERE projection_version = 'synthetic-performance-v1')::int AS synthetic
       FROM catalog.knowledge_projections`,
    );
    if (reuseFixture) {
      if (knowledgeCounts.rows[0]!.synthetic !== syntheticCount) {
        throw new Error('Reusable Phase 08 benchmark fixture is absent or incomplete.');
      }
    } else {
      await insertSyntheticCorpus(pool);
    }
    await pool.query('ANALYZE');

    const exactFixtureQuery = `Synthetic tracing candidate ${syntheticCount}`;
    const exactKnowledge = await loadQueryKnowledge(pool, exactFixtureQuery);
    const exactInterpretation = interpretQuery(exactFixtureQuery, {}, exactKnowledge);
    assert.ok((exactKnowledge.availableEntityCount ?? 0) >= syntheticCount);
    assert.equal(exactInterpretation.exactEntities[0]?.preferredLabel, exactFixtureQuery);

    const snapshotLatencies: number[] = [];
    let lastResultSetId = '';
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      const session = (await createExplorerSession(pool, localWorkspaceId, { query })) as {
        resultSetId: string;
      };
      lastResultSetId = session.resultSetId;
      await getExplorerResultPage(pool, localWorkspaceId, session.resultSetId, {
        limit: 50,
        sort: 'match',
      });
      snapshotLatencies.push(performance.now() - started);
    }

    const corpusLatencies: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      await listResearchCorpus(pool, localWorkspaceId, { query, limit: 12 });
      corpusLatencies.push(performance.now() - started);
    }

    const retrievalCandidatePlan = await pool.query<{
      'QUERY PLAN': Array<Record<string, unknown>>;
    }>(
      `
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      WITH lexical_projection_ids AS (
        SELECT kp.id
        FROM catalog.knowledge_projections kp
        WHERE kp.publication_state <> 'withdrawn'
          AND (kp.expires_at IS NULL OR kp.expires_at > now())
          AND (
            kp.aliases && $2::text[]
            OR kp.capability_keys && $2::text[]
            OR to_tsvector(
                 'simple'::regconfig,
                 kp.preferred_label || ' ' || kp.summary || ' ' || kp.search_text
               ) @@ to_tsquery('simple'::regconfig, $1)
          )
        ORDER BY kp.id
        LIMIT 300
      ), selected_projections AS (
        SELECT kp.id,
               ts_rank_cd(
                 to_tsvector(
                   'simple'::regconfig,
                   kp.preferred_label || ' ' || kp.summary || ' ' || kp.search_text
                 ),
                 to_tsquery('simple'::regconfig, $1)
               ) AS lexical_rank
        FROM lexical_projection_ids candidate
        JOIN catalog.knowledge_projections kp ON kp.id = candidate.id
        ORDER BY lexical_rank DESC, kp.preferred_label, kp.provider_id
        LIMIT 100
      )
      SELECT kp.provider_id, entity.id, latest_revision.entity_class_concept_id,
             COALESCE(facets.concept_count, 0)
      FROM selected_projections selected
      JOIN catalog.knowledge_projections kp ON kp.id = selected.id
      JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
      LEFT JOIN LATERAL (
        SELECT revision.entity_class_concept_id
        FROM catalog.knowledge_entity_revisions revision
        WHERE revision.entity_id = entity.id
        ORDER BY revision.revision DESC, revision.id DESC LIMIT 1
      ) latest_revision ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS concept_count
        FROM catalog.entity_facet_assignments assignment
        WHERE assignment.entity_id = entity.id AND assignment.valid_to IS NULL
      ) facets ON true
      ORDER BY selected.lexical_rank DESC, kp.preferred_label, kp.provider_id
    `,
      [
        'distributed:* | tracing:* | telemetry:* | sampling:* | storage:*',
        ['distributed', 'tracing', 'telemetry', 'sampling', 'storage'],
      ],
    );
    const resultPagePlan = await pool.query<{ 'QUERY PLAN': Array<Record<string, unknown>> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT item.id, fusion.match_score, item.position
       FROM workspace.query_result_items item
       JOIN workspace.query_candidate_fusions fusion
         ON fusion.result_set_id = item.result_set_id
        AND fusion.provider_id = item.provider_id
       WHERE item.result_set_id = $1 AND item.workspace_id = $2
       ORDER BY fusion.match_score DESC, item.position, item.id LIMIT 50`,
      [lastResultSetId, localWorkspaceId],
    );
    const sizes = await pool.query<{
      databaseBytes: string;
      projectionBytes: string;
      entityRevisionBytes: string;
      resultItemBytes: string;
    }>(`
      SELECT pg_database_size(current_database())::text AS "databaseBytes",
             pg_total_relation_size('catalog.knowledge_projections')::text AS "projectionBytes",
             pg_total_relation_size('catalog.knowledge_entity_revisions')::text AS "entityRevisionBytes",
             pg_total_relation_size('workspace.query_result_items')::text AS "resultItemBytes"
    `);
    const counts = await pool.query<{
      projections: number;
      entities: number;
      revisions: number;
      resultItems: number;
      retrievalHits: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM catalog.knowledge_projections) AS projections,
        (SELECT count(*)::int FROM catalog.knowledge_entities) AS entities,
        (SELECT count(*)::int FROM catalog.knowledge_entity_revisions) AS revisions,
        (SELECT count(*)::int FROM workspace.query_result_items) AS "resultItems",
        (SELECT count(*)::int FROM workspace.query_retrieval_hits) AS "retrievalHits"
    `);
    const postgresql = await pool.query<{ version: string }>('SELECT version()');
    const snapshotWarm = latencySummary(snapshotLatencies.slice(1));
    const corpusWarm = latencySummary(corpusLatencies.slice(1));
    const report = {
      benchmarkId: 'phase08-discovery-and-corpus-25k-v2',
      executedAt: new Date().toISOString(),
      dataset: {
        syntheticRecords: syntheticCount,
        realKnowledgeRecords: knowledgeCounts.rows[0]!.real,
        fixtureReused: reuseFixture,
        statement:
          'Synthetic rows measure local query mechanics only and are not evidence or knowledge-quality data.',
      },
      environment: benchmarkEnvironment(postgresql.rows[0]!.version),
      snapshotSearch: {
        path: 'plan, retrieve, fuse, rerank, persist immutable lineage, and serialize 50 matches',
        samples: snapshotLatencies.length,
        coldMs: Number(snapshotLatencies[0]!.toFixed(2)),
        warmMs: snapshotWarm,
      },
      corpusSearch: {
        path: 'score and serialize 12 matches from the combined local research corpus',
        samples: corpusLatencies.length,
        coldMs: Number(corpusLatencies[0]!.toFixed(2)),
        warmMs: corpusWarm,
      },
      target: {
        snapshotWarmP95Ms: snapshotWarmP95TargetMs,
        corpusWarmP95Ms: corpusWarmP95TargetMs,
        snapshotPassed: snapshotWarm.p95 <= snapshotWarmP95TargetMs,
        corpusPassed: corpusWarm.p95 <= corpusWarmP95TargetMs,
        passed:
          snapshotWarm.p95 <= snapshotWarmP95TargetMs && corpusWarm.p95 <= corpusWarmP95TargetMs,
      },
      functionalAssertions: {
        exactIdentityOutsideInitialCandidateWindow: {
          query: exactFixtureQuery,
          preferredLabel: exactInterpretation.exactEntities[0]?.preferredLabel,
          matchMethod: exactInterpretation.exactEntities[0]?.matchMethod,
          availableEntityCount: exactKnowledge.availableEntityCount,
          passed: true,
        },
      },
      counts: counts.rows[0],
      storage: Object.fromEntries(
        Object.entries(sizes.rows[0]!).map(([key, value]) => [key, Number(value)]),
      ),
      queryPlans: {
        retrievalCandidateSelection: retrievalCandidatePlan.rows[0]!['QUERY PLAN'][0],
        resultPage: resultPagePlan.rows[0]!['QUERY PLAN'][0],
      },
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
