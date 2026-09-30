import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { initializeWorker } from '../apps/worker/src/initialize.js';
import {
  createExplorerSession,
  createPool,
  getExplorerResultPage,
  migrate,
} from '../packages/db/src/index.js';
import { hashCanonical } from '../packages/domain/src/index.js';
import { calculateQuerySignalV1, type QueryValueInput } from '../packages/scoring/src/index.js';
import {
  phase06QueryEvaluationV1,
  type Phase06EvaluationQuery,
} from '../packages/seed/src/phase06-evaluation.js';
import { importSeed, localWorkspaceId } from '../packages/seed/src/import.js';
import {
  ensureTestDatabase,
  resetTestSchemas,
  testDatabaseUrl,
} from '../packages/test-fixtures/src/database.js';
import { emitJsonReport } from './write-json-report.js';

type BaselineKey = 'phase06PolicyReplay' | 'relevanceFirst' | 'evidenceAwareExpansion';

interface PageItem {
  id: string;
  name: string;
  kind: string;
  subjectType: 'implementation' | 'document';
  relevanceOrdinal: 'incidental' | 'complementary' | 'partial' | 'direct';
  relevanceValue: number;
  evidenceCoverage: number;
  signalDisplay: number | null;
}

interface ResultPage {
  items: PageItem[];
}

interface SessionResult {
  id: string;
  resultSetId: string;
  interpretation: { coverageState: Phase06EvaluationQuery['expectedCoverage'] };
}

interface ReplayRow {
  id: string;
  name: string;
  kind: string;
  subjectType: 'implementation' | 'document';
  relevanceOrdinal: 'incidental' | 'complementary' | 'partial' | 'direct';
  relevanceValue: number;
  relevanceMethod: 'rule' | 'human' | 'model_proposal';
  valueInputs: QueryValueInput[];
}

interface Ranking {
  names: string[];
  kinds: string[];
  subjectTypes: Array<'implementation' | 'document'>;
}

interface RankingJudgment {
  recallAt20: number | null;
  anyAcceptableAt20: boolean | null;
  prohibitedFoundAt20: string[];
  exactNameRetainedAt20: boolean | null;
  judgedRelevantAt5: number;
  judgedProhibitedAt5: number;
  unjudgedAt5: number;
  judgedPrecisionAt5: number | null;
}

interface QueryMeasurement {
  id: string;
  split: Phase06EvaluationQuery['split'];
  query: string;
  resultSetId: string;
  expectedCoverage: Phase06EvaluationQuery['expectedCoverage'];
  actualCoverage: Phase06EvaluationQuery['expectedCoverage'];
  coverageCorrect: boolean;
  candidatePoolCount: number;
  candidatePoolHash: string;
  elapsedMs: number;
  rankings: Record<BaselineKey, Ranking & RankingJudgment>;
}

const broadAnchors = [
  {
    query: 'ai',
    anchors: [
      'OpenAI',
      'GPT model family',
      'Claude model family',
      'Gemini model family',
      'Llama model family',
    ],
  },
  {
    query: 'ai models',
    anchors: [
      'GPT model family',
      'Claude model family',
      'Gemini model family',
      'Llama model family',
    ],
  },
  {
    query: 'devops',
    anchors: ['Kubernetes', 'Docker', 'Helm', 'Prometheus', 'OpenTelemetry'],
  },
  {
    query: 'ml',
    anchors: ['PyTorch', 'TensorFlow', 'scikit-learn', 'MLflow', 'Supervised learning'],
  },
  {
    query: 'cs',
    anchors: ['Rust', 'TypeScript', 'Algorithms', 'Distributed systems', 'Database systems'],
  },
  {
    query: 'AI context reduction',
    anchors: [
      'Context Mode',
      'Repomix',
      'Aider Repository Map',
      'Context Pack',
      'LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models',
    ],
  },
] as const;

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function average(values: number[]): number | null {
  return values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
    : null;
}

