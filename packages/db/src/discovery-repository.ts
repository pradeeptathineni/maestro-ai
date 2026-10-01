import type { Pool, PoolClient } from 'pg';
import type {
  AdapterConfigBody,
  DiscoveryAdmissionBody,
  DiscoveryRequestBody,
  KnowledgeOptionBody,
} from '../../contracts/src/index.js';
import {
  hashCanonical,
  buildDiscoveryPlan,
  interpretQuery,
  lexicalRelevance,
  newOpaqueId,
  type DiscoveryPlan,
  type DiscoveryRouteState,
  type QueryInterpretation,
} from '../../domain/src/index.js';
import {
  calculateQuerySignalV2,
  querySignalKindProfile,
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
import { furnishKnowledgeOption } from './authoring-repository.js';
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

export function scoreDiscoveryCandidate(
  query: string | QueryInterpretation,
  candidate: JsonRow & {
    id: string;
    title: string;
    summary: string;
    kindHint: string | null;
    sourcePayload: unknown;
  },
): JsonRow {
  const interpretation = typeof query === 'string' ? interpretQuery(query) : query;
  const relevance = lexicalRelevance(interpretation, {
    name: candidate.title,
    aliases: [],
    capabilities: candidate.kindHint ? [candidate.kindHint] : [],
    searchText: `${candidate.title} ${candidate.summary}`,
  });
  const signal = calculateQuerySignalV2({
    relevanceOrdinal: relevance.ordinal,
    relevanceMethod: 'rule',
    dimensions: discoveryLeadValueProfile(candidate),
    kindProfile: querySignalKindProfile(candidate.kindHint ?? 'other'),
    provisional: true,
  });
  const publicCandidate = { ...candidate };
  delete publicCandidate.sourcePayload;
  return {
    ...publicCandidate,
    matchedTerms: relevance.matchedTerms,
    relevanceOrdinal: relevance.ordinal,
    relevanceValue: relevance.value,
    signalDisplay: signal.signalDisplay,
    signalUnrounded: signal.signalUnrounded,
    evidenceCoverage: signal.evidenceCoverage,
    displayState: signal.displayState,
    signalBand: signal.band,
    signalPolicyVersion: signal.policyVersion,
    signalExplanation:
      'Preliminary query signal from source metadata. Review, project fit, and deeper evidence remain separate.',
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
    FROM ops.source_adapter_configs config
    LEFT JOIN LATERAL (
      SELECT * FROM ops.source_health_events health
      WHERE health.adapter_key = config.adapter_key ORDER BY checked_at DESC LIMIT 1
    ) latest ON true
    LEFT JOIN ops.adapter_daily_budgets budget
      ON budget.adapter_key = config.adapter_key AND budget.budget_date = current_date
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

export async function requestDiscovery(
  pool: Pool,
  workspaceId: string,
  querySessionId: string,
  input: DiscoveryRequestBody,
  route?: {
    planRouteId: string;
    variantIndex: number;
    routingReason: string;
    sourcePlanState: DiscoveryRouteState;
    outboundQuery: string | null;
    researchRunId?: string;
    researchStep?: number;
    researchActionKey?: string;
    resultSetId?: string;
    resultLimit?: number;
    dispatch?: 'outbox' | 'inline';
  },
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
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
         WHERE current.query_session_id = qs.id
           AND ($3::uuid IS NULL OR current.id = $3::uuid)
         ORDER BY revision DESC LIMIT 1
       ) qrs ON true
       WHERE qs.id = $1 AND qs.workspace_id = $2 AND qs.deleted_at IS NULL`,
      [querySessionId, workspaceId, route?.resultSetId ?? null],
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
          result_limit, safe_detail, finished_at, plan_route_id, variant_index, routing_reason,
          source_plan_state, research_run_id, research_step, research_action_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, CASE WHEN $11 IN ('not_configured', 'budget_denied', 'skipped', 'unsupported')
                    THEN now() ELSE NULL END, $15, $16, $17, $18, $19, $20, $21)`,
      [
        operationId,
        workspaceId,
        querySessionId,
        session.rows[0]!.resultSetId,
        input.adapterKey,
        input.idempotencyKey,
        route?.researchRunId ? 'research_action' : intent,
        route?.outboundQuery ?? input.approvedPublicQuery,
        hashCanonical(route?.outboundQuery ?? input.approvedPublicQuery),
        json({
          approvedBy: route ? 'bounded_source_plan' : 'human_request',
          sentFields: ['approvedPublicQuery'],
          privateProjectContextIncluded: false,
        }),
        state,
        reservedCalls,
        route?.resultLimit ?? 20,
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
        route?.researchStep ?? null,
        route?.researchActionKey ?? null,
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
      routingReason: route?.routingReason ?? null,
      sourcePlanState: route?.sourcePlanState ?? 'planned',
      resultLimit: route?.resultLimit ?? 20,
    };
  });
}

