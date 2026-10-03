import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { DiscoveryAdapter } from '../../adapters/src/index.js';
import {
  RESEARCH_PROTOCOL_VERSION,
  type ResearchModel,
  type ResearchModelRequest,
} from '../../domain/src/index.js';
import { localWorkspaceId, referenceProjectContextId } from '../../seed/src/import.js';
import { testDatabaseUrl } from '../../test-fixtures/src/database.js';
import { createPool } from './client.js';
import {
  configureAdapter,
  getDiscoveryOperation,
  processDiscoveryOperation,
  requestDiscovery,
} from './discovery-repository.js';
import { createExplorerSession, redactExplorerSession } from './explorer-repository.js';
import {
  getResearchRun,
  processResearchRun,
  recoverStaleResearchRuns,
  requestResearchRun,
  waitForResearchDiscoveryTerminal,
} from './research-repository.js';

interface RunView {
  id: string;
  resultSetId: string;
  state: string;
  strategy: string;
  proposals: Array<{ proposalType: string; output: unknown; citations: string[] }>;
  events: Array<{ eventType: string; payload: unknown }>;
  operations: Array<unknown>;
  candidates: Array<{ id: string; title: string; canonicalUri: string }>;
  consumedModelCalls: number;
  disclosure: { privateProjectContextIncluded: boolean };
  receipt: { candidateIds: string[] } | null;
}

