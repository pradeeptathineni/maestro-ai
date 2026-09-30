import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { buildDiscoveryPlan, interpretQuery } from '../packages/domain/src/index.js';

const queries = [
  { family: 'motivating', query: 'ai' },
  { family: 'motivating', query: 'ai models' },
  { family: 'motivating', query: 'devops' },
  { family: 'motivating', query: 'ml' },
  { family: 'motivating', query: 'cs' },
  { family: 'motivating', query: 'AI context reduction' },
  { family: 'balanced', query: 'container orchestration software' },
  { family: 'balanced', query: 'machine learning experiment tracking' },
  { family: 'balanced', query: 'open standard connecting tools to AI assistants' },
  { family: 'balanced', query: 'article about prompt compression research' },
  { family: 'balanced', query: 'site reliability engineering practices' },
  { family: 'balanced', query: 'current model context protocol specification' },
  { family: 'balanced', query: 'python library for classical machine learning' },
  { family: 'balanced', query: 'distributed systems learning resource article' },
  { family: 'balanced', query: 'observability telemetry standard' },
  { family: 'balanced', query: 'local metasearch without API keys' },
  { family: 'balanced', query: 'GitOps continuous delivery practice' },
  { family: 'balanced', query: 'recent open weight AI model release' },
  { family: 'community', query: 'community discussion article about context window compression' },
  { family: 'community', query: 'recent discussion of AI coding agent evaluation' },
  { family: 'community', query: 'community discussion article about Kubernetes alternatives' },
  { family: 'community', query: 'recent discussion of ML experiment tracking platforms' },
  { family: 'community', query: 'community discussion about Rust programming language ecosystems' },
  { family: 'community', query: 'recent discussion of OpenTelemetry adoption' },
] as const;

const baseUrl = process.env.PHASE07_API_URL ?? 'http://127.0.0.1:4310';
const resumeDatabaseUrl = process.env.PHASE07_RESUME_DATABASE_URL;
const outputPath = resolve(
  process.env.PHASE07_LIVE_OUTPUT ??
    '../maestro-ai-planning/outputs/phase-07-discovery-intelligence/implementation/live/live-study.json',
);
const terminal = new Set([
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

async function jsonRequest(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    const detail = await response.text();
    if (response.status !== 429 || attempt === 2) {
      throw new Error(`${response.status} ${path}: ${detail}`);
    }
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '60', 10);
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, (Number.isFinite(retryAfter) ? retryAfter : 60) * 1_000 + 250),
    );
  }
  throw new Error(`Request retry loop exhausted for ${path}.`);
}

