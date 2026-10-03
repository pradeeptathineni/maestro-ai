import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import {
  createGitHubDiscoveryAdapter,
  createHackerNewsDiscoveryAdapter,
  createMcpRegistryDiscoveryAdapter,
  type DiscoveryAdapter,
} from '../packages/adapters/src/index.js';
import {
  createExplorerSession,
  createPool,
  explorerDefaultFusionPolicy,
  explorerRetrievalPolicyVersion,
  getExplorerResultPage,
  migrate,
} from '../packages/db/src/index.js';
import { hashCanonical, structuredRerankPolicyVersion } from '../packages/domain/src/index.js';
import {
  phase06QueryEvaluationV1,
  type Phase06EvaluationQuery,
} from '../packages/seed/src/phase06-evaluation.js';
import {
  phase08ChallengeQueries,
  phase08DevelopmentQueries,
  phase08ExpertDraftQrels,
  phase08LiveQueries,
  type GradedQrel,
  type Phase08ExpertDraft,
} from '../packages/seed/src/phase08-evaluation.js';
import { importSeed, localWorkspaceId } from '../packages/seed/src/import.js';
import {
  ensureTestDatabase,
  resetTestSchemas,
  testDatabaseUrl,
} from '../packages/test-fixtures/src/database.js';
import { initializeWorker } from '../apps/worker/src/initialize.js';
import { emitJsonReport } from './write-json-report.js';

interface ResultItem {
  id: string;
  providerId: string | null;
  documentId: string | null;
  subjectType: 'implementation' | 'document';
  name: string;
  kind: string;
  capabilityGroup: string;
  relevanceValue: number;
  matchScore: number;
}

interface ResultPage {
  resultSet: {
    candidatePoolHash: string;
    retrievalPolicyVersion: string;
    fusionPolicyVersion: string;
    rerankPolicyVersion: string;
    retrievalPasses: number;
    stopReason: string;
    interpretation: {
      coverageState: 'maintained' | 'partial' | 'outside_maintained_coverage';
    };
    queryPlan: {
      policyVersion: string;
      routes: Array<{ state: string; adapterKey: string }>;
      secondPass: { state: string; routes: unknown[] };
    };
  };
  filteredCount: number;
  items: ResultItem[];
}