function payloadCandidates(request: ResearchModelRequest): Array<{ id: string }> {
  if (!request.payload || typeof request.payload !== 'object') return [];
  const candidates = (request.payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter(
    (candidate): candidate is { id: string } =>
      Boolean(candidate) &&
      typeof candidate === 'object' &&
      typeof (candidate as { id?: unknown }).id === 'string',
  );
}

function fixtureModel(
  requests: ResearchModelRequest[],
  options: {
    invalidRefinementCitation?: boolean;
    distinctSummaryCitation?: boolean;
    wideAction?: boolean;
  } = {},
): ResearchModel {
  return {
    async propose(request) {
      requests.push(request);
      const payload = request.payload as {
        allowedSourceKeys?: string[];
        publicQuery?: string;
      };
      const candidateId = payloadCandidates(request)[0]?.id ?? 'no-candidate';
      const summaryCandidateId = options.distinctSummaryCitation
        ? (payloadCandidates(request)[1]?.id ?? candidateId)
        : candidateId;
      if (request.proposalType === 'plan') {
        return {
          modelIdentifier: 'fixture-research-model',
          usage: { inputTokens: 20, outputTokens: 20 },
          output: {
            protocolVersion: RESEARCH_PROTOCOL_VERSION,
            interpretation: 'Investigate the public query using the enabled evidence boundary.',
            questions: ['Which directly evidenced options address the request?'],
            actions: [
              {
                actionKey: 'initial-evidence',
                sourceKey: payload.allowedSourceKeys?.[0] ?? 'missing',
                query: payload.publicQuery ?? 'public research query',
                purpose: 'Find directly relevant implementations and documentation.',
                maxResults: options.wideAction ? 20 : 5,
              },
            ],
            stopTests: ['Stop when directly relevant evidence can be cited.'],
          },
        };
      }
      if (request.proposalType === 'refinement') {
        return {
          modelIdentifier: 'fixture-research-model',
          usage: { inputTokens: 30, outputTokens: 20 },
          output: {
            protocolVersion: RESEARCH_PROTOCOL_VERSION,
            assessment: 'The acquired evidence is sufficient for this bounded run.',
            citedCandidateIds: [options.invalidRefinementCitation ? randomUUID() : candidateId],
            gaps: [],
            actions: [],
            shouldStop: true,
            stopReason: 'The bounded evidence supports an organized response.',
          },
        };
      }
      return {
        modelIdentifier: 'fixture-research-model',
        usage: { inputTokens: 30, outputTokens: 30 },
        output: {
          protocolVersion: RESEARCH_PROTOCOL_VERSION,
          contextAssessment: 'sufficient',
          abstentionReason: null,
          summary: 'The run found directly relevant, attributable evidence.',
          summaryCitationCandidateIds: [summaryCandidateId],
          groups: [
            {
              label: 'Direct evidence',
              description: 'Evidence selected for direct relevance.',
              candidateIds: [candidateId],
            },
          ],
          items: [
            {
              candidateId,
              reason: 'The evidence directly addresses the public research query.',
              uncertainty: 'The run used a bounded source and candidate budget.',
              citationCandidateIds: [candidateId],
            },
          ],
          limitations: ['No claim is made beyond stored evidence.'],
        },
      };
    },
  };
}

async function createSession(pool: Pool, query: string): Promise<string> {
  const session = (await createExplorerSession(pool, localWorkspaceId, {
    query,
    projectContextId: referenceProjectContextId,
  })) as { id: string };
  return session.id;
}

describe('bounded model-led research persistence', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(testDatabaseUrl());
    await pool.query(
      `UPDATE ops.source_adapter_configs SET daily_call_limit = 1000
       WHERE adapter_key = 'local_semantic'`,
    );
    await configureAdapter(pool, 'local_semantic', {
      enabled: true,
      baseUrl: 'http://127.0.0.1:18080/v1',
      modelIdentifier: 'fixture-research-model',
      maxInputTokens: 32768,
      maxOutputTokens: 1024,
    });
    await configureAdapter(pool, 'github', { enabled: true });
    await configureAdapter(pool, 'mcp_registry', { enabled: true });
  });

  afterAll(async () => {
    await configureAdapter(pool, 'github', { enabled: false });
    await configureAdapter(pool, 'mcp_registry', { enabled: false });
    await configureAdapter(pool, 'local_semantic', { enabled: false });
    await pool.query(
      `UPDATE ops.source_adapter_configs SET daily_call_limit = 20
       WHERE adapter_key = 'local_semantic'`,
    );
    await pool.end();
  });

  it('persists plan, source, refinement, synthesis, and privacy receipts for an unseen query', async () => {
    const sessionId = await createSession(pool, 'photonic compiler verification toolchains');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-search-${randomUUID()}`,
    })) as { id: string; state: string; strategy: string };
    expect(requested).toMatchObject({ state: 'queued', strategy: 'model' });

    const requests: ResearchModelRequest[] = [];
    const candidateId = randomUUID();
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      {
        model: fixtureModel(requests),
        sources: {
          async search(action) {
            expect(action.sourceKey).toBe('github');
            return {
              state: 'complete',
              candidates: [
                {
                  id: candidateId,
                  sourceKey: action.sourceKey,
                  title: 'Unseen-domain implementation',
                  summary: 'A fixture standing in for attributed public source evidence.',
                  canonicalUri: 'https://example.test/photonic-compiler',
                },
              ],
            };
          },
        },
      },
    );

    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    expect(run.state).toBe('complete');
    expect(run.proposals.map((proposal) => proposal.proposalType)).toEqual([
      'plan',
      'refinement',
      'synthesis',
    ]);
    expect(run.events.map((event) => event.eventType)).toContain('source_result');
    expect(run.receipt?.candidateIds).toEqual([candidateId]);
    expect(run.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: candidateId,
          title: 'Unseen-domain implementation',
          canonicalUri: 'https://example.test/photonic-compiler',
        }),
      ]),
    );
    expect(run.consumedModelCalls).toBe(3);
    expect(run.disclosure.privateProjectContextIncluded).toBe(false);
    expect(
      requests.every(
        (request) => !JSON.stringify(request.payload).includes(referenceProjectContextId),
      ),
    ).toBe(true);
  });

  it('uses the same protocol against admitted Corpus without live discovery operations', async () => {
    const sessionId = await createSession(pool, 'context engineering');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'corpus',
      idempotencyKey: `integration-corpus-${randomUUID()}`,
    })) as { id: string };
    const requests: ResearchModelRequest[] = [];
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      { model: fixtureModel(requests) },
    );

    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    expect(run.state).toBe('complete');
    expect(run.operations).toEqual([]);
    expect(run.receipt?.candidateIds.length).toBeGreaterThan(0);
    expect(requests.find((request) => request.proposalType === 'plan')?.payload).toMatchObject({
      mode: 'corpus',
      allowedSourceKeys: ['corpus'],
    });
  });

  it('persists distinct synthesis-summary citations as exact source anchors', async () => {
    const sessionId = await createSession(pool, 'distinct summary evidence anchors');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-summary-anchors-${randomUUID()}`,
    })) as { id: string };
    const itemCandidateId = randomUUID();
    const summaryCandidateId = randomUUID();
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      {
        model: fixtureModel([], { distinctSummaryCitation: true }),
        sources: {
          async search(action) {
            return {
              state: 'complete',
              candidates: [
                {
                  id: itemCandidateId,
                  sourceKey: action.sourceKey,
                  title: 'Item evidence',
                  summary: 'Evidence selected as the synthesized item.',
                  canonicalUri: 'https://example.test/item-evidence',
                },
                {
                  id: summaryCandidateId,
                  sourceKey: action.sourceKey,
                  title: 'Summary evidence',
                  summary: 'Different evidence cited by the synthesis summary.',
                  canonicalUri: 'https://example.test/summary-evidence',
                },
              ],
            };
          },
        },
      },
    );
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    const synthesis = run.proposals.find((proposal) => proposal.proposalType === 'synthesis');
    expect(synthesis?.citations).toEqual([summaryCandidateId, itemCandidateId]);
  });

  it('closes a queued v1 run without mixing protocol versions or calling the model', async () => {
    const sessionId = await createSession(pool, 'historical queued protocol handling');
    const template = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-v2-template-${randomUUID()}`,
    })) as { id: string };
    const historicalId = randomUUID();
    await pool.query(
      `INSERT INTO ops.research_runs
         (id, workspace_id, query_session_id, result_set_id, idempotency_key,
          mode, strategy, state, skill_version, protocol_version, query_hash, policy_hash,
          model_adapter_key, model_identifier, model_config_hash, allowed_source_keys,
          budget, disclosure, reserved_model_calls, safe_detail)
       SELECT $1, workspace_id, query_session_id, result_set_id, $2,
              mode, strategy, 'queued', skill_version, 'research-protocol-v1', query_hash,
              policy_hash, model_adapter_key, model_identifier, model_config_hash,
              allowed_source_keys, budget, disclosure, reserved_model_calls,
              'Historical queued run awaiting version-aware handling.'
       FROM ops.research_runs WHERE id = $3 AND workspace_id = $4`,
      [historicalId, `integration-historical-${randomUUID()}`, template.id, localWorkspaceId],
    );
    const calls: ResearchModelRequest[] = [];
    await processResearchRun(
      pool,
      { researchRunId: historicalId, workspaceId: localWorkspaceId },
      { model: fixtureModel(calls) },
    );
    const run = (await getResearchRun(pool, localWorkspaceId, historicalId)) as RunView & {
      errorCode: string;
    };
    expect(run).toMatchObject({ state: 'failed', errorCode: 'protocol_version_unsupported' });
    expect(run.proposals).toEqual([]);
    expect(run.events.map((event) => event.eventType)).toEqual(['run_failed']);
    expect(calls).toEqual([]);
  });

  it('records and rejects a model proposal that cites nonexistent evidence', async () => {
    const sessionId = await createSession(pool, 'unseen materials simulation methods');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-invalid-${randomUUID()}`,
    })) as { id: string };
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      {
        model: fixtureModel([], { invalidRefinementCitation: true }),
        sources: {
          async search(action) {
            return {
              state: 'complete',
              candidates: [
                {
                  id: randomUUID(),
                  sourceKey: action.sourceKey,
                  title: 'Stored evidence',
                  summary: 'Evidence whose identifier must be cited exactly.',
                  canonicalUri: 'https://example.test/stored-evidence',
                },
              ],
            };
          },
        },
      },
    );

    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    expect(run.state).toBe('failed');
    expect(run.proposals.map((proposal) => proposal.proposalType)).toEqual(['plan']);
    expect(run.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['proposal_rejected', 'run_failed']),
    );
  });

  it('rejects an oversized complete model envelope before the next dispatch', async () => {
    const sessionId = await createSession(pool, 'large bounded research envelope');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-input-envelope-${randomUUID()}`,
    })) as { id: string };
    const calls: ResearchModelRequest[] = [];
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      {
        model: fixtureModel(calls, { wideAction: true }),
        sources: {
          async search(action) {
            return {
              state: 'complete',
              candidates: Array.from({ length: 20 }, (_, index) => ({
                id: randomUUID(),
                sourceKey: action.sourceKey,
                title: `Oversized boundary candidate ${index} ${'t'.repeat(450)}`,
                summary: `Untrusted source text ${index} ${'x'.repeat(1_950)}`,
                canonicalUri: `https://example.test/oversized/${index}`,
              })),
            };
          },
        },
      },
    );
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView & {
      errorCode: string;
    };
    expect(run).toMatchObject({ state: 'failed', errorCode: 'budget_exceeded' });
    expect(calls.map((request) => request.proposalType)).toEqual(['plan']);
  });

  it('terminally accounts for an expired worker lease without replaying calls', async () => {
    const sessionId = await createSession(pool, 'lease recovery evidence');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-recovery-${randomUUID()}`,
    })) as { id: string };
    await pool.query(
      `UPDATE ops.research_runs
       SET state = 'running', lease_token = $3, lease_until = now() - interval '1 minute',
           started_at = now() - interval '2 minutes', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND state = 'queued'`,
      [requested.id, localWorkspaceId, randomUUID()],
    );

    expect(await recoverStaleResearchRuns(pool)).toBe(1);
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    expect(run.state).toBe('failed');
    expect(run.events.map((event) => event.eventType)).toContain('run_recovered');
    expect(run.consumedModelCalls).toBe(0);
  });

  it('waits for a discovery operation claimed by a competing dispatcher', async () => {
    const sessionId = await createSession(pool, 'competing dispatcher evidence');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-competing-dispatch-${randomUUID()}`,
    })) as { id: string };
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    const operation = (await requestDiscovery(
      pool,
      localWorkspaceId,
      sessionId,
      {
        adapterKey: 'mcp_registry',
        approvedPublicQuery: 'competing dispatcher evidence',
        idempotencyKey: `integration-competing-source-${randomUUID()}`,
        intent: 'explore',
      },
      {
        planRouteId: 'competing-source',
        variantIndex: 1,
        routingReason: 'Exercise the outbox and inline dispatch race.',
        sourcePlanState: 'planned',
        outboundQuery: 'competing dispatcher evidence',
        researchRunId: requested.id,
        researchStep: 0,
        researchActionKey: 'competing-source',
        resultSetId: run.resultSetId,
        resultLimit: 1,
        dispatch: 'inline',
      },
    )) as { id: string };
    await pool.query(
      `UPDATE ops.discovery_operations
       SET state = 'running', started_at = now(), finished_at = NULL, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [operation.id, localWorkspaceId],
    );
    const completion = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        pool
          .query(
            `UPDATE ops.discovery_operations
             SET state = 'complete', result_count = 0,
                 safe_detail = 'Competing dispatcher completed.', finished_at = now(), updated_at = now()
             WHERE id = $1 AND workspace_id = $2`,
            [operation.id, localWorkspaceId],
          )
          .then(() => resolve(), reject);
      }, 75);
    });
    await expect(
      waitForResearchDiscoveryTerminal(pool, localWorkspaceId, operation.id),
    ).resolves.toMatchObject({ state: 'complete', safeDetail: 'Competing dispatcher completed.' });
    await completion;
  });

  it('rejects a research source operation bound to a different result-set snapshot', async () => {
    const sessionId = await createSession(pool, 'frozen research result set');
    const otherSessionId = await createSession(pool, 'different result set');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-result-set-binding-${randomUUID()}`,
    })) as { id: string };
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    const other = await pool.query<{ resultSetId: string }>(
      `SELECT id AS "resultSetId" FROM workspace.query_result_sets
       WHERE query_session_id = $1 AND workspace_id = $2 ORDER BY revision DESC LIMIT 1`,
      [otherSessionId, localWorkspaceId],
    );
    const operation = (await requestDiscovery(
      pool,
      localWorkspaceId,
      sessionId,
      {
        adapterKey: 'mcp_registry',
        approvedPublicQuery: 'frozen research result set',
        idempotencyKey: `integration-result-set-operation-${randomUUID()}`,
        intent: 'explore',
      },
      {
        planRouteId: 'frozen-result-set',
        variantIndex: 1,
        routingReason: 'Negative invariant probe.',
        sourcePlanState: 'planned',
        outboundQuery: 'frozen research result set',
        researchRunId: requested.id,
        researchStep: 0,
        researchActionKey: 'frozen-result-set',
        resultSetId: run.resultSetId,
        resultLimit: 1,
        dispatch: 'inline',
      },
    )) as { id: string };
    await expect(
      pool.query(
        `UPDATE ops.discovery_operations SET result_set_id = $3
         WHERE id = $1 AND workspace_id = $2`,
        [operation.id, localWorkspaceId, other.rows[0]!.resultSetId],
      ),
    ).rejects.toThrow(/must match its run snapshot/);
  });

  it('serializes stale-run recovery against a running source finalization', async () => {
    const sessionId = await createSession(pool, 'recovery crossing source finalization');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-crossing-recovery-${randomUUID()}`,
    })) as { id: string };
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    const operation = (await requestDiscovery(
      pool,
      localWorkspaceId,
      sessionId,
      {
        adapterKey: 'mcp_registry',
        approvedPublicQuery: 'recovery crossing source finalization',
        idempotencyKey: `integration-crossing-source-${randomUUID()}`,
        intent: 'explore',
      },
      {
        planRouteId: 'crossing-source',
        variantIndex: 1,
        routingReason: 'Prove recovery wins without a late child commit.',
        sourcePlanState: 'planned',
        outboundQuery: 'recovery crossing source finalization',
        researchRunId: requested.id,
        researchStep: 0,
        researchActionKey: 'crossing-source',
        resultSetId: run.resultSetId,
        resultLimit: 1,
        dispatch: 'inline',
      },
    )) as { id: string };
    await pool.query(
      `UPDATE ops.research_runs
       SET state = 'running', lease_token = $3, lease_until = now() - interval '1 minute',
           started_at = now() - interval '2 minutes', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND state = 'queued'`,
      [requested.id, localWorkspaceId, randomUUID()],
    );
    await pool.query(
      `UPDATE ops.discovery_operations
       SET state = 'queued', reserved_calls = 1, finished_at = NULL, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [operation.id, localWorkspaceId],
    );
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const adapter: DiscoveryAdapter = {
      key: 'mcp_registry',
      version: 'fixture-v1',
      async search() {
        enteredResolve();
        await release;
        return {
          state: 'complete',
          leads: [
            {
              externalId: `late-${operation.id}`,
              canonicalUri: 'https://example.test/late-source',
              title: 'Late source result',
              summary: 'This result must not commit after parent recovery.',
              kindHint: 'tool',
              payload: { late: true },
              provenance: {
                adapter: 'mcp_registry',
                adapterVersion: 'fixture-v1',
                source: 'fixture',
                observedAt: new Date(0).toISOString(),
                reviewState: 'lead',
              },
            },
          ],
          responseBytes: 100,
          httpStatus: 200,
          rateLimit: { remaining: null, resetAt: null, retryAfter: null },
        };
      },
    };
    const processing = processDiscoveryOperation(
      pool,
      { operationId: operation.id, workspaceId: localWorkspaceId },
      adapter,
    );
    await entered;
    expect(await recoverStaleResearchRuns(pool)).toBe(1);
    releaseResolve();
    await processing;

    const recovered = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    const operationView = (await getDiscoveryOperation(pool, localWorkspaceId, operation.id)) as {
      state: string;
      attempts: unknown[];
      candidates: unknown[];
    };
    expect(recovered.state).toBe('failed');
    expect(operationView).toMatchObject({ state: 'failed', attempts: [], candidates: [] });
  });

  it('fails without a model call when configuration changes before claim', async () => {
    const sessionId = await createSession(pool, 'configuration drift evidence');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-config-drift-${randomUUID()}`,
    })) as { id: string };
    await configureAdapter(pool, 'local_semantic', {
      enabled: false,
      baseUrl: 'http://127.0.0.1:18080/v1',
      modelIdentifier: 'fixture-research-model',
      maxInputTokens: 32768,
      maxOutputTokens: 1024,
    });
    const calls: ResearchModelRequest[] = [];
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      { model: fixtureModel(calls) },
    );
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView & {
      errorCode: string;
    };
    expect(run).toMatchObject({ state: 'failed', errorCode: 'model_config_changed' });
    expect(calls).toEqual([]);
    await expect(
      pool.query(`DELETE FROM ops.research_runs WHERE id = $1`, [requested.id]),
    ).rejects.toThrow(/cannot be deleted|terminal research runs are immutable/);
    await expect(
      pool.query(
        `INSERT INTO ops.research_run_events
           (id, research_run_id, workspace_id, step_index, event_type, payload_hash, payload)
         VALUES ($1, $2, $3, 0, 'run_failed', $4, '{}'::jsonb)`,
        [randomUUID(), requested.id, localWorkspaceId, '0'.repeat(64)],
      ),
    ).rejects.toThrow(/terminal research runs cannot accept (?:new child records|child writes)/);
    await configureAdapter(pool, 'local_semantic', {
      enabled: true,
      baseUrl: 'http://127.0.0.1:18080/v1',
      modelIdentifier: 'fixture-research-model',
      maxInputTokens: 32768,
      maxOutputTokens: 1024,
    });
  });

  it('enforces the declared result limit before persistence', async () => {
    const sessionId = await createSession(pool, 'bounded acquisition evidence');
    const operation = (await requestDiscovery(
      pool,
      localWorkspaceId,
      sessionId,
      {
        adapterKey: 'mcp_registry',
        approvedPublicQuery: 'bounded acquisition evidence',
        idempotencyKey: `integration-result-limit-${randomUUID()}`,
        intent: 'explore',
      },
      {
        planRouteId: 'bounded-fixture',
        variantIndex: 1,
        routingReason: 'Verify host-enforced acquisition limits.',
        sourcePlanState: 'planned',
        outboundQuery: 'bounded acquisition evidence',
        resultLimit: 1,
        dispatch: 'inline',
      },
    )) as { id: string };
    await pool.query(
      `UPDATE ops.discovery_operations
       SET state = 'queued', reserved_calls = 1, finished_at = NULL, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [operation.id, localWorkspaceId],
    );
    const observedLimits: number[] = [];
    const adapter: DiscoveryAdapter = {
      key: 'mcp_registry',
      version: 'fixture-v1',
      async search(_query, limit) {
        observedLimits.push(limit ?? -1);
        return {
          state: 'complete',
          leads: Array.from({ length: 5 }, (_, index) => ({
            externalId: `bounded-${operation.id}-${index}`,
            canonicalUri: `https://example.test/bounded/${index}`,
            title: `Bounded result ${index}`,
            summary: 'Fixture evidence.',
            kindHint: 'tool',
            payload: { index },
            provenance: {
              adapter: 'mcp_registry',
              adapterVersion: 'fixture-v1',
              source: 'fixture',
              observedAt: new Date(0).toISOString(),
              reviewState: 'lead',
            },
          })),
          responseBytes: 500,
          httpStatus: 200,
          rateLimit: { remaining: null, resetAt: null, retryAfter: null },
        };
      },
    };
    await processDiscoveryOperation(
      pool,
      { operationId: operation.id, workspaceId: localWorkspaceId },
      adapter,
    );
    const view = (await getDiscoveryOperation(pool, localWorkspaceId, operation.id)) as {
      resultLimit: number;
      resultCount: number;
      candidates: unknown[];
    };
    expect(observedLimits).toEqual([1]);
    expect(view).toMatchObject({ resultLimit: 1, resultCount: 1 });
    expect(view.candidates).toHaveLength(1);
  });

  it('terminally closes a queued run when its private query is redacted before claim', async () => {
    const sessionId = await createSession(pool, 'redact before model execution');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-redacted-${randomUUID()}`,
    })) as { id: string };
    await redactExplorerSession(pool, localWorkspaceId, sessionId);
    const calls: ResearchModelRequest[] = [];
    await processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      { model: fixtureModel(calls) },
    );
    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView & {
      errorCode: string;
      fallbackAvailable: boolean;
    };
    expect(run).toMatchObject({
      state: 'failed',
      errorCode: 'session_unavailable',
      fallbackAvailable: false,
    });
    expect(calls).toEqual([]);
  });

  it('does not append proposals or evidence after recovery terminalizes an active run', async () => {
    await pool.query(`DELETE FROM ops.adapter_daily_budgets WHERE adapter_key = 'local_semantic'`);
    const sessionId = await createSession(pool, 'active lease recovery evidence');
    const requested = (await requestResearchRun(pool, localWorkspaceId, sessionId, {
      mode: 'search',
      idempotencyKey: `integration-active-recovery-${randomUUID()}`,
    })) as { id: string };
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const fixture = fixtureModel([]);
    const processing = processResearchRun(
      pool,
      { researchRunId: requested.id, workspaceId: localWorkspaceId },
      {
        model: {
          async propose(request) {
            enteredResolve();
            await release;
            return fixture.propose(request);
          },
        },
      },
    );
    await entered;
    await pool.query(
      `UPDATE ops.research_runs SET lease_until = now() - interval '1 second'
       WHERE id = $1 AND workspace_id = $2 AND state = 'running'`,
      [requested.id, localWorkspaceId],
    );
    expect(await recoverStaleResearchRuns(pool)).toBe(1);
    releaseResolve();
    await processing;

    const run = (await getResearchRun(pool, localWorkspaceId, requested.id)) as RunView;
    expect(run.state).toBe('failed');
    expect(run.proposals).toEqual([]);
    expect(run.events.map((event) => event.eventType)).toEqual(['run_recovered']);
  });
});