function judge(names: string[], item: Phase06EvaluationQuery): RankingJudgment {
  const top20 = names.slice(0, 20);
  const top5 = names.slice(0, 5);
  const acceptable = new Set(item.acceptableCandidates);
  const prohibited = new Set(item.prohibitedCandidates);
  const acceptableFound = item.acceptableCandidates.filter((name) => top20.includes(name));
  const prohibitedFound = item.prohibitedCandidates.filter((name) => top20.includes(name));
  const judgedRelevantAt5 = top5.filter((name) => acceptable.has(name)).length;
  const judgedProhibitedAt5 = top5.filter((name) => prohibited.has(name)).length;
  const judgedAt5 = judgedRelevantAt5 + judgedProhibitedAt5;
  return {
    recallAt20: item.acceptableCandidates.length
      ? ratio(acceptableFound.length, item.acceptableCandidates.length)
      : null,
    anyAcceptableAt20: item.acceptableCandidates.length ? acceptableFound.length > 0 : null,
    prohibitedFoundAt20: prohibitedFound,
    exactNameRetainedAt20: item.exactNameCandidate ? top20.includes(item.exactNameCandidate) : null,
    judgedRelevantAt5,
    judgedProhibitedAt5,
    unjudgedAt5: top5.length - judgedAt5,
    judgedPrecisionAt5: judgedAt5 ? ratio(judgedRelevantAt5, judgedAt5) : null,
  };
}

function summarize(measurements: QueryMeasurement[], baseline: BaselineKey) {
  const rankings = measurements.map((measurement) => measurement.rankings[baseline]);
  const recalls = rankings
    .map((ranking) => ranking.recallAt20)
    .filter((value): value is number => value !== null);
  const hitQueries = rankings.filter((ranking) => ranking.anyAcceptableAt20 !== null);
  const exact = rankings.filter((ranking) => ranking.exactNameRetainedAt20 !== null);
  const precision = rankings
    .map((ranking) => ranking.judgedPrecisionAt5)
    .filter((value): value is number => value !== null);
  return {
    queries: measurements.length,
    meanKnownRelevantRecallAt20: average(recalls),
    queryHitRateAt20: ratio(
      hitQueries.filter((ranking) => ranking.anyAcceptableAt20).length,
      hitQueries.length,
    ),
    meanJudgedPrecisionAt5: average(precision),
    judgedTop5Positions: rankings.reduce(
      (sum, ranking) => sum + ranking.judgedRelevantAt5 + ranking.judgedProhibitedAt5,
      0,
    ),
    unjudgedTop5Positions: rankings.reduce((sum, ranking) => sum + ranking.unjudgedAt5, 0),
    exactNameRetentionAt20: ratio(
      exact.filter((ranking) => ranking.exactNameRetainedAt20).length,
      exact.length,
    ),
    prohibitedHitsAt20: rankings.reduce(
      (sum, ranking) => sum + ranking.prohibitedFoundAt20.length,
      0,
    ),
  };
}

async function replayRows(pool: Pool, resultSetId: string): Promise<ReplayRow[]> {
  const result = await pool.query<ReplayRow>(
    `SELECT qri.id, p.canonical_name AS name, p.kind, 'implementation'::text AS "subjectType",
            qsr.relevance_ordinal AS "relevanceOrdinal",
            qsr.relevance_value AS "relevanceValue", qsr.relevance_method AS "relevanceMethod",
            qsr.value_inputs AS "valueInputs"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_runs qsr ON qsr.id = qri.query_signal_run_id
     JOIN catalog.providers p ON p.id = qri.provider_id
     WHERE qri.result_set_id = $1
     UNION ALL
     SELECT qdr.id, kd.title AS name, kd.document_kind AS kind,
            'document'::text AS "subjectType", qdr.relevance_ordinal AS "relevanceOrdinal",
            qdr.relevance_value AS "relevanceValue", 'rule'::text AS "relevanceMethod",
            qdr.value_inputs AS "valueInputs"
     FROM workspace.query_document_results qdr
     JOIN catalog.knowledge_documents kd ON kd.id = qdr.document_id
     WHERE qdr.result_set_id = $1`,
    [resultSetId],
  );
  return result.rows;
}

