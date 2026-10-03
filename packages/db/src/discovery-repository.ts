import type { Pool, PoolClient } from 'pg';
import type {
  AdapterConfigBody,
  DiscoveryAdmissionBody,
  DiscoveryRequestBody,
  KnowledgeOptionBody,
} from '../../contracts/src/index.js';
import {
  assessRetrievalMatch,
  assessResearchCoverage,
  hashCanonical,
  buildDiscoveryPlan,
  interpretQuery,
  learnResearchVocabulary,
  newOpaqueId,
  rankSourcesByMeasuredValue,
  runRetrievalPipeline,
  type DiscoveryPlan,
  type DiscoveryRouteState,
  type LearnedResearchTerm,
  type QueryInterpretation,
  type RetrievalDocument,
  type RetrievalPipelineResult,
} from '../../domain/src/index.js';
import {
  calculateCompatibilityIntrinsicSignal,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import {
  createGitHubDiscoveryAdapter,
  createHackerNewsDiscoveryAdapter,
  createMcpRegistryDiscoveryAdapter,
  createSearxngDiscoveryAdapter,
  validateExplicitLocalEndpoint,
  type DiscoveryAdapter,
} from '../../adapters/src/index.js';
import {
  furnishKnowledgeDocumentWithClient,
  furnishKnowledgeOptionWithClient,
} from './authoring-repository.js';
import { ConflictError, DomainValidationError, NotFoundError } from './errors.js';
import { inTransaction } from './transaction.js';

type JsonRow = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function discoveryLeadValueProfile(input: {
  kindHint: string | null;
  sourcePayload: unknown;
  id: string;
}): QueryValueInput[] {
  const payload =
    input.sourcePayload && typeof input.sourcePayload === 'object'
      ? (input.sourcePayload as Record<string, unknown>)
      : {};
  const stars = typeof payload.stars === 'number' && payload.stars >= 0 ? payload.stars : null;
  const archived = payload.archived === true;
  const updatedAt =
    typeof payload.updatedAt === 'string' && Number.isFinite(Date.parse(payload.updatedAt))
      ? payload.updatedAt
      : null;
  // Popularity is only a bounded maturity clue. It never stands in for setup or
  // operating ease, and it can move the maturity anchor by at most 25 points.
  const popularityMaturityRaw =
    stars === null ? null : 50 + Math.min(25, Math.round(5 * Math.log10(Math.max(1, stars))));
  const maturityRaw = archived ? 0 : (popularityMaturityRaw ?? (updatedAt ? 50 : null));
  const evidenceId = `discovery-candidate:${input.id}`;
  const highPrivilege = [
    'agent',
    'framework',
    'gateway',
    'mcp_server',
    'platform',
    'plugin',
    'runtime',
  ].includes(input.kindHint ?? '');
  return [
    {
      key: 'reuse_leverage',
      raw: null,
      confidence: 0,
      coverage: 0,
      applicability: 'applicable',
      state: 'missing',
      reasons: [],
      missing: ['The source lead has not been assessed for reusable scope.'],
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
      missing: ['Setup, operating burden, replacement, and rollback are not assessed.'],
      evidenceIds: [],
    },
    {
      key: 'maturity',
      raw: maturityRaw,
      confidence: maturityRaw === null ? 0 : archived ? 0.65 : stars !== null ? 0.35 : 0.25,
      coverage: maturityRaw === null ? 0 : 0.25,
      applicability: 'applicable',
      state: maturityRaw === null ? 'missing' : maturityRaw === 0 ? 'zero' : 'present',
      reasons: archived
        ? ['The source reports the repository as archived.']
        : stars !== null
          ? [
              `GitHub reported ${stars} stars and activity at ${updatedAt ?? 'an unknown date'}; popularity is capped as a weak maturity clue and does not establish support quality.`,
            ]
          : updatedAt
            ? [
                `The source reports repository activity at ${updatedAt}; continuity is not established.`,
              ]
            : [],
      missing: ['Release continuity and support quality are not assessed.'],
      evidenceIds: maturityRaw === null ? [] : [evidenceId],
    },
    {
      key: 'provenance_clarity',
      raw: 50,
      confidence: 0.35,
      coverage: 0.5,
      applicability: 'applicable',
      highPrivilege,
      state: 'present',
      reasons: ['The source adapter supplied an attributed identity and canonical URI.'],
      missing: ['Permissions, data flows, and consequential effects are not assessed.'],
      evidenceIds: [evidenceId],
    },
  ];
}

function discoveryLeadType(candidate: {
  adapterKey?: string;
  kindHint: string | null;
}): { subjectType: 'implementation' | 'document'; entityClass: string } {
  const kind = candidate.kindHint?.trim().toLocaleLowerCase('en-US') ?? '';
  const documentKinds = new Set([
    'article',
    'community_discussion',
    'documentation',
    'paper',
    'research',
    'specification',
    'standard',
  ]);
  const implementationKinds = new Set([
    'agent',
    'framework',
    'library',
    'mcp_server',
    'model',
    'oss_project',
    'platform',
    'plugin',
    'repository',
    'runtime',
    'service',
    'tool',
  ]);
  if (documentKinds.has(kind)) return { subjectType: 'document', entityClass: kind };
  if (implementationKinds.has(kind)) {
    return { subjectType: 'implementation', entityClass: 'implementation' };
  }
  if (candidate.adapterKey === 'github' || candidate.adapterKey === 'mcp_registry') {
    return { subjectType: 'implementation', entityClass: 'implementation' };
  }
  if (candidate.adapterKey === 'hacker_news') {
    return { subjectType: 'document', entityClass: 'community_discussion' };
  }
  return { subjectType: 'document', entityClass: 'unknown' };
}

export function discoveryLeadRetrievalDocument(candidate: {
  id: string;
  title: string;
  summary: string;
  kindHint: string | null;
  adapterKey?: string;
  canonicalUri?: string;
}): RetrievalDocument {
  const leadType = discoveryLeadType(candidate);
  return {
    candidateKey: `lead:${candidate.id}`,
    subjectType: leadType.subjectType,
    entityId: candidate.id,
    entityClass: leadType.entityClass,
    kind: candidate.kindHint ?? 'other',
    name: candidate.title,
    aliases: [],
    searchText: `${candidate.title} ${candidate.summary}`,
    strongIdentityKeys: candidate.canonicalUri ? [`uri:${candidate.canonicalUri}`] : [],
    concepts: [],
  };
}

export function scoreDiscoveryCandidate(
  query: string | QueryInterpretation,
  candidate: JsonRow & {
    id: string;
    title: string;
    summary: string;
    kindHint: string | null;
    sourcePayload: unknown;
    adapterKey?: string;
    canonicalUri?: string;
    createdAt?: string;
  },
): JsonRow {
  const interpretation = typeof query === 'string' ? interpretQuery(query) : query;
  const match = assessRetrievalMatch(discoveryLeadRetrievalDocument(candidate), interpretation);
  const relevance = match
    ? match.band === 'Direct'
      ? { ordinal: 'direct' as const, value: 100 as const }
      : match.band === 'Strong'
        ? { ordinal: 'partial' as const, value: 75 as const }
        : match.band === 'Related'
          ? { ordinal: 'complementary' as const, value: 50 as const }
          : { ordinal: 'incidental' as const, value: 25 as const }
    : { ordinal: 'no_match' as const, value: 0 as const };
  const observedAt =
    candidate.createdAt && Number.isFinite(Date.parse(candidate.createdAt))
      ? candidate.createdAt
      : '1970-01-01T00:00:00.000Z';
  const signal = calculateCompatibilityIntrinsicSignal({
    kind: candidate.kindHint ?? 'other',
    valueProfile: discoveryLeadValueProfile(candidate),
    observedAt,
    evidenceSourceGroups: [candidate.adapterKey ?? 'unreviewed_source_lead'],
    freshness: candidate.createdAt ? 0.7 : 0.3,
    provisional: true,
  });
  const publicCandidate = { ...candidate };
  delete publicCandidate.sourcePayload;
  return {
    ...publicCandidate,
    matchedTerms: match?.matchedTerms ?? [],
    relevanceOrdinal: relevance.ordinal,
    relevanceValue: relevance.value,
    matchScore: match?.score ?? 0,
    matchBand: match?.band ?? null,
    matchReasons: match?.reasons ?? [],
    matchPolicyVersion: match?.policyVersion ?? 'retrieval-match-v1',
    signalDisplay: signal.display,
    signalUnrounded: signal.conservative,
    evidenceCoverage: signal.evidenceConfidence.coverage,
    evidenceConfidence: signal.evidenceConfidence.score,
    evidenceConfidenceDetail: signal.evidenceConfidence,
    displayState: signal.displayState,
    signalBand: signal.band,
    signalPolicyVersion: signal.policyVersion,
    trend: signal.trend,
    signalExplanation:
      'Query-independent preliminary Signal from attributed source metadata. Review, Match, project fit, and deeper evidence remain separate.',
  };
}

export async function listAdapterStatus(pool: Pool): Promise<unknown[]> {
  const result = await pool.query<JsonRow>(`
    SELECT config.adapter_key AS "adapterKey", config.adapter_version AS "adapterVersion",
           config.source_class AS "sourceClass", config.base_url AS "baseUrl",
           config.data_disclosure_scope AS "dataDisclosureScope",
           config.rights_notes AS "rightsNotes", config.per_operation_call_limit AS "perOperationCallLimit",
           config.daily_call_limit AS "dailyCallLimit", config.timeout_ms AS "timeoutMs",
           config.response_byte_limit AS "responseByteLimit", config.max_attempts AS "maxAttempts",
           config.model_identifier AS "modelIdentifier",
           config.max_input_tokens AS "maxInputTokens",
           config.max_output_tokens AS "maxOutputTokens",
           config.enabled, config.revision, config.updated_at AS "updatedAt",
           COALESCE(budget.reserved_calls, 0) AS "reservedCallsToday",
           COALESCE(budget.consumed_calls, 0) AS "consumedCallsToday",
           COALESCE(budget.denied_calls, 0) AS "deniedCallsToday",
           latest.state AS "healthState", latest.safe_detail AS "healthDetail",
           latest.checked_at AS "lastCheckedAt"
           ,yield_window.attempted_calls AS "measuredCalls",
           yield_window.unique_candidates AS "measuredUniqueCandidates",
           yield_window.admitted_candidates AS "measuredAdmissions",
           yield_window.corroborated_candidates AS "measuredCorroborations"
    FROM ops.source_adapter_configs config
    LEFT JOIN LATERAL (
      SELECT * FROM ops.source_health_events health
      WHERE health.adapter_key = config.adapter_key ORDER BY checked_at DESC LIMIT 1
    ) latest ON true
    LEFT JOIN ops.adapter_daily_budgets budget
      ON budget.adapter_key = config.adapter_key AND budget.budget_date = current_date
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(attempted_calls), 0)::int AS attempted_calls,
             COALESCE(sum(unique_candidates), 0)::int AS unique_candidates,
             COALESCE(sum(admitted_candidates), 0)::int AS admitted_candidates,
             COALESCE(sum(corroborated_candidates), 0)::int AS corroborated_candidates
      FROM ops.adapter_yield_observations measured
      WHERE measured.adapter_key = config.adapter_key
        AND measured.window_end >= now() - interval '30 days'
    ) yield_window ON true
    ORDER BY config.adapter_key
  `);
  return result.rows.map((row) => ({
    ...row,
    configured: Boolean(row.enabled),
    status: row.enabled ? (row.healthState ?? 'not_exercised') : 'not_configured',
  }));
}

export async function configureAdapter(
  pool: Pool,
  adapterKey: string,
  input: AdapterConfigBody,
): Promise<unknown> {
  if (
    !['github', 'mcp_registry', 'searxng', 'hacker_news', 'local_semantic'].includes(adapterKey)
  ) {
    throw new NotFoundError('Adapter not found.');
  }
  if (['searxng', 'local_semantic'].includes(adapterKey) && input.enabled) {
    if (!input.baseUrl)
      throw new DomainValidationError('This adapter requires a loopback baseUrl.');
    try {
      validateExplicitLocalEndpoint(input.baseUrl);
    } catch {
      throw new DomainValidationError(
        'This adapter requires an explicit HTTP(S) loopback endpoint without credentials.',
      );
    }
  }
  if (adapterKey === 'local_semantic' && input.enabled && !input.modelIdentifier) {
    throw new DomainValidationError('The local semantic adapter requires a modelIdentifier.');
  }
  if (adapterKey !== 'local_semantic' && input.modelIdentifier) {
    throw new DomainValidationError('Only the local semantic adapter accepts a modelIdentifier.');
  }
  if (['github', 'mcp_registry', 'hacker_news'].includes(adapterKey) && input.baseUrl) {
    throw new DomainValidationError(
      'Native adapter destinations are fixed and cannot be overridden.',
    );
  }
  const result = await pool.query<JsonRow>(
    `UPDATE ops.source_adapter_configs
     SET enabled = $2, base_url = CASE WHEN adapter_key IN ('searxng', 'local_semantic')
                                           AND $3::text IS NOT NULL
                                      THEN $3::text ELSE base_url END,
         allowed_hosts = CASE WHEN adapter_key IN ('searxng', 'local_semantic')
                                   AND $3::text IS NOT NULL
                              THEN ARRAY[$4::text] ELSE allowed_hosts END,
         model_identifier = CASE WHEN adapter_key = 'local_semantic' AND $5::text IS NOT NULL
                                 THEN $5::text ELSE model_identifier END,
         max_input_tokens = CASE WHEN adapter_key = 'local_semantic'
                                 THEN $6::integer ELSE max_input_tokens END,
         max_output_tokens = CASE WHEN adapter_key = 'local_semantic'
                                  THEN $7::integer ELSE max_output_tokens END,
         revision = revision + 1, updated_at = now()
     WHERE adapter_key = $1
     RETURNING adapter_key AS "adapterKey", enabled, base_url AS "baseUrl",
               model_identifier AS "modelIdentifier", max_input_tokens AS "maxInputTokens",
               max_output_tokens AS "maxOutputTokens", revision`,
    [
      adapterKey,
      input.enabled,
      input.baseUrl ?? null,
      input.baseUrl ? new URL(input.baseUrl).hostname : null,
      input.modelIdentifier ?? null,
      input.maxInputTokens ?? 4096,
      input.maxOutputTokens ?? 512,
    ],
  );
  if (!result.rowCount) throw new NotFoundError('Adapter not found.');
  return result.rows[0];
}

interface DiscoveryRequestRoute {
  planRouteId: string;
  variantIndex: number;
  routingReason: string;
  sourcePlanState: DiscoveryRouteState;
  outboundQuery: string | null;
  researchRunId?: string;
  passIndex?: 1 | 2;
}

async function requestDiscoveryWithClient(
  client: PoolClient,
  workspaceId: string,
  querySessionId: string,
  input: DiscoveryRequestBody,
  route?: DiscoveryRequestRoute,
): Promise<unknown> {
    const intent = input.intent ?? 'deepen';
    const existing = await client.query<JsonRow>(
      `SELECT id, state, adapter_key AS "adapterKey", created_at AS "createdAt"
       FROM ops.discovery_operations WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, input.idempotencyKey],
    );
    if (existing.rowCount) return { ...existing.rows[0], duplicate: true };
    const session = await client.query<{ resultSetId: string }>(
      `SELECT qrs.id AS "resultSetId"
       FROM workspace.query_sessions qs
       JOIN LATERAL (
         SELECT id FROM workspace.query_result_sets current
         WHERE current.query_session_id = qs.id ORDER BY revision DESC LIMIT 1
       ) qrs ON true
       WHERE qs.id = $1 AND qs.workspace_id = $2 AND qs.deleted_at IS NULL`,
      [querySessionId, workspaceId],
    );
    if (!session.rowCount) throw new NotFoundError('Query session not found.');
    const config = await client.query<{
      enabled: boolean;
      perOperationCallLimit: number;
      dailyCallLimit: number;
    }>(
      `SELECT enabled, per_operation_call_limit AS "perOperationCallLimit",
              daily_call_limit AS "dailyCallLimit"
       FROM ops.source_adapter_configs WHERE adapter_key = $1 FOR UPDATE`,
      [input.adapterKey],
    );
    if (!config.rowCount) throw new NotFoundError('Adapter not found.');
    const operationId = newOpaqueId();
    const calls =
      route?.sourcePlanState === 'planned'
        ? Math.min(1, config.rows[0]!.perOperationCallLimit)
        : route
          ? 0
          : Math.min(1, config.rows[0]!.perOperationCallLimit);
    let state: 'queued' | 'not_configured' | 'budget_denied' | 'skipped' | 'unsupported' =
      route?.sourcePlanState === 'skipped'
        ? 'skipped'
        : route?.sourcePlanState === 'unsupported'
          ? 'unsupported'
          : 'not_configured';
    let reservedCalls = 0;
    if ((!route || route.sourcePlanState === 'planned') && config.rows[0]!.enabled && calls > 0) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('discovery-external-daily-budget:' || current_date::text))`,
      );
      await client.query(
        `INSERT INTO ops.adapter_daily_budgets (adapter_key, budget_date)
         VALUES ($1, current_date) ON CONFLICT DO NOTHING`,
        [input.adapterKey],
      );
      const overall = await client.query<{ reserved: number }>(
        `SELECT COALESCE(sum(reserved_calls), 0)::int AS reserved
         FROM ops.adapter_daily_budgets budget
         JOIN ops.source_adapter_configs config ON config.adapter_key = budget.adapter_key
         WHERE budget_date = current_date AND config.source_class <> 'local_semantic'`,
      );
      const reserved = await client.query(
        `UPDATE ops.adapter_daily_budgets SET reserved_calls = reserved_calls + $2, updated_at = now()
         WHERE adapter_key = $1 AND budget_date = current_date
           AND reserved_calls + $2 <= $3 AND $4 + $2 <= 60
         RETURNING reserved_calls`,
        [input.adapterKey, calls, config.rows[0]!.dailyCallLimit, overall.rows[0]!.reserved],
      );
      if (reserved.rowCount) {
        state = 'queued';
        reservedCalls = calls;
      } else {
        state = 'budget_denied';
        await client.query(
          `UPDATE ops.adapter_daily_budgets SET denied_calls = denied_calls + $2, updated_at = now()
           WHERE adapter_key = $1 AND budget_date = current_date`,
          [input.adapterKey, calls],
        );
      }
    }
    await client.query(
      `INSERT INTO ops.discovery_operations
         (id, workspace_id, query_session_id, result_set_id, adapter_key, idempotency_key,
          intent, outbound_query, outbound_query_hash, disclosure, state, reserved_calls,
          safe_detail, finished_at, plan_route_id, variant_index, routing_reason,
          source_plan_state, research_run_id, pass_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               CASE WHEN $11 IN ('not_configured', 'budget_denied', 'skipped', 'unsupported')
                    THEN now() ELSE NULL END, $14, $15, $16, $17, $18, $19)`,
      [
        operationId,
        workspaceId,
        querySessionId,
        session.rows[0]!.resultSetId,
        input.adapterKey,
        input.idempotencyKey,
        intent,
        route?.outboundQuery ?? input.approvedPublicQuery,
        hashCanonical(route?.outboundQuery ?? input.approvedPublicQuery),
        json({
          approvedBy: route ? 'bounded_source_plan' : 'human_request',
          sentFields: ['approvedPublicQuery'],
          privateProjectContextIncluded: false,
        }),
        state,
        reservedCalls,
        state === 'skipped' || state === 'unsupported'
          ? route!.routingReason
          : state === 'not_configured'
            ? 'Adapter is disabled. Cached exploration remains available.'
            : state === 'budget_denied'
              ? 'Atomic daily call budget denied this operation.'
              : 'Queued for the local worker.',
        route?.planRouteId ?? null,
        route?.variantIndex ?? 1,
        route?.routingReason ?? null,
        route?.sourcePlanState ?? 'planned',
        route?.researchRunId ?? null,
        route?.passIndex ?? 1,
      ],
    );
    if (state === 'queued') {
      await client.query(
        `INSERT INTO ops.outbox
           (id, operation_key, task_name, payload, state)
         VALUES ($1, $2, 'discovery_retrieve_v1', $3, 'pending')`,
        [newOpaqueId(), `discovery:${operationId}`, json({ operationId, workspaceId })],
      );
    }
    return {
      id: operationId,
      state,
      adapterKey: input.adapterKey,
      intent,
      disclosure: { sentFields: ['approvedPublicQuery'], privateProjectContextIncluded: false },
      reservedCalls,
      duplicate: false,
      planRouteId: route?.planRouteId ?? null,
      variantIndex: route?.variantIndex ?? 1,
      routingReason: route?.routingReason ?? null,
      sourcePlanState: route?.sourcePlanState ?? 'planned',
      researchRunId: route?.researchRunId ?? null,
      passIndex: route?.passIndex ?? 1,
    };
}

