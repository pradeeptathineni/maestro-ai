import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ConflictError,
  createPool,
  DomainValidationError,
  NotFoundError,
} from '../../../packages/db/src/index.js';
import { apiConfig, type ApiConfig } from './config.js';
import { registerInstrumentation } from './instrumentation.js';
import { loggerOptions } from './logging.js';
import { registerRoutes } from './routes.js';
import { registerSecurityBoundary } from './security.js';

export interface BuildAppOptions {
  pool?: Pool;
  config?: ApiConfig;
  logger?: boolean;
  staticDirectory?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? apiConfig();
  const pool = options.pool ?? createPool();
  const ownsPool = !options.pool;
  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: false,
    genReqId: () => randomUUID(),
    logger: options.logger === false ? false : loggerOptions,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Maestro local API',
        version: '0.1.0',
        description: 'Local, deterministic evidence-to-decision API. No execution routes exist.',
      },
      servers: [{ url: `http://127.0.0.1:${config.port}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/documentation' });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: [
          "'self'",
          ...[...config.allowedOrigins].filter((origin) => !origin.includes('[::1]')),
        ],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || config.allowedOrigins.has(origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-maestro-request'],
  });
  await app.register(rateLimit, { max: config.rateLimitMax, timeWindow: '1 minute' });

  // Fastify snapshots the active error handler when routes are registered, so
  // install Maestro's stable problem-details boundary before route creation.
  app.setErrorHandler((error, request, reply) => {
    const knownError = error instanceof Error ? error : new Error('Unknown request error.');
    const validation =
      (typeof error === 'object' &&
        error !== null &&
        'validation' in error &&
        Boolean(error.validation)) ||
      (error as { code?: string }).code === 'FST_ERR_VALIDATION';
    const declaredStatus = (error as { statusCode?: unknown }).statusCode;
    const frameworkClientStatus =
      typeof declaredStatus === 'number' &&
      Number.isInteger(declaredStatus) &&
      declaredStatus >= 400 &&
      declaredStatus < 500
        ? declaredStatus
        : null;
    const status =
      error instanceof NotFoundError
        ? 404
        : error instanceof ConflictError || (error as { code?: string }).code === '23505'
          ? 409
          : error instanceof DomainValidationError
            ? 422
            : validation
              ? 400
              : (frameworkClientStatus ?? 500);
    const code =
      error instanceof NotFoundError
        ? error.code
        : error instanceof ConflictError
          ? error.code
          : error instanceof DomainValidationError
            ? error.code
            : validation
              ? 'request_validation_failed'
              : status === 429
                ? 'rate_limit_exceeded'
                : status === 409
                  ? 'conflict'
                  : status < 500
                    ? 'request_rejected'
                    : 'internal_error';
    if (status >= 500)
      request.log.error({ err: knownError, correlationId: request.id }, 'request failed');
    return reply.code(status).send({
      type: 'about:blank',
      title:
        status >= 500
          ? 'Internal error'
          : status === 429
            ? 'Too many requests'
            : 'Request rejected',
      status,
      code,
      detail:
        status >= 500
          ? 'The request failed safely. Use the correlation ID for local logs.'
          : knownError.message,
      correlationId: request.id,
    });
  });

  registerSecurityBoundary(app, config);
  registerInstrumentation(app);
  registerRoutes(app, pool);

  const staticDirectory = options.staticDirectory ?? join(process.cwd(), 'dist/apps/web');
  if (existsSync(staticDirectory)) {
    await app.register(fastifyStatic, {
      root: staticDirectory,
      prefix: '/',
      wildcard: false,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (
      existsSync(join(staticDirectory, 'index.html')) &&
      !request.url.startsWith('/api/') &&
      request.headers.accept?.includes('text/html')
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'route_not_found',
      detail: 'No route matches this request.',
      correlationId: request.id,
    });
  });

  if (ownsPool) app.addHook('onClose', async () => pool.end());
  return app;
}