function replayPhase06(rows: ReplayRow[]): Ranking {
  const ordered = rows
    .map((row) => ({
      ...row,
      replaySignal: calculateQuerySignalV1({
        relevanceOrdinal: row.relevanceOrdinal,
        relevanceMethod: row.relevanceMethod,
        dimensions: row.valueInputs,
      }).signalUnrounded,
    }))
    .sort(
      (left, right) =>
        right.replaySignal - left.replaySignal ||
        right.relevanceValue - left.relevanceValue ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  return {
    names: ordered.map((row) => row.name),
    kinds: ordered.map((row) => row.kind),
    subjectTypes: ordered.map((row) => row.subjectType),
  };
}

function fromPage(page: ResultPage): Ranking {
  return {
    names: page.items.map((item) => item.name),
    kinds: page.items.map((item) => item.kind),
    subjectTypes: page.items.map((item) => item.subjectType),
  };
}

async function getRankings(pool: Pool, query: string) {
  const started = performance.now();
  const session = (await createExplorerSession(pool, localWorkspaceId, {
    query,
  })) as SessionResult;
  const [relevancePage, recommendedPage, rows] = await Promise.all([
    getExplorerResultPage(pool, localWorkspaceId, session.resultSetId, {
      limit: 50,
      sort: 'relevance',
    }) as Promise<ResultPage>,
    getExplorerResultPage(pool, localWorkspaceId, session.resultSetId, {
      limit: 50,
      sort: 'recommended',
    }) as Promise<ResultPage>,
    replayRows(pool, session.resultSetId),
  ]);
  const poolIdentity = rows
    .map((row) => ({ id: row.id, kind: row.kind, name: row.name, subjectType: row.subjectType }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    session,
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    candidatePoolCount: rows.length,
    candidatePoolHash: hashCanonical(poolIdentity),
    rankings: {
      phase06PolicyReplay: replayPhase06(rows),
      relevanceFirst: fromPage(relevancePage),
      evidenceAwareExpansion: fromPage(recommendedPage),
    } satisfies Record<BaselineKey, Ranking>,
  };
}

function kindDistribution(measurements: QueryMeasurement[], baseline: BaselineKey) {
  const counts = new Map<string, number>();
  for (const measurement of measurements) {
    for (const kind of measurement.rankings[baseline].kinds.slice(0, 10)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}

async function main(): Promise<void> {
  const databaseUrl = testDatabaseUrl();
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Phase 07 evaluation only resets a dedicated database ending in _test.');
  }
  await ensureTestDatabase();
  await resetTestSchemas();
  await migrate(databaseUrl);
  await initializeWorker(databaseUrl);
  await importSeed(databaseUrl);
  await importSeed(databaseUrl);
  const pool = createPool(databaseUrl);
  try {
    const measurements: QueryMeasurement[] = [];
    for (const item of phase06QueryEvaluationV1) {
      const result = await getRankings(pool, item.query);
      const judged = Object.fromEntries(
        Object.entries(result.rankings).map(([key, ranking]) => [
          key,
          { ...ranking, ...judge(ranking.names, item) },
        ]),
      ) as QueryMeasurement['rankings'];
      measurements.push({
        id: item.id,
        split: item.split,
        query: item.query,
        resultSetId: result.session.resultSetId,
        expectedCoverage: item.expectedCoverage,
        actualCoverage: result.session.interpretation.coverageState,
        coverageCorrect: result.session.interpretation.coverageState === item.expectedCoverage,
        candidatePoolCount: result.candidatePoolCount,
        candidatePoolHash: result.candidatePoolHash,
        elapsedMs: result.elapsedMs,
        rankings: judged,
      });
    }

    const anchorMeasurements = [];
    for (const anchor of broadAnchors) {
      const result = await getRankings(pool, anchor.query);
      anchorMeasurements.push({
        query: anchor.query,
        anchors: anchor.anchors,
        candidatePoolCount: result.candidatePoolCount,
        candidatePoolHash: result.candidatePoolHash,
        baselines: Object.fromEntries(
          Object.entries(result.rankings).map(([key, ranking]) => {
            const found = anchor.anchors.filter((name) =>
              ranking.names.slice(0, 20).includes(name),
            );
            return [
              key,
              {
                recallAt20: ratio(found.length, anchor.anchors.length),
                found,
                top20: ranking.names.slice(0, 20),
                kindsAt10: [...new Set(ranking.kinds.slice(0, 10))],
                subjectTypesAt10: [...new Set(ranking.subjectTypes.slice(0, 10))],
              },
            ];
          }),
        ),
      });
    }

    const corpus = await pool.query<{
      providers: number;
      documents: number;
      reviewed: number;
      proposed: number;
    }>(`SELECT
      (SELECT count(*)::int FROM catalog.providers) AS providers,
      (SELECT count(*)::int FROM catalog.knowledge_documents) AS documents,
      (SELECT count(*)::int FROM catalog.knowledge_projections
       WHERE publication_state = 'reviewed') AS reviewed,
      (SELECT count(*)::int FROM catalog.knowledge_projections
       WHERE publication_state = 'proposed') AS proposed`);
    const version = await pool.query<{ version: string }>('SELECT version()');
    const baselineKeys: BaselineKey[] = [
      'phase06PolicyReplay',
      'relevanceFirst',
      'evidenceAwareExpansion',
    ];
    const report = {
      evaluationId: 'phase07-retrieval-evaluation-v1',
      executedAt: new Date().toISOString(),
      labelScope: {
        inherited50:
          'Phase 06 agent-proxy acceptable/prohibited sets frozen before Phase 07; not human relevance ground truth.',
        broadAnchors:
          'Six prompt-mandated confirmation queries with builder-selected source-backed anchors; post-implementation and not a holdout.',
        unjudged:
          'All positions outside explicit acceptable/prohibited sets remain unjudged; no nDCG is claimed.',
      },
      candidatePoolControl:
        'All three policies are replayed over each query result set identified by one candidate-pool hash.',
      configuration: {
        retrieval: 'deterministic-v3 knowledge-backed interpretation + lexical-concept-v4',
        currentSignalPolicy: 'query-signal-v2',
        historicalReplayPolicy: 'query-signal-v1',
        resultCutoff: 20,
        database: version.rows[0]!.version,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        corpus: corpus.rows[0],
        externalCalls: 0,
        modelCalls: 0,
      },
      baselines: Object.fromEntries(
        baselineKeys.map((key) => [
          key,
          {
            overall: summarize(measurements, key),
            development: summarize(
              measurements.filter((item) => item.split === 'development'),
              key,
            ),
            heldOutReuse: summarize(
              measurements.filter((item) => item.split === 'held_out'),
              key,
            ),
            top10KindDistribution: kindDistribution(measurements, key),
          },
        ]),
      ),
      coverageClassificationAccuracy: ratio(
        measurements.filter((measurement) => measurement.coverageCorrect).length,
        measurements.length,
      ),
      broadAnchors: anchorMeasurements,
      semanticMechanism: {
        state: 'not_configured',
        implementedCandidate:
          'Versioned concept and alias resolution, bounded taxonomy-relation expansion, heterogeneous documents, and diversity-aware ranking.',
        limitation:
          'No approved local embedding or reranking endpoint was configured, so semantic-model benefit remains unmeasured.',
      },
      measurements,
    };
    await emitJsonReport(report, 'MAESTRO_PHASE07_EVALUATION_REPORT_PATH');
    const invariantsFailed = measurements.some(
      (measurement) =>
        !measurement.coverageCorrect ||
        measurement.rankings.evidenceAwareExpansion.prohibitedFoundAt20.length > 0 ||
        measurement.rankings.evidenceAwareExpansion.exactNameRetainedAt20 === false,
    );
    if (invariantsFailed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