export async function requestEnabledDiscovery(
  pool: Pool,
  workspaceId: string,
  querySessionId: string,
  approvedPublicQuery: string,
  resultSetId?: string,
): Promise<unknown[]> {
  const session = await pool.query<{
    interpretation: QueryInterpretation;
    plan: DiscoveryPlan | null;
  }>(
    `SELECT qs.normalized_intent AS interpretation, qp.plan
     FROM workspace.query_sessions qs
     LEFT JOIN workspace.query_plans qp
       ON qp.query_session_id = qs.id AND qp.workspace_id = qs.workspace_id
     WHERE qs.id = $1 AND qs.workspace_id = $2 AND qs.deleted_at IS NULL`,
    [querySessionId, workspaceId],
  );
  if (!session.rowCount) throw new NotFoundError('Query session not found.');
  const plan =
    session.rows[0]!.plan ??
    buildDiscoveryPlan(approvedPublicQuery, session.rows[0]!.interpretation);
  const operations: unknown[] = [];
  for (const route of plan.routes) {
    operations.push(
      await requestDiscovery(
        pool,
        workspaceId,
        querySessionId,
        {
          adapterKey: route.adapterKey,
          approvedPublicQuery,
          idempotencyKey: `search:${querySessionId}:${route.id}:1`,
          intent: 'explore',
        },
        {
          planRouteId: route.id,
          variantIndex: 1,
          routingReason: route.reason,
          sourcePlanState: route.state,
          outboundQuery: route.variant,
          resultSetId,
        },
      ),
    );
  }
  return operations;
}

