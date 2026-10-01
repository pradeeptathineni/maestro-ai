import type { Pool } from 'pg';
import type { ResearchRunBody } from '../../contracts/src/index.js';
import { createLocalResearchModel } from '../../adapters/src/index.js';
import {
  executeResearchSkill,
  hashCanonical,
  newOpaqueId,
  RESEARCH_PROTOCOL_VERSION,
  RESEARCH_SKILL_VERSION,
  ResearchProtocolError,
  type ResearchAction,
  type ResearchCandidate,
  type ResearchJournalEvent,
  type ResearchModel,
  type ResearchModelRequest,
  type ResearchModelResponse,
  type ResearchPolicy,
  type ResearchSourceExecutor,
  type ResearchSourceResult,
} from '../../domain/src/index.js';
import {
  processDiscoveryOperation,
  requestDiscovery,
  requestEnabledDiscovery,
} from './discovery-repository.js';
import { ConflictError, NotFoundError } from './errors.js';
import { inTransaction } from './transaction.js';

const DEFAULT_RESEARCH_BUDGET = {
  maxSteps: 2,
  maxActionsPerStep: 3,
  maxCandidates: 60,
  maxResultsPerAction: 20,
  maxQueryLength: 300,
} as const;
const MODEL_CALL_RESERVATION = DEFAULT_RESEARCH_BUDGET.maxSteps + 1;
const RESEARCH_LEASE_SECONDS = 180;

interface ResearchTaskPayload {
  researchRunId: string;
  workspaceId: string;
}

interface ClaimedResearchRun {
  id: string;
  workspaceId: string;
  querySessionId: string;
  resultSetId: string;
  publicQuery: string;
  sessionAvailable: boolean;
  mode: 'search' | 'corpus';
  allowedSourceKeys: string[];
  budget: typeof DEFAULT_RESEARCH_BUDGET;
  modelConfigHash: string;
  expectedModelIdentifier: string;
  modelEnabled: boolean;
  currentAdapterVersion: string;
  currentBaseUrl: string | null;
  currentModelIdentifier: string | null;
  currentTimeoutMs: number;
  currentMaxInputTokens: number;
  currentMaxOutputTokens: number;
  leaseToken: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function reportedTokens(usage: unknown, key: 'inputTokens' | 'outputTokens'): number | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function researchPolicy(row: ClaimedResearchRun): ResearchPolicy {
  return {
    mode: row.mode,
    allowedSourceKeys: row.allowedSourceKeys,
    budget: row.budget,
  };
}

function proposalTaskKey(type: 'plan' | 'refinement' | 'synthesis'): string {
  return `research_${type}`;
}

function proposalCitations(output: unknown): string[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const record = output as Record<string, unknown>;
  const ids = new Set<string>();
  if (Array.isArray(record.citedCandidateIds)) {
    for (const id of record.citedCandidateIds) if (typeof id === 'string') ids.add(id);
  }
  if (Array.isArray(record.items)) {
    for (const value of record.items) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (typeof item.candidateId === 'string') ids.add(item.candidateId);
      if (Array.isArray(item.citationCandidateIds)) {
        for (const id of item.citationCandidateIds) if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return [...ids];
}

async function writeRunEvent(
  pool: Pool,
  row: Pick<ClaimedResearchRun, 'id' | 'workspaceId'>,
  step: number,
  eventType: 'source_result' | 'proposal_rejected' | 'run_failed' | 'run_recovered',
  payload: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO ops.research_run_events
       (id, research_run_id, workspace_id, step_index, event_type, payload_hash, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newOpaqueId(),
      row.id,
      row.workspaceId,
      step,
      eventType,
      hashCanonical(payload),
      json(payload),
    ],
  );
}

function genericTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 1),
    ),
  ];
}