async function waitForOperation(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  while (true) {
    const operation = await jsonRequest(`/api/v1/discovery/operations/${id}`);
    if (terminal.has(String(operation.state))) return operation;
    if (Date.now() >= deadline) return { ...operation, studyDeadlineReached: true };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
}

type ResumedSession = {
  id: string;
  resultSetId: string;
  createdAt: string;
  operationIds: string[];
};

async function findResumedSessions(): Promise<Map<string, ResumedSession>> {
  if (!resumeDatabaseUrl) return new Map();
  const pool = new Pool({ connectionString: resumeDatabaseUrl, max: 1 });
  try {
    const result = await pool.query<ResumedSession & { query: string }>(
      `SELECT DISTINCT ON (qs.query_text)
              qs.query_text AS query, qs.id, qrs.id AS "resultSetId",
              qs.created_at::text AS "createdAt",
              coalesce(array_agg(op.id ORDER BY op.created_at)
                FILTER (WHERE op.id IS NOT NULL), '{}') AS "operationIds"
       FROM workspace.query_sessions qs
       JOIN LATERAL (
         SELECT id FROM workspace.query_result_sets current
         WHERE current.query_session_id = qs.id ORDER BY revision DESC LIMIT 1
       ) qrs ON true
       LEFT JOIN ops.discovery_operations op
         ON op.query_session_id = qs.id AND op.workspace_id = qs.workspace_id
       WHERE qs.query_text = ANY($1::text[]) AND qs.deleted_at IS NULL
       GROUP BY qs.query_text, qs.id, qrs.id, qs.created_at
       ORDER BY qs.query_text, qs.created_at DESC`,
      [queries.map((item) => item.query)],
    );
    return new Map(result.rows.map((row) => [row.query, row]));
  } finally {
    await pool.end();
  }
}

async function runCase(
  input: (typeof queries)[number],
  resumed?: ResumedSession,
): Promise<Record<string, unknown>> {
  const startedAt = resumed?.createdAt ?? new Date().toISOString();
  const started = performance.now();
  const session = resumed
    ? { id: resumed.id, resultSetId: resumed.resultSetId }
    : await jsonRequest('/api/v1/explorer/sessions', {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ query: input.query, searchConnectedSources: true }),
      });
  const operationRefs = resumed
    ? resumed.operationIds.map((id) => ({ id }))
    : (session.discoveryOperations as Array<{ id: string }>);
  const operations = await Promise.all(
    operationRefs.map((operation) => waitForOperation(operation.id)),
  );
  const resultPage = await jsonRequest(
    `/api/v1/explorer/result-sets/${String(session.resultSetId)}?limit=20&sort=recommended`,
  );
  return {
    family: input.family,
    publicQuery: input.query,
    startedAt,
    elapsedMs: Math.round(performance.now() - started),
    querySessionId: session.id,
    resultSetId: session.resultSetId,
    resumedWithoutDuplicateCalls: Boolean(resumed),
    interpretation: session.interpretation ?? resultPage.interpretation,
    queryPlan: session.plan ?? resultPage.queryPlan,
    localResults: (resultPage.items as Array<Record<string, unknown>>).map((item) => ({
      id: item.id,
      subjectType: item.subjectType,
      providerId: item.providerId,
      documentId: item.documentId,
      name: item.name,
      kind: item.kind,
      position: item.position,
      relevanceOrdinal: item.relevanceOrdinal,
      signalDisplay: item.signalDisplay,
      evidenceCoverage: item.evidenceCoverage,
      displayState: item.displayState,
    })),
    operations: operations.map((operation) => ({
      id: operation.id,
      adapterKey: operation.adapterKey,
      state: operation.state,
      sourcePlanState: operation.sourcePlanState,
      outboundQuery: operation.outboundQuery,
      routingReason: operation.routingReason,
      reservedCalls: operation.reservedCalls,
      consumedCalls: operation.consumedCalls,
      resultCount: operation.resultCount,
      errorCode: operation.errorCode,
      safeDetail: operation.safeDetail,
      attempts: operation.attempts,
      candidates: (operation.candidates as Array<Record<string, unknown>>).map((candidate) => ({
        id: candidate.id,
        canonicalUri: candidate.canonicalUri,
        title: candidate.title,
        summary: candidate.summary,
        kindHint: candidate.kindHint,
        relevanceOrdinal: candidate.relevanceOrdinal,
        signalDisplay: candidate.signalDisplay,
        evidenceCoverage: candidate.evidenceCoverage,
        provenance: candidate.provenance,
      })),
      studyDeadlineReached: operation.studyDeadlineReached ?? false,
    })),
  };
}

const plannedCalls = queries.reduce(
  (sum, input) =>
    sum +
    buildDiscoveryPlan(input.query, interpretQuery(input.query)).routes.reduce(
      (routeSum, route) => routeSum + route.callLimit,
      0,
    ),
  0,
);
if (plannedCalls > 55) {
  throw new Error(`Live study would reserve ${plannedCalls} calls; the study ceiling is 55.`);
}

const results: Array<Record<string, unknown>> = [];
const resumedSessions = await findResumedSessions();
for (let index = 0; index < queries.length; index += 2) {
  const batch = queries.slice(index, index + 2);
  results.push(
    ...(await Promise.all(batch.map((input) => runCase(input, resumedSessions.get(input.query))))),
  );
}
const report = {
  schemaVersion: 'phase07-live-study-v1',
  generatedAt: new Date().toISOString(),
  operatingProfile: 'configured-live-public',
  queryCount: queries.length,
  plannedCallCeiling: plannedCalls,
  resumedSessionCount: resumedSessions.size,
  monetaryCostUsd: 0,
  privateProjectContextIncluded: false,
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ outputPath, queryCount: queries.length, plannedCalls }, null, 2)}\n`,
);