export async function getDiscoveryOperation(
  pool: Pool,
  workspaceId: string,
  operationId: string,
): Promise<unknown> {
  const operation = await pool.query<JsonRow>(
    `SELECT id, adapter_key AS "adapterKey", intent, disclosure, state,
            outbound_query AS "outboundQuery",
            plan_route_id AS "planRouteId", variant_index AS "variantIndex",
            routing_reason AS "routingReason", source_plan_state AS "sourcePlanState",
            reserved_calls AS "reservedCalls", consumed_calls AS "consumedCalls",
            result_count AS "resultCount", result_limit AS "resultLimit",
            error_code AS "errorCode",
            safe_detail AS "safeDetail", started_at AS "startedAt",
            finished_at AS "finishedAt", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM ops.discovery_operations WHERE id = $1 AND workspace_id = $2`,
    [operationId, workspaceId],
  );
  if (!operation.rowCount) throw new NotFoundError('Discovery operation not found.');
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
              candidate.canonical_uri AS "canonicalUri", candidate.title,
              candidate.summary, candidate.kind_hint AS "kindHint",
              candidate.source_payload AS "sourcePayload", candidate.provenance,
              candidate.review_state AS "reviewState", candidate.created_at AS "createdAt"
       FROM ops.discovery_operation_candidates link
       JOIN ops.discovery_candidates candidate ON candidate.id = link.discovery_candidate_id
       WHERE link.operation_id = $1 AND link.workspace_id = $2
       ORDER BY candidate.title, candidate.id`,
      [operationId, workspaceId],
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
  const outboundQuery = operation.rows[0]!.outboundQuery;
  const query = typeof outboundQuery === 'string' ? outboundQuery : '';
  const scoredCandidates = candidates.rows
    .map((candidate) =>
      scoreDiscoveryCandidate(
        query,
        candidate as JsonRow & {
          id: string;
          title: string;
          summary: string;
          kindHint: string | null;
          sourcePayload: unknown;
        },
      ),
    )
    .sort(
      (left, right) =>
        Number(right.signalUnrounded) - Number(left.signalUnrounded) ||
        String(left.title).localeCompare(String(right.title)),
    );
  return {
    ...operation.rows[0],
    attempts: attempts.rows,
    candidates: scoredCandidates,
    semanticProposal: semanticProposal.rows[0] ?? null,
  };
}

export async function cancelDiscoveryOperation(
  pool: Pool,
  workspaceId: string,
  operationId: string,
): Promise<unknown> {
  const result = await pool.query<JsonRow>(
    `UPDATE ops.discovery_operations
     SET state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
         safe_detail = 'Cancellation stops future dispatch; a submitted request may still complete.',
         finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END,
         updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND state IN ('queued', 'running')
     RETURNING id, state, safe_detail AS "safeDetail"`,
    [operationId, workspaceId],
  );
  if (!result.rowCount) throw new ConflictError('Operation is not cancellable.');
  return result.rows[0];
}

interface DiscoveryTaskPayload {
  operationId: string;
  workspaceId: string;
}

async function lockActiveResearchParentForOperation(
  client: PoolClient,
  payload: DiscoveryTaskPayload,
): Promise<boolean> {
  const association = await client.query<{ researchRunId: string | null }>(
    `SELECT research_run_id AS "researchRunId"
     FROM ops.discovery_operations WHERE id = $1 AND workspace_id = $2`,
    [payload.operationId, payload.workspaceId],
  );
  if (!association.rows[0]?.researchRunId) return true;
  const parent = await client.query<{ finishedAt: Date | null }>(
    `SELECT finished_at AS "finishedAt" FROM ops.research_runs
     WHERE id = $1 AND workspace_id = $2 FOR SHARE`,
    [association.rows[0].researchRunId, payload.workspaceId],
  );
  return Boolean(parent.rowCount && !parent.rows[0]!.finishedAt);
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
  interface ClaimedOperation {
    adapterKey: string;
    baseUrl: string | null;
    timeoutMs: number;
    responseByteLimit: number;
    resultLimit: number;
    query: string;
    attempt: number;
    startedAt: Date;
  }
  const row = await inTransaction(pool, async (client): Promise<ClaimedOperation | null> => {
    if (!(await lockActiveResearchParentForOperation(client, payload))) return null;
    const claimed = await client.query<ClaimedOperation>(
      `UPDATE ops.discovery_operations operation
       SET state = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
       FROM ops.source_adapter_configs config
       WHERE operation.id = $1 AND operation.workspace_id = $2 AND operation.state = 'queued'
         AND config.adapter_key = operation.adapter_key AND (config.enabled OR $3::boolean)
       RETURNING operation.adapter_key AS "adapterKey", config.base_url AS "baseUrl",
                 config.timeout_ms AS "timeoutMs", config.response_byte_limit AS "responseByteLimit",
                 operation.outbound_query AS query, operation.result_limit AS "resultLimit",
                 operation.started_at AS "startedAt",
                 COALESCE((SELECT max(attempt) + 1 FROM ops.discovery_attempts
                           WHERE operation_id = operation.id), 1)::int AS attempt`,
      [payload.operationId, payload.workspaceId, Boolean(adapterOverride)],
    );
    return claimed.rows[0] ?? null;
  });
  if (!row) return;
  let result;
  try {
    const adapter = adapterOverride ?? adapterFor(row);
    if (adapter.key !== row.adapterKey) throw new Error('adapter_key_mismatch');
    result = await adapter.search(row.query, row.resultLimit);
    result = { ...result, leads: result.leads.slice(0, row.resultLimit) };
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
    if (!(await lockActiveResearchParentForOperation(client, payload))) return;
    const latest = await client.query<{ state: string }>(
      `SELECT state FROM ops.discovery_operations WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [payload.operationId, payload.workspaceId],
    );
    if (!['running', 'cancel_requested'].includes(latest.rows[0]?.state ?? '')) return;
    const cancelled = latest.rows[0]?.state === 'cancel_requested';
    for (const lead of result.leads) {
      const candidateId = newOpaqueId();
      await client.query(
        `INSERT INTO ops.discovery_candidates
           (id, operation_id, workspace_id, adapter_key, external_id, canonical_uri,
            title, summary, kind_hint, source_payload_hash, source_payload, provenance, review_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'lead')
         ON CONFLICT (adapter_key, external_id, source_payload_hash) DO NOTHING`,
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
      const stored = await client.query<{ id: string }>(
        `SELECT id FROM ops.discovery_candidates
         WHERE workspace_id = $1 AND adapter_key = $2 AND external_id = $3
           AND source_payload_hash = $4`,
        [payload.workspaceId, row.adapterKey, lead.externalId, hashCanonical(lead.payload)],
      );
      if (stored.rowCount) {
        await client.query(
          `INSERT INTO ops.discovery_operation_candidates
             (operation_id, discovery_candidate_id, workspace_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [payload.operationId, stored.rows[0]!.id, payload.workspaceId],
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
  });
}

export async function admitDiscoveryCandidate(
  pool: Pool,
  workspaceId: string,
  candidateId: string,
  input: DiscoveryAdmissionBody,
): Promise<unknown> {
  const candidate = await pool.query<{
    title: string;
    summary: string;
    canonicalUri: string;
    kindHint: string | null;
    admissionId: string | null;
  }>(
    `SELECT dc.title, dc.summary, dc.canonical_uri AS "canonicalUri",
            dc.kind_hint AS "kindHint", da.id AS "admissionId"
     FROM ops.discovery_candidates dc
     LEFT JOIN ops.discovery_admissions da ON da.discovery_candidate_id = dc.id
     WHERE dc.id = $1 AND dc.workspace_id = $2`,
    [candidateId, workspaceId],
  );
  if (!candidate.rowCount) throw new NotFoundError('Discovery candidate not found.');
  if (candidate.rows[0]!.admissionId) throw new ConflictError('Candidate is already admitted.');
  const optionInput: KnowledgeOptionBody = {
    name: candidate.rows[0]!.title,
    kind: candidate.rows[0]!.kindHint ?? 'other',
    description: candidate.rows[0]!.summary,
    canonicalUrl: candidate.rows[0]!.canonicalUri,
    sourceTitle: `${candidate.rows[0]!.title} discovery source`,
    sourceOwner: 'External source publisher',
    capabilityKey: input.capabilityKey,
    capabilityName: input.capabilityName,
    searchTerms: input.searchTerms,
    limitations: input.limitations,
    reviewState: input.reviewState,
  };
  const furnished = (await furnishKnowledgeOption(pool, workspaceId, optionInput)) as {
    id: string;
    revision: number;
    projectionId: string;
    evidenceId: string;
  };
  const observation = await pool.query<{ id: string }>(
    `SELECT source_observation_id AS id FROM catalog.evidence_items WHERE id = $1`,
    [furnished.evidenceId],
  );
  const admissionId = newOpaqueId();
  await pool.query(
    `INSERT INTO ops.discovery_admissions
       (id, discovery_candidate_id, workspace_id, provider_id, provider_revision,
        source_observation_id, evidence_item_id, projection_id, actor_type, rationale, input_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'human', $9, $10)`,
    [
      admissionId,
      candidateId,
      workspaceId,
      furnished.id,
      furnished.revision,
      observation.rows[0]!.id,
      furnished.evidenceId,
      furnished.projectionId,
      input.rationale,
      hashCanonical({ candidateId, input, providerId: furnished.id }),
    ],
  );
  return {
    id: admissionId,
    candidateId,
    providerId: furnished.id,
    projectionId: furnished.projectionId,
  };
}