async function retrieveCorpusEvidence(
  pool: Pool,
  query: string,
  maximum: number,
): Promise<ResearchCandidate[]> {
  const result = await pool.query<{
    id: string;
    title: string;
    summary: string;
    canonicalUri: string | null;
    observedAt: Date;
    searchText: string;
    sourceTypes: string[];
    reviewState: string;
    kindHint: string;
  }>(
    `SELECT projection.id::text AS id, projection.preferred_label AS title,
            projection.summary,
            source_data.canonical_uri AS "canonicalUri",
            COALESCE(source_data.observed_at, projection.indexed_at) AS "observedAt",
            projection.search_text AS "searchText", projection.kind_profile AS "kindHint",
            projection.publication_state AS "reviewState",
            COALESCE(source_data.source_types, ARRAY['local_catalog']::text[]) AS "sourceTypes"
     FROM catalog.knowledge_projections projection
     LEFT JOIN LATERAL (
       SELECT (array_agg(source.canonical_uri ORDER BY observation.observed_at DESC, source.id))[1]
                AS canonical_uri,
              max(observation.observed_at) AS observed_at,
              array_agg(DISTINCT source.source_type ORDER BY source.source_type) AS source_types
       FROM catalog.knowledge_projection_sources binding
       JOIN catalog.source_observations observation
         ON observation.id = binding.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       WHERE binding.projection_id = projection.id
     ) source_data ON true
     WHERE projection.publication_state <> 'withdrawn'
       AND (projection.expires_at IS NULL OR projection.expires_at > now())
     UNION ALL
     SELECT document.id::text, document.title, document.summary,
            document.canonical_uri, document.observed_at, document.search_text,
            document.document_kind, document.publication_state, ARRAY[source.source_type]::text[]
     FROM catalog.knowledge_documents document
     JOIN catalog.source_observations observation ON observation.id = document.source_observation_id
     JOIN catalog.sources source ON source.id = observation.source_id
     WHERE document.publication_state <> 'withdrawn'`,
  );
  const terms = genericTerms(query);
  const phrase = query.normalize('NFKC').trim().toLocaleLowerCase();
  return result.rows
    .map((row) => {
      const searchable = row.searchText.normalize('NFKC').toLocaleLowerCase();
      const overlap = terms.reduce((count, term) => count + (searchable.includes(term) ? 1 : 0), 0);
      return {
        row,
        score: overlap + (phrase && searchable.includes(phrase) ? terms.length + 1 : 0),
      };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.row.title.localeCompare(right.row.title),
    )
    .slice(0, maximum)
    .map(({ row }) => ({
      id: row.id,
      sourceKey: 'corpus',
      title: row.title,
      summary: row.summary,
      canonicalUri: row.canonicalUri ?? `urn:maestro:corpus:${row.id}`,
      observedAt: row.observedAt.toISOString(),
      sourceClass: 'local_corpus',
      sourceTypes: row.sourceTypes,
      reviewState: row.reviewState,
      kindHint: row.kindHint,
    }));
}

async function executeLiveAction(
  pool: Pool,
  row: ClaimedResearchRun,
  action: ResearchAction,
  step: number,
): Promise<ResearchSourceResult> {
  const requested = (await requestDiscovery(
    pool,
    row.workspaceId,
    row.querySessionId,
    {
      adapterKey: action.sourceKey as 'github' | 'mcp_registry' | 'searxng' | 'hacker_news',
      approvedPublicQuery: action.query,
      idempotencyKey: `research:${row.id}:${action.actionKey}`,
      intent: 'explore',
    },
    {
      planRouteId: action.actionKey,
      variantIndex: 1,
      routingReason: action.purpose,
      sourcePlanState: 'planned',
      outboundQuery: action.query,
      researchRunId: row.id,
      researchStep: step,
      researchActionKey: action.actionKey,
      resultSetId: row.resultSetId,
      resultLimit: action.maxResults,
      dispatch: 'inline',
    },
  )) as { id: string; state: string };
  if (requested.state === 'queued') {
    await processDiscoveryOperation(pool, {
      operationId: requested.id,
      workspaceId: row.workspaceId,
    });
  }
  const [operation, candidates] = await Promise.all([
    pool.query<{ state: string; safeDetail: string | null }>(
      `SELECT state, safe_detail AS "safeDetail"
       FROM ops.discovery_operations WHERE id = $1 AND workspace_id = $2`,
      [requested.id, row.workspaceId],
    ),
    pool.query<ResearchCandidate>(
      `SELECT candidate.id, candidate.adapter_key AS "sourceKey", candidate.title,
            candidate.summary, candidate.canonical_uri AS "canonicalUri",
            candidate.created_at::text AS "observedAt",
            config.source_class AS "sourceClass", candidate.review_state AS "reviewState",
            candidate.kind_hint AS "kindHint", ARRAY[candidate.adapter_key]::text[] AS "sourceTypes"
     FROM ops.discovery_operation_candidates link
     JOIN ops.discovery_candidates candidate ON candidate.id = link.discovery_candidate_id
     JOIN ops.source_adapter_configs config ON config.adapter_key = candidate.adapter_key
     WHERE link.operation_id = $1 AND link.workspace_id = $2
     ORDER BY candidate.title, candidate.id
     LIMIT $3`,
      [requested.id, row.workspaceId, action.maxResults],
    ),
  ]);
  const operationState = operation.rows[0]?.state ?? 'failed';
  const state =
    operationState === 'complete' && candidates.rowCount === 0
      ? 'empty'
      : [
            'complete',
            'partial',
            'failed',
            'not_configured',
            'budget_denied',
            'skipped',
            'unsupported',
            'cancelled',
          ].includes(operationState)
        ? (operationState as ResearchSourceResult['state'])
        : 'failed';
  return {
    state,
    candidates: candidates.rows,
    operationId: requested.id,
    safeDetail:
      operation.rows[0]?.safeDetail ??
      (state === 'failed' ? 'The source operation did not reach a terminal state.' : null),
  };
}

export async function requestResearchRun(
  pool: Pool,
  workspaceId: string,
  querySessionId: string,
  input: ResearchRunBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const existing = await client.query<{
      id: string;
      mode: string;
      strategy: string;
      state: string;
      safeDetail: string;
      createdAt: Date;
    }>(
      `SELECT id, mode, strategy, state, safe_detail AS "safeDetail",
              created_at AS "createdAt"
       FROM ops.research_runs WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, input.idempotencyKey],
    );
    if (existing.rowCount) return { ...existing.rows[0], duplicate: true };

    const session = await client.query<{ resultSetId: string; publicQuery: string }>(
      `SELECT result.id AS "resultSetId", session.query_text AS "publicQuery"
       FROM workspace.query_sessions session
       JOIN LATERAL (
         SELECT id FROM workspace.query_result_sets current
         WHERE current.query_session_id = session.id ORDER BY revision DESC LIMIT 1
       ) result ON true
       WHERE session.id = $1 AND session.workspace_id = $2 AND session.deleted_at IS NULL`,
      [querySessionId, workspaceId],
    );
    if (!session.rowCount) throw new NotFoundError('Query session not found.');

    const semantic = await client.query<{
      enabled: boolean;
      adapterVersion: string;
      baseUrl: string | null;
      modelIdentifier: string | null;
      dailyCallLimit: number;
      timeoutMs: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    }>(
      `SELECT enabled, adapter_version AS "adapterVersion", base_url AS "baseUrl",
              model_identifier AS "modelIdentifier", daily_call_limit AS "dailyCallLimit",
              timeout_ms AS "timeoutMs", max_input_tokens AS "maxInputTokens",
              max_output_tokens AS "maxOutputTokens"
       FROM ops.source_adapter_configs WHERE adapter_key = 'local_semantic' FOR UPDATE`,
    );
    if (!semantic.rowCount) throw new NotFoundError('Semantic adapter not found.');

    const sourceKeys =
      input.mode === 'corpus'
        ? ['corpus']
        : (
            await client.query<{ adapterKey: string }>(
              `SELECT adapter_key AS "adapterKey" FROM ops.source_adapter_configs
               WHERE enabled AND source_class <> 'local_semantic' ORDER BY adapter_key`,
            )
          ).rows.map((source) => source.adapterKey);
    const modelConfigured = Boolean(
      semantic.rows[0]!.enabled &&
      semantic.rows[0]!.baseUrl &&
      semantic.rows[0]!.modelIdentifier &&
      sourceKeys.length > 0,
    );
    let state: 'queued' | 'not_configured' | 'budget_denied' = 'not_configured';
    let reservedModelCalls = 0;
    if (modelConfigured) {
      await client.query(
        `INSERT INTO ops.adapter_daily_budgets (adapter_key, budget_date)
         VALUES ('local_semantic', current_date) ON CONFLICT DO NOTHING`,
      );
      const reserved = await client.query(
        `UPDATE ops.adapter_daily_budgets
         SET reserved_calls = reserved_calls + $1, updated_at = now()
         WHERE adapter_key = 'local_semantic' AND budget_date = current_date
           AND reserved_calls + $1 <= $2
         RETURNING reserved_calls`,
        [MODEL_CALL_RESERVATION, semantic.rows[0]!.dailyCallLimit],
      );
      if (reserved.rowCount) {
        state = 'queued';
        reservedModelCalls = MODEL_CALL_RESERVATION;
      } else {
        state = 'budget_denied';
        await client.query(
          `UPDATE ops.adapter_daily_budgets
           SET denied_calls = denied_calls + $1, updated_at = now()
           WHERE adapter_key = 'local_semantic' AND budget_date = current_date`,
          [MODEL_CALL_RESERVATION],
        );
      }
    }

    const policy: ResearchPolicy = {
      mode: input.mode,
      allowedSourceKeys: sourceKeys.length
        ? sourceKeys
        : [input.mode === 'corpus' ? 'corpus' : 'none'],
      budget: { ...DEFAULT_RESEARCH_BUDGET },
    };
    const configFingerprint = {
      adapterVersion: semantic.rows[0]!.adapterVersion,
      baseUrl: semantic.rows[0]!.baseUrl,
      modelIdentifier: semantic.rows[0]!.modelIdentifier,
      timeoutMs: semantic.rows[0]!.timeoutMs,
      maxInputTokens: semantic.rows[0]!.maxInputTokens,
      maxOutputTokens: semantic.rows[0]!.maxOutputTokens,
    };
    const runId = newOpaqueId();
    const terminal = state !== 'queued';
    const safeDetail =
      state === 'not_configured'
        ? 'Model-led research is unavailable; the deterministic Search or Corpus path remains available.'
        : state === 'budget_denied'
          ? 'The configured model-call budget denied this research run.'
          : 'Queued one bounded model-led research run.';
    await client.query(
      `INSERT INTO ops.research_runs
         (id, workspace_id, query_session_id, result_set_id, idempotency_key,
          mode, strategy, state, skill_version, protocol_version, query_hash, policy_hash,
          model_adapter_key, model_identifier, model_config_hash, allowed_source_keys,
          budget, disclosure, reserved_model_calls, safe_detail, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19, $20,
               CASE WHEN $21 THEN now() ELSE NULL END)`,
      [
        runId,
        workspaceId,
        querySessionId,
        session.rows[0]!.resultSetId,
        input.idempotencyKey,
        input.mode,
        modelConfigured ? 'model' : 'deterministic_fallback',
        state,
        RESEARCH_SKILL_VERSION,
        RESEARCH_PROTOCOL_VERSION,
        hashCanonical(session.rows[0]!.publicQuery),
        hashCanonical(policy),
        modelConfigured ? 'local_semantic' : null,
        modelConfigured ? semantic.rows[0]!.modelIdentifier : null,
        modelConfigured ? hashCanonical(configFingerprint) : null,
        sourceKeys.length ? sourceKeys : [input.mode === 'corpus' ? 'corpus' : 'none'],
        json(policy.budget),
        json({
          sentFields: ['publicQuery', 'publicEvidence', 'researchPolicy'],
          privateProjectContextIncluded: false,
          modelMayProposeOnlyAllowlistedSearchActions: true,
        }),
        reservedModelCalls,
        safeDetail,
        terminal,
      ],
    );
    if (state === 'queued') {
      await client.query(
        `INSERT INTO ops.outbox (id, operation_key, task_name, payload, state)
         VALUES ($1, $2, 'research_run_v1', $3, 'pending')`,
        [newOpaqueId(), `research:${runId}`, json({ researchRunId: runId, workspaceId })],
      );
    }
    return {
      id: runId,
      mode: input.mode,
      strategy: modelConfigured ? 'model' : 'deterministic_fallback',
      state,
      safeDetail,
      fallbackAvailable: state !== 'queued',
      duplicate: false,
    };
  });
}

async function claimResearchRun(
  pool: Pool,
  payload: ResearchTaskPayload,
): Promise<ClaimedResearchRun | null> {
  const leaseToken = newOpaqueId();
  const claimed = await pool.query<ClaimedResearchRun>(
    `UPDATE ops.research_runs run
     SET state = 'running', lease_token = $3,
         lease_until = now() + make_interval(secs => $4),
         started_at = COALESCE(started_at, now()), updated_at = now()
     FROM workspace.query_sessions session, ops.source_adapter_configs config
     WHERE run.id = $1 AND run.workspace_id = $2 AND run.state = 'queued'
       AND session.id = run.query_session_id AND session.workspace_id = run.workspace_id
       AND config.adapter_key = 'local_semantic'
     RETURNING run.id, run.workspace_id AS "workspaceId",
               run.query_session_id AS "querySessionId", run.result_set_id AS "resultSetId",
               session.query_text AS "publicQuery", session.deleted_at IS NULL AS "sessionAvailable",
               run.mode,
               run.allowed_source_keys AS "allowedSourceKeys", run.budget,
               run.model_config_hash AS "modelConfigHash",
               run.model_identifier AS "expectedModelIdentifier",
               config.enabled AS "modelEnabled",
               config.adapter_version AS "currentAdapterVersion",
               config.base_url AS "currentBaseUrl",
               config.model_identifier AS "currentModelIdentifier",
               config.timeout_ms AS "currentTimeoutMs",
               config.max_input_tokens AS "currentMaxInputTokens",
               config.max_output_tokens AS "currentMaxOutputTokens",
               run.lease_token AS "leaseToken"`,
    [payload.researchRunId, payload.workspaceId, leaseToken, RESEARCH_LEASE_SECONDS],
  );
  return claimed.rows[0] ?? null;
}

async function renewResearchLease(pool: Pool, row: ClaimedResearchRun): Promise<void> {
  const renewed = await pool.query(
    `UPDATE ops.research_runs
     SET lease_until = now() + make_interval(secs => $4), updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND lease_token = $3 AND state = 'running'
     RETURNING id`,
    [row.id, row.workspaceId, row.leaseToken, RESEARCH_LEASE_SECONDS],
  );
  if (!renewed.rowCount) throw new Error('research_lease_lost');
}

function currentModelFingerprint(row: ClaimedResearchRun): string | null {
  if (!row.currentBaseUrl || !row.currentModelIdentifier) return null;
  return hashCanonical({
    adapterVersion: row.currentAdapterVersion,
    baseUrl: row.currentBaseUrl,
    modelIdentifier: row.currentModelIdentifier,
    timeoutMs: row.currentTimeoutMs,
    maxInputTokens: row.currentMaxInputTokens,
    maxOutputTokens: row.currentMaxOutputTokens,
  });
}

export async function processResearchRun(
  pool: Pool,
  payload: ResearchTaskPayload,
  overrides?: { model?: ResearchModel; sources?: ResearchSourceExecutor },
): Promise<void> {
  const row = await claimResearchRun(pool, payload);
  if (!row) return;
  let modelCalls = 0;
  const modelTrace: {
    lastCall: { request: ResearchModelRequest; response: ResearchModelResponse } | null;
  } = { lastCall: null };
  let lastAcceptedOutputHash: string | null = null;
  const currentFingerprint = currentModelFingerprint(row);
  if (
    !row.sessionAvailable ||
    !row.modelEnabled ||
    currentFingerprint === null ||
    currentFingerprint !== row.modelConfigHash ||
    row.currentModelIdentifier !== row.expectedModelIdentifier
  ) {
    const errorCode = row.sessionAvailable ? 'model_config_changed' : 'session_unavailable';
    await writeRunEvent(pool, row, 0, 'run_failed', { errorCode });
    await pool.query(
      `UPDATE ops.research_runs
       SET state = 'failed', error_code = $4,
           safe_detail = CASE WHEN $4 = 'session_unavailable'
             THEN 'The query session was redacted before execution; no model call was made.'
             ELSE 'The configured local model changed before execution; no model call was made.' END,
           lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND lease_token = $3 AND state = 'running'`,
      [row.id, row.workspaceId, row.leaseToken, errorCode],
    );
    return;
  }
  const activeModel =
    overrides?.model ??
    createLocalResearchModel({
      baseUrl: row.currentBaseUrl!,
      model: row.currentModelIdentifier,
      timeoutMs: row.currentTimeoutMs,
      maxOutputTokens: row.currentMaxOutputTokens,
    });
  const model = {
    async propose(request: ResearchModelRequest): Promise<ResearchModelResponse> {
      if (Buffer.byteLength(JSON.stringify(request.payload), 'utf8') > row.currentMaxInputTokens) {
        throw new ResearchProtocolError(
          'budget_exceeded',
          'Serialized model input exceeded the configured conservative byte boundary.',
        );
      }
      await renewResearchLease(pool, row);
      modelCalls += 1;
      const response = await activeModel.propose(request);
      await renewResearchLease(pool, row);
      modelTrace.lastCall = { request, response };
      const inputTokens = reportedTokens(response.usage, 'inputTokens');
      const outputTokens = reportedTokens(response.usage, 'outputTokens');
      if (
        (inputTokens !== null && inputTokens > row.currentMaxInputTokens) ||
        (outputTokens !== null && outputTokens > row.currentMaxOutputTokens)
      ) {
        throw new ResearchProtocolError(
          'budget_exceeded',
          'Model-reported usage exceeded the configured per-call token boundary.',
        );
      }
      return response;
    },
  };
  let currentStep = 0;
  const journal = async (event: ResearchJournalEvent): Promise<void> => {
    currentStep = event.step;
    if (event.type === 'source_result') {
      await writeRunEvent(pool, row, event.step, 'source_result', {
        actionKey: event.action.actionKey,
        sourceKey: event.action.sourceKey,
        sourceState: event.sourceState,
        operationId: event.operationId,
        safeDetail: event.safeDetail,
        queryHash: hashCanonical(event.action.query),
        candidateIds: event.candidateIds,
        candidates: event.candidates,
      });
      return;
    }
    if (!modelTrace.lastCall) throw new Error('research_model_receipt_missing');
    const outputHash = hashCanonical(event.output);
    lastAcceptedOutputHash = outputHash;
    await pool.query(
      `INSERT INTO ops.semantic_proposals
         (id, workspace_id, query_session_id, operation_id, research_run_id,
          task_key, proposal_type, step_index, adapter_key, adapter_version,
          model_identifier, model_config_hash, schema_version, input_hash, output_hash,
          output, source_anchors, usage, safety_checks, validation_receipt, review_state)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'local_semantic', $8,
               $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'proposed')`,
      [
        newOpaqueId(),
        row.workspaceId,
        row.querySessionId,
        row.id,
        proposalTaskKey(event.proposalType),
        event.proposalType,
        event.step,
        row.currentAdapterVersion,
        event.modelIdentifier,
        row.modelConfigHash,
        RESEARCH_PROTOCOL_VERSION,
        hashCanonical(modelTrace.lastCall.request.payload),
        outputHash,
        json(event.output),
        json(proposalCitations(event.output)),
        json(event.usage),
        json({
          structuredOutput: true,
          allowedSourcesEnforcedByHost: true,
          evidenceIdsValidatedByHost: event.proposalType !== 'plan',
          inputBoundedBeforeDispatch: true,
          inputBoundaryUnit: 'utf8_bytes_conservative_against_configured_input_tokens',
          privateProjectContextIncluded: false,
          arbitraryToolAuthority: false,
        }),
        json({ acceptedByProtocol: true, protocolVersion: RESEARCH_PROTOCOL_VERSION }),
      ],
    );
  };

  try {
    const result = await executeResearchSkill(
      { publicQuery: row.publicQuery, policy: researchPolicy(row) },
      {
        model,
        sources: {
          async search(action) {
            await renewResearchLease(pool, row);
            const sourceResult = overrides?.sources
              ? await overrides.sources.search(action)
              : row.mode === 'corpus'
                ? await retrieveCorpusEvidence(pool, action.query, action.maxResults).then(
                    (candidates): ResearchSourceResult => ({
                      state: candidates.length ? 'complete' : 'empty',
                      candidates,
                      safeDetail: candidates.length
                        ? `Retrieved ${candidates.length} admitted Corpus record(s).`
                        : 'No admitted Corpus evidence matched this bounded query.',
                    }),
                  )
                : await executeLiveAction(pool, row, action, Math.max(0, modelCalls - 1));
            await renewResearchLease(pool, row);
            return sourceResult;
          },
        },
        journal,
      },
    );
    await inTransaction(pool, async (client) => {
      const completed = await client.query(
        `UPDATE ops.research_runs
         SET state = 'complete', consumed_model_calls = $4, stop_reason = $5,
             receipt = $6, safe_detail = $7, lease_token = NULL, lease_until = NULL,
             finished_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND lease_token = $3 AND state = 'running'`,
        [
          row.id,
          row.workspaceId,
          row.leaseToken,
          modelCalls,
          result.receipt.stopReason,
          json(result.receipt),
          `Model-led ${row.mode} completed with ${result.candidates.length} evidence candidate(s).`,
        ],
      );
      if (!completed.rowCount) throw new Error('research_lease_lost');
      await client.query(
        `UPDATE ops.adapter_daily_budgets
         SET consumed_calls = consumed_calls + $1, updated_at = now()
         WHERE adapter_key = 'local_semantic' AND budget_date = current_date`,
        [modelCalls],
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'research_lease_lost') return;
    const protocolCode = error instanceof ResearchProtocolError ? error.code : 'upstream';
    if (
      modelTrace.lastCall &&
      hashCanonical(modelTrace.lastCall.response.output) !== lastAcceptedOutputHash
    ) {
      await writeRunEvent(pool, row, currentStep, 'proposal_rejected', {
        proposalType: modelTrace.lastCall.request.proposalType,
        inputHash: hashCanonical(modelTrace.lastCall.request.payload),
        outputHash: hashCanonical(modelTrace.lastCall.response.output),
        output: modelTrace.lastCall.response.output,
        modelIdentifier: modelTrace.lastCall.response.modelIdentifier,
        rejectionCode: protocolCode,
      });
    }
    await writeRunEvent(pool, row, currentStep, 'run_failed', { errorCode: protocolCode });
    await inTransaction(pool, async (client) => {
      const failed = await client.query(
        `UPDATE ops.research_runs
         SET state = 'failed', consumed_model_calls = $4, error_code = $5,
             safe_detail = 'The bounded research run failed; stored evidence and fallback paths remain available.',
             lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND lease_token = $3 AND state = 'running'`,
        [row.id, row.workspaceId, row.leaseToken, modelCalls, protocolCode],
      );
      if (!failed.rowCount) throw new Error('research_lease_lost');
      await client.query(
        `UPDATE ops.adapter_daily_budgets
         SET consumed_calls = consumed_calls + $1, updated_at = now()
         WHERE adapter_key = 'local_semantic' AND budget_date = current_date`,
        [modelCalls],
      );
    });
  }
}

export async function getResearchRun(
  pool: Pool,
  workspaceId: string,
  researchRunId: string,
): Promise<unknown> {
  const run = await pool.query<{ mode: string; errorCode: string | null; state: string }>(
    `SELECT id, query_session_id AS "querySessionId", result_set_id AS "resultSetId",
            mode, strategy, state, skill_version AS "skillVersion",
            protocol_version AS "protocolVersion", model_identifier AS "modelIdentifier",
            allowed_source_keys AS "allowedSourceKeys", budget, disclosure,
            reserved_model_calls AS "reservedModelCalls",
            consumed_model_calls AS "consumedModelCalls", stop_reason AS "stopReason",
            receipt, error_code AS "errorCode", safe_detail AS "safeDetail",
            started_at AS "startedAt", finished_at AS "finishedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM ops.research_runs WHERE id = $1 AND workspace_id = $2`,
    [researchRunId, workspaceId],
  );
  if (!run.rowCount) throw new NotFoundError('Research run not found.');
  const [proposals, events, operations] = await Promise.all([
    pool.query(
      `SELECT id, proposal_type AS "proposalType", step_index AS step,
              model_identifier AS "modelIdentifier", schema_version AS "schemaVersion",
              output, source_anchors AS citations, usage,
              safety_checks AS "safetyChecks", validation_receipt AS "validationReceipt",
              review_state AS "reviewState", created_at AS "createdAt"
       FROM ops.semantic_proposals
       WHERE research_run_id = $1 AND workspace_id = $2
       ORDER BY step_index, created_at, id`,
      [researchRunId, workspaceId],
    ),
    pool.query(
      `SELECT step_index AS step, event_type AS "eventType", payload,
              created_at AS "createdAt"
       FROM ops.research_run_events
       WHERE research_run_id = $1 AND workspace_id = $2
       ORDER BY created_at, id`,
      [researchRunId, workspaceId],
    ),
    pool.query(
      `SELECT id, adapter_key AS "sourceKey", research_step AS step,
              research_action_key AS "actionKey", state, result_count AS "resultCount",
              error_code AS "errorCode", safe_detail AS "safeDetail"
       FROM ops.discovery_operations
       WHERE research_run_id = $1 AND workspace_id = $2
       ORDER BY research_step, created_at, id`,
      [researchRunId, workspaceId],
    ),
  ]);
  const candidates = new Map<string, ResearchCandidate>();
  for (const event of events.rows as Array<{ eventType: string; payload: unknown }>) {
    if (
      event.eventType !== 'source_result' ||
      !event.payload ||
      typeof event.payload !== 'object'
    ) {
      continue;
    }
    const snapshots = (event.payload as { candidates?: unknown }).candidates;
    if (!Array.isArray(snapshots)) continue;
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
      const candidate = snapshot as Partial<ResearchCandidate>;
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.sourceKey !== 'string' ||
        typeof candidate.title !== 'string' ||
        typeof candidate.summary !== 'string' ||
        typeof candidate.canonicalUri !== 'string'
      ) {
        continue;
      }
      if (!candidates.has(candidate.id))
        candidates.set(candidate.id, candidate as ResearchCandidate);
    }
  }
  return {
    ...run.rows[0],
    fallbackAvailable:
      run.rows[0]?.mode === 'search' &&
      run.rows[0]?.errorCode !== 'session_unavailable' &&
      ['failed', 'not_configured', 'budget_denied'].includes(String(run.rows[0]?.state)),
    proposals: proposals.rows,
    events: events.rows,
    operations: operations.rows,
    candidates: [...candidates.values()],
  };
}