interface RankedQuery {
  elapsedMs: number;
  page: ResultPage;
  sourceClassesAt20: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function average(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length
    ? Number((available.reduce((sum, value) => sum + value, 0) / available.length).toFixed(4))
    : null;
}

function dcg(grades: number[], cutoff: number): number {
  return grades.slice(0, cutoff).reduce((sum, grade, index) => {
    return sum + (2 ** grade - 1) / Math.log2(index + 2);
  }, 0);
}

function ndcg(names: string[], qrels: GradedQrel[], cutoff: number): number | null {
  const byName = new Map(qrels.map((qrel) => [qrel.candidate, qrel.grade]));
  const observed = names.map((name) => byName.get(name) ?? 0);
  const ideal = qrels
    .map((qrel) => qrel.grade)
    .filter((grade) => grade > 0)
    .sort((left, right) => right - left);
  const denominator = dcg(ideal, cutoff);
  return denominator ? Number((dcg(observed, cutoff) / denominator).toFixed(4)) : null;
}

function gradedJudgment(names: string[], item: Phase08ExpertDraft) {
  const grade = new Map(item.qrels.map((qrel) => [qrel.candidate, qrel.grade]));
  const relevant = item.qrels.filter((qrel) => qrel.grade >= 2).map((qrel) => qrel.candidate);
  const prohibited = new Set(
    item.qrels.filter((qrel) => qrel.grade === 0).map((qrel) => qrel.candidate),
  );
  const relevantAt = (cutoff: number) =>
    names.slice(0, cutoff).filter((name) => (grade.get(name) ?? 0) >= 2).length;
  const judgedAt = (cutoff: number) =>
    names.slice(0, cutoff).filter((name) => grade.has(name)).length;
  const firstEssential = names.findIndex((name) => (grade.get(name) ?? 0) === 3);
  return {
    recallAt20: ratio(relevantAt(20), relevant.length),
    recallAt50: ratio(relevantAt(50), relevant.length),
    ndcgAt10: ndcg(names, item.qrels, 10),
    ndcgAt20: ndcg(names, item.qrels, 20),
    lowerBoundPrecisionAt5: ratio(relevantAt(5), Math.min(5, names.length)),
    lowerBoundPrecisionAt10: ratio(relevantAt(10), Math.min(10, names.length)),
    judgedPrecisionAt5: ratio(relevantAt(5), judgedAt(5)),
    judgedPrecisionAt10: ratio(relevantAt(10), judgedAt(10)),
    unjudgedAt10: names.slice(0, 10).filter((name) => !grade.has(name)).length,
    reciprocalRankEssential:
      firstEssential >= 0 ? Number((1 / (firstEssential + 1)).toFixed(4)) : 0,
    prohibitedHitsAt20: names.slice(0, 20).filter((name) => prohibited.has(name)),
  };
}

function proxyJudgment(names: string[], item: Phase06EvaluationQuery) {
  const acceptable = new Set(item.acceptableCandidates);
  const prohibited = new Set(item.prohibitedCandidates);
  const found = item.acceptableCandidates.filter((name) => names.slice(0, 20).includes(name));
  return {
    recallAt20: ratio(found.length, item.acceptableCandidates.length),
    exactRetained:
      item.exactNameCandidate === undefined
        ? null
        : names.slice(0, 20).includes(item.exactNameCandidate),
    prohibitedHits: names.slice(0, 20).filter((name) => prohibited.has(name)),
    judgedRelevantAt5: names.slice(0, 5).filter((name) => acceptable.has(name)).length,
  };
}

async function sourceClasses(pool: Pool, items: ResultItem[]): Promise<string[]> {
  const providerIds = items.flatMap((item) => (item.providerId ? [item.providerId] : []));
  const documentIds = items.flatMap((item) => (item.documentId ? [item.documentId] : []));
  const result = await pool.query<{ sourceType: string }>(
    `SELECT DISTINCT source_type AS "sourceType" FROM (
       SELECT source.source_type
       FROM catalog.knowledge_projections projection
       JOIN catalog.knowledge_projection_sources binding ON binding.projection_id = projection.id
       JOIN catalog.source_observations observation ON observation.id = binding.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       WHERE projection.provider_id = ANY($1::uuid[])
       UNION ALL
       SELECT source.source_type
       FROM catalog.knowledge_documents document
       JOIN catalog.source_observations observation ON observation.id = document.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       WHERE document.id = ANY($2::uuid[])
     ) source_types ORDER BY source_type`,
    [providerIds, documentIds],
  );
  return result.rows.map((row) => row.sourceType);
}

async function rank(pool: Pool, query: string): Promise<RankedQuery> {
  const started = performance.now();
  const session = (await createExplorerSession(
    pool,
    localWorkspaceId,
    { query },
    { fusionPolicy: 'normalized-weighted-fusion-v1' },
  )) as { resultSetId: string };
  const page = (await getExplorerResultPage(pool, localWorkspaceId, session.resultSetId, {
    limit: 50,
    sort: 'recommended',
  })) as ResultPage;
  return {
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    sourceClassesAt20: await sourceClasses(pool, page.items.slice(0, 20)),
    page,
  };
}

function broadShape(result: RankedQuery, item: Phase08ExpertDraft) {
  const top = result.page.items.slice(0, 20);
  const groups = [...new Set(top.map((row) => row.capabilityGroup).filter(Boolean))];
  const types = [...new Set(top.map((row) => `${row.subjectType}:${row.kind}`))];
  const names = top.map((row) => row.name);
  return {
    essentialAnchorCoverage: ratio(
      item.requiredAnchors.filter((anchor) => names.includes(anchor)).length,
      item.requiredAnchors.length,
    ),
    expectedFacetCoverage: ratio(
      item.importantFacets.filter((facet) =>
        groups.some((group) =>
          group.toLocaleLowerCase('en-US').includes(facet.toLocaleLowerCase('en-US')),
        ),
      ).length,
      item.importantFacets.length,
    ),
    representedGroups: groups,
    typeDiversity: types,
    sourceDiversity: result.sourceClassesAt20,
    duplicateNameRate: ratio(names.length - new Set(names).size, names.length),
  };
}

async function runLocalEvaluation(pool: Pool) {
  const observedConfigurations = new Map<
    string,
    {
      retrievalPolicyVersion: string;
      fusionPolicyVersion: string;
      rerankPolicyVersion: string;
    }
  >();
  const rankAndRecordConfiguration = async (query: string): Promise<RankedQuery> => {
    const result = await rank(pool, query);
    const configuration = {
      retrievalPolicyVersion: result.page.resultSet.retrievalPolicyVersion,
      fusionPolicyVersion: result.page.resultSet.fusionPolicyVersion,
      rerankPolicyVersion: result.page.resultSet.rerankPolicyVersion,
    };
    if (
      configuration.retrievalPolicyVersion !== explorerRetrievalPolicyVersion ||
      configuration.fusionPolicyVersion !== explorerDefaultFusionPolicy ||
      configuration.rerankPolicyVersion !== structuredRerankPolicyVersion
    ) {
      throw new Error('Evaluation result-set policy metadata does not match the runtime contract.');
    }
    observedConfigurations.set(hashCanonical(configuration), configuration);
    return result;
  };
  const phase06ByQuery = new Map(phase06QueryEvaluationV1.map((item) => [item.query, item]));
  const development = [];
  for (const item of phase08DevelopmentQueries) {
    const result = await rankAndRecordConfiguration(item.query);
    const source = phase06ByQuery.get(item.query);
    development.push({
      ...item,
      candidateCount: result.page.filteredCount,
      candidatePoolHash: result.page.resultSet.candidatePoolHash,
      expectedCoverage: source?.expectedCoverage ?? null,
      actualCoverage: result.page.resultSet.interpretation.coverageState,
      coverageCorrect:
        source === undefined
          ? null
          : result.page.resultSet.interpretation.coverageState === source.expectedCoverage,
      elapsedMs: result.elapsedMs,
      proxyJudgment: source
        ? proxyJudgment(
            result.page.items.map((row) => row.name),
            source,
          )
        : null,
    });
  }

  const expertDraft = [];
  for (const item of phase08ExpertDraftQrels) {
    const result = await rankAndRecordConfiguration(item.query);
    const names = result.page.items.map((row) => row.name);
    expertDraft.push({
      id: item.id,
      query: item.query,
      family: item.family,
      labelProvenance: item.labelProvenance,
      candidateCount: result.page.filteredCount,
      candidatePoolHash: result.page.resultSet.candidatePoolHash,
      top20: names.slice(0, 20),
      metrics: gradedJudgment(names, item),
      broadShape: ['ultra_broad', 'typed_broad', 'cross_type'].includes(item.family)
        ? broadShape(result, item)
        : null,
      elapsedMs: result.elapsedMs,
    });
  }

  const challenge = [];
  for (const item of phase08ChallengeQueries) {
    const result = await rankAndRecordConfiguration(item.query);
    const plan = result.page.resultSet.queryPlan;
    challenge.push({
      ...item,
      actualCoverage: result.page.resultSet.interpretation.coverageState,
      candidateCount: result.page.filteredCount,
      top10: result.page.items.slice(0, 10).map((row) => row.name),
      planPolicyVersion: plan.policyVersion,
      retrievalPasses: result.page.resultSet.retrievalPasses,
      plannedExternalRoutes: plan.routes
        .filter((route) => route.state === 'planned')
        .map((route) => route.adapterKey),
      coherentPlan:
        plan.policyVersion === 'research-plan-v5' &&
        result.page.resultSet.interpretation.coverageState === item.expectedPlan.expectedCoverage &&
        result.page.resultSet.retrievalPasses >= item.expectedPlan.minimumPasses &&
        plan.routes.some((route) => route.state === 'planned'),
      usefulCandidateJudgment: 'unjudged_pending_independent_review',
      elapsedMs: result.elapsedMs,
    });
  }

  const proxyRows = development
    .map((row) => row.proxyJudgment)
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const expertMetrics = expertDraft.map((row) => row.metrics);
  if (observedConfigurations.size !== 1) {
    throw new Error('Evaluation result sets used inconsistent retrieval policy configurations.');
  }
  return {
    effectiveConfiguration: [...observedConfigurations.values()][0]!,
    development: {
      manifestCount: phase08DevelopmentQueries.length,
      labeledProxyCount: proxyRows.length,
      currentPhase07Proxy: {
        meanRecallAt20: average(proxyRows.map((row) => row.recallAt20)),
        coverageAgreement: ratio(
          development.filter((row) => row.coverageCorrect === true).length,
          development.filter((row) => row.coverageCorrect !== null).length,
        ),
        exactNameRetention: ratio(
          proxyRows.filter((row) => row.exactRetained !== null && row.exactRetained).length,
          proxyRows.filter((row) => row.exactRetained !== null).length,
        ),
        prohibitedHitsAt20: proxyRows.reduce((sum, row) => sum + row.prohibitedHits.length, 0),
      },
      measurements: development,
    },
    expertDraft: {
      labelState: 'expert_draft_not_human_gold',
      queryCount: expertDraft.length,
      meanRecallAt20: average(expertMetrics.map((row) => row.recallAt20)),
      meanRecallAt50: average(expertMetrics.map((row) => row.recallAt50)),
      meanNdcgAt10: average(expertMetrics.map((row) => row.ndcgAt10)),
      meanNdcgAt20: average(expertMetrics.map((row) => row.ndcgAt20)),
      meanLowerBoundPrecisionAt5: average(expertMetrics.map((row) => row.lowerBoundPrecisionAt5)),
      meanLowerBoundPrecisionAt10: average(expertMetrics.map((row) => row.lowerBoundPrecisionAt10)),
      meanJudgedPrecisionAt5: average(expertMetrics.map((row) => row.judgedPrecisionAt5)),
      meanJudgedPrecisionAt10: average(expertMetrics.map((row) => row.judgedPrecisionAt10)),
      meanReciprocalRankEssential: average(expertMetrics.map((row) => row.reciprocalRankEssential)),
      prohibitedHitsAt20: expertMetrics.reduce(
        (sum, row) => sum + row.prohibitedHitsAt20.length,
        0,
      ),
      measurements: expertDraft,
    },
    challenge: {
      frozenAfterPolicyCommit: phase08ChallengeQueries[0]!.freeze.createdAfterPolicyCommit,
      queryCount: challenge.length,
      coherentPlanRate: ratio(challenge.filter((row) => row.coherentPlan).length, challenge.length),
      nonEmptyLocalCandidateRate: ratio(
        challenge.filter((row) => row.candidateCount > 0).length,
        challenge.length,
      ),
      measurements: challenge,
    },
  };
}

function adapterFor(key: 'github' | 'mcp_registry' | 'hacker_news'): DiscoveryAdapter {
  if (key === 'github') return createGitHubDiscoveryAdapter({ timeoutMs: 15_000 });
  if (key === 'mcp_registry') return createMcpRegistryDiscoveryAdapter({ timeoutMs: 15_000 });
  return createHackerNewsDiscoveryAdapter({ timeoutMs: 15_000 });
}

async function runLiveEvaluation() {
  if (
    process.env.MAESTRO_PHASE08_LIVE !== 'true' ||
    process.env.MAESTRO_ALLOW_NETWORK_FETCH !== 'true'
  ) {
    return {
      state: 'not_run',
      reason:
        'Live probes require both MAESTRO_PHASE08_LIVE=true and MAESTRO_ALLOW_NETWORK_FETCH=true.',
      queryCount: phase08LiveQueries.length,
    };
  }
  const measurements: Array<{
    id: string;
    query: string;
    family: string;
    adapter: 'github' | 'mcp_registry' | 'hacker_news';
    observedOn: string;
    elapsedMs: number;
    state: 'complete' | 'partial' | 'failed';
    httpStatus: number | null;
    responseBytes: number;
    resultCount: number;
    uniqueCanonicalUris: number;
    leads: Array<{
      title: string;
      canonicalUri: string;
      summary: string;
      kindHint: string;
      provenance: Record<string, unknown>;
    }>;
    judgmentState: 'unjudged_pending_independent_review';
  }> = [];
  for (const item of phase08LiveQueries) {
    const started = performance.now();
    const result = await adapterFor(item.adapter).search(item.query, 10);
    measurements.push({
      ...item,
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      state: result.state,
      httpStatus: result.httpStatus,
      responseBytes: result.responseBytes,
      resultCount: result.leads.length,
      uniqueCanonicalUris: new Set(result.leads.map((lead) => lead.canonicalUri)).size,
      leads: result.leads.map((lead) => ({
        title: lead.title,
        canonicalUri: lead.canonicalUri,
        summary: lead.summary,
        kindHint: lead.kindHint,
        provenance: lead.provenance,
      })),
      judgmentState: 'unjudged_pending_independent_review',
    });
  }
  return {
    state: 'recorded_unjudged',
    queryCount: measurements.length,
    successfulQueryRate: ratio(
      measurements.filter((measurement) => measurement.state !== 'failed').length,
      measurements.length,
    ),
    nonEmptyQueryRate: ratio(
      measurements.filter((measurement) => measurement.resultCount > 0).length,
      measurements.length,
    ),
    adapterYield: ['github', 'mcp_registry', 'hacker_news'].map((adapter) => {
      const rows = measurements.filter((measurement) => measurement.adapter === adapter);
      return {
        adapter,
        queries: rows.length,
        successful: rows.filter((row) => row.state !== 'failed').length,
        candidates: rows.reduce((sum, row) => sum + row.resultCount, 0),
        uniqueCanonicalUris: new Set(
          rows.flatMap((row) => row.leads.map((lead) => lead.canonicalUri)),
        ).size,
      };
    }),
    measurements,
  };
}

async function main(): Promise<void> {
  const databaseUrl = testDatabaseUrl();
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Phase 08 evaluation only resets a dedicated database ending in _test.');
  }
  await ensureTestDatabase();
  await resetTestSchemas();
  await migrate(databaseUrl);
  await initializeWorker(databaseUrl);
  await importSeed(databaseUrl);
  const pool = createPool(databaseUrl);
  try {
    const local = await runLocalEvaluation(pool);
    const live = await runLiveEvaluation();
    const configuration = {
      retrievalPolicyVersion: local.effectiveConfiguration.retrievalPolicyVersion,
      fusionPolicyVersion: local.effectiveConfiguration.fusionPolicyVersion,
      rerankPolicyVersion: local.effectiveConfiguration.rerankPolicyVersion,
      retrieval: `deterministic-v4 + ${local.effectiveConfiguration.retrievalPolicyVersion} + ${local.effectiveConfiguration.fusionPolicyVersion} + ${local.effectiveConfiguration.rerankPolicyVersion}`,
      signal: 'intrinsic-signal-v3 (not a relevance input)',
      externalPrivateContextSent: false,
      productionImportsQrels: false,
    };
    const report = {
      evaluationId: 'phase08-stratified-evaluation-v1',
      executedAt: new Date().toISOString(),
      reportHashBasis: hashCanonical({
        development: phase08DevelopmentQueries,
        expertDraft: phase08ExpertDraftQrels,
        challenge: phase08ChallengeQueries,
        live: phase08LiveQueries,
        configuration,
      }),
      configuration,
      phase07Comparison: {
        evidenceClass: 'agent_proxy_not_human_gold',
        baselineSha: 'e08e1326eef5c5157310f234fd171de4cfaee22d',
        baselineRecallAt20: 0.9141,
        frozenPhase08SelectedPolicyRecallAt20: 0.8811,
        comparisonWarning:
          'Only the development proxy metric is directly comparable; expert-draft and challenge metrics use different labels.',
      },
      ...local,
      liveCurrent: live,
      nonClaims: [
        'AI-authored qrels are expert drafts, not human gold.',
        'Unjudged results are reported and are not silently labeled irrelevant.',
        'Live-current results remain unjudged until an independent review records usefulness.',
        'No model call or private project context was used for query interpretation.',
      ],
    };
    await emitJsonReport(report, 'MAESTRO_PHASE08_EVALUATION_REPORT_PATH');
    const failed =
      local.development.currentPhase07Proxy.prohibitedHitsAt20 > 0 ||
      local.development.currentPhase07Proxy.exactNameRetention !== 1 ||
      local.development.currentPhase07Proxy.coverageAgreement !== 1 ||
      local.challenge.coherentPlanRate !== 1;
    if (failed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
