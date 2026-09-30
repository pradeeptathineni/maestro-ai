import { emitJsonReport } from './write-json-report.js';

const queries = [
  'ai',
  'AI context reduction',
  'zero trust workload identity for Kubernetes',
  'Rust async web framework with observability',
  'software supply chain SBOM signing and provenance',
  'CRDT local-first database research article',
  'passwordless authentication web standard',
  'reduce flaky browser tests',
  'local offline vector database without API key',
  'recent open weight speech recognition model',
  'community discussion about WebAssembly component model adoption',
  'lichen spectroscopy field notebook',
  'OpenTelemetry',
  'distributed tracing telemetry sampling storage',
  'quantum error correction software libraries',
] as const;

const apiUrl = process.env.MAESTRO_DOGFOOD_API_URL ?? 'http://127.0.0.1:4310';
const queryDelayMs = Number(process.env.MAESTRO_DOGFOOD_QUERY_DELAY_MS ?? '0');
const terminalStates = new Set([
  'complete',
  'partial',
  'failed',
  'not_configured',
  'budget_denied',
  'skipped',
  'unsupported',
  'cancelled',
]);
const mutationHeaders = {
  'content-type': 'application/json',
  origin: 'http://127.0.0.1:5173',
  'x-maestro-request': '1',
};

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}${path}`, init);
  if (response.ok) return (await response.json()) as Record<string, unknown>;
  throw new Error(`${response.status} ${path}: ${await response.text()}`);
}

async function waitForOperation(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const operation = await request(`/api/v1/discovery/operations/${id}`);
    if (terminalStates.has(String(operation.state))) return operation;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { id, state: 'deadline_exceeded' };
}

function compactItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    layer: item.layer,
    subjectType: item.subjectType,
    name: item.name ?? item.title,
    kind: item.kind ?? item.kindHint,
    entityClass: item.entityClass,
    state: item.state ?? item.reviewState,
    position: item.position,
    relevanceOrdinal: item.relevanceOrdinal,
    matchBand: item.matchBand,
    matchedTerms: item.matchedTerms,
    signalDisplay: item.signalDisplay,
    evidenceConfidence: item.evidenceConfidence,
    evidenceCoverage: item.evidenceCoverage,
    displayState: item.displayState,
    canonicalUri: item.canonicalUri,
  };
}

async function runQuery(query: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  const session = await request('/api/v1/explorer/sessions', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ query, searchConnectedSources: true }),
  });
  const operationRefs = (session.discoveryOperations ?? []) as Array<{ id: string }>;
  const operations = await Promise.all(
    operationRefs.map((operation) => waitForOperation(operation.id)),
  );
  const indexed = await request(
    `/api/v1/explorer/result-sets/${String(session.resultSetId)}?limit=12&sort=match`,
  );
  const corpus = await request('/api/v1/corpus/search', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ query, limit: 12 }),
  });
  return {
    query,
    elapsedMs: Math.round(performance.now() - started),
    interpretation: session.interpretation,
    plan: session.plan,
    search: {
      resultSet: indexed.resultSet,
      items: ((indexed.items ?? []) as Array<Record<string, unknown>>).map(compactItem),
    },
    live: operations.map((operation) => ({
      adapterKey: operation.adapterKey,
      outboundQuery: operation.outboundQuery,
      state: operation.state,
      sourcePlanState: operation.sourcePlanState,
      routingReason: operation.routingReason,
      errorCode: operation.errorCode,
      safeDetail: operation.safeDetail,
      attempts: operation.attempts,
      items: ((operation.candidates ?? []) as Array<Record<string, unknown>>).map(compactItem),
    })),
    corpus: {
      corpusCount: corpus.corpusCount,
      matchedCount: corpus.matchedCount,
      filteredCount: corpus.filteredCount,
      candidateSelection: corpus.candidateSelection,
      facets: corpus.facets,
      items: ((corpus.items ?? []) as Array<Record<string, unknown>>).map(compactItem),
    },
  };
}

const results: Array<Record<string, unknown>> = [];
for (const [index, query] of queries.entries()) {
  if (index > 0 && queryDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, queryDelayMs));
  }
  results.push(await runQuery(query));
}

await emitJsonReport(
  {
    schemaVersion: 'discovery-dogfood-v1',
    generatedAt: new Date().toISOString(),
    methodology:
      'Actual API Search snapshots, enabled bounded live-source operations, and Corpus query responses. Judgments remain a separate review step.',
    queryDelayMs,
    queries,
    results,
  },
  'MAESTRO_DOGFOOD_REPORT_PATH',
);
