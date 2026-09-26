import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import {
  CandidateBodySchema,
  CatalogQuerySchema,
  DecisionBodySchema,
  IdParamsSchema,
  IntakeBodySchema,
  IntakeCurationBodySchema,
  NeedBodySchema,
  ReviseNeedBodySchema,
  WorkspaceParamsSchema,
  type CandidateBody,
  type DecisionBody,
  type IntakeBody,
  type NeedBody,
  type ReviseNeedBody,
} from '../../../packages/contracts/src/index.js';
import {
  addCandidate,
  createIntake,
  createNeed,
  curateIntake,
  getDecision,
  getIntake,
  getNeedComparison,
  getProviderDetail,
  listDomains,
  listIntakes,
  listNeeds,
  listProjects,
  listProviders,
  listVerificationQueue,
  NotFoundError,
  recordDecision,
  replayStoredScores,
  retryIntake,
  reviseNeed,
} from '../../../packages/db/src/index.js';
import { localWorkspaceId } from '../../../packages/seed/src/import.js';

interface IdParams {
  id: string;
}

interface WorkspaceParams {
  workspaceId: string;
}

interface NeedParams {
  id: string;
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
    }>(`
      SELECT
        (SELECT count(*)::int FROM ops.schema_migrations) AS migrations,
        (SELECT count(*)::int FROM catalog.providers) AS providers,
        (to_regclass('graphile_worker.jobs') IS NOT NULL) AS "workerSchemaReady",
        EXISTS (
          SELECT 1 FROM ops.worker_heartbeats
          WHERE worker_key = 'local-intake-worker' AND last_seen_at > now() - interval '15 seconds'
        ) AS "workerActive"
    `);
    const state = result.rows[0]!;
    const ready =
      state.migrations >= 8 &&
      state.providers === 12 &&
      state.workerSchemaReady &&
      state.workerActive;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', ...state });
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
