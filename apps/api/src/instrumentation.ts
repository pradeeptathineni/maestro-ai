import { trace, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const spans = new WeakMap<FastifyRequest, Span>();

export function registerInstrumentation(app: FastifyInstance): void {
  const tracer = trace.getTracer('maestro-api', '0.1.0');
  app.addHook('onRequest', (request, _reply, done) => {
    const span = tracer.startSpan(`${request.method} ${request.routeOptions.url ?? request.url}`);
    span.setAttribute('http.request.method', request.method);
    spans.set(request, span);
    done();
  });
  app.addHook('onResponse', async (request, reply) => {
    const span = spans.get(request);
    span?.setAttribute('http.response.status_code', reply.statusCode);
    span?.end();
    spans.delete(request);
  });
  app.addHook('onError', async (request, _reply, error) => {
    spans.get(request)?.recordException(error);
  });
}
