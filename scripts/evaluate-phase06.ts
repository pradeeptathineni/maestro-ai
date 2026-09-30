import { performance } from 'node:perf_hooks';
import { initializeWorker } from '../apps/worker/src/initialize.js';
import {
  createExplorerSession,
  createPool,
  getExplorerResultPage,
  migrate,
} from '../packages/db/src/index.js';
import { importSeed, localWorkspaceId } from '../packages/seed/src/import.js';
import {
  phase06QueryEvaluationV1,
  type Phase06EvaluationQuery,
} from '../packages/seed/src/phase06-evaluation.js';
import {
  ensureTestDatabase,
  resetTestSchemas,
  testDatabaseUrl,
} from '../packages/test-fixtures/src/database.js';
import { emitJsonReport } from './write-json-report.js';

interface ResultPage {
  items: Array<{
    name: string;
    relevanceOrdinal: string;
    displayState: string;
    signalDisplay: number | null;
  }>;
}

interface SessionResult {
  id: string;
  resultSetId: string;
  interpretation: { coverageState: Phase06EvaluationQuery['expectedCoverage'] };
}

interface QueryMeasurement {
  id: string;
  split: Phase06EvaluationQuery['split'];
  query: string;
  resultSetId: string;
  expectedCoverage: Phase06EvaluationQuery['expectedCoverage'];
  actualCoverage: Phase06EvaluationQuery['expectedCoverage'];
  coverageCorrect: boolean;
  acceptableCount: number;
  acceptableFoundAt20: string[];
  recallAt20: number | null;
  anyAcceptableAt20: boolean | null;
  exactNameCandidate: string | null;
  exactNameRetainedAt20: boolean | null;
  prohibitedFoundAt20: string[];
  judgedRelevantAt5: number;
  judgedProhibitedAt5: number;
  unjudgedAt5: number;
  judgedPrecisionAt5: number | null;
  top20: string[];
  coldMs: number;
  warmMs: number;
}

interface StoredSignal {
  name: string;
  position: number;
  relevanceValue: number;
  signalUnrounded: number;
  dimensions: Array<{
    key: string;
    weight: number;
    adjusted: number | null;
    confidence: number;
    applicability: 'applicable' | 'not_applicable';
  }>;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.ceil(fraction * ordered.length) - 1]!.toFixed(2));
}

