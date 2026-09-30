import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { verifyVerificationBundle } from '../../../packages/domain/src/index.js';
import {
  createPool,
  processDiscoveryOperation,
  processSemanticInterpretation,
  recoverDueWatches,
} from '../../../packages/db/src/index.js';
import { localWorkspaceId, referenceProjectContextId } from '../../../packages/seed/src/import.js';
import { testDatabaseUrl } from '../../../packages/test-fixtures/src/database.js';
import { buildApp } from './app.js';

const hostHeaders = { host: '127.0.0.1:4310' };
const mutationHeaders = {
  ...hostHeaders,
  origin: 'http://127.0.0.1:5173',
  'content-type': 'application/json',
  'x-maestro-request': '1',
};

describe('Phase 06 explorer and authoring contracts', () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = createPool(testDatabaseUrl());
    app = await buildApp({
      pool,
      logger: false,
      config: {
        host: '127.0.0.1',
        port: 4310,
        rateLimitMax: 120,
        allowedHosts: new Set(['127.0.0.1:4310', 'localhost:4310']),
        allowedOrigins: new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:4310']),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function createSession(query: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/explorer/sessions',
      headers: mutationHeaders,
      payload: { query },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{
      id: string;
      resultSetId: string;
      interpretation: {
        coverageState: string;
        explicitFacets: Array<{ value: string }>;
        inferredFacets: Array<{ value: string }>;
      };
      counts: { assessed: number };
    }>();
  }

  it('creates query-bound snapshots and pages them with result-set-bound cursors', async () => {
    const session = await createSession('ai');
    expect(session.counts.assessed).toBeGreaterThanOrEqual(12);
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=5`,
      headers: hostHeaders,
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{
      items: Array<{ id: string; signalDisplay: number | null; displayState: string }>;
      nextCursor: string;
      resultSet: { id: string; signalPolicyVersion: string };
    }>();
    expect(firstPage.resultSet).toMatchObject({
      id: session.resultSetId,
      signalPolicyVersion: 'intrinsic-signal-v3',
    });
    expect(firstPage.items).toHaveLength(5);
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=5&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      headers: hostHeaders,
    });
    expect(second.statusCode).toBe(200);
    const secondItems = second.json<{ items: Array<{ id: string }> }>().items;
    expect(new Set([...firstPage.items, ...secondItems].map((item) => item.id)).size).toBe(10);

    const rejectedCursor = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?sort=name&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      headers: hostHeaders,
    });
    expect(rejectedCursor.statusCode).toBe(422);
  });

  it('handles ambiguous, semantic, and out-of-coverage queries truthfully', async () => {
    const github = await createSession('ai github');
    expect(github.interpretation.explicitFacets).toContainEqual(
      expect.objectContaining({ value: 'github' }),
    );
    expect(github.interpretation.inferredFacets).toContainEqual(
      expect.objectContaining({ value: 'github_integration' }),
    );

    const writing = await createSession('ai language better tone');
    const writingPage = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${writing.resultSetId}?limit=20`,
      headers: hostHeaders,
    });
    expect(
      writingPage.json<{ items: Array<{ name: string; displayState: string }> }>().items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'No AI Slop', displayState: 'provisional' }),
      ]),
    );

    const outside = await createSession('iphone shortcuts');
    expect(outside.interpretation.coverageState).toBe('outside_maintained_coverage');
    expect(outside.counts.assessed).toBe(0);

    const medical = await createSession('medical diagnosis agent');
    expect(medical.interpretation.coverageState).toBe('outside_maintained_coverage');
    expect(medical.counts.assessed).toBe(0);

    const medicalCorpus = await app.inject({
      method: 'POST',
      url: '/api/v1/corpus/search',
      headers: mutationHeaders,
      payload: { query: 'medical diagnosis agent', layer: 'indexed_knowledge' },
    });
    expect(medicalCorpus.statusCode).toBe(200);
    expect(medicalCorpus.json()).toMatchObject({ matchedCount: 0, items: [] });
  });

  it('serves versioned data-backed facets and filters Corpus by entity class', async () => {
    const taxonomy = await app.inject({
      method: 'GET',
      url: '/api/v1/taxonomy/facets',
      headers: hostHeaders,
    });
    expect(taxonomy.statusCode).toBe(200);
    const body = taxonomy.json<{
      semantics: string;
      facets: Array<{
        key: string;
        values: Array<{ stableKey: string; count: number; scheme: { version: number } }>;
      }>;
    }>();
    expect(body.semantics).toContain('independent facets');
    expect(body.facets.map((facet) => facet.key)).toEqual([
      'entity_class',
      'interface',
      'service_model',
      'domain',
      'capability',
      'document_type',
    ]);
    expect(body.facets.find((facet) => facet.key === 'entity_class')?.values).toContainEqual(
      expect.objectContaining({
        stableKey: 'entity-class:implementation',
        count: expect.any(Number),
        scheme: expect.objectContaining({ version: 1 }),
      }),
    );

    const documents = await app.inject({
      method: 'GET',
      url: '/api/v1/corpus?entityClass=document&limit=50',
      headers: hostHeaders,
    });
    expect(documents.statusCode).toBe(200);
    const documentBody = documents.json<{
      facets: { entityClasses: Array<{ value: string; count: number }> };
      items: Array<{ entityClass: string; layer: string }>;
    }>();
    expect(documentBody.facets.entityClasses).toContainEqual(
      expect.objectContaining({ value: 'document' }),
    );
    expect(documentBody.items.length).toBeGreaterThan(0);
    expect(documentBody.items.every((item) => item.entityClass === 'document')).toBe(true);
  });

  it('dogfoods the explorer with a signal estimate for every returned tool', async () => {
    const session = await createSession(
      'ai coding agent repository skills hooks runtime verification orchestration multi-model integrations',
    );
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=50&sort=name`,
      headers: hostHeaders,
    });
    expect(response.statusCode).toBe(200);
    const firstPage = response.json<{
      items: Array<{ name: string; displayState: string; signalDisplay: number | null }>;
      nextCursor: string | null;
    }>();
    const items = [...firstPage.items];
    if (firstPage.nextCursor) {
      const next = await app.inject({
        method: 'GET',
        url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=50&sort=name&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
        headers: hostHeaders,
      });
      expect(next.statusCode).toBe(200);
      items.push(
        ...next.json<{
          items: Array<{ name: string; displayState: string; signalDisplay: number | null }>;
        }>().items,
      );
    }
    for (const name of [
      'Build Web Apps',
      'Chisle',
      'Codex Hooks',
      'Codex Skills',
      'Codex Subagents',
      'Composio',
      'GitNexus',
      'LiteLLM Gateway',
      'OpenAI Agents SDK',
      'Ponytail',
      'Reticle',
      'Superpowers',
    ]) {
      expect(items).toContainEqual(
        expect.objectContaining({
          name,
          displayState: 'provisional',
          signalDisplay: expect.any(Number),
        }),
      );
    }
    expect(items.every((item) => typeof item.signalDisplay === 'number')).toBe(true);
  });

  it('keeps cached Corpus scoring equivalent to full Explorer materialization', async () => {
    const session = await createSession('context compression');
    const explorerResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=50`,
      headers: hostHeaders,
    });
    const explorerItem = explorerResponse
      .json<{
        items: Array<{
          providerId: string;
          signalDisplay: number;
          evidenceCoverage: number;
          displayState: string;
        }>;
      }>()
      .items.find((item) => item.providerId);
    expect(explorerItem).toBeDefined();

    const corpusResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/corpus/search',
      headers: mutationHeaders,
      payload: { query: 'context compression', layer: 'indexed_knowledge', limit: 50 },
    });
    expect(corpusResponse.statusCode).toBe(200);
    const corpusItem = corpusResponse
      .json<{
        items: Array<Record<string, unknown> & { providerId: string }>;
      }>()
      .items.find((item) => item.providerId === explorerItem!.providerId);
    expect(corpusItem).toMatchObject({
      signalDisplay: explorerItem!.signalDisplay,
      evidenceCoverage: explorerItem!.evidenceCoverage,
      displayState: explorerItem!.displayState,
    });
    expect(corpusItem).not.toHaveProperty('valueProfile');
    expect(corpusItem).not.toHaveProperty('cachedValueConservative');
    expect(corpusItem).not.toHaveProperty('cachedEvidenceCoverage');
  });

  it('keeps list, graph, detail, comparison, and portable export on one snapshot', async () => {
    const session = await createSession('ai context reduction github');
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=10`,
      headers: hostHeaders,
    });
    const items = list.json<{ items: Array<{ id: string }> }>().items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const graph = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/graph?limit=3`,
      headers: hostHeaders,
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({
      resultSetId: session.resultSetId,
      visibleCount: 3,
      hiddenCount: expect.any(Number),
      accessibleItems: expect.any(Array),
    });
    const expandedGraph = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/graph?limit=100`,
      headers: hostHeaders,
    });
    expect(expandedGraph.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/items/${items[0]!.id}`,
      headers: hostHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      resultSetId: session.resultSetId,
      policyVersion: 'intrinsic-signal-v3',
      valueInputs: expect.any(Array),
      evidence: expect.any(Array),
    });
    const comparison = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/compare`,
      headers: mutationHeaders,
      payload: { resultItemIds: items.slice(0, 2).map((item) => item.id) },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json<{ items: unknown[] }>().items).toHaveLength(2);

    const exported = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/export`,
      headers: mutationHeaders,
      payload: { includePrivateQuery: false, includeProjectContext: false },
    });
    expect(exported.statusCode).toBe(200);
    expect(verifyVerificationBundle(exported.json())).toMatchObject({
      status: 'partial',
      valid: true,
    });
  });

  it('treats explanatory documents as first-class, inspectable, saveable results', async () => {
    const session = await createSession('AI context reduction article');
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=10`,
      headers: hostHeaders,
    });
    const document = list
      .json<{ items: Array<{ id: string; subjectType: string; kind: string }> }>()
      .items.find((item) => item.subjectType === 'document');
    expect(document).toBeDefined();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/items/${document!.id}`,
      headers: hostHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      subjectType: 'document',
      valueInputs: expect.any(Array),
      evidence: [expect.objectContaining({ dimensionKey: 'document_identity' })],
    });
    const saved = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}/shortlists`,
      headers: mutationHeaders,
      payload: {
        projectContextId: referenceProjectContextId,
        name: 'Knowledge document shortlist',
        resultItemIds: [document!.id],
      },
    });
    expect(saved.statusCode).toBe(201);
    const stored = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM workspace.shortlist_document_items
       WHERE shortlist_id = $1`,
      [saved.json<{ id: string }>().id],
    );
    expect(stored.rows[0]!.count).toBe(1);
  });

  it('keeps representative model families visible in the broad AI landscape', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/explorer/sessions',
      headers: mutationHeaders,
      payload: { query: 'ai' },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json<{ resultSetId: string }>();
    const page = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=20&sort=recommended`,
      headers: hostHeaders,
    });
    expect(page.statusCode).toBe(200);
    const names = page.json<{ items: Array<{ name: string }> }>().items.map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'OpenAI',
        'GPT model family',
        'Claude model family',
        'Gemini model family',
        'Llama model family',
      ]),
    );
  });

  it('creates an explicit immutable result revision only when maintained knowledge changes', async () => {
    const session = await createSession('ai');
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=5`,
      headers: hostHeaders,
    });
    const firstPage = first.json<{
      items: Array<{ id: string }>;
      nextCursor: string;
    }>();
    expect(firstPage.nextCursor).toBeTruthy();

    const suffix = randomUUID();
    const name = `Refresh canary ${suffix}`;
    const authored = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/options',
      headers: mutationHeaders,
      payload: {
        name,
        kind: 'practice',
        description: 'A source-backed refresh fixture for immutable result revisions.',
        canonicalUrl: `https://example.com/refresh-${suffix}`,
        sourceTitle: 'Refresh fixture',
        sourceOwner: 'Maestro integration test',
        capabilityKey: `refresh-${suffix}`,
        capabilityName: 'Refresh fixture',
        searchTerms: ['ai', 'refresh', suffix],
        limitations: ['Controlled fixture, not a live-source observation.'],
        reviewState: 'reviewed',
      },
    });
    expect(authored.statusCode).toBe(201);
    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/sessions/${session.id}/refresh`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      state: 'refreshed',
      resultSetRevision: 2,
      predecessorId: session.resultSetId,
    });
    const nextResultSetId = refreshed.json<{ resultSetId: string }>().resultSetId;
    expect(nextResultSetId).not.toBe(session.resultSetId);

    const oldNextPage = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${session.resultSetId}?limit=5&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      headers: hostHeaders,
    });
    expect(oldNextPage.statusCode).toBe(200);
    expect(
      new Set(
        [...firstPage.items, ...oldNextPage.json<{ items: Array<{ id: string }> }>().items].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(10);
    const revisedPage = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${nextResultSetId}?limit=50&sort=name&kind=practice`,
      headers: hostHeaders,
    });
    expect(revisedPage.json<{ items: Array<{ name: string }> }>().items).toContainEqual(
      expect.objectContaining({ name }),
    );
    const unchanged = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/sessions/${session.id}/refresh`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(unchanged.json()).toMatchObject({
      state: 'unchanged',
      resultSetId: nextResultSetId,
      resultSetRevision: 2,
    });
  });

  it('creates generic project contexts and preserves immutable context revisions', async () => {
    const suffix = randomUUID();
    const privatePlatform = `PRIVATE_PLATFORM_${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${localWorkspaceId}/projects`,
      headers: mutationHeaders,
      payload: {
        name: `Phase 06 project ${suffix}`,
        context: {
          goal: 'Evaluate a writing-quality workflow.',
          technologies: ['TypeScript'],
          platforms: ['Linux'],
          dataSensitivity: 'public examples only',
          allowedEgress: ['approved public query'],
          allowedEffects: ['read_data'],
          budget: 'No paid API during evaluation',
          preferences: ['reversible setup'],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json<{ id: string; currentContextId: string; snapshotHash: string }>();
    const revised = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/contexts`,
      headers: mutationHeaders,
      payload: {
        expectedRevision: 1,
        context: {
          goal: 'Evaluate a writing-quality workflow on representative documents.',
          platforms: ['Linux', privatePlatform],
        },
      },
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json()).toMatchObject({ revision: 2 });
    const revisedContext = revised.json<{ id: string }>();
    const contexts = await pool.query<{ revision: number; snapshotHash: string }>(
      `SELECT revision, snapshot_hash AS "snapshotHash" FROM workspace.project_contexts
       WHERE project_id = $1 ORDER BY revision`,
      [project.id],
    );
    expect(contexts.rows).toHaveLength(2);
    expect(contexts.rows[0]!.snapshotHash).toBe(project.snapshotHash);

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/contexts`,
      headers: mutationHeaders,
      payload: { expectedRevision: 1, context: { goal: 'Stale writer.' } },
    });
    expect(conflict.statusCode).toBe(409);

    const privateQuery = `PRIVATE_QUERY_${suffix} ai local search`;
    const generic = await app.inject({
      method: 'POST',
      url: '/api/v1/explorer/sessions',
      headers: mutationHeaders,
      payload: { query: privateQuery },
    });
    expect(generic.statusCode).toBe(201);
    const explored = await app.inject({
      method: 'POST',
      url: '/api/v1/explorer/sessions',
      headers: mutationHeaders,
      payload: { query: privateQuery, projectContextId: revisedContext.id },
    });
    expect(explored.statusCode).toBe(201);
    expect(explored.json()).toMatchObject({
      projectFit: { state: 'unknown_blocked', orderingApplied: false },
    });
    expect(JSON.stringify(explored.json())).not.toContain(privatePlatform);
    const genericResultSetId = generic.json<{ resultSetId: string }>().resultSetId;
    const contextualResultSetId = explored.json<{ resultSetId: string }>().resultSetId;
    const [genericPage, contextualPage] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/explorer/result-sets/${genericResultSetId}?limit=50&sort=name`,
        headers: hostHeaders,
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/explorer/result-sets/${contextualResultSetId}?limit=50&sort=name`,
        headers: hostHeaders,
      }),
    ]);
    const stableSignals = (response: typeof genericPage) =>
      response
        .json<{ items: Array<{ providerId: string; signalUnrounded: number }> }>()
        .items.map((item) => [item.providerId, item.signalUnrounded]);
    expect(stableSignals(contextualPage)).toEqual(stableSignals(genericPage));
    expect(contextualPage.json()).toMatchObject({
      resultSet: {
        diagnostics: {
          projectFitState: 'unknown_blocked',
          projectContextAffectsSignal: false,
        },
      },
    });
    const safeExport = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/result-sets/${contextualResultSetId}/export`,
      headers: mutationHeaders,
      payload: { includePrivateQuery: false, includeProjectContext: false },
    });
    const safeBody = safeExport.body;
    expect(safeExport.statusCode).toBe(200);
    expect(safeBody).not.toContain(privateQuery);
    expect(safeBody).not.toContain(privatePlatform);
    expect(safeBody).not.toContain(revisedContext.id);
  });

  it('represents provider, practice, composition, status-quo, build, and defer options honestly', async () => {
    const suffix = randomUUID();
    const projectResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${localWorkspaceId}/projects`,
      headers: mutationHeaders,
      payload: {
        name: `Option semantics ${suffix}`,
        context: { goal: 'Compare real option kinds.' },
      },
    });
    const project = projectResponse.json<{ id: string }>();
    const needResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/needs',
      headers: mutationHeaders,
      payload: {
        projectId: project.id,
        title: `Option kinds ${suffix}`,
        desiredOutcome: 'Keep provider identity separate from non-provider alternatives.',
        successCriteria: ['Every option kind remains explicit.'],
        requiredCapabilityKeys: [],
        constraints: [
          {
            key: 'reversible',
            label: 'Prefer reversible approaches',
            kind: 'preference',
            unknownHandling: 'penalize',
            weight: 1,
          },
        ],
      },
    });
    expect(needResponse.statusCode).toBe(201);
    const need = needResponse.json<{ id: string }>();
    const providers = await pool.query<{ id: string; kind: string; name: string }>(
      `SELECT id, kind, canonical_name AS name FROM catalog.providers
       WHERE kind IN ('practice', 'oss_project') ORDER BY kind DESC, canonical_name LIMIT 2`,
    );
    expect(providers.rows).toHaveLength(2);
    expect(providers.rows.some((provider) => provider.kind === 'practice')).toBe(true);

    const inputs = [
      {
        optionKind: 'provider',
        providerId: providers.rows.find((provider) => provider.kind === 'practice')!.id,
        label: 'Source-backed practice',
      },
      {
        optionKind: 'composition',
        providerIds: providers.rows.map((provider) => provider.id),
        label: 'Two-part composition',
      },
      { optionKind: 'status_quo', label: 'Current workflow' },
      { optionKind: 'build', label: 'Bounded local build' },
      { optionKind: 'defer', label: 'Defer pending evidence' },
    ];
    for (const input of inputs) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/needs/${need.id}/candidates`,
        headers: mutationHeaders,
        payload: input,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ optionKind: input.optionKind });
    }
    const comparison = await app.inject({
      method: 'GET',
      url: `/api/v1/needs/${need.id}`,
      headers: hostHeaders,
    });
    const candidates = comparison.json<{ candidates: Array<{ optionKind: string }> }>().candidates;
    expect(new Set(candidates.map((candidate) => candidate.optionKind))).toEqual(
      new Set(['provider', 'composition', 'status_quo', 'build', 'defer']),
    );
  });

  it('furnishes reviewed knowledge through the service and rejects unsafe sources', async () => {
    const name = `Reviewed option ${randomUUID()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/options',
      headers: mutationHeaders,
      payload: {
        name,
        kind: 'practice',
        description: 'A source-backed editing practice for concise technical prose.',
        canonicalUrl: 'https://example.com/concise-writing',
        sourceTitle: 'Concise writing guidance',
        sourceOwner: 'Example publisher',
        capabilityKey: `concise-writing-${randomUUID()}`,
        capabilityName: 'Concise technical writing',
        searchTerms: ['tone', 'editing', 'technical prose'],
        limitations: ['The workflow has not been trialed in this workspace.'],
        reviewState: 'reviewed',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name, publicationState: 'reviewed' });

    const githubName = `Refreshable option ${randomUUID()}`;
    const github = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/options',
      headers: mutationHeaders,
      payload: {
        name: githubName,
        kind: 'oss_project',
        description: 'A repository-backed option that can enter the bounded refresh loop.',
        canonicalUrl: 'https://github.com/DeepSeek-AI/FlashMLA',
        sourceTitle: 'FlashMLA repository',
        sourceOwner: 'DeepSeek AI',
        capabilityKey: `optimized-attention-${randomUUID()}`,
        capabilityName: 'Optimized attention kernels',
        searchTerms: ['FlashMLA', 'attention', 'MLA'],
        limitations: ['Repository metadata is not an independent performance evaluation.'],
        reviewState: 'proposed',
      },
    });
    expect(github.statusCode).toBe(201);
    const githubIdentity = await pool.query(
      `SELECT scheme, normalized_value AS "normalizedValue", display_value AS "displayValue"
       FROM catalog.provider_identities WHERE provider_id = $1`,
      [github.json().id],
    );
    expect(githubIdentity.rows).toEqual([
      {
        scheme: 'github_repository',
        normalizedValue: 'deepseek-ai/flashmla',
        displayValue: 'https://github.com/DeepSeek-AI/FlashMLA',
      },
    ]);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/options',
      headers: mutationHeaders,
      payload: {
        name: 'Unsafe',
        kind: 'other',
        description: 'Must not admit local sources.',
        canonicalUrl: 'https://127.0.0.1/private',
        sourceTitle: 'Unsafe',
        sourceOwner: 'Unsafe',
        capabilityKey: 'unsafe-source',
        capabilityName: 'Unsafe source',
        searchTerms: ['unsafe'],
        limitations: [],
        reviewState: 'proposed',
      },
    });
    expect(blocked.statusCode).toBe(422);
  });

  it('records disabled discovery precisely and enforces idempotency', async () => {
    const session = await createSession('ai coding evaluation');
    const key = `disabled-${randomUUID()}`;
    const request = async () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/explorer/sessions/${session.id}/discovery`,
        headers: mutationHeaders,
        payload: {
          adapterKey: 'github',
          approvedPublicQuery: 'ai coding evaluation',
          idempotencyKey: key,
        },
      });
    const first = await request();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ state: 'not_configured', duplicate: false });
    const second = await request();
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ state: 'not_configured', duplicate: true });
  });

  it('runs the bounded discovery-to-review pipeline against a controlled adapter fixture', async () => {
    await pool.query(
      `UPDATE ops.source_adapter_configs SET enabled = true, daily_call_limit = 10
       WHERE adapter_key = 'github'`,
    );
    await pool.query(
      `DELETE FROM ops.adapter_daily_budgets WHERE adapter_key = 'github' AND budget_date = current_date`,
    );
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/explorer/sessions',
      headers: mutationHeaders,
      payload: {
        query: 'ai repository review fixture',
        searchConnectedSources: true,
      },
    });
    expect(requested.statusCode).toBe(201);
    expect(requested.json()).toMatchObject({
      externalDiscovery: { attempted: true, state: 'queued' },
      discoveryOperations: expect.arrayContaining([
        expect.objectContaining({ adapterKey: 'github', state: 'queued', reservedCalls: 1 }),
        expect.objectContaining({ adapterKey: 'mcp_registry', state: 'skipped' }),
      ]),
    });
    const operationId = requested.json<{
      discoveryOperations: Array<{ id: string }>;
    }>().discoveryOperations[0]!.id;
    await processDiscoveryOperation(
      pool,
      { operationId, workspaceId: localWorkspaceId },
      {
        key: 'github',
        version: 'controlled-fixture-v1',
        async search() {
          return {
            state: 'complete',
            leads: [
              {
                externalId: `fixture-${operationId}`,
                canonicalUri: `https://github.com/maestro-fixture/${operationId}`,
                title: 'maestro-fixture/discovered-option',
                summary:
                  'Controlled discovery lead used to verify admission without network access.',
                kindHint: 'oss_project',
                payload: {
                  fixture: true,
                  stars: 1_000,
                  archived: false,
                  updatedAt: '2026-09-28T12:00:00.000Z',
                },
                provenance: {
                  adapter: 'github',
                  adapterVersion: 'controlled-fixture-v1',
                  source: 'controlled integration fixture',
                  observedAt: '2026-09-29T12:00:00.000Z',
                  reviewState: 'lead',
                },
              },
            ],
            responseBytes: 128,
            httpStatus: 200,
            rateLimit: { remaining: null, resetAt: null, retryAfter: null },
          };
        },
      },
    );
    const operation = await app.inject({
      method: 'GET',
      url: `/api/v1/discovery/operations/${operationId}`,
      headers: hostHeaders,
    });
    expect(operation.json()).toMatchObject({
      state: 'complete',
      resultCount: 1,
      candidates: [
        expect.objectContaining({
          title: 'maestro-fixture/discovered-option',
          reviewState: 'lead',
          displayState: 'provisional',
          signalDisplay: expect.any(Number),
          evidenceCoverage: expect.any(Number),
        }),
      ],
    });
    const candidateId = operation.json<{ candidates: Array<{ id: string }> }>().candidates[0]!.id;
    const resultSetId = requested.json<{ resultSetId: string }>().resultSetId;
    const restored = await app.inject({
      method: 'GET',
      url: `/api/v1/explorer/result-sets/${resultSetId}`,
      headers: hostHeaders,
    });
    expect(restored.json()).toMatchObject({
      discoveryOperations: expect.arrayContaining([
        expect.objectContaining({ id: operationId, state: 'complete' }),
      ]),
    });
    const leadCorpus = await app.inject({
      method: 'POST',
      url: '/api/v1/corpus/search',
      headers: mutationHeaders,
      payload: { query: 'controlled discovery', layer: 'source_lead' },
    });
    expect(leadCorpus.statusCode).toBe(200);
    expect(leadCorpus.json()).toMatchObject({
      scoringApplied: true,
      items: [
        expect.objectContaining({
          id: candidateId,
          layer: 'source_lead',
          state: 'lead',
          signalDisplay: expect.any(Number),
          evidenceCoverage: expect.any(Number),
        }),
      ],
    });
    const admitted = await app.inject({
      method: 'POST',
      url: `/api/v1/discovery/candidates/${candidateId}/admit`,
      headers: mutationHeaders,
      payload: {
        capabilityKey: `controlled-discovery-${randomUUID()}`,
        capabilityName: 'Controlled discovery review',
        searchTerms: ['repository', 'review'],
        limitations: ['Fixture evidence only; no live source was called.'],
        reviewState: 'proposed',
        rationale: 'Exercise the supported lead-to-knowledge service path.',
      },
    });
    expect(admitted.statusCode).toBe(201);
    expect(admitted.json()).toMatchObject({ candidateId, providerId: expect.any(String) });
    const admittedCorpus = await app.inject({
      method: 'POST',
      url: '/api/v1/corpus/search',
      headers: mutationHeaders,
      payload: { query: 'controlled discovery' },
    });
    expect(admittedCorpus.json()).toMatchObject({
      scoringApplied: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          layer: 'indexed_knowledge',
          state: 'proposed',
          signalDisplay: expect.any(Number),
        }),
      ]),
    });
    expect(
      admittedCorpus
        .json<{ items: Array<{ id: string; layer: string }> }>()
        .items.some((item) => item.id === candidateId && item.layer === 'source_lead'),
    ).toBe(false);
    await pool.query(
      `UPDATE ops.source_adapter_configs SET enabled = false WHERE adapter_key = 'github'`,
    );
  });

  it('queues and stores an attributed local semantic proposal without mutating its snapshot', async () => {
    const session = await createSession('context compression tools');
    const before = await pool.query<{ hash: string }>(
      `SELECT result_hash AS hash FROM workspace.query_result_sets WHERE id = $1`,
      [session.resultSetId],
    );
    const configured = await app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/local_semantic',
      headers: mutationHeaders,
      payload: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelIdentifier: 'controlled-fixture',
        maxInputTokens: 2048,
        maxOutputTokens: 256,
      },
    });
    expect(configured.statusCode).toBe(200);
    await pool.query(
      `DELETE FROM ops.adapter_daily_budgets
       WHERE adapter_key = 'local_semantic' AND budget_date = current_date`,
    );
    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/explorer/sessions/${session.id}/semantic-proposals`,
      headers: mutationHeaders,
      payload: { idempotencyKey: `semantic-${randomUUID()}` },
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toMatchObject({
      state: 'queued',
      adapterKey: 'local_semantic',
      intent: 'semantic_interpretation',
      disclosure: {
        destination: 'configured_loopback_endpoint',
        projectContextIncluded: false,
        resultSetMutationAuthorized: false,
      },
    });
    const operationId = requested.json<{ id: string }>().id;
    await processSemanticInterpretation(
      pool,
      { operationId, workspaceId: localWorkspaceId },
      async (input) => {
        expect(input.config).toMatchObject({
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'controlled-fixture',
          maxInputTokens: 2048,
          maxOutputTokens: 256,
        });
        expect(input.payload).toMatchObject({ query: 'context compression tools' });
        return {
          output: {
            summary: 'The request concerns reducing context while retaining useful signals.',
            intentLabels: ['context reduction'],
            queryExpansions: ['repository context compression'],
            selectedCapabilityGroups: [],
            ambiguityNotes: ['The desired compression stage is not specified.'],
            sourceAnchors: [{ quote: 'context', start: 0, end: 7 }],
          },
          modelIdentifier: 'controlled-fixture',
          usage: { inputTokens: 42, outputTokens: 31 },
          reviewState: 'proposed',
        };
      },
    );
    const operation = await app.inject({
      method: 'GET',
      url: `/api/v1/discovery/operations/${operationId}`,
      headers: hostHeaders,
    });
    expect(operation.statusCode).toBe(200);
    expect(operation.json()).toMatchObject({
      state: 'complete',
      resultCount: 1,
      semanticProposal: {
        modelIdentifier: 'controlled-fixture',
        schemaVersion: 'semantic-interpretation-v1',
        reviewState: 'proposed',
        output: {
          intentLabels: ['context reduction'],
          sourceAnchors: [{ quote: 'context', start: 0, end: 7 }],
        },
        safetyChecks: {
          schemaValidated: true,
          sourceAnchorsBound: true,
          automaticResultMutation: false,
          declaredMaxInputTokens: 2048,
          modelReportedInputTokens: 42,
          modelReportedInputWithinLimit: true,
        },
      },
    });
    const after = await pool.query<{ hash: string }>(
      `SELECT result_hash AS hash FROM workspace.query_result_sets WHERE id = $1`,
      [session.resultSetId],
    );
    expect(after.rows[0]!.hash).toBe(before.rows[0]!.hash);
    await pool.query(
      `UPDATE ops.source_adapter_configs SET enabled = false
       WHERE adapter_key = 'local_semantic'`,
    );
  });

  it('rejects non-loopback local inference configuration before it can be enabled', async () => {
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/local_semantic',
      headers: mutationHeaders,
      payload: {
        enabled: true,
        baseUrl: 'https://inference.example/v1',
        modelIdentifier: 'remote-model',
        maxInputTokens: 2048,
        maxOutputTokens: 256,
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: 'invalid_domain_input' });
    const stored = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM ops.source_adapter_configs WHERE adapter_key = 'local_semantic'`,
    );
    expect(stored.rows[0]!.enabled).toBe(false);
  });

  it('reserves a shared external-call budget atomically under concurrent requests', async () => {
    const session = await createSession('ai concurrent budget fixture');
    await pool.query(
      `UPDATE ops.source_adapter_configs SET enabled = true, daily_call_limit = 1
       WHERE adapter_key = 'github'`,
    );
    await pool.query(
      `DELETE FROM ops.adapter_daily_budgets WHERE adapter_key = 'github' AND budget_date = current_date`,
    );
    const responses = await Promise.all(
      [randomUUID(), randomUUID()].map((key) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/explorer/sessions/${session.id}/discovery`,
          headers: mutationHeaders,
          payload: {
            adapterKey: 'github',
            approvedPublicQuery: 'ai concurrent budget fixture',
            idempotencyKey: `concurrent-${key}`,
          },
        }),
      ),
    );
    expect(responses.map((response) => response.json<{ state: string }>().state).sort()).toEqual([
      'budget_denied',
      'queued',
    ]);
    const budget = await pool.query<{ reserved: number; denied: number }>(
      `SELECT reserved_calls AS reserved, denied_calls AS denied
       FROM ops.adapter_daily_budgets
       WHERE adapter_key = 'github' AND budget_date = current_date`,
    );
    expect(budget.rows[0]).toEqual({ reserved: 1, denied: 1 });
    await pool.query(
      `UPDATE ops.source_adapter_configs SET enabled = false WHERE adapter_key = 'github'`,
    );
  });

  it('reports bounded knowledge coverage without exposing retained query text', async () => {
    const canary = `PRIVATE_COVERAGE_QUERY_${randomUUID()}`;
    await createSession(`${canary} ai context compression`);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/coverage',
      headers: hostHeaders,
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<{
      scope: { label: string; statement: string };
      knowledge: { total: number };
      domains: Array<{ total: number }>;
      sourceClasses: unknown[];
      depth: Array<{ items: number }>;
      discovery: {
        allocationPolicy: {
          dailyExternalCallLimit: number;
          perSearchCallLimitPerSource: number;
        };
      };
      queryGaps: { sessions: number; repeatedEmptyAreas: unknown[] };
    }>();
    expect(report.scope).toMatchObject({
      label: 'Tracked local corpus',
      statement:
        'Counts describe source-bound records in this Maestro instance, not a percentage of all AI knowledge.',
    });
    expect(report.knowledge.total).toBeGreaterThanOrEqual(61);
    expect(report.domains.length).toBeGreaterThan(0);
    expect(report.sourceClasses.length).toBeGreaterThan(0);
    expect(report.depth.reduce((sum, item) => sum + item.items, 0)).toBe(report.knowledge.total);
    expect(report.discovery.allocationPolicy).toMatchObject({
      dailyExternalCallLimit: 50,
      perSearchCallLimitPerSource: 1,
    });
    expect(report.queryGaps.sessions).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(canary);
  });

  it('redacts retained private query text through the supported delete control', async () => {
    const canary = `PRIVATE_QUERY_${randomUUID()}`;
    const session = await createSession(`${canary} ai`);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/explorer/sessions/${session.id}`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    const stored = await pool.query<{ query: string; intent: unknown; deletedAt: Date | null }>(
      `SELECT query_text AS query, normalized_intent AS intent, deleted_at AS "deletedAt"
       FROM workspace.query_sessions WHERE id = $1`,
      [session.id],
    );
    expect(stored.rows[0]).toMatchObject({ query: '[deleted by user]', intent: {} });
    expect(stored.rows[0]!.deletedAt).not.toBeNull();
    expect(JSON.stringify(stored.rows[0])).not.toContain(canary);
  });

  it('records unchanged, changed, and failed watch checks without inventing evidence', async () => {
    const provider = await pool.query<{ id: string }>(
      `SELECT DISTINCT p.id
       FROM catalog.providers p
       JOIN catalog.provider_evidence_bindings peb ON peb.provider_id = p.id
       JOIN catalog.evidence_items ei ON ei.id = peb.evidence_item_id
       JOIN catalog.source_observations so ON so.id = ei.source_observation_id
       ORDER BY p.id LIMIT 1`,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/watches',
      headers: mutationHeaders,
      payload: { providerId: provider.rows[0]!.id, cadence: 'manual', priority: 70 },
    });
    expect(created.statusCode).toBe(201);
    const watch = created.json<{ id: string; sourceId: string; sourceWatermark: string }>();
    const before = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.source_observations WHERE source_id = $1`,
      [watch.sourceId],
    );

    const unchanged = await app.inject({
      method: 'POST',
      url: `/api/v1/watches/${watch.id}/checks`,
      headers: mutationHeaders,
      payload: {
        outcome: 'unchanged',
        watermark: watch.sourceWatermark,
        reason: 'Injected unchanged fixture for deterministic verification.',
      },
    });
    expect(unchanged.statusCode).toBe(201);
    expect(unchanged.json()).toMatchObject({ outcome: 'unchanged', observationId: null });
    const afterUnchanged = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.source_observations WHERE source_id = $1`,
      [watch.sourceId],
    );
    expect(afterUnchanged.rows[0]!.count).toBe(before.rows[0]!.count);

    const watermark = createHash('sha256').update(`changed:${watch.id}`).digest('hex');
    const changed = await app.inject({
      method: 'POST',
      url: `/api/v1/watches/${watch.id}/checks`,
      headers: mutationHeaders,
      payload: {
        outcome: 'changed',
        watermark,
        predicate: 'maintainer-status',
        applicabilityScope: 'public provider maintenance metadata',
        reason: 'Injected material-change fixture; not a live source claim.',
      },
    });
    expect(changed.statusCode).toBe(201);
    expect(changed.json()).toMatchObject({
      outcome: 'changed',
      observationId: expect.any(String),
      materialChange: { predicate: 'maintainer-status' },
    });
    const afterChanged = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.source_observations WHERE source_id = $1`,
      [watch.sourceId],
    );
    expect(afterChanged.rows[0]!.count).toBe(before.rows[0]!.count + 1);

    const failed = await app.inject({
      method: 'POST',
      url: `/api/v1/watches/${watch.id}/checks`,
      headers: mutationHeaders,
      payload: { outcome: 'failed', reason: 'Injected timeout fixture; state is not all-clear.' },
    });
    expect(failed.statusCode).toBe(201);
    expect(failed.json()).toMatchObject({ outcome: 'failed', observationId: null });
    const afterFailed = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.source_observations WHERE source_id = $1`,
      [watch.sourceId],
    );
    expect(afterFailed.rows[0]!.count).toBe(afterChanged.rows[0]!.count);

    const changes = await app.inject({
      method: 'GET',
      url: '/api/v1/changes',
      headers: hostHeaders,
    });
    const notice = changes
      .json<{ items: Array<{ id: string; reason: string }> }>()
      .items.find((item) => item.reason.includes('Injected material-change fixture'));
    expect(notice).toBeDefined();
    const disposition = await app.inject({
      method: 'PUT',
      url: `/api/v1/changes/${notice!.id}`,
      headers: mutationHeaders,
      payload: { disposition: 'reviewed', note: 'Fixture reviewed.' },
    });
    expect(disposition.statusCode).toBe(200);
    expect(disposition.json()).toMatchObject({ disposition: 'reviewed' });
  });

  it('recovers due schedules idempotently and preserves explicit disable state', async () => {
    const provider = await pool.query<{ id: string }>(
      `SELECT p.id FROM catalog.providers p
       WHERE NOT EXISTS (
         SELECT 1 FROM workspace.watches w
         WHERE w.workspace_id = $1 AND w.provider_id = p.id AND w.cadence = 'daily'
       )
       ORDER BY p.id LIMIT 1`,
      [localWorkspaceId],
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/watches',
      headers: mutationHeaders,
      payload: { providerId: provider.rows[0]!.id, cadence: 'daily', priority: 99 },
    });
    expect(created.statusCode).toBe(201);
    const watchId = created.json<{ id: string }>().id;
    await pool.query('DELETE FROM ops.outbox WHERE operation_key LIKE $1', [`watch:${watchId}:%`]);
    await pool.query(
      `UPDATE workspace.watches
       SET next_due_at = now() - interval '1 minute', lease_token = NULL, lease_until = NULL
       WHERE id = $1`,
      [watchId],
    );
    expect(await recoverDueWatches(pool)).toBeGreaterThanOrEqual(1);
    await recoverDueWatches(pool);
    const outbox = await pool.query<{ count: number; taskName: string }>(
      `SELECT count(*)::int AS count, max(task_name) AS "taskName"
       FROM ops.outbox WHERE operation_key LIKE $1`,
      [`watch:${watchId}:%`],
    );
    expect(outbox.rows[0]).toEqual({ count: 1, taskName: 'refresh_watch_v2' });
    const disabled = await app.inject({
      method: 'PUT',
      url: `/api/v1/watches/${watchId}/state`,
      headers: mutationHeaders,
      payload: { state: 'disabled' },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ state: 'disabled', nextDueAt: null });
  });

  it('binds new fit evidence relationally and rejects a cross-provider reference', async () => {
    const suffix = randomUUID();
    const projectResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${localWorkspaceId}/projects`,
      headers: mutationHeaders,
      payload: {
        name: `Integrity project ${suffix}`,
        context: { goal: 'Verify relational binding.' },
      },
    });
    const project = projectResponse.json<{ id: string }>();
    const provider = await pool.query<{ id: string }>(
      `SELECT provider_id AS id FROM catalog.provider_compatibility
       WHERE compatibility_key = 'macos' AND cardinality(evidence_ids) > 0 LIMIT 1`,
    );
    const needResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/needs',
      headers: mutationHeaders,
      payload: {
        projectId: project.id,
        title: 'Evidence binding integrity',
        desiredOutcome: 'Reject evidence from the wrong provider.',
        successCriteria: ['Cross-provider references fail closed.'],
        requiredCapabilityKeys: [],
        constraints: [
          {
            key: 'macos',
            label: 'macOS support',
            kind: 'hard_gate',
            unknownHandling: 'block',
          },
        ],
      },
    });
    const need = needResponse.json<{ id: string }>();
    const candidateResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/needs/${need.id}/candidates`,
      headers: mutationHeaders,
      payload: {
        providerId: provider.rows[0]!.id,
        optionKind: 'provider',
        label: 'Bound provider candidate',
      },
    });
    expect(candidateResponse.statusCode).toBe(201);
    const candidate = candidateResponse.json<{ id: string }>();
    const fit = await pool.query<{ id: string; bindingCount: number }>(
      `SELECT fa.id, count(faeb.id)::int AS "bindingCount"
       FROM workspace.fit_assessments fa
       LEFT JOIN workspace.fit_assessment_evidence_bindings faeb
         ON faeb.fit_assessment_id = fa.id
       WHERE fa.candidate_id = $1 GROUP BY fa.id`,
      [candidate.id],
    );
    expect(fit.rows[0]!.bindingCount).toBeGreaterThan(0);
    const otherEvidence = await pool.query<{ id: string }>(
      `SELECT evidence_item_id AS id FROM catalog.provider_evidence_bindings
       WHERE provider_id <> $1 LIMIT 1`,
      [provider.rows[0]!.id],
    );
    await expect(
      pool.query(
        `INSERT INTO workspace.fit_assessment_evidence_bindings
           (id, fit_assessment_id, workspace_id, candidate_id, catalog_evidence_id,
            applicability_scope)
         VALUES ($1, $2, $3, $4, $5, 'invalid-cross-provider-fixture')`,
        [randomUUID(), fit.rows[0]!.id, localWorkspaceId, candidate.id, otherEvidence.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('serves decision labels from their immutable display snapshot', async () => {
    const suffix = randomUUID();
    const projectResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${localWorkspaceId}/projects`,
      headers: mutationHeaders,
      payload: { name: `Snapshot project ${suffix}`, context: { goal: 'Preserve labels.' } },
    });
    const project = projectResponse.json<{ id: string }>();
    const needResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/needs',
      headers: mutationHeaders,
      payload: {
        projectId: project.id,
        title: `Snapshot need ${suffix}`,
        desiredOutcome: 'Preserve decision display inputs.',
        successCriteria: ['Historical labels survive current-label edits.'],
        requiredCapabilityKeys: [],
        constraints: [
          {
            key: 'reversibility',
            label: 'Reversibility is preferred',
            kind: 'preference',
            unknownHandling: 'penalize',
            weight: 1,
          },
        ],
      },
    });
    const need = needResponse.json<{ id: string }>();
    const candidateResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/needs/${need.id}/candidates`,
      headers: mutationHeaders,
      payload: { optionKind: 'status_quo', label: 'Original status quo' },
    });
    const candidate = candidateResponse.json<{ id: string }>();
    const comparison = await app.inject({
      method: 'GET',
      url: `/api/v1/needs/${need.id}`,
      headers: hostHeaders,
    });
    expect(
      comparison.json<{ candidates: Array<{ preferenceResult: { band: string } }> }>()
        .candidates[0]!.preferenceResult.band,
    ).toBe('Insufficient evidence');
    const decisionResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/needs/${need.id}/decisions`,
      headers: mutationHeaders,
      payload: {
        outcome: 'trial',
        selectedCandidateId: candidate.id,
        rationale: 'Verify display snapshot behavior.',
        conditions: ['No execution authority is granted.'],
      },
    });
    expect(decisionResponse.statusCode).toBe(201);
    const decision = decisionResponse.json<{ id: string }>();
    await pool.query(
      `UPDATE workspace.projects SET name = 'Changed current project' WHERE id = $1`,
      [project.id],
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/decisions/${decision.id}`,
      headers: hostHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      projectName: `Snapshot project ${suffix}`,
      selectedCandidateLabel: 'Original status quo',
      displayCaptureState: 'captured',
      receiptVerified: true,
    });
  });
});