export async function requestDiscovery(
  pool: Pool,
  workspaceId: string,
  querySessionId: string,
  input: DiscoveryRequestBody,
  route?: DiscoveryRequestRoute,
): Promise<unknown> {
  return inTransaction(pool, (client) =>
    requestDiscoveryWithClient(client, workspaceId, querySessionId, input, route),
  );
}

const terminalDiscoveryStates = new Set([
  'partial',
  'complete',
  'failed',
  'cancelled',
  'not_configured',
  'budget_denied',
  'skipped',
  'unsupported',
]);

interface LiveResearchCandidateRow extends JsonRow {
  id: string;
  adapterKey: string;
  title: string;
  summary: string;
  kindHint: string | null;
  canonicalUri: string;
  operationIds?: string[];
}

interface ResearchRetrievalLineage {
  candidateId: string;
  contributingCandidateIds: string[];
  sourceAdapters: string[];
  operationIds: string[];
  fusionPolicy: string;
  fusedRank: number;
  fusedScore: number;
  fusionContributions: unknown[];
  rerankPolicy: string;
  rerankPosition: number;
  rerankScore: number;
  matchScore: number;
  matchBand: string;
  matchedTerms: string[];
  matchedConceptIds: string[];
  reasons: string[];
}

interface ResearchRetrievalReceipt {
  policyVersion: 'live-research-receipt-v1';
  originalQuery: string;
  interpretationVersion: QueryInterpretation['interpretationMethod'];
  retrievalPipelineVersion: 'retrieval-pipeline-v1';
  fusionPolicy: string;
  rerankPolicy: 'structured-rerank-v2';
  completedPassCount: 1 | 2;
  candidatePoolHash: string;
  candidateLineage: ResearchRetrievalLineage[];
  duplicateResolutions: RetrievalPipelineResult['duplicateResolutions'];
}