function average(values: number[]): number | null {
  return values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
    : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function summarize(measurements: QueryMeasurement[]) {
  const judgedPrecision = measurements
    .map((measurement) => measurement.judgedPrecisionAt5)
    .filter((value): value is number => value !== null);
  const recalls = measurements
    .map((measurement) => measurement.recallAt20)
    .filter((value): value is number => value !== null);
  const queriesWithAcceptable = measurements.filter(
    (measurement) => measurement.anyAcceptableAt20 !== null,
  );
  const exact = measurements.filter((measurement) => measurement.exactNameRetainedAt20 !== null);
  return {
    queries: measurements.length,
    coverageClassificationAccuracy: ratio(
      measurements.filter((measurement) => measurement.coverageCorrect).length,
      measurements.length,
    ),
    meanKnownRelevantRecallAt20: average(recalls),
    queryHitRateAt20: ratio(
      queriesWithAcceptable.filter((measurement) => measurement.anyAcceptableAt20).length,
      queriesWithAcceptable.length,
    ),
    meanJudgedPrecisionAt5: average(judgedPrecision),
    judgedTop5Positions: measurements.reduce(
      (sum, measurement) => sum + measurement.judgedRelevantAt5 + measurement.judgedProhibitedAt5,
      0,
    ),
    unjudgedTop5Positions: measurements.reduce(
      (sum, measurement) => sum + measurement.unjudgedAt5,
      0,
    ),
    exactNameRetentionAt20: ratio(
      exact.filter((measurement) => measurement.exactNameRetainedAt20).length,
      exact.length,
    ),
    prohibitedHitsAt20: measurements.reduce(
      (sum, measurement) => sum + measurement.prohibitedFoundAt20.length,
      0,
    ),
    coldLatencyMs: {
      p50: percentile(
        measurements.map((measurement) => measurement.coldMs),
        0.5,
      ),
      p95: percentile(
        measurements.map((measurement) => measurement.coldMs),
        0.95,
      ),
    },
    warmLatencyMs: {
      p50: percentile(
        measurements.map((measurement) => measurement.warmMs),
        0.5,
      ),
      p95: percentile(
        measurements.map((measurement) => measurement.warmMs),
        0.95,
      ),
    },
    ndcgAt10: null,
    ndcgReason: 'The frozen proxy labels are acceptable sets, not graded relevance judgments.',
  };
}

function perturbedSignal(row: StoredSignal, dimensionKey: string, factor: number): number {
  const applicable = row.dimensions.filter(
    (dimension) => dimension.applicability === 'applicable' && dimension.adjusted !== null,
  );
  const weights = applicable.map((dimension) => ({
    ...dimension,
    variedWeight: dimension.weight * (dimension.key === dimensionKey ? factor : 1),
  }));
  const totalWeight = weights.reduce((sum, dimension) => sum + dimension.variedWeight, 0);
  const central = weights.reduce(
    (sum, dimension) => sum + (dimension.variedWeight / totalWeight) * dimension.adjusted!,
    0,
  );
  const confidence = weights.reduce(
    (sum, dimension) => sum + (dimension.variedWeight / totalWeight) * dimension.confidence,
    0,
  );
  const signal =
    (row.relevanceValue / 100) * Math.max(0, Math.min(100, central - 20 * (1 - confidence)));
  return Math.round((signal + Number.EPSILON) * 1_000_000) / 1_000_000;
}

async function selectionSensitivity(
  pool: ReturnType<typeof createPool>,
  measurements: QueryMeasurement[],
) {
  const dimensions = ['reuse_leverage', 'adoption_ease', 'maturity', 'provenance_clarity'];
  const variants = dimensions.flatMap((dimension) => [
    { id: `${dimension}-minus-20pct`, dimension, factor: 0.8 },
    { id: `${dimension}-plus-20pct`, dimension, factor: 1.2 },
  ]);
  const changes: Array<{
    queryId: string;
    variant: string;
    baselineTop: string;
    perturbedTop: string;
  }> = [];
  let queriesEvaluated = 0;
  for (const measurement of measurements) {
    const result = await pool.query<StoredSignal>(
      `SELECT p.canonical_name AS name, qri.position, qsr.relevance_value AS "relevanceValue",
              qsr.signal_unrounded::float8 AS "signalUnrounded", qsr.value_inputs AS dimensions
       FROM workspace.query_signal_runs qsr
       JOIN workspace.query_result_items qri ON qri.query_signal_run_id = qsr.id
       JOIN catalog.providers p ON p.id = qsr.provider_id
       WHERE qsr.result_set_id = $1
       ORDER BY qri.position`,
      [measurement.resultSetId],
    );
    const baselineTop = result.rows[0]?.name;
    if (!baselineTop) continue;
    queriesEvaluated += 1;
    for (const variant of variants) {
      const perturbed = [...result.rows].sort(
        (left, right) =>
          perturbedSignal(right, variant.dimension, variant.factor) -
            perturbedSignal(left, variant.dimension, variant.factor) ||
          right.relevanceValue - left.relevanceValue ||
          left.name.localeCompare(right.name),
      );
      const perturbedTop = perturbed[0]?.name;
      if (perturbedTop && perturbedTop !== baselineTop) {
        changes.push({
          queryId: measurement.id,
          variant: variant.id,
          baselineTop,
          perturbedTop,
        });
      }
    }
  }
  const proposed = await pool.query<{
    assessedRuns: number;
    numericEstimates: number;
    missingNumericEstimates: number;
    meanEvidenceCoverage: number | null;
    maxInternalSignal: number | null;
  }>(`
    SELECT count(*)::int AS "assessedRuns",
           count(*) FILTER (WHERE qsr.signal_display IS NOT NULL)::int AS "numericEstimates",
           count(*) FILTER (WHERE qsr.signal_display IS NULL)::int AS "missingNumericEstimates",
           avg(qsr.evidence_coverage)::float8 AS "meanEvidenceCoverage",
           max(qsr.signal_unrounded)::float8 AS "maxInternalSignal"
    FROM workspace.query_signal_runs qsr
    JOIN catalog.knowledge_projections kp
      ON kp.provider_id = qsr.provider_id AND kp.provider_revision = qsr.provider_revision
    WHERE kp.publication_state = 'proposed'
  `);
  return {
    policy: 'query-signal-v1',
    perturbation: 'Each dimension weight varied by -20% and +20% relative, then renormalized.',
    queriesEvaluated,
    queriesWithTopChange: new Set(changes.map((change) => change.queryId)).size,
    comparisons: queriesEvaluated * variants.length,
    topResultChanges: changes.length,
    topResultChangeRate: ratio(changes.length, queriesEvaluated * variants.length),
    changes,
    proposedEstimateAudit: proposed.rows[0],
    interpretation:
      'A changed top result identifies fragile ordering for review; it does not establish that either option is better.',
  };
}

async function runQuery(
  pool: ReturnType<typeof createPool>,
  item: Phase06EvaluationQuery,
): Promise<QueryMeasurement> {
  const execute = async () => {
    const started = performance.now();
    const session = (await createExplorerSession(pool, localWorkspaceId, {
      query: item.query,
    })) as SessionResult;
    const page = (await getExplorerResultPage(pool, localWorkspaceId, session.resultSetId, {
      limit: 20,
      sort: 'signal',
    })) as ResultPage;
    return { session, page, elapsedMs: performance.now() - started };
  };
  const cold = await execute();
  const warm = await execute();
  const names = warm.page.items.map((result) => result.name);
  const topFive = names.slice(0, 5);
  const acceptable = new Set(item.acceptableCandidates);
  const prohibited = new Set(item.prohibitedCandidates);
  const acceptableFoundAt20 = item.acceptableCandidates.filter((name) => names.includes(name));
  const prohibitedFoundAt20 = item.prohibitedCandidates.filter((name) => names.includes(name));
  const judgedRelevantAt5 = topFive.filter((name) => acceptable.has(name)).length;
  const judgedProhibitedAt5 = topFive.filter((name) => prohibited.has(name)).length;
  const judgedAt5 = judgedRelevantAt5 + judgedProhibitedAt5;
  return {
    id: item.id,
    split: item.split,
    query: item.query,
    resultSetId: warm.session.resultSetId,
    expectedCoverage: item.expectedCoverage,
    actualCoverage: warm.session.interpretation.coverageState,
    coverageCorrect: warm.session.interpretation.coverageState === item.expectedCoverage,
    acceptableCount: item.acceptableCandidates.length,
    acceptableFoundAt20,
    recallAt20: item.acceptableCandidates.length
      ? ratio(acceptableFoundAt20.length, item.acceptableCandidates.length)
      : null,
    anyAcceptableAt20: item.acceptableCandidates.length ? acceptableFoundAt20.length > 0 : null,
    exactNameCandidate: item.exactNameCandidate ?? null,
    exactNameRetainedAt20: item.exactNameCandidate ? names.includes(item.exactNameCandidate) : null,
    prohibitedFoundAt20,
    judgedRelevantAt5,
    judgedProhibitedAt5,
    unjudgedAt5: topFive.length - judgedAt5,
    judgedPrecisionAt5: judgedAt5 ? ratio(judgedRelevantAt5, judgedAt5) : null,
    top20: names,
    coldMs: Number(cold.elapsedMs.toFixed(2)),
    warmMs: Number(warm.elapsedMs.toFixed(2)),
  };
}

async function main(): Promise<void> {
  const databaseUrl = testDatabaseUrl();
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Phase 06 evaluation only resets a dedicated database ending in _test.');
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
    for (const item of phase06QueryEvaluationV1) measurements.push(await runQuery(pool, item));
    const corpus = await pool.query<{ providers: number; projections: number; reviewed: number }>(`
      SELECT
        (SELECT count(*)::int FROM catalog.providers) AS providers,
        (SELECT count(*)::int FROM catalog.knowledge_projections) AS projections,
        (SELECT count(*)::int FROM catalog.knowledge_projections
         WHERE publication_state = 'reviewed') AS reviewed
    `);
    const version = await pool.query<{ version: string }>('SELECT version()');
    const development = measurements.filter((item) => item.split === 'development');
    const heldOut = measurements.filter((item) => item.split === 'held_out');
    const sensitivity = await selectionSensitivity(pool, measurements);
    const report = {
      evaluationId: 'phase06-retrieval-evaluation-v1',
      executedAt: new Date().toISOString(),
      labelScope:
        'Agent-proxy engineering judgments frozen before this run; not human relevance ground truth.',
      datasetUse: {
        development: 'Development diagnostics.',
        heldOut:
          'Reused after the first diagnostic exposed misses; post-diagnostic numbers are confirmation data, not an untouched held-out estimate.',
      },
      configuration: {
        retrieval: 'deterministic-v1 interpretation + lexical-alias-v2',
        signalPolicy: 'query-signal-v1',
        resultCutoff: 20,
        database: version.rows[0]!.version,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        corpus: corpus.rows[0],
      },
      lexicalBaseline: {
        overall: summarize(measurements),
        development: summarize(development),
        heldOut: summarize(heldOut),
      },
      hybridComparison: {
        state: 'not_run',
        reason:
          'No explicitly provisioned loopback semantic endpoint and model artifact were available; cached lexical results remain the product baseline.',
        modelCalls: 0,
        externalCalls: 0,
      },
      selectionPolicySensitivity: sensitivity,
      measurements,
    };
    await emitJsonReport(report, 'MAESTRO_EVALUATION_REPORT_PATH');
    const invariantsFailed = measurements.some(
      (measurement) =>
        !measurement.coverageCorrect ||
        measurement.prohibitedFoundAt20.length > 0 ||
        measurement.exactNameRetainedAt20 === false,
    );
    if (invariantsFailed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
