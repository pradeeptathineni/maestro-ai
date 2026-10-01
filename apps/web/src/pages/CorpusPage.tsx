import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDate, formatFractionPercent, label } from '../api.js';
import { ResearchEvidenceList, type ResearchEvidenceCandidate } from '../ResearchEvidenceList.js';
import { Badge, Empty, ErrorPanel, Loading, PageHeader } from '../ui.js';

interface CorpusItem {
  id: string;
  layer: 'indexed_knowledge' | 'knowledge_document' | 'source_lead';
  providerId: string | null;
  name: string;
  summary: string;
  kind: string;
  state: 'reviewed' | 'proposed' | 'stale' | 'lead';
  sources: string[];
  canonicalUri: string | null;
  observedAt: string;
  matchedTerms: string[];
  relevanceOrdinal: string | null;
  signalDisplay: number | null;
  evidenceCoverage: number | null;
  displayState: string | null;
  signalBand: string | null;
  signalExplanation: string | null;
}

interface CorpusResponse {
  scope: { label: string; statement: string };
  query: string | null;
  scoringApplied: boolean;
  corpusCount: number;
  matchedCount: number;
  filteredCount: number;
  facets: {
    layers: Array<{ value: string; count: number }>;
    states: Array<{ value: string; count: number }>;
    sources: Array<{ value: string; count: number }>;
    kinds: Array<{ value: string; count: number }>;
  };
  items: CorpusItem[];
  nextCursor: string | null;
}

interface CorpusResearchRun {
  id: string;
  strategy: 'model' | 'deterministic_fallback';
  state: string;
  modelIdentifier: string | null;
  safeDetail: string;
  candidates: ResearchEvidenceCandidate[];
  proposals: Array<{
    proposalType: string;
    output: unknown;
  }>;
}

interface CorpusSynthesis {
  summary: string;
  groups: Array<{ label: string; description: string; candidateIds: string[] }>;
  items: Array<{
    candidateId: string;
    reason: string;
    uncertainty: string | null;
  }>;
  limitations: string[];
}

function evidenceLabel(state: string | null): string {
  if (state === 'available') return 'Source-backed';
  if (state === 'provisional') return 'Preliminary';
  if (state === 'insufficient_evidence') return 'Low confidence';
  return state ? label(state) : 'Not query-scored';
}