function assessLiveResearchCoverage(
  interpretation: QueryInterpretation,
  candidates: LiveResearchCandidateRow[],
): {
  coverage: ReturnType<typeof assessResearchCoverage>;
  distinctCandidates: number;
  duplicateCandidates: number;
  pipeline: RetrievalPipelineResult;
  learnedVocabulary: LearnedResearchTerm[];
} {
  const pipeline = runRetrievalPipeline(
    candidates.map(discoveryLeadRetrievalDocument),
    interpretation,
    {
      fusionPolicy: 'normalized-weighted-fusion-v1',
      maximumCandidates: 200,
      shouldRunSecondPass: (firstPassCandidates, resolvedDocuments) => {
        const documentByCandidate = new Map(
          resolvedDocuments.map((document) => [document.candidateKey, document] as const),
        );
        return assessResearchCoverage(
          interpretation,
          firstPassCandidates
            .slice(0, 100)
            .map((candidate) => documentByCandidate.get(candidate.candidateKey))
            .filter((document): document is RetrievalDocument => Boolean(document))
            .map((document) => ({
              entityClass: document.entityClass,
              group: document.kind === 'other' ? null : document.kind,
            })),
        ).needsSecondPass;
      },
    },
  );
  const documentByCandidate = new Map(
    pipeline.documents.map((document) => [document.candidateKey, document] as const),
  );
  const coverage = assessResearchCoverage(
    interpretation,
    pipeline.selected
      .slice(0, 100)
      .map((candidate) => documentByCandidate.get(candidate.candidateKey))
      .filter((document): document is RetrievalDocument => Boolean(document))
      .map((document) => ({
        entityClass: document.entityClass,
        group: document.kind === 'other' ? null : document.kind,
      })),
  );
  const candidateByKey = new Map<string, LiveResearchCandidateRow>(
    candidates.map((candidate) => [`lead:${candidate.id}`, candidate] as const),
  );
  const learnedVocabulary = learnResearchVocabulary(
    interpretation,
    pipeline.selected.flatMap((candidate) => {
      const source = candidateByKey.get(candidate.candidateKey);
      if (!source) return [];
      return [
        {
          candidateId: source.id,
          adapterKey: source.adapterKey,
          canonicalUri: source.canonicalUri,
          title: source.title,
          summary: source.summary,
          matchBand: candidate.matchBand,
          matchScore: candidate.matchScore,
          rerankPosition: candidate.rerankPosition,
        },
      ];
    }),
  );
  return {
    coverage,
    distinctCandidates: pipeline.documents.length,
    duplicateCandidates: pipeline.duplicateResolutions.filter(
      (resolution) => resolution.method !== 'distinct',
    ).length,
    pipeline,
    learnedVocabulary,
  };
}

