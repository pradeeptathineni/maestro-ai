import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import {
  AdapterConfigBodySchema,
  AdapterParamsSchema,
  BundleExportBodySchema,
  CandidateBodySchema,
  ChangeDispositionBodySchema,
  CatalogQuerySchema,
  ComparisonBodySchema,
  CorpusBrowseQuerySchema,
  CorpusSearchBodySchema,
  DecisionBodySchema,
  DiscoveryAdmissionBodySchema,
  DiscoveryRequestBodySchema,
  ExplorerQueryBodySchema,
  GraphQuerySchema,
  IdParamsSchema,
  IntakeBodySchema,
  IntakeCurationBodySchema,
  KnowledgeOptionBodySchema,
  NeedBodySchema,
  ProjectBodySchema,
  ProjectContextRevisionBodySchema,
  ResultItemParamsSchema,
  ResultPageQuerySchema,
  ReviseNeedBodySchema,
  SemanticProposalRequestBodySchema,
  ShortlistBodySchema,
  WatchBodySchema,
  WatchCheckBodySchema,
  WatchStateBodySchema,
  WorkspaceParamsSchema,
  type AdapterConfigBody,
  type BundleExportBody,
  type CandidateBody,
  type ChangeDispositionBody,
  type ComparisonBody,
  type CorpusBrowseQuery,
  type CorpusSearchBody,
  type DecisionBody,
  type DiscoveryAdmissionBody,
  type DiscoveryRequestBody,
  type ExplorerQueryBody,
  type IntakeBody,
  type KnowledgeOptionBody,
  type NeedBody,
  type ProjectBody,
  type ProjectContextRevisionBody,
  type ResultPageQuery,
  type ReviseNeedBody,
  type SemanticProposalRequestBody,
  type ShortlistBody,
  type WatchBody,
  type WatchCheckBody,
  type WatchStateBody,
} from '../../../packages/contracts/src/index.js';
import {
  addCandidate,
  admitDiscoveryCandidate,
  cancelDiscoveryOperation,
  compareExplorerItems,
  configureAdapter,
  createIntake,
  createNeed,
  createExplorerSession,
  createProject,
  createWatch,
  curateIntake,
  exportExplorerBundle,
  getDecision,
  getDiscoveryOperation,
  getExplorerGraph,
  getExplorerItem,
  getExplorerResultPage,
  getIntake,
  getNeedComparison,
  getKnowledgeCoverageReport,
  getProviderDetail,
  furnishKnowledgeOption,
  listAdapterStatus,
  listResearchCorpus,
  listDomains,
  listExplorerSessions,
  listIntakes,
  listNeeds,
  listProjects,
  listMaterialChanges,
  listProviders,
  listVerificationQueue,
  listWatches,
  NotFoundError,
  recordDecision,
  redactExplorerSession,
  replayStoredScores,
  requestDiscovery,
  requestEnabledDiscovery,
  requestSemanticInterpretation,
  retryIntake,
  reviseProjectContext,
  reviseNeed,
  saveShortlist,
  setChangeDisposition,
  setWatchState,
  recordWatchCheck,
  refreshExplorerSession,
} from '../../../packages/db/src/index.js';
import { localWorkspaceId } from '../../../packages/seed/src/import.js';
import { assessReadiness } from './readiness.js';

interface IdParams {
  id: string;
}

interface WorkspaceParams {
  workspaceId: string;
}

interface NeedParams {
  id: string;
}

interface ResultItemParams {
  id: string;
  itemId: string;
}

