import type { FastifyInstance } from 'fastify';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface SecurityBoundaryOptions {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}

export function registerSecurityBoundary(
  app: FastifyInstance,
  options: SecurityBoundaryOptions,
): void {
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.toLowerCase();
    if (!host || !options.allowedHosts.has(host)) {
      return reply.code(421).send({
        type: 'about:blank',
        title: 'Misdirected request',
        status: 421,
        code: 'invalid_host',
        detail: 'The Host header is not allowed by the local application boundary.',
        correlationId: request.id,
      });
    }
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins.has(origin)) {
      return reply.code(403).send({
        type: 'about:blank',
        title: 'Forbidden origin',
        status: 403,
        code: 'invalid_origin',
        detail: 'The browser origin is not allowed.',
        correlationId: request.id,
      });
    }
    if (mutationMethods.has(request.method)) {
      if (request.headers['x-maestro-request'] !== '1') {
        return reply.code(403).send({
          type: 'about:blank',
          title: 'Mutation boundary rejected',
          status: 403,
          code: 'csrf_header_required',
          detail: 'Local browser mutations require the Maestro request header.',
          correlationId: request.id,
        });
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        return reply.code(415).send({
          type: 'about:blank',
          title: 'Unsupported media type',
          status: 415,
          code: 'json_required',
          detail: 'Mutation requests must use application/json.',
          correlationId: request.id,
        });
      }
    }
  });
}