function researchRetrievalReceipt(
  originalQuery: string,
  interpretation: QueryInterpretation,
  candidates: LiveResearchCandidateRow[],
  pipeline: RetrievalPipelineResult,
  completedPassCount: 1 | 2,
): ResearchRetrievalReceipt {
  const candidateByKey = new Map<string, LiveResearchCandidateRow>(
    candidates.map((candidate) => [`lead:${candidate.id}`, candidate] as const),
  );
  const contributorsByCanonical = new Map<string, LiveResearchCandidateRow[]>();
  for (const resolution of pipeline.duplicateResolutions) {
    const contributor = candidateByKey.get(resolution.candidateKey);
    if (!contributor) continue;
    const contributors = contributorsByCanonical.get(resolution.canonicalCandidateKey) ?? [];
    contributors.push(contributor);
    contributorsByCanonical.set(resolution.canonicalCandidateKey, contributors);
  }
  const candidateLineage = pipeline.selected.flatMap((candidate) => {
    const representative = candidateByKey.get(candidate.candidateKey);
    if (!representative) return [];
    const contributors = contributorsByCanonical.get(candidate.candidateKey) ?? [representative];
    return [
      {
        candidateId: representative.id,
        contributingCandidateIds: contributors.map((item) => item.id).sort(),
        sourceAdapters: [...new Set(contributors.map((item) => item.adapterKey))].sort(),
        operationIds: [
          ...new Set(contributors.flatMap((item) => item.operationIds ?? [])),
        ].sort(),
        fusionPolicy: candidate.fusionPolicy,
        fusedRank: candidate.fusedRank,
        fusedScore: candidate.fusedScore,
        fusionContributions: candidate.contributions,
        rerankPolicy: candidate.rerankPolicy,
        rerankPosition: candidate.rerankPosition,
        rerankScore: candidate.rerankScore,
        matchScore: candidate.matchScore,
        matchBand: candidate.matchBand,
        matchedTerms: candidate.matchedTerms,
        matchedConceptIds: candidate.matchedConceptIds,
        reasons: candidate.reasons,
      },
    ];
  });
  return {
    policyVersion: 'live-research-receipt-v1',
    originalQuery,
    interpretationVersion: interpretation.interpretationMethod,
    retrievalPipelineVersion: 'retrieval-pipeline-v1',
    fusionPolicy: pipeline.fusionPolicy,
    rerankPolicy: 'structured-rerank-v2',
    completedPassCount,
    candidatePoolHash: hashCanonical(
      candidates
        .map((candidate) => ({
          candidateId: candidate.id,
          adapterKey: candidate.adapterKey,
          canonicalUri: candidate.canonicalUri,
        }))
        .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    ),
    candidateLineage,
    duplicateResolutions: pipeline.duplicateResolutions,
  };
}