export async function requestResearchFallback(
  pool: Pool,
  workspaceId: string,
  researchRunId: string,
): Promise<unknown> {
  const run = await pool.query<{
    querySessionId: string;
    resultSetId: string;
    publicQuery: string;
    mode: string;
    state: string;
  }>(
    `SELECT run.query_session_id AS "querySessionId", run.result_set_id AS "resultSetId",
            session.query_text AS "publicQuery", run.mode, run.state
     FROM ops.research_runs run
     JOIN workspace.query_sessions session
       ON session.id = run.query_session_id AND session.workspace_id = run.workspace_id
     WHERE run.id = $1 AND run.workspace_id = $2 AND session.deleted_at IS NULL`,
    [researchRunId, workspaceId],
  );
  if (!run.rowCount) throw new NotFoundError('Research run not found.');
  const record = run.rows[0]!;
  if (
    record.mode !== 'search' ||
    !['failed', 'not_configured', 'budget_denied'].includes(record.state)
  ) {
    throw new ConflictError('Deterministic fallback is not available for this research run.');
  }
  const operations = await requestEnabledDiscovery(
    pool,
    workspaceId,
    record.querySessionId,
    record.publicQuery,
    record.resultSetId,
  );
  return { researchRunId, operations };
}

export async function recoverStaleResearchRuns(pool: Pool): Promise<number> {
  return inTransaction(pool, async (client) => {
    const stale = await client.query<{ id: string; workspaceId: string }>(
      `SELECT id, workspace_id AS "workspaceId" FROM ops.research_runs
       WHERE state = 'running' AND lease_until < now() FOR UPDATE SKIP LOCKED`,
    );
    for (const row of stale.rows) {
      const receipt = {
        reason: 'worker_lease_expired',
        recoveryPolicy: 'terminal_without_unsafe_replay',
      };
      await client.query(
        `INSERT INTO ops.research_run_events
           (id, research_run_id, workspace_id, step_index, event_type, payload_hash, payload)
         VALUES ($1, $2, $3, 0, 'run_recovered', $4, $5)`,
        [newOpaqueId(), row.id, row.workspaceId, hashCanonical(receipt), json(receipt)],
      );
      await client.query(
        `UPDATE ops.research_runs
         SET state = 'failed', error_code = 'worker_lease_expired',
             safe_detail = 'Worker lease expired; the run was closed without replaying model or source calls.',
             lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND state = 'running'`,
        [row.id, row.workspaceId],
      );
    }
    return stale.rowCount ?? 0;
  });
}
