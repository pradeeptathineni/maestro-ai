import type { Pool } from 'pg';
import type { SemanticProposalRequestBody } from '../../contracts/src/index.js';
import {
  proposeStructuredLocalOutput,
  type LocalSemanticProposal,
} from '../../adapters/src/index.js';
import { hashCanonical, newOpaqueId } from '../../domain/src/index.js';
import { ConflictError, DomainValidationError, NotFoundError } from './errors.js';
import { inTransaction } from './transaction.js';

export interface SemanticInterpretationProposal {
  summary: string;
  intentLabels: string[];
  queryExpansions: string[];
  selectedCapabilityGroups: string[];
  ambiguityNotes: string[];
  sourceAnchors: Array<{ quote: string; start: number; end: number }>;
}

interface SemanticTaskPayload {
  operationId: string;
  workspaceId: string;
}

interface SemanticCall {
  config: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  task: string;
  payload: unknown;
  schema: unknown;
}

export type SemanticProposer = (
  input: SemanticCall,
) => Promise<LocalSemanticProposal<SemanticInterpretationProposal>>;

const semanticInterpretationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'intentLabels',
    'queryExpansions',
    'selectedCapabilityGroups',
    'ambiguityNotes',
    'sourceAnchors',
  ],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    intentLabels: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    },
    queryExpansions: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    selectedCapabilityGroups: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    ambiguityNotes: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    sourceAnchors: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'start', 'end'],
        properties: {
          quote: { type: 'string', minLength: 1, maxLength: 240 },
          start: { type: 'integer', minimum: 0 },
          end: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function reportedInputTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const value = (usage as Record<string, unknown>).inputTokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isBoundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= maximumLength,
    )
  );
}

export function validateSemanticInterpretationProposal(
  value: unknown,
  query: string,
  allowedCapabilityGroups: string[],
): SemanticInterpretationProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainValidationError('Semantic proposal must be an object.');
  }
  const proposal = value as Record<string, unknown>;
  if (
    typeof proposal.summary !== 'string' ||
    proposal.summary.length === 0 ||
    proposal.summary.length > 500 ||
    !isBoundedStringArray(proposal.intentLabels, 8, 80) ||
    !isBoundedStringArray(proposal.queryExpansions, 8, 120) ||
    !isBoundedStringArray(proposal.selectedCapabilityGroups, 12, 120) ||
    !isBoundedStringArray(proposal.ambiguityNotes, 8, 240) ||
    !Array.isArray(proposal.sourceAnchors) ||
    proposal.sourceAnchors.length > 8
  ) {
    throw new DomainValidationError('Semantic proposal failed the bounded output contract.');
  }
  const allowed = new Set(allowedCapabilityGroups);
  if (proposal.selectedCapabilityGroups.some((group) => !allowed.has(group))) {
    throw new DomainValidationError(
      'Semantic proposal referenced an unavailable capability group.',
    );
  }
  for (const anchor of proposal.sourceAnchors) {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
      throw new DomainValidationError('Semantic proposal contains an invalid source anchor.');
    }
    const record = anchor as Record<string, unknown>;
    if (
      typeof record.quote !== 'string' ||
      record.quote.length === 0 ||
      record.quote.length > 240 ||
      !Number.isInteger(record.start) ||
      !Number.isInteger(record.end) ||
      (record.start as number) < 0 ||
      (record.end as number) <= (record.start as number) ||
      query.slice(record.start as number, record.end as number) !== record.quote
    ) {
      throw new DomainValidationError(
        'Semantic proposal source anchor does not bind to the query.',
      );
    }
  }
  return proposal as unknown as SemanticInterpretationProposal;
}