async function persistObservedResearchPlan(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: DiscoveryPlan,
): Promise<void> {
  await client.query(
    `UPDATE ops.research_runs
     SET observed_plan = $3, observed_plan_hash = $4, updated_at = now()
     WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId, json(plan), plan.planHash],
  );
}

async function finishResearchRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  stopReason: string,
  coverage: ReturnType<typeof assessResearchCoverage>,
  receipt: ResearchRetrievalReceipt,
): Promise<void> {
  const receiptHash = hashCanonical(receipt);
  await client.query(
    `UPDATE ops.research_runs
     SET state = CASE WHEN $3 IN ('sufficient_live_coverage', 'second_pass_complete')
                      THEN 'complete' ELSE 'stopped' END,
         final_coverage = $4, stop_reason = $3, completed_pass_count = $5,
         retrieval_receipt = $6, retrieval_receipt_hash = $7,
         finished_at = now(), updated_at = now()
     WHERE id = $1 AND workspace_id = $2`,
    [
      runId,
      workspaceId,
      stopReason,
      json(coverage),
      receipt.completedPassCount,
      json(receipt),
      receiptHash,
    ],
  );
}

async function advanceResearchRunWithClient(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<unknown[]> {
  const runResult = await client.query<{
    querySessionId: string;
    state: 'first_pass' | 'second_pass' | 'complete' | 'stopped';
    maximumExternalCalls: number;
    maximumCandidates: number;
    deadlineAt: Date;
    queryText: string;
    interpretation: QueryInterpretation;
    observedPlan: DiscoveryPlan | null;
  }>(
    `SELECT run.query_session_id AS "querySessionId", run.state,
            run.maximum_external_calls AS "maximumExternalCalls",
            run.maximum_candidates AS "maximumCandidates", run.deadline_at AS "deadlineAt",
            session.query_text AS "queryText", session.normalized_intent AS interpretation,
            run.observed_plan AS "observedPlan"
     FROM ops.research_runs run
     JOIN workspace.query_sessions session
       ON session.id = run.query_session_id AND session.workspace_id = run.workspace_id
     WHERE run.id = $1 AND run.workspace_id = $2
     FOR UPDATE OF run`,
    [runId, workspaceId],
  );
  if (!runResult.rowCount) throw new NotFoundError('Research run not found.');
  const run = runResult.rows[0]!;
  if (run.state === 'complete' || run.state === 'stopped') return [];
  const passIndex = run.state === 'first_pass' ? 1 : 2;
  const operations = await client.query<{
    state: string;
    reservedCalls: number;
  }>(
    `SELECT state, reserved_calls AS "reservedCalls"
     FROM ops.discovery_operations
     WHERE research_run_id = $1 AND workspace_id = $2 AND pass_index = $3
     ORDER BY created_at, id`,
    [runId, workspaceId, passIndex],
  );
  if (!operations.rowCount || operations.rows.some((operation) => !terminalDiscoveryStates.has(operation.state))) {
    return [];
  }
  const candidates = await client.query<LiveResearchCandidateRow>(
    `SELECT candidate.id, candidate.adapter_key AS "adapterKey",
            candidate.title, candidate.summary, candidate.kind_hint AS "kindHint",
            candidate.canonical_uri AS "canonicalUri",
            array_agg(DISTINCT operation.id::text ORDER BY operation.id::text) AS "operationIds"
     FROM ops.discovery_operations operation
     JOIN ops.discovery_operation_candidates link
       ON link.operation_id = operation.id AND link.workspace_id = operation.workspace_id
     JOIN ops.discovery_candidates candidate
       ON candidate.id = link.candidate_id AND candidate.workspace_id = link.workspace_id
     WHERE operation.research_run_id = $1 AND operation.workspace_id = $2
     GROUP BY candidate.id
     ORDER BY candidate.id`,
    [runId, workspaceId],
  );
  const assessed = assessLiveResearchCoverage(run.interpretation, candidates.rows);
  const receipt = researchRetrievalReceipt(
    run.queryText,
    run.interpretation,
    candidates.rows,
    assessed.pipeline,
    passIndex,
  );
  const allOperations = await client.query<{ externalCalls: number }>(
    `SELECT COALESCE(sum(reserved_calls), 0)::int AS "externalCalls"
     FROM ops.discovery_operations
     WHERE research_run_id = $1 AND workspace_id = $2`,
    [runId, workspaceId],
  );
  const externalCalls = allOperations.rows[0]!.externalCalls;
  const sourceSucceeded = operations.rows.some((operation) =>
    ['partial', 'complete'].includes(operation.state),
  );
  const elapsed = Date.now() >= run.deadlineAt.getTime();
  const duplicateDominated =
    candidates.rows.length >= 5 &&
    assessed.distinctCandidates / Math.max(candidates.rows.length, 1) < 0.25;
  if (elapsed) {
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      'elapsed_budget_exhausted',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  if (candidates.rows.length >= run.maximumCandidates) {
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      'candidate_budget_reached',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  if (duplicateDominated) {
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      'duplicate_dominance',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  if (!sourceSucceeded) {
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      'source_denial_or_failure',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  if (passIndex === 2) {
    const learnedVocabulary = run.observedPlan?.secondPass.learnedVocabulary ?? [];
    const completedPlan = buildDiscoveryPlan(run.queryText, run.interpretation, {
      coverageAssessment: assessed.coverage,
      externalSourcesEnabled: true,
      secondPassExecuted: true,
      learnedVocabulary,
    });
    await persistObservedResearchPlan(client, workspaceId, runId, completedPlan);
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      assessed.coverage.needsSecondPass ? 'second_pass_exhausted' : 'second_pass_complete',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  const observedPlan = buildDiscoveryPlan(run.queryText, run.interpretation, {
    coverageAssessment: assessed.coverage,
    externalSourcesEnabled: true,
    learnedVocabulary: assessed.learnedVocabulary,
  });
  await client.query(
    `UPDATE ops.research_runs
     SET first_pass_coverage = $3, updated_at = now()
     WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId, json(assessed.coverage)],
  );
  if (!assessed.coverage.needsSecondPass) {
    await persistObservedResearchPlan(client, workspaceId, runId, observedPlan);
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      'sufficient_live_coverage',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  const remainingCalls = run.maximumExternalCalls - externalCalls;
  const secondPassRoutes = observedPlan.secondPass.routes
    .filter((route) => route.state === 'planned' && route.callLimit > 0)
    .slice(0, Math.max(remainingCalls, 0));
  if (!secondPassRoutes.length) {
    await persistObservedResearchPlan(client, workspaceId, runId, observedPlan);
    await finishResearchRun(
      client,
      workspaceId,
      runId,
      remainingCalls <= 0 ? 'external_call_budget_exhausted' : 'second_pass_exhausted',
      assessed.coverage,
      receipt,
    );
    return [];
  }
  await client.query(
    `UPDATE ops.research_runs SET state = 'second_pass', updated_at = now()
     WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId],
  );
  await persistObservedResearchPlan(client, workspaceId, runId, observedPlan);
  const created: unknown[] = [];
  for (const route of secondPassRoutes) {
    created.push(
      await requestDiscoveryWithClient(
        client,
        workspaceId,
        run.querySessionId,
        {
          adapterKey: route.adapterKey,
          approvedPublicQuery: run.queryText,
          idempotencyKey: `search:${run.querySessionId}:${route.id}:${route.variantIndex}`,
          intent: 'explore',
        },
        {
          planRouteId: route.id,
          variantIndex: route.variantIndex,
          routingReason: route.reason,
          sourcePlanState: route.state,
          outboundQuery: route.variant,
          researchRunId: runId,
          passIndex: 2,
        },
      ),
    );
  }
  if (
    created.every(
      (operation) =>
        typeof operation === 'object' &&
        operation !== null &&
        (operation as { state?: string }).state !== 'queued',
    )
  ) {
    created.push(...(await advanceResearchRunWithClient(client, workspaceId, runId)));
  }
  return created;
}

export async function requestEnabledDiscovery(
  pool: Pool,
  workspaceId: string,
  querySessionId: string,
  approvedPublicQuery: string,
): Promise<unknown[]> {
  return inTransaction(pool, async (client) => {
    const session = await client.query<{
      interpretation: QueryInterpretation;
      plan: DiscoveryPlan | null;
    }>(
      `SELECT qs.normalized_intent AS interpretation, qp.plan
       FROM workspace.query_sessions qs
       LEFT JOIN LATERAL (
         SELECT plan FROM workspace.query_plans current_plan
         WHERE current_plan.query_session_id = qs.id
           AND current_plan.workspace_id = qs.workspace_id
         ORDER BY current_plan.created_at DESC, current_plan.id DESC LIMIT 1
       ) qp ON true
       WHERE qs.id = $1 AND qs.workspace_id = $2 AND qs.deleted_at IS NULL`,
      [querySessionId, workspaceId],
    );
    if (!session.rowCount) throw new NotFoundError('Query session not found.');
    const storedPlan = session.rows[0]!.plan;
    const plan =
      storedPlan?.policyVersion === 'research-plan-v5'
        ? storedPlan
        : buildDiscoveryPlan(approvedPublicQuery, session.rows[0]!.interpretation, {
            externalSourcesEnabled: true,
          });
    const plannedCalls = plan.routes.reduce(
      (total, route) => total + (route.state === 'planned' ? route.callLimit : 0),
      0,
    );
    if (plannedCalls > plan.budgets.maximumExternalCalls) {
      throw new DomainValidationError('The persisted source plan exceeds its external-call budget.');
    }
    const existingRun = await client.query<{ id: string }>(
      `SELECT id FROM ops.research_runs
       WHERE workspace_id = $1 AND query_session_id = $2`,
      [workspaceId, querySessionId],
    );
    if (existingRun.rowCount) {
      const existingOperations = await client.query<JsonRow>(
        `SELECT id, state, adapter_key AS "adapterKey", intent, disclosure,
                reserved_calls AS "reservedCalls", plan_route_id AS "planRouteId",
                variant_index AS "variantIndex", routing_reason AS "routingReason",
                source_plan_state AS "sourcePlanState", research_run_id AS "researchRunId",
                pass_index AS "passIndex", true AS duplicate
         FROM ops.discovery_operations
         WHERE research_run_id = $1 AND workspace_id = $2
         ORDER BY pass_index, created_at, id`,
        [existingRun.rows[0]!.id, workspaceId],
      );
      return existingOperations.rows;
    }
    const runId = newOpaqueId();
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + plan.budgets.maximumElapsedMs);
    await client.query(
      `INSERT INTO ops.research_runs
         (id, workspace_id, query_session_id, initial_plan_hash, state,
          maximum_external_calls, maximum_candidates, maximum_elapsed_ms,
          started_at, deadline_at)
       VALUES ($1, $2, $3, $4, 'first_pass', $5, $6, $7, $8, $9)`,
      [
        runId,
        workspaceId,
        querySessionId,
        plan.planHash,
        plan.budgets.maximumExternalCalls,
        plan.budgets.maximumCandidates,
        plan.budgets.maximumElapsedMs,
        startedAt,
        deadlineAt,
      ],
    );
    const measured = await client.query<{
      adapterKey: string;
      attemptedCalls: number;
      successfulCalls: number;
      uniqueCandidates: number;
      admittedCandidates: number;
      corroboratedCandidates: number;
      durationMs: number;
      health: 'healthy' | 'partial' | 'failed' | 'unknown';
    }>(`
      SELECT adapter_key AS "adapterKey", attempted_calls AS "attemptedCalls",
             successful_calls AS "successfulCalls", unique_candidates AS "uniqueCandidates",
             admitted_candidates AS "admittedCandidates",
             corroborated_candidates AS "corroboratedCandidates", duration_ms AS "durationMs",
             health_state AS health
      FROM ops.adapter_yield_observations
      WHERE window_end >= now() - interval '30 days'
      ORDER BY window_end DESC
    `);
    const values = rankSourcesByMeasuredValue(
      plan.routes.map((route) => route.adapterKey),
      measured.rows,
    );
    const preference = new Map(values.map((value, index) => [value.adapterKey, index]));
    const orderedRoutes = plan.routes
      .map((route, index) => ({ route, index }))
      .sort(
        (left, right) =>
          Number(right.route.state === 'planned') - Number(left.route.state === 'planned') ||
          (preference.get(left.route.adapterKey) ?? values.length) -
            (preference.get(right.route.adapterKey) ?? values.length) ||
          left.index - right.index,
      )
      .map(({ route }) => route);
    const operations: unknown[] = [];
    for (const route of orderedRoutes) {
      operations.push(
        await requestDiscoveryWithClient(
          client,
          workspaceId,
          querySessionId,
          {
            adapterKey: route.adapterKey,
            approvedPublicQuery,
            idempotencyKey: `search:${querySessionId}:${route.id}:${route.variantIndex}`,
            intent: 'explore',
          },
          {
            planRouteId: route.id,
            variantIndex: route.variantIndex,
            routingReason: route.reason,
            sourcePlanState: route.state,
            outboundQuery: route.variant,
            researchRunId: runId,
            passIndex: 1,
          },
        ),
      );
    }
    if (
      operations.every(
        (operation) =>
          typeof operation === 'object' &&
          operation !== null &&
          (operation as { state?: string }).state !== 'queued',
      )
    ) {
      operations.push(...(await advanceResearchRunWithClient(client, workspaceId, runId)));
    }
    return operations;
  });
}

export async function getDiscoveryOperation(
  pool: Pool,
  workspaceId: string,
  operationId: string,
): Promise<unknown> {
  const operation = await pool.query<JsonRow>(
    `SELECT operation.id, operation.query_session_id AS "querySessionId",
            operation.adapter_key AS "adapterKey", operation.intent,
            operation.disclosure, operation.state, operation.outbound_query AS "outboundQuery",
            session.normalized_intent AS "queryInterpretation",
            operation.plan_route_id AS "planRouteId",
            operation.variant_index AS "variantIndex",
            operation.routing_reason AS "routingReason",
            operation.source_plan_state AS "sourcePlanState",
            operation.research_run_id AS "researchRunId",
            operation.pass_index AS "passIndex",
            operation.reserved_calls AS "reservedCalls",
            operation.consumed_calls AS "consumedCalls",
            operation.result_count AS "resultCount", operation.error_code AS "errorCode",
            operation.safe_detail AS "safeDetail", operation.started_at AS "startedAt",
            operation.finished_at AS "finishedAt", operation.created_at AS "createdAt",
            operation.updated_at AS "updatedAt"
     FROM ops.discovery_operations operation
     JOIN workspace.query_sessions session
       ON session.id = operation.query_session_id AND session.workspace_id = operation.workspace_id
     WHERE operation.id = $1 AND operation.workspace_id = $2`,
    [operationId, workspaceId],
  );
  if (!operation.rowCount) throw new NotFoundError('Discovery operation not found.');
  const querySessionId = String(operation.rows[0]!.querySessionId);
  const [attempts, candidates, semanticProposal] = await Promise.all([
    pool.query<JsonRow>(
      `SELECT attempt, state, http_status AS "httpStatus", response_bytes AS "responseBytes",
              result_count AS "resultCount", cost_state AS "costState", cost_amount AS "costAmount",
              error_code AS "errorCode", safe_detail AS "safeDetail",
              started_at AS "startedAt", finished_at AS "finishedAt"
       FROM ops.discovery_attempts WHERE operation_id = $1 AND workspace_id = $2 ORDER BY attempt`,
      [operationId, workspaceId],
    ),
    pool.query<JsonRow>(
      `SELECT candidate.id, candidate.adapter_key AS "adapterKey",
              candidate.external_id AS "externalId",
              candidate.canonical_uri AS "canonicalUri", candidate.title, candidate.summary,
              candidate.kind_hint AS "kindHint", candidate.source_payload AS "sourcePayload",
              candidate.provenance, candidate.review_state AS "reviewState",
              candidate.created_at AS "createdAt",
              array_agg(DISTINCT link.operation_id::text ORDER BY link.operation_id::text)
                AS "operationIds"
       FROM ops.discovery_operations session_operation
       JOIN ops.discovery_operation_candidates link
         ON link.operation_id = session_operation.id
        AND link.workspace_id = session_operation.workspace_id
       JOIN ops.discovery_candidates candidate
         ON candidate.id = link.candidate_id AND candidate.workspace_id = link.workspace_id
       WHERE session_operation.query_session_id = $1
         AND session_operation.workspace_id = $2
       GROUP BY candidate.id
       ORDER BY candidate.title, candidate.id`,
      [querySessionId, workspaceId],
    ),
    pool.query<JsonRow>(
      `SELECT id, task_key AS "taskKey", adapter_version AS "adapterVersion",
              model_identifier AS "modelIdentifier", schema_version AS "schemaVersion",
              output, source_anchors AS "sourceAnchors", usage, safety_checks AS "safetyChecks",
              review_state AS "reviewState", created_at AS "createdAt"
       FROM ops.semantic_proposals
       WHERE operation_id = $1 AND workspace_id = $2`,
      [operationId, workspaceId],
    ),
  ]);
  const query = operation.rows[0]!.queryInterpretation as QueryInterpretation;
  const researchRunId = operation.rows[0]!.researchRunId;
  const researchRun =
    typeof researchRunId === 'string'
      ? await pool.query<JsonRow>(
          `SELECT id, state, maximum_external_calls AS "maximumExternalCalls",
                  maximum_candidates AS "maximumCandidates",
                  maximum_elapsed_ms AS "maximumElapsedMs",
                  first_pass_coverage AS "firstPassCoverage",
                  final_coverage AS "finalCoverage", stop_reason AS "stopReason",
                  observed_plan AS "observedPlan", observed_plan_hash AS "observedPlanHash",
                  completed_pass_count AS "completedPassCount",
                  retrieval_receipt AS "retrievalReceipt",
                  retrieval_receipt_hash AS "retrievalReceiptHash",
                  started_at AS "startedAt", deadline_at AS "deadlineAt",
                  finished_at AS "finishedAt", updated_at AS "updatedAt"
           FROM ops.research_runs WHERE id = $1 AND workspace_id = $2`,
          [researchRunId, workspaceId],
        )
      : null;
  const researchOperations =
    typeof researchRunId === 'string'
      ? await pool.query<JsonRow>(
          `SELECT id, adapter_key AS "adapterKey", state, pass_index AS "passIndex",
                  variant_index AS "variantIndex", source_plan_state AS "sourcePlanState",
                  safe_detail AS "safeDetail"
           FROM ops.discovery_operations
           WHERE research_run_id = $1 AND workspace_id = $2
           ORDER BY pass_index, created_at, id`,
          [researchRunId, workspaceId],
        )
      : null;
  const typedCandidates = candidates.rows as Array<
    JsonRow & {
      id: string;
      adapterKey: string;
      title: string;
      summary: string;
      kindHint: string | null;
      sourcePayload: unknown;
      canonicalUri: string;
      operationIds: string[];
    }
  >;
  const documents = typedCandidates.map(discoveryLeadRetrievalDocument);
  let firstPassCoverage = assessResearchCoverage(query, []);
  const pipeline = runRetrievalPipeline(documents, query, {
    fusionPolicy: 'normalized-weighted-fusion-v1',
    maximumCandidates: 200,
    shouldRunSecondPass: (firstPassCandidates, resolvedDocuments) => {
      const documentByCandidate = new Map(
        resolvedDocuments.map((document) => [document.candidateKey, document] as const),
      );
      firstPassCoverage = assessResearchCoverage(
        query,
        firstPassCandidates
          .slice(0, 100)
          .map((candidate) => documentByCandidate.get(candidate.candidateKey))
          .filter((document): document is RetrievalDocument => Boolean(document))
          .map((document) => ({
            entityClass: document.entityClass,
            group: document.kind === 'other' ? null : document.kind,
          })),
      );
      return firstPassCoverage.needsSecondPass;
    },
  });
  const candidateByKey = new Map<string, (typeof typedCandidates)[number]>(
    typedCandidates.map((candidate) => [`lead:${candidate.id}`, candidate] as const),
  );
  const currentPassCount = Math.max(
    1,
    ...(researchOperations?.rows.map((row) => Number(row.passIndex ?? 1)) ?? [1]),
  ) as 1 | 2;
  const activeReceipt = researchRetrievalReceipt(
    query.sourceText ?? query.normalizedText,
    query,
    typedCandidates,
    pipeline,
    currentPassCount,
  );
  const persistedReceipt = researchRun?.rows[0]?.retrievalReceipt as
    | ResearchRetrievalReceipt
    | null
    | undefined;
  const displayedReceipt =
    persistedReceipt?.policyVersion === 'live-research-receipt-v1'
      ? persistedReceipt
      : activeReceipt;
  const scoredCandidates = displayedReceipt.candidateLineage.flatMap((retrieval) => {
    const representative = candidateByKey.get(`lead:${retrieval.candidateId}`);
    if (!representative) return [];
    const scored = scoreDiscoveryCandidate(query, representative);
    const relevance =
      retrieval.matchBand === 'Direct'
        ? { ordinal: 'direct', value: 100 }
        : retrieval.matchBand === 'Strong'
          ? { ordinal: 'partial', value: 75 }
          : retrieval.matchBand === 'Related'
            ? { ordinal: 'complementary', value: 50 }
            : { ordinal: 'incidental', value: 25 };
    return [
      {
        ...scored,
        matchedTerms: retrieval.matchedTerms,
        relevanceOrdinal: relevance.ordinal,
        relevanceValue: relevance.value,
        matchScore: retrieval.matchScore,
        matchBand: retrieval.matchBand,
        matchReasons: retrieval.reasons,
        matchPolicyVersion: 'retrieval-match-v1',
        sourceAdapters: retrieval.sourceAdapters,
        operationIds: retrieval.operationIds,
        contributingCandidateIds: retrieval.contributingCandidateIds,
        fusionPolicy: retrieval.fusionPolicy,
        fusedRank: retrieval.fusedRank,
        rerankPolicy: retrieval.rerankPolicy,
        rerankPosition: retrieval.rerankPosition,
      },
    ];
  });
  return {
    ...operation.rows[0],
    attempts: attempts.rows,
    candidates: scoredCandidates,
    candidateScope: 'query_session_fused',
    retrievalMethod: {
      policyVersion: displayedReceipt.retrievalPipelineVersion,
      receiptPolicyVersion: displayedReceipt.policyVersion,
      receiptHash: researchRun?.rows[0]?.retrievalReceiptHash ?? hashCanonical(displayedReceipt),
      fusionPolicy: displayedReceipt.fusionPolicy,
      rerankPolicy: displayedReceipt.rerankPolicy,
      passes: displayedReceipt.completedPassCount,
      firstPassCoverage: researchRun?.rows[0]?.firstPassCoverage ?? firstPassCoverage,
      candidatePoolHash: displayedReceipt.candidatePoolHash,
      duplicateResolutionCount: displayedReceipt.duplicateResolutions.filter(
        (resolution) => resolution.method !== 'distinct',
      ).length,
    },
    researchRun: researchRun?.rows[0] ?? null,
    researchOperations: researchOperations?.rows ?? [],
    semanticProposal: semanticProposal.rows[0] ?? null,
  };
}

export async function cancelDiscoveryOperation(
  pool: Pool,
  workspaceId: string,
  operationId: string,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const result = await client.query<JsonRow>(
      `UPDATE ops.discovery_operations
       SET state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
           safe_detail = 'Cancellation stops future dispatch; a submitted request may still complete.',
           finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND state IN ('queued', 'running')
       RETURNING id, state, safe_detail AS "safeDetail", research_run_id AS "researchRunId"`,
      [operationId, workspaceId],
    );
    if (!result.rowCount) throw new ConflictError('Operation is not cancellable.');
    const researchRunId = result.rows[0]!.researchRunId;
    if (result.rows[0]!.state === 'cancelled' && typeof researchRunId === 'string') {
      await advanceResearchRunWithClient(client, workspaceId, researchRunId);
    }
    return result.rows[0];
  });
}

interface DiscoveryTaskPayload {
  operationId: string;
  workspaceId: string;
}

function adapterFor(config: {
  adapterKey: string;
  baseUrl: string | null;
  timeoutMs: number;
  responseByteLimit: number;
}): DiscoveryAdapter {
  const options = { timeoutMs: config.timeoutMs, maximumBytes: config.responseByteLimit };
  if (config.adapterKey === 'github') return createGitHubDiscoveryAdapter(options);
  if (config.adapterKey === 'mcp_registry') return createMcpRegistryDiscoveryAdapter(options);
  if (config.adapterKey === 'hacker_news') return createHackerNewsDiscoveryAdapter(options);
  if (config.adapterKey === 'searxng' && config.baseUrl) {
    return createSearxngDiscoveryAdapter(config.baseUrl, options);
  }
  throw new Error('adapter_not_configured');
}

export async function processDiscoveryOperation(
  pool: Pool,
  payload: DiscoveryTaskPayload,
  adapterOverride?: DiscoveryAdapter,
): Promise<void> {
  const claimToken = newOpaqueId();
  const claimed = await pool.query<{
    adapterKey: string;
    intent: 'explore' | 'deepen';
    baseUrl: string | null;
    timeoutMs: number;
    responseByteLimit: number;
    query: string;
    attempt: number;
    startedAt: Date;
    researchRunId: string | null;
    passIndex: 1 | 2;
  }>(
    `UPDATE ops.discovery_operations operation
     SET state = 'running', started_at = COALESCE(started_at, now()),
         lease_token = $3,
         lease_until = now() + (config.timeout_ms + 10000) * interval '1 millisecond',
         updated_at = now()
     FROM ops.source_adapter_configs config
     WHERE operation.id = $1 AND operation.workspace_id = $2 AND operation.state = 'queued'
       AND config.adapter_key = operation.adapter_key AND config.enabled
     RETURNING operation.adapter_key AS "adapterKey", operation.intent,
               config.base_url AS "baseUrl",
               config.timeout_ms AS "timeoutMs", config.response_byte_limit AS "responseByteLimit",
               operation.outbound_query AS query,
               operation.started_at AS "startedAt",
               operation.research_run_id AS "researchRunId",
               operation.pass_index AS "passIndex",
               COALESCE((SELECT max(attempt) + 1 FROM ops.discovery_attempts
                         WHERE operation_id = operation.id), 1)::int AS attempt`,
    [payload.operationId, payload.workspaceId, claimToken],
  );
  if (!claimed.rowCount) return;
  const row = claimed.rows[0]!;
  let result;
  try {
    const adapter = adapterOverride ?? adapterFor(row);
    if (adapter.key !== row.adapterKey) throw new Error('adapter_key_mismatch');
    result = await adapter.search(row.query, 20);
  } catch {
    result = {
      state: 'failed' as const,
      leads: [] as [],
      responseBytes: 0,
      httpStatus: null,
      errorCode: 'upstream' as const,
    };
  }
  await inTransaction(pool, async (client) => {
    const latest = await client.query<{ state: string; leaseToken: string | null }>(
      `SELECT state, lease_token AS "leaseToken"
       FROM ops.discovery_operations WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [payload.operationId, payload.workspaceId],
    );
    if (latest.rows[0]?.leaseToken !== claimToken) return;
    const cancelled = latest.rows[0]?.state === 'cancel_requested';
    let uniqueCandidates = 0;
    for (const lead of result.leads) {
      const candidateId = newOpaqueId();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ops.discovery_candidates
           (id, operation_id, workspace_id, adapter_key, external_id, canonical_uri,
            title, summary, kind_hint, source_payload_hash, source_payload, provenance, review_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'lead')
         ON CONFLICT (workspace_id, adapter_key, external_id, source_payload_hash) DO NOTHING`,
        [
          candidateId,
          payload.operationId,
          payload.workspaceId,
          row.adapterKey,
          lead.externalId,
          lead.canonicalUri,
          lead.title,
          lead.summary,
          lead.kindHint,
          hashCanonical(lead.payload),
          json(lead.payload),
          json(lead.provenance),
        ],
      );
      const persistedCandidateId = inserted.rows[0]?.id
        ? inserted.rows[0].id
        : (
            await client.query<{ id: string }>(
              `SELECT id FROM ops.discovery_candidates
               WHERE workspace_id = $1 AND adapter_key = $2 AND external_id = $3
                 AND source_payload_hash = $4`,
              [
                payload.workspaceId,
                row.adapterKey,
                lead.externalId,
                hashCanonical(lead.payload),
              ],
            )
          ).rows[0]!.id;
      await client.query(
        `INSERT INTO ops.discovery_operation_candidates
           (operation_id, candidate_id, workspace_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [payload.operationId, persistedCandidateId, payload.workspaceId],
      );
      if (inserted.rowCount) {
        uniqueCandidates += 1;
        const originClass =
          row.adapterKey === 'github'
            ? 'repository'
            : row.adapterKey === 'mcp_registry'
              ? 'structured_registry'
              : row.adapterKey === 'hacker_news'
                ? 'community'
                : 'general_web';
        const primarySourceUri =
          row.adapterKey === 'github' || row.adapterKey === 'mcp_registry'
            ? lead.canonicalUri
            : null;
        await client.query(
          `INSERT INTO ops.discovery_candidate_origins
             (id, discovery_candidate_id, workspace_id, origin_class, retrieved_via,
              origin_uri, primary_source_uri, corroboration_state, provenance_detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            newOpaqueId(),
            persistedCandidateId,
            payload.workspaceId,
            originClass,
            row.adapterKey,
            lead.canonicalUri,
            primarySourceUri,
            primarySourceUri ? 'primary_only' : 'unverified_lead',
            json(lead.provenance),
          ],
        );
      }
    }
    const finalState = cancelled
      ? 'cancelled'
      : result.state === 'failed'
        ? 'failed'
        : result.state;
    await client.query(
      `INSERT INTO ops.discovery_attempts
         (id, operation_id, workspace_id, attempt, request_hash, state, http_status,
          response_bytes, result_count, cost_state, error_code, safe_detail, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unavailable', $10, $11, $12, now())`,
      [
        newOpaqueId(),
        payload.operationId,
        payload.workspaceId,
        row.attempt,
        hashCanonical({ adapter: row.adapterKey, queryHash: hashCanonical(row.query) }),
        cancelled
          ? 'cancelled'
          : result.state === 'failed'
            ? 'failed'
            : result.state === 'partial'
              ? 'partial'
              : 'succeeded',
        result.httpStatus,
        result.responseBytes,
        result.leads.length,
        result.state === 'failed' ? result.errorCode : null,
        cancelled
          ? 'Cancellation observed after dispatch; upstream completion/cost may be unknown.'
          : result.state === 'failed'
            ? 'Adapter request failed under its configured boundary.'
            : 'Bounded adapter request completed.',
        row.startedAt,
      ],
    );
    await client.query(
      `UPDATE ops.discovery_operations
       SET state = $3, consumed_calls = consumed_calls + 1, result_count = $4,
           error_code = $5, safe_detail = $6, finished_at = now(), updated_at = now()
           , lease_token = NULL, lease_until = NULL
       WHERE id = $1 AND workspace_id = $2`,
      [
        payload.operationId,
        payload.workspaceId,
        finalState,
        result.leads.length,
        result.state === 'failed' ? result.errorCode : null,
        result.state === 'failed'
          ? 'Discovery failed; cached results remain available.'
          : `Recorded ${result.leads.length} attributed lead(s); none are admitted knowledge yet.`,
      ],
    );
    await client.query(
      `UPDATE ops.adapter_daily_budgets SET consumed_calls = consumed_calls + 1, updated_at = now()
       WHERE adapter_key = $1 AND budget_date = current_date`,
      [row.adapterKey],
    );
    await client.query(
      `INSERT INTO ops.source_health_events
         (id, adapter_key, state, safe_detail, checked_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        newOpaqueId(),
        row.adapterKey,
        result.state === 'failed'
          ? 'failed'
          : result.state === 'complete'
            ? 'healthy'
            : result.state,
        result.state === 'failed'
          ? 'Bounded discovery request failed.'
          : 'Bounded discovery request completed.',
      ],
    );
    const finishedAt = new Date();
    await client.query(
      `INSERT INTO ops.adapter_yield_observations
         (id, adapter_key, source_value_policy_version, intent, attempted_calls,
          successful_calls, returned_candidates, unique_candidates, duration_ms,
          cost_state, health_state, window_start, window_end)
       VALUES ($1, $2, 'source-value-v1', $3, 1, $4, $5, $6, $7,
               'unavailable', $8, $9, $10)`,
      [
        newOpaqueId(),
        row.adapterKey,
        row.intent,
        result.state === 'failed' ? 0 : 1,
        result.leads.length,
        uniqueCandidates,
        Math.max(0, finishedAt.getTime() - row.startedAt.getTime()),
        result.state === 'complete' ? 'healthy' : result.state,
        row.startedAt,
        finishedAt,
      ],
    );
    if (row.researchRunId) {
      await advanceResearchRunWithClient(client, payload.workspaceId, row.researchRunId);
    }
  });
}

/**
 * Terminally accounts for live-source work whose worker lease expired. The unknown request is not
 * replayed: doing so could duplicate a non-idempotent upstream call. Advancing the parent run keeps
 * partial-source behavior truthful and prevents the Search UI from polling forever.
 */
export async function recoverStaleDiscoveryOperations(pool: Pool, limit = 50): Promise<number> {
  return inTransaction(pool, async (client) => {
    const stale = await client.query<{
      id: string;
      workspaceId: string;
      adapterKey: string;
      state: 'running' | 'cancel_requested';
      outboundQueryHash: string;
      reservedCalls: number;
      startedAt: Date | null;
      researchRunId: string | null;
      nextAttempt: number;
    }>(
      `SELECT operation.id, operation.workspace_id AS "workspaceId",
              operation.adapter_key AS "adapterKey", operation.state,
              operation.outbound_query_hash AS "outboundQueryHash",
              operation.reserved_calls AS "reservedCalls", operation.started_at AS "startedAt",
              operation.research_run_id AS "researchRunId", attempts."nextAttempt"
       FROM ops.discovery_operations operation
       CROSS JOIN LATERAL (
         SELECT LEAST(3, COALESCE(max(attempt), 0) + 1)::int AS "nextAttempt"
         FROM ops.discovery_attempts
         WHERE operation_id = operation.id AND workspace_id = operation.workspace_id
       ) attempts
       WHERE operation.state IN ('running', 'cancel_requested')
         AND operation.lease_until < now()
       ORDER BY operation.lease_until, operation.id
       FOR UPDATE OF operation SKIP LOCKED
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    const touchedRuns = new Set<string>();
    for (const operation of stale.rows) {
      const cancelled = operation.state === 'cancel_requested';
      await client.query(
        `INSERT INTO ops.discovery_attempts
           (id, operation_id, workspace_id, attempt, request_hash, state,
            result_count, cost_state, error_code, safe_detail, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 'unavailable', 'worker_lost',
                 'The worker lease expired; upstream completion and cost are unknown.',
                 COALESCE($7, now()), now())
         ON CONFLICT (operation_id, attempt) DO NOTHING`,
        [
          newOpaqueId(),
          operation.id,
          operation.workspaceId,
          operation.nextAttempt,
          operation.outboundQueryHash,
          cancelled ? 'cancelled' : 'failed',
          operation.startedAt,
        ],
      );
      await client.query(
        `UPDATE ops.discovery_operations
         SET state = $3, consumed_calls = GREATEST(consumed_calls, reserved_calls),
             error_code = 'worker_lost',
             safe_detail = 'Worker lease expired; no automatic external replay was attempted.',
             lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [operation.id, operation.workspaceId, cancelled ? 'cancelled' : 'failed'],
      );
      if (operation.reservedCalls > 0) {
        await client.query(
          `UPDATE ops.adapter_daily_budgets
           SET consumed_calls = consumed_calls + 1, updated_at = now()
           WHERE adapter_key = $1 AND budget_date = current_date`,
          [operation.adapterKey],
        );
      }
      if (operation.researchRunId) touchedRuns.add(operation.researchRunId);
    }
    for (const runId of touchedRuns) {
      const workspaceId = stale.rows.find((row) => row.researchRunId === runId)!.workspaceId;
      await advanceResearchRunWithClient(client, workspaceId, runId);
    }
    return stale.rowCount ?? 0;
  });
}

export async function admitDiscoveryCandidate(
  pool: Pool,
  workspaceId: string,
  candidateId: string,
  input: DiscoveryAdmissionBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const candidate = await client.query<{
      adapterKey: string;
      title: string;
      summary: string;
      canonicalUri: string;
      kindHint: string | null;
      admissionId: string | null;
    }>(
      `SELECT dc.adapter_key AS "adapterKey", dc.title, dc.summary,
              dc.canonical_uri AS "canonicalUri", dc.kind_hint AS "kindHint",
              da.id AS "admissionId"
       FROM ops.discovery_candidates dc
       LEFT JOIN ops.discovery_admissions da ON da.discovery_candidate_id = dc.id
       WHERE dc.id = $1 AND dc.workspace_id = $2
       FOR UPDATE OF dc`,
      [candidateId, workspaceId],
    );
    if (!candidate.rowCount) throw new NotFoundError('Discovery candidate not found.');
    if (candidate.rows[0]!.admissionId) {
      throw new ConflictError('Candidate is already admitted.');
    }
    const row = candidate.rows[0]!;
    const inferred = discoveryLeadType(row);
    const entityClass = input.entityClass ?? inferred.subjectType;
    const title = input.title ?? row.title;
    const summary = input.summary ?? row.summary;
    const publisher = input.publisher ?? new URL(row.canonicalUri).hostname;
    const inferredImplementationKind =
      row.kindHint === 'repository' || row.kindHint === 'tool'
        ? 'oss_project'
        : (row.kindHint ?? 'other');
    const inferredDocumentKind =
      row.kindHint === 'article'
        ? 'article'
        : row.kindHint === 'paper' || row.kindHint === 'research'
          ? 'research'
          : row.kindHint === 'specification'
            ? 'specification'
            : row.kindHint === 'standard'
              ? 'standard'
              : 'resource';
    const kind = input.kind ??
      (entityClass === 'document' ? inferredDocumentKind : inferredImplementationKind);
    let furnished:
      | {
          subjectType: 'implementation';
          id: string;
          revision: number;
          projectionId: string;
          evidenceId: string;
          knowledgeEntityId: string;
        }
      | {
          subjectType: 'document';
          id: string;
          revision: number;
          projectionId: null;
          evidenceId: string;
          knowledgeEntityId: string;
        };
    if (entityClass === 'document') {
      const document = await furnishKnowledgeDocumentWithClient(client, workspaceId, {
        title,
        summary,
        documentKind: kind,
        canonicalUrl: row.canonicalUri,
        sourceTitle: `${row.title} discovery source`,
        publisher,
        capabilityKey: input.capabilityKey,
        capabilityName: input.capabilityName,
        searchTerms: input.searchTerms,
        limitations: input.limitations,
        reviewState: input.reviewState,
      });
      furnished = { ...document, subjectType: 'document', projectionId: null };
    } else {
      const optionInput: KnowledgeOptionBody = {
        name: title,
        kind,
        description: summary,
        canonicalUrl: row.canonicalUri,
        sourceTitle: `${row.title} discovery source`,
        sourceOwner: publisher,
        capabilityKey: input.capabilityKey,
        capabilityName: input.capabilityName,
        searchTerms: input.searchTerms,
        limitations: input.limitations,
        reviewState: input.reviewState,
      };
      const implementation = (await furnishKnowledgeOptionWithClient(
        client,
        workspaceId,
        optionInput,
      )) as {
        id: string;
        revision: number;
        projectionId: string;
        evidenceId: string;
        knowledgeEntityId: string;
      };
      furnished = { ...implementation, subjectType: 'implementation' };
    }
    const observation = await client.query<{ id: string }>(
      `SELECT source_observation_id AS id FROM catalog.evidence_items WHERE id = $1`,
      [furnished.evidenceId],
    );
    const admissionId = newOpaqueId();
    await client.query(
      `INSERT INTO ops.discovery_admissions
         (id, discovery_candidate_id, workspace_id, provider_id, provider_revision,
          document_id, document_revision, knowledge_entity_id, source_observation_id,
          evidence_item_id, projection_id, actor_type, rationale, input_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'human', $12, $13)`,
      [
        admissionId,
        candidateId,
        workspaceId,
        furnished.subjectType === 'implementation' ? furnished.id : null,
        furnished.subjectType === 'implementation' ? furnished.revision : null,
        furnished.subjectType === 'document' ? furnished.id : null,
        furnished.subjectType === 'document' ? furnished.revision : null,
        furnished.knowledgeEntityId,
        observation.rows[0]!.id,
        furnished.evidenceId,
        furnished.projectionId,
        input.rationale,
        hashCanonical({ candidateId, input, entityClass, kind, entityId: furnished.id }),
      ],
    );
    await client.query(
      `INSERT INTO ops.adapter_yield_observations
         (id, adapter_key, source_value_policy_version, intent, attempted_calls,
          successful_calls, returned_candidates, unique_candidates, admitted_candidates,
          duration_ms, cost_state, health_state, window_start, window_end)
       VALUES ($1, $2, 'source-value-v1', 'deepen', 0, 0, 0, 0, 1,
               0, 'zero', 'unknown', now(), now())`,
      [newOpaqueId(), row.adapterKey],
    );
    return {
      id: admissionId,
      candidateId,
      entityClass,
      kind,
      knowledgeEntityId: furnished.knowledgeEntityId,
      providerId: furnished.subjectType === 'implementation' ? furnished.id : null,
      documentId: furnished.subjectType === 'document' ? furnished.id : null,
      projectionId: furnished.projectionId,
    };
  });
}