export function CorpusPage() {
  const [parameters, setParameters] = useSearchParams();
  const [appliedQuery, setAppliedQuery] = useState('');
  const [draftQuery, setDraftQuery] = useState('');
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);
  const queryString = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of ['layer', 'state', 'source', 'kind', 'cursor']) {
      const value = parameters.get(key);
      if (value) query.set(key, value);
    }
    query.set('limit', '12');
    return query.toString();
  }, [parameters]);
  const corpus = useQuery({
    queryKey: ['research-corpus', queryString, appliedQuery],
    queryFn: () => {
      if (!appliedQuery) return api<CorpusResponse>(`/api/v1/corpus?${queryString}`);
      const filters = Object.fromEntries(new URLSearchParams(queryString));
      return api<CorpusResponse>('/api/v1/corpus/search', {
        method: 'POST',
        body: JSON.stringify({ ...filters, limit: 12, query: appliedQuery }),
      });
    },
  });
  const startResearch = useMutation({
    mutationFn: async (query: string) => {
      const session = await api<{ id: string }>('/api/v1/explorer/sessions', {
        method: 'POST',
        body: JSON.stringify({ query, searchConnectedSources: false }),
      });
      return api<{ id: string; state: string; strategy: string }>(
        `/api/v1/explorer/sessions/${session.id}/research-runs`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'corpus',
            idempotencyKey: `corpus:${session.id}:research-skill-v1`,
          }),
        },
      );
    },
    onSuccess: (run) => setResearchRunId(run.id),
  });
  const researchRun = useQuery({
    queryKey: ['corpus-research-run', researchRunId],
    enabled: Boolean(researchRunId),
    queryFn: () => api<CorpusResearchRun>(`/api/v1/research/runs/${researchRunId}`),
    refetchInterval: (query: { state: { data?: CorpusResearchRun } }) =>
      ['queued', 'running'].includes(query.state.data?.state ?? '') ? 1_000 : false,
  });

  function replaceParameter(key: string, value: string): void {
    const next = new URLSearchParams(parameters);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('cursor');
    setPreviousCursors([]);
    setParameters(next);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const next = new URLSearchParams(parameters);
    next.delete('cursor');
    setPreviousCursors([]);
    setParameters(next);
    const normalized = draftQuery.trim();
    setAppliedQuery(normalized);
    setResearchRunId(null);
    if (normalized) startResearch.mutate(normalized);
  }

  function clearFilters(): void {
    setDraftQuery('');
    setAppliedQuery('');
    setResearchRunId(null);
    setPreviousCursors([]);
    setParameters({});
  }

  const synthesis = researchRun.data?.proposals.find(
    (proposal) => proposal.proposalType === 'synthesis',
  )?.output as CorpusSynthesis | undefined;
  const researchCandidates = new Map(
    (researchRun.data?.candidates ?? []).map((candidate) => [candidate.id, candidate]),
  );

  function nextPage(): void {
    if (!corpus.data?.nextCursor) return;
    setPreviousCursors((current) => [...current, parameters.get('cursor') ?? '']);
    const next = new URLSearchParams(parameters);
    next.set('cursor', corpus.data.nextCursor);
    setParameters(next);
  }

  function previousPage(): void {
    const previous = previousCursors.at(-1);
    if (previous === undefined) return;
    setPreviousCursors((current) => current.slice(0, -1));
    const next = new URLSearchParams(parameters);
    if (previous) next.set('cursor', previous);
    else next.delete('cursor');
    setParameters(next);
  }

  return (
    <div className="page-shell corpus-page">
      <PageHeader
        eyebrow="Admitted knowledge"
        title="Browse the durable research corpus"
        description="The corpus contains reviewed or explicitly proposed knowledge. Live Search findings stay in research history until they pass an admission decision."
        action={
          <Link className="button primary" to="/explore">
            Start a search
          </Link>
        }
      />

      <section className="corpus-controls" aria-labelledby="corpus-controls-heading">
        <div className="section-heading compact-heading">
          <div>
            <h2 id="corpus-controls-heading">Search and filter</h2>
            <p>
              Enter a need to calculate query-specific signals. Leave it empty to browse saved
              records by source, kind, or review state.
            </p>
          </div>
        </div>
        <form className="corpus-search" onSubmit={submit}>
          <label>
            Search the corpus
            <input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              maxLength={1000}
              placeholder="Context reduction for coding agents"
            />
          </label>
          <button className="button primary" type="submit">
            Search corpus
          </button>
        </form>
        <div className="corpus-filters">
          <label>
            Layer
            <select
              value={parameters.get('layer') ?? ''}
              onChange={(event) => replaceParameter('layer', event.target.value)}
            >
              <option value="">All layers</option>
              <option value="indexed_knowledge">Indexed knowledge</option>
              <option value="knowledge_document">Knowledge documents</option>
            </select>
          </label>
          <label>
            Review state
            <select
              value={parameters.get('state') ?? ''}
              onChange={(event) => replaceParameter('state', event.target.value)}
            >
              <option value="">All states</option>
              {corpus.data?.facets.states.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {label(facet.value)} ({facet.count})
                </option>
              ))}
            </select>
          </label>
          <label>
            Source
            <select
              value={parameters.get('source') ?? ''}
              onChange={(event) => replaceParameter('source', event.target.value)}
            >
              <option value="">All sources</option>
              {corpus.data?.facets.sources.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {label(facet.value)} ({facet.count})
                </option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select
              value={parameters.get('kind') ?? ''}
              onChange={(event) => replaceParameter('kind', event.target.value)}
            >
              <option value="">All kinds</option>
              {corpus.data?.facets.kinds.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {label(facet.value)} ({facet.count})
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary compact" onClick={clearFilters} type="button">
            Clear
          </button>
        </div>
      </section>

      {corpus.isPending ? <Loading message="Loading the local research corpus…" /> : null}
      {corpus.error ? <ErrorPanel error={corpus.error} /> : null}
      {startResearch.error ? <ErrorPanel error={startResearch.error} /> : null}
      {researchRun.error ? <ErrorPanel error={researchRun.error} /> : null}
      {corpus.data ? (
        <>
          <section className="corpus-summary" aria-label="Corpus scope">
            <div>
              <strong>{corpus.data.corpusCount}</strong>
              <span>saved records</span>
            </div>
            <div>
              <strong>{corpus.data.matchedCount}</strong>
              <span>{corpus.data.scoringApplied ? 'query matches' : 'available to browse'}</span>
            </div>
            <div>
              <strong>{corpus.data.filteredCount}</strong>
              <span>after filters</span>
            </div>
            <p>{corpus.data.scope.statement}</p>
          </section>

          {appliedQuery && (startResearch.isPending || researchRun.data) ? (
            <section className="source-results" aria-labelledby="corpus-synthesis-heading">
              <div className="source-results-body">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Corpus research</p>
                    <h2 id="corpus-synthesis-heading">Organized from admitted evidence</h2>
                  </div>
                  {researchRun.data ? <Badge>{label(researchRun.data.state)}</Badge> : null}
                </div>
                {startResearch.isPending ||
                ['queued', 'running'].includes(researchRun.data?.state ?? '') ? (
                  <Loading message="Reviewing corpus evidence and checking coverage gaps…" />
                ) : synthesis ? (
                  <>
                    <p>{synthesis.summary}</p>
                    <div className="chip-row" aria-label="Corpus research groups">
                      {synthesis.groups.map((group) => (
                        <span
                          className="facet-chip explicit"
                          key={group.label}
                          title={group.description}
                        >
                          {group.label} ({group.candidateIds.length})
                        </span>
                      ))}
                    </div>
                    <ResearchEvidenceList candidates={researchCandidates} items={synthesis.items} />
                    {synthesis.limitations.length ? (
                      <p className="hint">Limits: {synthesis.limitations.join(' ')}</p>
                    ) : null}
                  </>
                ) : researchRun.data ? (
                  <p className="authority-note">{researchRun.data.safeDetail}</p>
                ) : null}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="corpus-results-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">
                  {corpus.data.scoringApplied ? 'Query-scored records' : 'Recently observed'}
                </p>
                <h2 id="corpus-results-heading">Corpus records</h2>
              </div>
              <p className="hint">
                {corpus.data.scoringApplied
                  ? 'Every displayed match has a numeric estimate. Confidence and review state remain separate.'
                  : 'Browse mode does not invent a universal score. Search for a need to calculate query-specific signals.'}
              </p>
            </div>
            {corpus.data.items.length ? (
              <div className="corpus-list">
                {corpus.data.items.map((item) => (
                  <article className="corpus-row" key={`${item.layer}:${item.id}`}>
                    <div className="corpus-record-main">
                      <div className="card-topline">
                        <Badge>
                          {item.layer === 'indexed_knowledge'
                            ? 'Implementation'
                            : item.layer === 'knowledge_document'
                              ? 'Knowledge document'
                              : 'Legacy source lead'}
                        </Badge>
                        <Badge>{label(item.state)}</Badge>
                        <Badge>{label(item.kind)}</Badge>
                      </div>
                      <h3>{item.name}</h3>
                      <p>{item.summary}</p>
                      <small>
                        {item.sources.map(label).join(' · ')} · observed{' '}
                        {formatDate(item.observedAt)}
                      </small>
                      {item.matchedTerms.length ? (
                        <p className="matched-terms">
                          Matched: {item.matchedTerms.slice(0, 8).join(', ')}
                        </p>
                      ) : null}
                    </div>
                    {corpus.data.scoringApplied ? (
                      <div className="query-signal">
                        <strong>Signal {item.signalDisplay}</strong>
                        <span>
                          {item.relevanceOrdinal
                            ? `${label(item.relevanceOrdinal)} relevance · `
                            : ''}
                          {evidenceLabel(item.displayState)}
                        </span>
                        <small>
                          {formatFractionPercent(item.evidenceCoverage ?? 0)} evidence coverage
                        </small>
                      </div>
                    ) : null}
                    <div className="corpus-record-action">
                      {item.layer === 'indexed_knowledge' && item.providerId ? (
                        <Link
                          className="button secondary compact"
                          to={`/providers/${item.providerId}`}
                        >
                          Inspect record
                        </Link>
                      ) : item.canonicalUri ? (
                        <a
                          className="button secondary compact"
                          href={item.canonicalUri}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open source
                        </a>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Empty title="No corpus records match">
                Change the query or clear one of the filters. A live Search saves attributed source
                leads here automatically.
              </Empty>
            )}
            <div className="corpus-pagination">
              <button
                className="button secondary compact"
                disabled={!previousCursors.length}
                onClick={previousPage}
                type="button"
              >
                Previous
              </button>
              <button
                className="button secondary compact"
                disabled={!corpus.data.nextCursor}
                onClick={nextPage}
                type="button"
              >
                Next
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