export async function requestSemanticInterpretation(
  pool: Pool,
  workspaceId: string,
  querySessionId: string,
  input: SemanticProposalRequestBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const existing = await client.query<{
      id: string;
      state: string;
      createdAt: Date;
    }>(
      `SELECT id, state, created_at AS "createdAt"
       FROM ops.discovery_operations WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, input.idempotencyKey],
    );
    if (existing.rowCount) {
      return {
        ...existing.rows[0],
        adapterKey: 'local_semantic',
        intent: 'semantic_interpretation',
        duplicate: true,
      };
    }
    const session = await client.query<{ resultSetId: string; query: string }>(
      `SELECT qrs.id AS "resultSetId", qs.query_text AS query
       FROM workspace.query_sessions qs
       JOIN LATERAL (
         SELECT id FROM workspace.query_result_sets current
         WHERE current.query_session_id = qs.id ORDER BY revision DESC LIMIT 1
       ) qrs ON true
       WHERE qs.id = $1 AND qs.workspace_id = $2 AND qs.deleted_at IS NULL`,
      [querySessionId, workspaceId],
    );
    if (!session.rowCount) throw new NotFoundError('Query session not found.');

    await client.query(`SELECT pg_advisory_xact_lock(hashtext('phase06-local-semantic:' || $1))`, [
      workspaceId,
    ]);
    const active = await client.query(
      `SELECT 1 FROM ops.discovery_operations
       WHERE workspace_id = $1 AND adapter_key = 'local_semantic'
         AND state IN ('queued', 'running') LIMIT 1`,
      [workspaceId],
    );
    if (active.rowCount) {
      throw new ConflictError('A local semantic request is already queued or running.');
    }
    const config = await client.query<{
      enabled: boolean;
      baseUrl: string | null;
      modelIdentifier: string | null;
      dailyCallLimit: number;
    }>(
      `SELECT enabled, base_url AS "baseUrl", model_identifier AS "modelIdentifier",
              daily_call_limit AS "dailyCallLimit"
       FROM ops.source_adapter_configs WHERE adapter_key = 'local_semantic' FOR UPDATE`,
    );
    if (!config.rowCount) throw new NotFoundError('Local semantic adapter not found.');
    const configured = Boolean(
      config.rows[0]!.enabled && config.rows[0]!.baseUrl && config.rows[0]!.modelIdentifier,
    );
    let state: 'queued' | 'not_configured' | 'budget_denied' = 'not_configured';
    let reservedCalls = 0;
    if (configured) {
      await client.query(
        `INSERT INTO ops.adapter_daily_budgets (adapter_key, budget_date)
         VALUES ('local_semantic', current_date) ON CONFLICT DO NOTHING`,
      );
      const reserved = await client.query(
        `UPDATE ops.adapter_daily_budgets SET reserved_calls = reserved_calls + 1, updated_at = now()
         WHERE adapter_key = 'local_semantic' AND budget_date = current_date
           AND reserved_calls + 1 <= $1
         RETURNING reserved_calls`,
        [config.rows[0]!.dailyCallLimit],
      );
      if (reserved.rowCount) {
        state = 'queued';
        reservedCalls = 1;
      } else {
        state = 'budget_denied';
        await client.query(
          `UPDATE ops.adapter_daily_budgets SET denied_calls = denied_calls + 1, updated_at = now()
           WHERE adapter_key = 'local_semantic' AND budget_date = current_date`,
        );
      }
    }

    const operationId = newOpaqueId();
    const disclosure = {
      destination: 'configured_loopback_endpoint',
      sentFields: ['query', 'deterministicInterpretation', 'candidateCapabilityGroups'],
      projectContextIncluded: false,
      resultSetMutationAuthorized: false,
    };
    await client.query(
      `INSERT INTO ops.discovery_operations
         (id, workspace_id, query_session_id, result_set_id, adapter_key, idempotency_key,
          intent, outbound_query, outbound_query_hash, disclosure, state, reserved_calls,
          safe_detail, finished_at)
       VALUES ($1, $2, $3, $4, 'local_semantic', $5, 'semantic_interpretation',
               NULL, $6, $7, $8, $9, $10,
               CASE WHEN $8 IN ('not_configured', 'budget_denied') THEN now() ELSE NULL END)`,
      [
        operationId,
        workspaceId,
        querySessionId,
        session.rows[0]!.resultSetId,
        input.idempotencyKey,
        hashCanonical(session.rows[0]!.query),
        json(disclosure),
        state,
        reservedCalls,
        state === 'not_configured'
          ? 'Local semantic assistance is disabled or incomplete; deterministic results are unchanged.'
          : state === 'budget_denied'
            ? 'The configured local inference call budget denied this request.'
            : 'Queued one bounded interpretation proposal; deterministic results remain authoritative.',
      ],
    );
    if (state === 'queued') {
      await client.query(
        `INSERT INTO ops.outbox (id, operation_key, task_name, payload, state)
         VALUES ($1, $2, 'phase06_semantic_v1', $3, 'pending')`,
        [newOpaqueId(), `semantic:${operationId}`, json({ operationId, workspaceId })],
      );
    }
    return {
      id: operationId,
      state,
      adapterKey: 'local_semantic',
      intent: 'semantic_interpretation',
      disclosure,
      reservedCalls,
      duplicate: false,
    };
  });
}

export async function processSemanticInterpretation(
  pool: Pool,
  payload: SemanticTaskPayload,
  proposer: SemanticProposer = proposeStructuredLocalOutput,
): Promise<void> {
  const claimed = await pool.query<{
    querySessionId: string;
    resultSetId: string;
    query: string;
    deterministicInterpretation: unknown;
    adapterVersion: string;
    baseUrl: string;
    modelIdentifier: string;
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilityGroups: string[];
    attempt: number;
    startedAt: Date;
  }>(
    `UPDATE ops.discovery_operations operation
     SET state = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
     FROM ops.source_adapter_configs config, workspace.query_sessions session
     WHERE operation.id = $1 AND operation.workspace_id = $2 AND operation.state = 'queued'
       AND operation.adapter_key = 'local_semantic' AND config.adapter_key = operation.adapter_key
       AND config.enabled AND config.base_url IS NOT NULL AND config.model_identifier IS NOT NULL
       AND session.id = operation.query_session_id AND session.workspace_id = operation.workspace_id
       AND session.deleted_at IS NULL
     RETURNING operation.query_session_id AS "querySessionId",
               operation.result_set_id AS "resultSetId", session.query_text AS query,
               session.normalized_intent AS "deterministicInterpretation",
               config.adapter_version AS "adapterVersion", config.base_url AS "baseUrl",
               config.model_identifier AS "modelIdentifier", config.timeout_ms AS "timeoutMs",
               config.max_input_tokens AS "maxInputTokens",
               config.max_output_tokens AS "maxOutputTokens",
               ARRAY(
                 SELECT DISTINCT item.capability_group
                 FROM workspace.query_result_items item
                 WHERE item.result_set_id = operation.result_set_id
                 ORDER BY item.capability_group
               ) AS "capabilityGroups",
               COALESCE((SELECT max(attempt) + 1 FROM ops.discovery_attempts
                         WHERE operation_id = operation.id), 1)::int AS attempt,
               operation.started_at AS "startedAt"`,
    [payload.operationId, payload.workspaceId],
  );
  if (!claimed.rowCount) return;
  const row = claimed.rows[0]!;
  const inputPayload = {
    query: row.query,
    deterministicInterpretation: row.deterministicInterpretation,
    candidateCapabilityGroups: row.capabilityGroups,
  };
  let proposal: LocalSemanticProposal<SemanticInterpretationProposal> | null = null;
  let inputTokens: number | null = null;
  let errorCode: string | null = null;
  try {
    const generated = await proposer({
      config: {
        baseUrl: row.baseUrl,
        model: row.modelIdentifier,
        timeoutMs: row.timeoutMs,
        maxInputTokens: row.maxInputTokens,
        maxOutputTokens: row.maxOutputTokens,
      },
      task: [
        'Propose an interpretation of the query.',
        'Do not score, select, execute, install, or claim facts about tools.',
        'Capability groups must come from candidateCapabilityGroups.',
        'Every source anchor must use exact query offsets; use an empty array when none is needed.',
      ].join(' '),
      payload: inputPayload,
      schema: semanticInterpretationSchema,
    });
    inputTokens = reportedInputTokens(generated.usage);
    if (inputTokens !== null && inputTokens > row.maxInputTokens) {
      throw new DomainValidationError('Model-reported input usage exceeded the declared limit.');
    }
    proposal = {
      ...generated,
      output: validateSemanticInterpretationProposal(
        generated.output,
        row.query,
        row.capabilityGroups,
      ),
    };
  } catch (error) {
    errorCode = error instanceof DomainValidationError ? 'invalid_semantic_output' : 'upstream';
  }

  await inTransaction(pool, async (client) => {
    const latest = await client.query<{ state: string }>(
      `SELECT state FROM ops.discovery_operations WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [payload.operationId, payload.workspaceId],
    );
    const cancelled = latest.rows[0]?.state === 'cancel_requested';
    if (proposal && !cancelled) {
      await client.query(
        `INSERT INTO ops.semantic_proposals
           (id, workspace_id, query_session_id, operation_id, task_key, adapter_key,
            adapter_version, model_identifier, schema_version, input_hash, output_hash,
            output, source_anchors, usage, safety_checks, review_state)
         VALUES ($1, $2, $3, $4, 'query_interpretation', 'local_semantic', $5, $6,
                 'semantic-interpretation-v1', $7, $8, $9, $10, $11, $12, 'proposed')`,
        [
          newOpaqueId(),
          payload.workspaceId,
          row.querySessionId,
          payload.operationId,
          row.adapterVersion,
          proposal.modelIdentifier,
          hashCanonical(inputPayload),
          hashCanonical(proposal.output),
          json(proposal.output),
          json(proposal.output.sourceAnchors),
          json(proposal.usage ?? {}),
          json({
            schemaValidated: true,
            capabilityGroupsAllowlisted: true,
            sourceAnchorsBound: true,
            privateProjectContextIncluded: false,
            automaticResultMutation: false,
            declaredMaxInputTokens: row.maxInputTokens,
            modelReportedInputTokens: inputTokens,
            modelReportedInputWithinLimit: inputTokens === null ? null : true,
          }),
        ],
      );
    }
    const finalState = cancelled ? 'cancelled' : proposal ? 'complete' : 'failed';
    await client.query(
      `INSERT INTO ops.discovery_attempts
         (id, operation_id, workspace_id, attempt, request_hash, state, http_status,
          response_bytes, result_count, cost_state, error_code, safe_detail, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 'unavailable', $9, $10, $11, now())`,
      [
        newOpaqueId(),
        payload.operationId,
        payload.workspaceId,
        row.attempt,
        hashCanonical({ adapter: 'local_semantic', inputHash: hashCanonical(inputPayload) }),
        cancelled ? 'cancelled' : proposal ? 'succeeded' : 'failed',
        proposal ? Buffer.byteLength(json(proposal.output)) : 0,
        proposal && !cancelled ? 1 : 0,
        cancelled ? null : errorCode,
        cancelled
          ? 'Cancellation was observed after dispatch; local compute may already have occurred.'
          : proposal
            ? 'Stored one attributed proposal; it has not changed the result snapshot.'
            : 'Local semantic generation failed or returned an invalid bounded proposal.',
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
        proposal && !cancelled ? 1 : 0,
        cancelled ? null : errorCode,
        cancelled
          ? 'Semantic request cancelled; deterministic results are unchanged.'
          : proposal
            ? 'One reviewable interpretation proposal is available; deterministic results are unchanged.'
            : 'Semantic request failed; deterministic results remain available.',
      ],
    );
    await client.query(
      `UPDATE ops.adapter_daily_budgets SET consumed_calls = consumed_calls + 1, updated_at = now()
       WHERE adapter_key = 'local_semantic' AND budget_date = current_date`,
    );
    await client.query(
      `INSERT INTO ops.source_health_events (id, adapter_key, state, safe_detail, checked_at)
       VALUES ($1, 'local_semantic', $2, $3, now())`,
      [
        newOpaqueId(),
        proposal ? 'healthy' : 'failed',
        proposal
          ? 'Bounded local semantic proposal completed.'
          : 'Local semantic proposal failed or was invalid.',
      ],
    );
  });
}
