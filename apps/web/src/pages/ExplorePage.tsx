import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDate, formatFractionPercent, label } from '../api.js';
import type {
  ExplorerGraphData,
  ExplorerItemDetail,
  ExplorerRefresh,
  ExplorerResultItem,
  ExplorerResultPage,
  ExplorerSession,
} from '../types.js';
import { Badge, Empty, ErrorPanel, Loading, StateBadge } from '../ui.js';
import { useWorkspaceProjects } from '../workspace-queries.js';

const loadExplorerMap = () => import('../ExplorerMap.js');
const ExplorerMap = lazy(async () => ({ default: (await loadExplorerMap()).ExplorerMap }));

interface ExplorerHistoryItem {
  id: string;
  query: string;
  state: string;
  createdAt: string;
  retentionUntil: string;
  resultSetId: string;
  resultSetRevision: number;
  assessedCount: number;
  status: string;
  coverageState: string;
}

interface Comparison {
  resultSetId: string;
  items: ExplorerItemDetail[];
  differenceFields: string[];
  authority: string;
}

interface IntegrationStatus {
  adapterKey: string;
  enabled: boolean;
  sourceClass: string;
  baseUrl: string | null;
  modelIdentifier: string | null;
  dailyCallLimit: number;
  reservedCallsToday: number;
  status: string;
}

interface DiscoveryCandidate {
  id: string;
  adapterKey: string;
  canonicalUri: string;
  title: string;
  summary: string;
  kindHint: string | null;
  reviewState: string;
  matchedTerms: string[];
  relevanceOrdinal: string;
  signalDisplay: number;
  evidenceCoverage: number;
  displayState: string;
  signalExplanation: string;
}

interface DiscoveryOperation {
  id: string;
  adapterKey: string;
  state: string;
  safeDetail: string;
  candidates: DiscoveryCandidate[];
}

interface SearchSession extends ExplorerSession {
  discoveryOperations: Array<{ id: string; adapterKey: string; state: string }>;
}

interface TaxonomyResponse {
  facets: Array<{
    key: string;
    values: Array<{ stableKey: string; label: string; count: number }>;
  }>;
}

const resultSetPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const resultPageSize = 10;

function signalLabel(item: ExplorerResultItem): string {
  return item.signalDisplay === null ? 'Excluded' : `Signal ${item.signalDisplay}`;
}

function matchLabel(item: ExplorerResultItem): string {
  return `${item.matchBand ?? label(item.relevanceOrdinal)} Match`;
}

function confidenceLabel(item: ExplorerResultItem): string {
  const detail = item.evidenceConfidenceDetail;
  if (detail) return `${detail.band} evidence confidence · ${detail.display}%`;
  return `${formatFractionPercent(item.evidenceConfidence)} legacy evidence confidence`;
}

function sourceCoverage(item: ExplorerResultItem): number {
  return item.evidenceConfidenceDetail?.coverage ?? item.evidenceCoverage;
}

function trendLabel(item: ExplorerResultItem): string {
  return item.trendState ? label(item.trendState) : 'Trend unavailable';
}

function signalExplanation(item: ExplorerItemDetail): string {
  const scored = item.valueInputs
    .filter((input) => input.adjusted !== null)
    .sort((left, right) => (right.adjusted ?? 0) - (left.adjusted ?? 0));
  const strongest = scored.slice(0, 2).map((input) => label(input.key));
  const gaps = [
    ...new Set([
      ...item.missing,
      ...item.valueInputs.flatMap((input) => input.missing),
      ...(item.evidenceConfidenceDetail?.limitations ?? []),
    ]),
  ];
  const drivers = strongest.length
    ? `${strongest.join(' and ')} are the strongest measured dimensions.`
    : 'No measured dimension is strong enough to identify as a driver.';
  const qualification = gaps.length
    ? `The estimate is tempered by ${gaps.slice(0, 2).join(' ').trim()}`
    : 'No additional policy-visible evidence gap was recorded.';
  return `${item.signalBand ?? signalStateLabel(item.displayState)} is a query-independent, type-aware estimate. ${drivers} ${qualification}`;
}

function signalStateLabel(state: string): string {
  if (state === 'insufficient_evidence') return 'Low confidence';
  if (state === 'provisional') return 'Preliminary';
  if (state === 'available') return 'Source-backed';
  return label(state);
}

function primaryCaveat(item: ExplorerResultItem): string | null {
  return (
    item.caveats.find((caveat) => !caveat.startsWith('Source review state is')) ??
    item.caveats[0] ??
    null
  );
}

function saveJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ExplorePage() {
  const client = useQueryClient();
  const [parameters, setParameters] = useSearchParams();
  const requestedResultSet = parameters.get('resultSet');
  const resultSetId =
    requestedResultSet && resultSetPattern.test(requestedResultSet) ? requestedResultSet : null;
  const [question, setQuestion] = useState('');
  const [clarification, setClarification] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [sort, setSort] = useState('recommended');
  const [kind, setKind] = useState('');
  const [entityClass, setEntityClass] = useState('');
  const [matchBand, setMatchBand] = useState('');
  const [evidenceState, setEvidenceState] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [projectContextId, setProjectContextId] = useState('');
  const [shortlistName, setShortlistName] = useState('Search shortlist');
  const [discoveryOperationIds, setDiscoveryOperationIds] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [additionalPage, setAdditionalPage] = useState<{
    viewKey: string;
    items: ExplorerResultItem[];
    nextCursor: string | null;
  } | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const detailClose = useRef<HTMLButtonElement | null>(null);
  const { projects } = useWorkspaceProjects();
  const history = useQuery({
    queryKey: ['explorer-history'],
    queryFn: () => api<{ items: ExplorerHistoryItem[] }>('/api/v1/explorer/sessions'),
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<{ items: IntegrationStatus[] }>('/api/v1/integrations'),
  });
  const taxonomy = useQuery({
    queryKey: ['taxonomy-facets'],
    queryFn: () => api<TaxonomyResponse>('/api/v1/taxonomy/facets'),
  });
  const discoveryOperations = useQueries({
    queries: discoveryOperationIds.map((operationId) => ({
      queryKey: ['discovery-operation', operationId],
      queryFn: () => api<DiscoveryOperation>(`/api/v1/discovery/operations/${operationId}`),
      refetchInterval: (query: { state: { data?: DiscoveryOperation } }) =>
        ['queued', 'running'].includes(query.state.data?.state ?? '') ? 1_000 : false,
    })),
  });

  const resultQuery = useMemo(() => {
    const query = new URLSearchParams({ limit: String(resultPageSize), sort });
    if (kind) query.set('kind', kind);
    if (entityClass) query.set('entityClass', entityClass);
    if (matchBand) query.set('matchBand', matchBand);
    if (evidenceState) query.set('evidenceState', evidenceState);
    return query.toString();
  }, [entityClass, evidenceState, kind, matchBand, sort]);
  const graphQueryString = useMemo(() => {
    const query = new URLSearchParams(resultQuery);
    query.set('limit', '100');
    return query.toString();
  }, [resultQuery]);
  const resultViewKey = `${resultSetId ?? 'none'}:${resultQuery}`;

  const results = useQuery({
    queryKey: ['explorer-results', resultSetId, resultQuery],
    enabled: Boolean(resultSetId),
    queryFn: () =>
      api<ExplorerResultPage>(`/api/v1/explorer/result-sets/${resultSetId}?${resultQuery}`),
  });
  useEffect(() => {
    if (!results.data || !resultSetId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      void loadExplorerMap().then((module) => module.preloadExplorerMapRenderer());
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resultSetId, results.data]);
  const graph = useQuery({
    queryKey: ['explorer-graph', resultSetId, graphQueryString],
    enabled: Boolean(resultSetId) && view === 'map',
    queryFn: () =>
      api<ExplorerGraphData>(
        `/api/v1/explorer/result-sets/${resultSetId}/graph?${graphQueryString}`,
      ),
  });
  const detail = useQuery({
    queryKey: ['explorer-detail', resultSetId, selectedId],
    enabled: Boolean(resultSetId && selectedId),
    queryFn: () =>
      api<ExplorerItemDetail>(`/api/v1/explorer/result-sets/${resultSetId}/items/${selectedId}`),
  });
  const loadMore = useMutation({
    mutationFn: ({ cursor }: { cursor: string; viewKey: string }) =>
      api<ExplorerResultPage>(
        `/api/v1/explorer/result-sets/${resultSetId}?${resultQuery}&cursor=${encodeURIComponent(cursor)}`,
      ),
    onSuccess: (page, input) => {
      setAdditionalPage((current) => ({
        viewKey: input.viewKey,
        items: [
          ...(current?.viewKey === input.viewKey ? current.items : []),
          ...page.items.filter(
            (item) =>
              !current?.items.some((existing) => existing.id === item.id) &&
              !results.data?.items.some((existing) => existing.id === item.id),
          ),
        ],
        nextCursor: page.nextCursor,
      }));
    },
  });

  const runQuery = useMutation({
    mutationFn: (input: {
      query: string;
      explicitFacets?: Record<string, string>;
      projectContextId?: string;
      searchConnectedSources?: boolean;
    }) =>
      api<SearchSession>('/api/v1/explorer/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (session) => {
      setParameters({ resultSet: session.resultSetId });
      setSelectedId(null);
      setCompareIds([]);
      setComparison(null);
      setDiscoveryOperationIds(session.discoveryOperations.map((operation) => operation.id));
      setClarification('');
      const activeOperationCount = session.discoveryOperations.filter((operation) =>
        ['queued', 'running'].includes(operation.state),
      ).length;
      setNotice(
        activeOperationCount
          ? `${session.counts.assessed} indexed results are ready. ${activeOperationCount} connected source search${activeOperationCount === 1 ? ' is' : 'es are'} running.`
          : session.discoveryOperations.length
            ? `${session.counts.assessed} indexed results are ready. The source plan was recorded; no connected source request was queued.`
            : `${session.counts.assessed} indexed results are ready. No connected source is enabled.`,
      );
      void client.invalidateQueries({ queryKey: ['explorer-history'] });
    },
  });
  const compare = useMutation({
    mutationFn: () =>
      api<Comparison>(`/api/v1/explorer/result-sets/${resultSetId}/compare`, {
        method: 'POST',
        body: JSON.stringify({ resultItemIds: compareIds }),
      }),
    onSuccess: setComparison,
  });
  const shortlist = useMutation({
    mutationFn: () =>
      api<{ id: string; itemCount: number }>(
        `/api/v1/explorer/result-sets/${resultSetId}/shortlists`,
        {
          method: 'POST',
          body: JSON.stringify({
            projectContextId,
            name: shortlistName,
            resultItemIds: compareIds,
          }),
        },
      ),
    onSuccess: (saved) => setNotice(`Saved ${saved.itemCount} items to the project shortlist.`),
  });
  const exportBundle = useMutation({
    mutationFn: () =>
      api<Record<string, unknown>>(`/api/v1/explorer/result-sets/${resultSetId}/export`, {
        method: 'POST',
        body: JSON.stringify({ includePrivateQuery: false, includeProjectContext: false }),
      }),
    onSuccess: (bundle) => {
      saveJson(`maestro-result-${resultSetId}.json`, bundle);
      setNotice('Verification bundle downloaded without private query or project context.');
    },
  });
  const refresh = useMutation({
    mutationFn: () => {
      const sessionId = results.data?.resultSet.querySessionId;
      if (!sessionId) throw new Error('Run a query before refreshing the local index.');
      return api<ExplorerRefresh>(`/api/v1/explorer/sessions/${sessionId}/refresh`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    onSuccess: (next) => {
      if (next.state === 'unchanged') {
        setNotice('The local index is unchanged. This result snapshot remains current.');
        return;
      }
      setParameters({ resultSet: next.resultSetId });
      setSelectedId(null);
      setCompareIds([]);
      setComparison(null);
      setNotice(`The updated local index created result snapshot r${next.resultSetRevision}.`);
      void client.invalidateQueries({ queryKey: ['explorer-history'] });
    },
  });
  const redact = useMutation({
    mutationFn: (sessionId: string) =>
      api<void>(`/api/v1/explorer/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setParameters({});
      setQuestion('');
      setSelectedId(null);
      setCompareIds([]);
      setComparison(null);
      setNotice('The retained query text and interpreted facets were deleted.');
      void client.invalidateQueries({ queryKey: ['explorer-history'] });
    },
  });
  const watch = useMutation({
    mutationFn: (providerId: string) =>
      api<{ id: string; duplicate?: boolean }>('/api/v1/watches', {
        method: 'POST',
        body: JSON.stringify({ providerId, cadence: 'weekly', priority: 50 }),
      }),
    onSuccess: (created) => {
      setNotice(
        created.duplicate
          ? 'This item already has a weekly watch.'
          : 'Weekly watch created. Network refresh still requires the GitHub adapter to be enabled.',
      );
      void client.invalidateQueries({ queryKey: ['watches'] });
    },
  });

  const inspect = useCallback((id: string) => {
    detailTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(id);
  }, []);
  const closeDetail = useCallback(() => {
    setSelectedId(null);
    const trigger = detailTrigger.current;
    requestAnimationFrame(() => trigger?.focus());
  }, []);

  useEffect(() => {
    if (!detail.data) return;
    detailClose.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDetail();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeDetail, detail.data]);
  useEffect(() => {
    if (!results.data) return;
    setDiscoveryOperationIds(results.data.discoveryOperations.map((operation) => operation.id));
  }, [results.data]);
  const interpretation = results.data?.resultSet.interpretation;
  const additionalItems = additionalPage?.viewKey === resultViewKey ? additionalPage.items : [];
  const visibleItems = results.data ? [...results.data.items, ...additionalItems] : [];
  const nextCursor =
    additionalPage?.viewKey === resultViewKey
      ? additionalPage.nextCursor
      : (results.data?.nextCursor ?? null);
  const errors = [
    runQuery.error,
    results.error,
    graph.error,
    detail.error,
    compare.error,
    shortlist.error,
    exportBundle.error,
    refresh.error,
    redact.error,
    ...discoveryOperations.map((operation) => operation.error),
    watch.error,
    loadMore.error,
    taxonomy.error,
  ].filter(Boolean);
  const entityClassOptions =
    taxonomy.data?.facets
      .find((facet) => facet.key === 'entity_class')
      ?.values.filter((value) => value.count > 0)
      .map((value) => ({
        value: value.stableKey.replace(/^entity-class:/, ''),
        label: value.label,
        count: value.count,
      })) ?? [];
  const discoveryIntegrations =
    integrations.data?.items.filter(
      (integration) => integration.sourceClass !== 'local_semantic',
    ) ?? [];
  const enabledDiscoveryCount = discoveryIntegrations.filter(
    (integration) => integration.enabled,
  ).length;
  const connectedCandidatesByUri = new Map<string, DiscoveryCandidate>();
  for (const candidate of discoveryOperations.flatMap(
    (operation) => operation.data?.candidates ?? [],
  )) {
    const current = connectedCandidatesByUri.get(candidate.canonicalUri);
    if (!current || candidate.signalDisplay > current.signalDisplay) {
      connectedCandidatesByUri.set(candidate.canonicalUri, candidate);
    }
  }
  const connectedCandidates = [...connectedCandidatesByUri.values()].sort(
    (left, right) =>
      right.signalDisplay - left.signalDisplay || left.title.localeCompare(right.title),
  );
  const connectedSearchesPending = discoveryOperations.some(
    (operation) =>
      operation.isPending || ['queued', 'running'].includes(operation.data?.state ?? ''),
  );
  const detailMissing = detail.data
    ? [
        ...new Set([
          ...detail.data.missing,
          ...detail.data.valueInputs.flatMap((input) => input.missing),
          ...(detail.data.evidenceConfidenceDetail?.limitations ?? []),
        ]),
      ]
    : [];

  function toggleComparison(id: string): void {
    setComparison(null);
    setCompareIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : current.length < 5
          ? [...current, id]
          : current,
    );
  }

  return (
    <div className="page-shell explorer-page">
      <section
        className={`explorer-hero${results.data ? ' populated' : ''}`}
        aria-labelledby="explorer-heading"
      >
        <p className="eyebrow">Technology search</p>
        <h1 id="explorer-heading">Find existing tools for what you need</h1>
        <p>
          Describe what you need. Maestro searches its local index and every source you have
          enabled, then keeps query Match separate from intrinsic Signal, confidence, and evidence.
        </p>
        <form
          className="explorer-query"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = question.trim();
            if (trimmed) {
              runQuery.mutate({
                query: trimmed,
                searchConnectedSources: true,
              });
            }
          }}
        >
          <label htmlFor="explorer-question" className="sr-only">
            Capability question
          </label>
          <textarea
            id="explorer-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Reduce repository context before an AI coding agent starts work"
            rows={2}
            maxLength={1000}
            required
          />
          <button className="button primary" disabled={runQuery.isPending} type="submit">
            {runQuery.isPending ? 'Searching…' : 'Search'}
          </button>
        </form>
        <div className="privacy-line">
          <span>Local index available offline</span>
          <span>Match answers the query; Signal describes the entity</span>
          <span>
            {enabledDiscoveryCount
              ? `${enabledDiscoveryCount} connected source${enabledDiscoveryCount === 1 ? '' : 's'} enabled`
              : 'No connected sources enabled'}
          </span>
          <Link to="/workspace#integrations">Configure sources</Link>
        </div>
      </section>

      {requestedResultSet && !resultSetId ? (
        <div className="state-panel error" role="alert">
          The result-set identifier in this URL is invalid.
        </div>
      ) : null}
      {notice ? (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      {errors.map((error, index) => (
        <ErrorPanel error={error} key={index} />
      ))}
      {results.isPending && resultSetId ? (
        <Loading message="Loading the immutable result snapshot…" />
      ) : null}

      {results.data ? (
        <>
          <details className="interpretation-panel">
            <summary>Search interpretation and query details</summary>
            <div>
              <h2 id="interpretation-heading">Query details</h2>
            </div>
            <div className="interpretation-groups">
              <div>
                <strong>Explicit</strong>
                <div className="chip-row">
                  {interpretation?.explicitFacets.length ? (
                    interpretation.explicitFacets.map((facet) => (
                      <span className="facet-chip explicit" key={`${facet.key}:${facet.value}`}>
                        {facet.label}: {facet.value}
                      </span>
                    ))
                  ) : (
                    <span className="muted">No explicit facets extracted</span>
                  )}
                </div>
              </div>
              <div>
                <strong>Inferred</strong>
                <div className="chip-row">
                  {interpretation?.inferredFacets.length ? (
                    interpretation.inferredFacets.map((facet) => (
                      <button
                        className="facet-chip inferred"
                        key={`${facet.key}:${facet.value}`}
                        onClick={() =>
                          runQuery.mutate({
                            query: results.data.resultSet.query,
                            searchConnectedSources: true,
                            explicitFacets: { [facet.key]: facet.value },
                            ...(results.data.resultSet.projectContextId
                              ? { projectContextId: results.data.resultSet.projectContextId }
                              : {}),
                          })
                        }
                        title="Accept this suggestion explicitly and create a new snapshot"
                        type="button"
                      >
                        Use {facet.value}
                      </button>
                    ))
                  ) : (
                    <span className="muted">No inferred facets</span>
                  )}
                </div>
              </div>
              <div>
                <strong>Missing context</strong>
                <div className="chip-row">
                  {interpretation?.missingContext.length ? (
                    interpretation.missingContext.map((facet) => (
                      <span className="facet-chip missing" key={facet.key}>
                        {facet.label}
                      </span>
                    ))
                  ) : (
                    <span className="muted">No rule-visible gaps</span>
                  )}
                </div>
              </div>
            </div>
            {interpretation?.landscapeFacets.length ? (
              <div className="landscape-overview" aria-labelledby="landscape-heading">
                <div>
                  <strong id="landscape-heading">Landscape lenses</strong>
                  <span>
                    Broad intent: {label(interpretation.intentMode)}. Choose a lens to create a new,
                    explicit snapshot.
                  </span>
                </div>
                <div className="landscape-lenses">
                  {interpretation.landscapeFacets.map((facet) => (
                    <button
                      key={facet}
                      type="button"
                      onClick={() =>
                        runQuery.mutate({
                          query: results.data.resultSet.query,
                          searchConnectedSources: true,
                          explicitFacets: { landscape_focus: facet },
                        })
                      }
                    >
                      {facet}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {results.data.resultSet.queryPlan ? (
              <div className="query-plan" aria-labelledby="query-plan-heading">
                <div>
                  <strong id="query-plan-heading">Inspectable source plan</strong>
                  <span>{results.data.resultSet.queryPlan.policyVersion}</span>
                </div>
                <ul>
                  {results.data.resultSet.queryPlan.routes.map((route) => (
                    <li key={route.id}>
                      <span>
                        <strong>{label(route.adapterKey)}</strong>
                        <StateBadge state={route.state} />
                      </span>
                      <code>{route.variant ?? 'No outbound query'}</code>
                      <small>{route.reason}</small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="snapshot-meta">
              Snapshot r{results.data.resultSet.revision} · {visibleItems.length} shown of{' '}
              {results.data.filteredCount} filtered · {results.data.resultSet.availableCount}{' '}
              matched in the local index · {results.data.resultSet.signalPolicyVersion}
            </p>
            {results.data.resultSet.projectContextId ? (
              <p className="authority-note">
                Project fit is unknown and blocked until provider-specific gates and preferences are
                assessed. This context is bound to the snapshot but alters neither Match nor
                intrinsic Signal.
              </p>
            ) : null}
            <form
              className="clarification-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (clarification.trim()) {
                  runQuery.mutate({
                    query: results.data.resultSet.query,
                    searchConnectedSources: true,
                    explicitFacets: { user_clarification: clarification.trim() },
                    ...(results.data.resultSet.projectContextId
                      ? { projectContextId: results.data.resultSet.projectContextId }
                      : {}),
                  });
                }
              }}
            >
              <label>
                Correct or clarify the interpretation
                <input
                  value={clarification}
                  onChange={(event) => setClarification(event.target.value)}
                  placeholder="For example: TypeScript repository integration"
                  maxLength={240}
                />
              </label>
              <button
                className="button secondary compact"
                disabled={!clarification.trim() || runQuery.isPending}
                type="submit"
              >
                Search with clarification
              </button>
            </form>
          </details>

          <details className="source-results">
            <summary>
              <div>
                <p className="eyebrow">Connected sources</p>
                <strong>Source plan and live leads</strong>
              </div>
              <span>{discoveryOperationIds.length} planned route states</span>
            </summary>
            <div className="source-results-body">
              <p className="hint">
                Live leads receive a preliminary query score from source metadata. It is not the
                intrinsic Signal assigned only after evidence-backed corpus admission.
              </p>
              {discoveryOperationIds.length ? (
                <>
                  <div className="source-status-row" aria-live="polite">
                    {discoveryOperations.map((operation, index) => (
                      <span key={discoveryOperationIds[index]}>
                        <strong>
                          {label(operation.data?.adapterKey ?? `source ${index + 1}`)}
                        </strong>
                        <StateBadge state={operation.data?.state ?? 'running'} />
                      </span>
                    ))}
                  </div>
                  {connectedCandidates.length ? (
                    <div className="source-result-list">
                      {connectedCandidates.map((candidate) => (
                        <article className="source-result-row" key={candidate.id}>
                          <div className="result-identity">
                            <div className="card-topline">
                              <Badge>{label(candidate.kindHint ?? 'source result')}</Badge>
                              <Badge>{signalStateLabel(candidate.displayState)}</Badge>
                            </div>
                            <h3>{candidate.title}</h3>
                            <p>{candidate.summary}</p>
                          </div>
                          <div className="query-signal live-lead-score">
                            <strong>Lead score {candidate.signalDisplay}</strong>
                            <span>
                              {label(candidate.relevanceOrdinal)} relevance ·{' '}
                              {signalStateLabel(candidate.displayState)}
                            </span>
                            <small>
                              {formatFractionPercent(candidate.evidenceCoverage)} metadata coverage
                            </small>
                          </div>
                          <a
                            className="button secondary compact"
                            href={candidate.canonicalUri}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open source
                          </a>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="hint">
                      {connectedSearchesPending
                        ? 'Connected source searches are still running.'
                        : 'No live leads were returned. Route states above preserve skipped, unsupported, disabled, failed, and empty outcomes.'}
                    </p>
                  )}
                </>
              ) : (
                <p className="source-empty">
                  No connected source is enabled. The local index still works without network
                  access. <Link to="/workspace#integrations">Configure sources</Link>
                </p>
              )}
            </div>
          </details>

          <section className="explorer-workbench" aria-labelledby="results-heading">
            <div className="workbench-toolbar">
              <div>
                <p className="eyebrow">Local index</p>
                <h2 id="results-heading">Results</h2>
              </div>
              <div className="segmented" aria-label="Result view">
                <button
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                  type="button"
                >
                  List
                </button>
                <button aria-pressed={view === 'map'} onClick={() => setView('map')} type="button">
                  Map
                </button>
              </div>
            </div>
            {view === 'list' && visibleItems[0] ? (
              <button
                className="top-result-glance"
                onClick={() => inspect(visibleItems[0]!.id)}
                type="button"
              >
                <span>Top result</span>
                <strong>{visibleItems[0].name}</strong>
                <small>
                  {matchLabel(visibleItems[0])} · {signalLabel(visibleItems[0])} ·{' '}
                  {confidenceLabel(visibleItems[0])}
                </small>
              </button>
            ) : null}
            <div className="result-controls">
              <label>
                Sort
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  <option value="recommended">Recommended</option>
                  <option value="match">Match</option>
                  <option value="signal">Signal</option>
                  <option value="evidence">Evidence confidence</option>
                  <option value="name">Name</option>
                </select>
              </label>
              <label>
                Kind
                <select value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="">All kinds</option>
                  {[...new Set(visibleItems.map((item) => item.kind))].sort().map((value) => (
                    <option key={value} value={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Entity class
                <select
                  value={entityClass}
                  onChange={(event) => setEntityClass(event.target.value)}
                >
                  <option value="">All classes</option>
                  {entityClassOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Match
                <select value={matchBand} onChange={(event) => setMatchBand(event.target.value)}>
                  <option value="">All bands</option>
                  <option value="Direct">Direct</option>
                  <option value="Strong">Strong</option>
                  <option value="Related">Related</option>
                  <option value="Peripheral">Peripheral</option>
                </select>
              </label>
              <label>
                Signal state
                <select
                  value={evidenceState}
                  onChange={(event) => setEvidenceState(event.target.value)}
                >
                  <option value="">All states</option>
                  <option value="available">Source-backed</option>
                  <option value="provisional">Preliminary</option>
                  <option value="insufficient_evidence">Low confidence</option>
                </select>
              </label>
              <button
                className="button secondary compact"
                type="button"
                onClick={() => exportBundle.mutate()}
              >
                Export safe bundle
              </button>
            </div>

            {visibleItems.length === 0 ? (
              <Empty title="No indexed results">
                Try a more specific description. Any enabled source searches continue below.
              </Empty>
            ) : view === 'map' ? (
              graph.isPending ? (
                <Loading message="Building the bounded map…" />
              ) : graph.data ? (
                <Suspense fallback={<Loading message="Loading the map renderer…" />}>
                  <ExplorerMap data={graph.data} selectedId={selectedId} onSelect={inspect} />
                </Suspense>
              ) : null
            ) : (
              <div className="result-list">
                {visibleItems.map((item) => (
                  <article className="result-row" key={item.id}>
                    <label className="compare-check">
                      <input
                        type="checkbox"
                        checked={compareIds.includes(item.id)}
                        disabled={!compareIds.includes(item.id) && compareIds.length >= 5}
                        onChange={() => toggleComparison(item.id)}
                      />
                      <span>Compare</span>
                    </label>
                    <div className="result-identity">
                      <div className="card-topline">
                        <Badge>{label(item.entityClass)}</Badge>
                        <Badge>{label(item.kind)}</Badge>
                      </div>
                      <h3>{item.name}</h3>
                      <p>{item.description}</p>
                      <div className="chip-row">
                        {item.capabilities.slice(0, 4).map((capability) => (
                          <span className="facet-chip" key={capability}>
                            {label(capability)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="result-reason">
                      <strong>{matchLabel(item)}</strong>
                      <p>{item.explanation}</p>
                      {primaryCaveat(item) ? (
                        <small>Limitation: {primaryCaveat(item)}</small>
                      ) : null}
                    </div>
                    <div className="query-signal">
                      <strong>{signalLabel(item)}</strong>
                      <span>
                        {item.signalBand ?? signalStateLabel(item.displayState)} ·{' '}
                        {trendLabel(item)}
                      </span>
                      <small>{confidenceLabel(item)}</small>
                      <small>{formatFractionPercent(sourceCoverage(item))} source coverage</small>
                    </div>
                    <button
                      className="button secondary compact"
                      onClick={() => inspect(item.id)}
                      type="button"
                    >
                      Inspect
                    </button>
                  </article>
                ))}
                {nextCursor ? (
                  <div className="pagination-action">
                    <button
                      className="button secondary"
                      disabled={loadMore.isPending}
                      onClick={() =>
                        loadMore.mutate({ cursor: nextCursor, viewKey: resultViewKey })
                      }
                      type="button"
                    >
                      {loadMore.isPending
                        ? 'Loading more…'
                        : `Load ${Math.min(resultPageSize, results.data.filteredCount - visibleItems.length)} more`}
                    </button>
                    <span>
                      Showing {visibleItems.length} of {results.data.filteredCount} filtered results
                    </span>
                  </div>
                ) : null}
              </div>
            )}

            {compareIds.length ? (
              <div className="selection-tray">
                <strong>{compareIds.length} selected</strong>
                <button
                  className="button secondary compact"
                  disabled={compareIds.length < 2 || compare.isPending}
                  onClick={() => compare.mutate()}
                  type="button"
                >
                  Compare 2–5
                </button>
                <label>
                  Project
                  <select
                    aria-label="Shortlist project"
                    value={projectContextId}
                    onChange={(event) => setProjectContextId(event.target.value)}
                  >
                    <option value="">Choose context</option>
                    {projects.data?.items.map((project) => (
                      <option key={project.currentContextId} value={project.currentContextId}>
                        {project.name} · r{project.contextRevision}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Shortlist name
                  <input
                    value={shortlistName}
                    onChange={(event) => setShortlistName(event.target.value)}
                  />
                </label>
                <button
                  className="button primary compact"
                  disabled={!projectContextId || shortlist.isPending}
                  onClick={() => shortlist.mutate()}
                  type="button"
                >
                  Save to project
                </button>
              </div>
            ) : null}
          </section>

          {comparison ? (
            <section className="comparison-panel" aria-labelledby="comparison-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Selected results</p>
                  <h2 id="comparison-heading">Compare results</h2>
                </div>
                <button
                  className="button secondary compact"
                  onClick={() => setComparison(null)}
                  type="button"
                >
                  Close
                </button>
              </div>
              <div className="comparison-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Field</th>
                      {comparison.items.map((item) => (
                        <th key={item.id}>{item.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>Entity class</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{label(item.entityClass)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Subtype</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{label(item.kind)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Match</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{matchLabel(item)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Signal</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>
                          {signalLabel(item)} ·{' '}
                          {item.signalBand ?? signalStateLabel(item.displayState)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th>Evidence confidence</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{confidenceLabel(item)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Trend</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{trendLabel(item)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Source coverage</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{formatFractionPercent(sourceCoverage(item))}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Relationships</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>
                          {item.relations
                            .map(
                              (relation) =>
                                `${label(relation.type)} ${relation.targetName ?? relation.targetCapabilityName ?? ''}`,
                            )
                            .join('; ') || 'None recorded'}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th>Unknowns</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{item.missing.join('; ') || 'None recorded'}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Caveats</th>
                      {comparison.items.map((item) => (
                        <td key={item.id}>{item.caveats.join('; ') || 'None recorded'}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="authority-note">{comparison.authority}</p>
            </section>
          ) : null}

          <section className="snapshot-actions" aria-label="Snapshot privacy controls">
            <div>
              <strong>Result history and query privacy</strong>
              <p>
                This result set stays auditable. Deletion clears retained query text and facets
                without rewriting the historical result snapshot.
              </p>
            </div>
            <div className="button-group">
              <button
                className="button secondary"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
                type="button"
              >
                {refresh.isPending ? 'Checking…' : 'Refresh local results'}
              </button>
              <button
                className="button danger"
                disabled={redact.isPending}
                onClick={() => redact.mutate(results.data.resultSet.querySessionId)}
                type="button"
              >
                Delete retained query text
              </button>
            </div>
          </section>
        </>
      ) : null}

      {detail.data ? (
        <aside
          className="detail-drawer"
          aria-labelledby="detail-heading"
          aria-describedby="detail-summary"
          role="dialog"
          aria-modal="false"
        >
          <div className="drawer-header">
            <div>
              <p className="eyebrow">Result details</p>
              <h2 id="detail-heading">{detail.data.name}</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close detail"
              onClick={closeDetail}
              ref={detailClose}
              type="button"
            >
              ×
            </button>
          </div>
          <p id="detail-summary">{detail.data.description}</p>
          <div className="chip-row detail-facets" aria-label="Entity facets">
            <span className="facet-chip explicit">Class: {label(detail.data.entityClass)}</span>
            <span className="facet-chip">Subtype: {label(detail.data.kind)}</span>
            <span className="facet-chip">Group: {detail.data.capabilityGroup}</span>
            {detail.data.capabilities.slice(0, 5).map((capability) => (
              <span className="facet-chip" key={capability}>
                {label(capability)}
              </span>
            ))}
          </div>
          <div className="signal-callout">
            <strong>{signalLabel(detail.data)}</strong>
            <span>
              {detail.data.signalBand ?? signalStateLabel(detail.data.displayState)} ·{' '}
              {confidenceLabel(detail.data)}
            </span>
            <small>{trendLabel(detail.data)} · query-independent intrinsic estimate</small>
          </div>
          {detail.data.providerId ? (
            <button
              className="button secondary"
              disabled={watch.isPending}
              onClick={() => watch.mutate(detail.data.providerId!)}
              type="button"
            >
              Track material changes weekly
            </button>
          ) : detail.data.canonicalUri ? (
            <a
              className="button secondary"
              href={detail.data.canonicalUri}
              rel="noreferrer"
              target="_blank"
            >
              Open document source
            </a>
          ) : null}
          <h3>Why it matched</h3>
          <p>
            <strong>{matchLabel(detail.data)}</strong> · {detail.data.explanation}
          </p>
          <div className="chip-row detail-facets" aria-label="Match path">
            {detail.data.matchedConcepts.map((concept) => (
              <span className="facet-chip inferred" key={concept.id}>
                {label(concept.facetKey)}: {concept.label}
              </span>
            ))}
            {detail.data.matchedFields.map((field) => (
              <span className="facet-chip" key={field}>
                {label(field)} field
              </span>
            ))}
          </div>
          <h3>Why Signal is high or low</h3>
          <p>{signalExplanation(detail.data)}</p>
          <div className="signal-facts">
            <div>
              <strong>Evidence confidence</strong>
              <span>{confidenceLabel(detail.data)}</span>
            </div>
            <div>
              <strong>Source coverage</strong>
              <span>{formatFractionPercent(sourceCoverage(detail.data))}</span>
            </div>
            <div>
              <strong>Trend</strong>
              <span>{trendLabel(detail.data)}</span>
              <small>{detail.data.trend?.reasons.join(' ') || 'No comparable history yet.'}</small>
            </div>
          </div>
          <h3>Signal calculation</h3>
          <p className="muted">
            {detail.data.policyVersion}. Values are normalized within a type profile; Match is not
            an input.
          </p>
          <div className="input-grid">
            {detail.data.valueInputs.map((input) => (
              <div key={input.key}>
                <strong>{label(input.key)}</strong>
                <span>
                  {input.adjusted === null
                    ? label(input.state)
                    : `${input.adjusted.toFixed(1)} adjusted`}
                </span>
                <small>
                  confidence {formatFractionPercent(input.confidence)} · coverage{' '}
                  {formatFractionPercent(input.coverage)} · prior {input.prior}
                </small>
                {input.reasons.length ? <small>{input.reasons.join(' ')}</small> : null}
                {input.missing.length ? (
                  <small className="missing-text">Missing: {input.missing.join('; ')}</small>
                ) : null}
              </div>
            ))}
          </div>
          <h3>Sources and evidence</h3>
          <p className="muted">
            {detail.data.evidence.length} bound evidence item
            {detail.data.evidence.length === 1 ? '' : 's'} across{' '}
            {detail.data.evidenceConfidenceDetail?.sourceGroupIds.length ?? 0} declared source group
            {(detail.data.evidenceConfidenceDetail?.sourceGroupIds.length ?? 0) === 1 ? '' : 's'}.
            Coverage does not imply independent corroboration.
          </p>
          {detail.data.evidence.length ? (
            detail.data.evidence.map((item) => (
              <article className="evidence-mini" key={`${item.id}:${item.dimensionKey}`}>
                <div>
                  <Badge>{label(item.dimensionKey)}</Badge>
                  <span>{label(item.evidenceType)}</span>
                </div>
                <strong>{item.sourceTitle ?? item.producer}</strong>
                <p>{item.limitations.join('; ') || 'No additional limitation recorded.'}</p>
                {item.sourceUrl ? (
                  <a href={item.sourceUrl} rel="noreferrer" target="_blank">
                    Open source
                  </a>
                ) : null}
              </article>
            ))
          ) : (
            <p className="muted">
              No evidence item is bound. The estimate uses declared priors and the policy's
              uncertainty deduction.
            </p>
          )}
          <h3>Relationships</h3>
          {detail.data.relations.length ? (
            <ul className="relationship-list">
              {detail.data.relations.map((relation, index) => (
                <li
                  key={`${relation.type}:${relation.targetProviderId ?? relation.targetCapabilityId ?? index}`}
                >
                  <strong>{label(relation.type)}</strong>{' '}
                  {relation.targetName ?? relation.targetCapabilityName ?? 'Related entity'}
                  <span>
                    {relation.scope ?? relation.rationale ?? 'No narrower scope recorded.'} ·{' '}
                    {label(relation.status)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No evidence-bearing relationship is recorded for this snapshot.</p>
          )}
          <h3>Missing evidence and limits</h3>
          {detailMissing.length ? (
            <ul className="missing-evidence-list">
              {detailMissing.map((missing) => (
                <li key={missing}>{missing}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No policy-visible gap is recorded; this is not a claim of complete market knowledge.
            </p>
          )}
          <p className="drawer-hash">
            Input hash <code>{detail.data.inputHash}</code>
          </p>
        </aside>
      ) : null}

      {history.data?.items.length ? (
        <section className="history-panel" aria-labelledby="history-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Local retention</p>
              <h2 id="history-heading">Recent query snapshots</h2>
            </div>
          </div>
          <div className="history-list">
            {history.data.items.slice(0, 8).map((item) => (
              <button
                key={item.id}
                onClick={() => setParameters({ resultSet: item.resultSetId })}
                type="button"
              >
                <span>
                  <strong>{item.query}</strong>
                  <small>
                    {formatDate(item.createdAt)} · snapshot r{item.resultSetRevision} ·{' '}
                    {item.assessedCount} results
                  </small>
                </span>
                <StateBadge state={item.coverageState} />
              </button>
            ))}
          </div>
          <p className="hint">
            Private query text remains local. Safe exports exclude it by default.
          </p>
        </section>
      ) : null}

      {!results.data && !results.isPending ? (
        <section className="explorer-start" aria-label="Search guidance">
          <div>
            <span>1</span>
            <strong>Describe the need</strong>
            <p>Use a workflow, capability, constraint, or product name.</p>
          </div>
          <div>
            <span>2</span>
            <strong>Review Match and Signal</strong>
            <p>See why it matched, intrinsic strength, confidence, trend, and missing evidence.</p>
          </div>
          <div>
            <span>3</span>
            <strong>Compare or save</strong>
            <p>Attach project context only when you are ready to make a decision.</p>
          </div>
          <p className="hint">No project setup is required to search.</p>
        </section>
      ) : null}
    </div>
  );
}