export function registerRoutes(app: FastifyInstance, pool: Pool): void {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>();
  routes.get('/api/v1/health/live', { schema: { tags: ['health'] } }, () => ({
    status: 'ok',
    service: 'maestro-api',
  }));

  routes.get('/api/v1/health/ready', { schema: { tags: ['health'] } }, async (_request, reply) => {
    const result = await pool.query<{
      migrations: number;
      providers: number;
      workerSchemaReady: boolean;
      workerActive: boolean;
      enabledAdapters: number;
      unhealthyAdapters: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM ops.schema_migrations) AS migrations,
        (SELECT count(*)::int FROM catalog.providers) AS providers,
        (to_regclass('graphile_worker.jobs') IS NOT NULL) AS "workerSchemaReady",
        EXISTS (
          SELECT 1 FROM ops.worker_heartbeats
          WHERE worker_key = 'local-intake-worker' AND last_seen_at > now() - interval '15 seconds'
        ) AS "workerActive",
        (SELECT count(*)::int FROM ops.source_adapter_configs WHERE enabled) AS "enabledAdapters",
        (SELECT count(DISTINCT config.adapter_key)::int
           FROM ops.source_adapter_configs config
           JOIN LATERAL (
             SELECT state FROM ops.source_health_events health
             WHERE health.adapter_key = config.adapter_key
             ORDER BY checked_at DESC LIMIT 1
           ) latest ON true
          WHERE config.enabled AND latest.state IN ('failed', 'partial')) AS "unhealthyAdapters"
    `);
    const state = result.rows[0]!;
    const assessment = assessReadiness(state);
    return reply.code(assessment.ready ? 200 : 503).send({ ...assessment, ...state });
  });

  routes.get('/api/v1/openapi.json', { schema: { hide: true } }, () => app.swagger());

  routes.get('/api/v1/domains', { schema: { tags: ['catalog'] } }, async () => ({
    items: await listDomains(pool),
  }));

  routes.get<{ Querystring: Record<string, unknown> }>(
    '/api/v1/providers',
    { schema: { tags: ['catalog'], querystring: CatalogQuerySchema } },
    async (request) => listProviders(pool, request.query),
  );

  routes.get<{ Params: IdParams }>(
    '/api/v1/providers/:id',
    { schema: { tags: ['catalog'], params: IdParamsSchema } },
    async (request) => {
      const provider = await getProviderDetail(pool, request.params.id);
      if (!provider) throw new NotFoundError('Provider not found.');
      return provider;
    },
  );

  routes.get('/api/v1/verification', { schema: { tags: ['evidence'] } }, async () => ({
    items: await listVerificationQueue(pool),
  }));

  routes.get('/api/v1/workspace', { schema: { tags: ['workspace'] } }, () => ({
    id: localWorkspaceId,
    boundary: 'private_local',
    modelRequired: false,
    executionAvailable: false,
  }));

  routes.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/projects',
    { schema: { tags: ['workspace'], params: WorkspaceParamsSchema } },
    async (request) => ({ items: await listProjects(pool, request.params.workspaceId) }),
  );

  routes.post<{ Params: WorkspaceParams; Body: ProjectBody }>(
    '/api/v1/workspaces/:workspaceId/projects',
    { schema: { tags: ['workspace'], params: WorkspaceParamsSchema, body: ProjectBodySchema } },
    async (request, reply) =>
      reply.code(201).send(await createProject(pool, request.params.workspaceId, request.body)),
  );

  routes.post<{ Params: IdParams; Body: ProjectContextRevisionBody }>(
    '/api/v1/projects/:id/contexts',
    {
      schema: {
        tags: ['workspace'],
        params: IdParamsSchema,
        body: ProjectContextRevisionBodySchema,
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await reviseProjectContext(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.post<{ Body: KnowledgeOptionBody }>(
    '/api/v1/knowledge/options',
    { schema: { tags: ['knowledge-review'], body: KnowledgeOptionBodySchema } },
    async (request, reply) =>
      reply.code(201).send(await furnishKnowledgeOption(pool, localWorkspaceId, request.body)),
  );

  routes.get('/api/v1/knowledge/coverage', { schema: { tags: ['knowledge-review'] } }, async () =>
    getKnowledgeCoverageReport(pool, localWorkspaceId),
  );

  routes.get<{ Querystring: CorpusBrowseQuery }>(
    '/api/v1/corpus',
    { schema: { tags: ['research-corpus'], querystring: CorpusBrowseQuerySchema } },
    async (request) => {
      const { layer, state, source, kind, cursor, limit } = request.query;
      return listResearchCorpus(pool, localWorkspaceId, {
        layer,
        state,
        source,
        kind,
        cursor,
        limit,
      });
    },
  );

  routes.post<{ Body: CorpusSearchBody }>(
    '/api/v1/corpus/search',
    { schema: { tags: ['research-corpus'], body: CorpusSearchBodySchema } },
    async (request) => listResearchCorpus(pool, localWorkspaceId, request.body),
  );

  routes.get('/api/v1/explorer/sessions', { schema: { tags: ['explorer'] } }, async () => ({
    items: await listExplorerSessions(pool, localWorkspaceId),
  }));

  routes.post<{ Body: ExplorerQueryBody }>(
    '/api/v1/explorer/sessions',
    { schema: { tags: ['explorer'], body: ExplorerQueryBodySchema } },
    async (request, reply) => {
      const session = (await createExplorerSession(pool, localWorkspaceId, request.body)) as Record<
        string,
        unknown
      > & { id: string };
      const discoveryOperations = request.body.searchConnectedSources
        ? await requestEnabledDiscovery(
            pool,
            localWorkspaceId,
            session.id,
            request.body.query.trim(),
          )
        : [];
      return reply.code(201).send({
        ...session,
        externalDiscovery: {
          attempted: discoveryOperations.length > 0,
          state: discoveryOperations.length > 0 ? 'queued' : 'not_configured',
        },
        discoveryOperations,
      });
    },
  );

  routes.post<{ Params: IdParams }>(
    '/api/v1/explorer/sessions/:id/refresh',
    { schema: { tags: ['explorer'], params: IdParamsSchema, body: {} } },
    async (request) => refreshExplorerSession(pool, localWorkspaceId, request.params.id),
  );

  routes.delete<{ Params: IdParams }>(
    '/api/v1/explorer/sessions/:id',
    { schema: { tags: ['explorer'], params: IdParamsSchema, body: {} } },
    async (request, reply) => {
      await redactExplorerSession(pool, localWorkspaceId, request.params.id);
      return reply.code(204).send();
    },
  );

  routes.get<{ Params: IdParams; Querystring: ResultPageQuery }>(
    '/api/v1/explorer/result-sets/:id',
    {
      schema: {
        tags: ['explorer'],
        params: IdParamsSchema,
        querystring: ResultPageQuerySchema,
      },
    },
    async (request) =>
      getExplorerResultPage(pool, localWorkspaceId, request.params.id, request.query),
  );

  routes.get<{ Params: IdParams; Querystring: ResultPageQuery & { limit?: number } }>(
    '/api/v1/explorer/result-sets/:id/graph',
    { schema: { tags: ['explorer'], params: IdParamsSchema, querystring: GraphQuerySchema } },
    async (request) => getExplorerGraph(pool, localWorkspaceId, request.params.id, request.query),
  );

  routes.get<{ Params: ResultItemParams }>(
    '/api/v1/explorer/result-sets/:id/items/:itemId',
    { schema: { tags: ['explorer'], params: ResultItemParamsSchema } },
    async (request) =>
      getExplorerItem(pool, localWorkspaceId, request.params.id, request.params.itemId),
  );

  routes.post<{ Params: IdParams; Body: ComparisonBody }>(
    '/api/v1/explorer/result-sets/:id/compare',
    { schema: { tags: ['explorer'], params: IdParamsSchema, body: ComparisonBodySchema } },
    async (request) =>
      compareExplorerItems(pool, localWorkspaceId, request.params.id, request.body.resultItemIds),
  );

  routes.post<{ Params: IdParams; Body: ShortlistBody }>(
    '/api/v1/explorer/result-sets/:id/shortlists',
    { schema: { tags: ['explorer'], params: IdParamsSchema, body: ShortlistBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(await saveShortlist(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.post<{ Params: IdParams; Body: BundleExportBody }>(
    '/api/v1/explorer/result-sets/:id/export',
    { schema: { tags: ['explorer'], params: IdParamsSchema, body: BundleExportBodySchema } },
    async (request) =>
      exportExplorerBundle(pool, localWorkspaceId, request.params.id, request.body),
  );

  routes.post<{ Params: IdParams; Body: DiscoveryRequestBody }>(
    '/api/v1/explorer/sessions/:id/discovery',
    { schema: { tags: ['discovery'], params: IdParamsSchema, body: DiscoveryRequestBodySchema } },
    async (request, reply) =>
      reply
        .code(202)
        .send(await requestDiscovery(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.post<{ Params: IdParams; Body: SemanticProposalRequestBody }>(
    '/api/v1/explorer/sessions/:id/semantic-proposals',
    {
      schema: {
        tags: ['semantic-assistance'],
        params: IdParamsSchema,
        body: SemanticProposalRequestBodySchema,
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await requestSemanticInterpretation(
            pool,
            localWorkspaceId,
            request.params.id,
            request.body,
          ),
        ),
  );

  routes.get<{ Params: IdParams }>(
    '/api/v1/discovery/operations/:id',
    { schema: { tags: ['discovery'], params: IdParamsSchema } },
    async (request) => getDiscoveryOperation(pool, localWorkspaceId, request.params.id),
  );

  routes.post<{ Params: IdParams }>(
    '/api/v1/discovery/operations/:id/cancel',
    { schema: { tags: ['discovery'], params: IdParamsSchema, body: {} } },
    async (request) => cancelDiscoveryOperation(pool, localWorkspaceId, request.params.id),
  );

  routes.post<{ Params: IdParams; Body: DiscoveryAdmissionBody }>(
    '/api/v1/discovery/candidates/:id/admit',
    {
      schema: {
        tags: ['knowledge-review'],
        params: IdParamsSchema,
        body: DiscoveryAdmissionBodySchema,
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await admitDiscoveryCandidate(pool, localWorkspaceId, request.params.id, request.body),
        ),
  );

  routes.get('/api/v1/integrations', { schema: { tags: ['operations'] } }, async () => ({
    items: await listAdapterStatus(pool),
  }));

  routes.put<{ Params: IdParams; Body: AdapterConfigBody }>(
    '/api/v1/integrations/:id',
    {
      schema: { tags: ['operations'], params: AdapterParamsSchema, body: AdapterConfigBodySchema },
    },
    async (request) => configureAdapter(pool, request.params.id, request.body),
  );

  routes.get('/api/v1/watches', { schema: { tags: ['refresh'] } }, async () => ({
    items: await listWatches(pool, localWorkspaceId),
  }));

  routes.post<{ Body: WatchBody }>(
    '/api/v1/watches',
    { schema: { tags: ['refresh'], body: WatchBodySchema } },
    async (request, reply) =>
      reply.code(201).send(await createWatch(pool, localWorkspaceId, request.body)),
  );

  routes.put<{ Params: IdParams; Body: WatchStateBody }>(
    '/api/v1/watches/:id/state',
    { schema: { tags: ['refresh'], params: IdParamsSchema, body: WatchStateBodySchema } },
    async (request) => setWatchState(pool, localWorkspaceId, request.params.id, request.body),
  );

  routes.post<{ Params: IdParams; Body: WatchCheckBody }>(
    '/api/v1/watches/:id/checks',
    { schema: { tags: ['refresh'], params: IdParamsSchema, body: WatchCheckBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(await recordWatchCheck(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.get('/api/v1/changes', { schema: { tags: ['refresh'] } }, async () => ({
    items: await listMaterialChanges(pool, localWorkspaceId),
  }));

  routes.put<{ Params: IdParams; Body: ChangeDispositionBody }>(
    '/api/v1/changes/:id',
    {
      schema: {
        tags: ['refresh'],
        params: IdParamsSchema,
        body: ChangeDispositionBodySchema,
      },
    },
    async (request) =>
      setChangeDisposition(pool, localWorkspaceId, request.params.id, request.body),
  );

  routes.get('/api/v1/needs', { schema: { tags: ['decisions'] } }, async () => ({
    items: await listNeeds(pool, localWorkspaceId),
  }));

  routes.post<{ Body: NeedBody }>(
    '/api/v1/needs',
    { schema: { tags: ['decisions'], body: NeedBodySchema } },
    async (request, reply) =>
      reply.code(201).send(await createNeed(pool, localWorkspaceId, request.body)),
  );

  routes.put<{ Params: NeedParams; Body: ReviseNeedBody }>(
    '/api/v1/needs/:id',
    { schema: { tags: ['decisions'], params: IdParamsSchema, body: ReviseNeedBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(await reviseNeed(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.get<{ Params: NeedParams }>(
    '/api/v1/needs/:id',
    { schema: { tags: ['decisions'], params: IdParamsSchema } },
    async (request) => {
      const need = await getNeedComparison(pool, localWorkspaceId, request.params.id);
      if (!need) throw new NotFoundError('Need not found.');
      return need;
    },
  );

  routes.post<{ Params: NeedParams; Body: CandidateBody }>(
    '/api/v1/needs/:id/candidates',
    { schema: { tags: ['decisions'], params: IdParamsSchema, body: CandidateBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(await addCandidate(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.post<{ Params: NeedParams; Body: DecisionBody }>(
    '/api/v1/needs/:id/decisions',
    { schema: { tags: ['decisions'], params: IdParamsSchema, body: DecisionBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(await recordDecision(pool, localWorkspaceId, request.params.id, request.body)),
  );

  routes.get<{ Params: IdParams }>(
    '/api/v1/decisions/:id',
    { schema: { tags: ['decisions'], params: IdParamsSchema } },
    async (request) => {
      const decision = await getDecision(pool, localWorkspaceId, request.params.id);
      if (!decision) throw new NotFoundError('Decision not found.');
      return decision;
    },
  );

  routes.post('/api/v1/score-runs/replay', { schema: { tags: ['catalog'], body: {} } }, async () =>
    replayStoredScores(pool),
  );

  routes.get('/api/v1/intakes', { schema: { tags: ['intake'] } }, async () => ({
    items: await listIntakes(pool, localWorkspaceId),
  }));

  routes.post<{ Body: IntakeBody }>(
    '/api/v1/intakes',
    { schema: { tags: ['intake'], body: IntakeBodySchema } },
    async (request, reply) =>
      reply.code(201).send(await createIntake(pool, localWorkspaceId, request.body, request.id)),
  );

  routes.get<{ Params: IdParams }>(
    '/api/v1/intakes/:id',
    { schema: { tags: ['intake'], params: IdParamsSchema } },
    async (request) => {
      const intake = await getIntake(pool, localWorkspaceId, request.params.id);
      if (!intake) throw new NotFoundError('Intake not found.');
      return intake;
    },
  );

  routes.post<{ Params: IdParams }>(
    '/api/v1/intakes/:id/retry',
    { schema: { tags: ['intake'], params: IdParamsSchema, body: {} } },
    async (request, reply) => {
      await retryIntake(pool, localWorkspaceId, request.params.id, request.id);
      return reply.code(202).send({ status: 'queued' });
    },
  );

  routes.post<{
    Params: IdParams;
    Body: { providerId: string; action: 'attach' | 'merge_duplicate' };
  }>(
    '/api/v1/intakes/:id/curate',
    { schema: { tags: ['intake'], params: IdParamsSchema, body: IntakeCurationBodySchema } },
    async (request) => {
      await curateIntake(
        pool,
        localWorkspaceId,
        request.params.id,
        request.body.providerId,
        request.body.action,
        request.id,
      );
      return { status: 'curated' };
    },
  );
}
