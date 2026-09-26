import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatFractionPercent, label } from '../api.js';
import type { Domain, ProviderSummary } from '../types.js';
import { Badge, Empty, ErrorPanel, Loading, PageHeader, Score, StateBadge } from '../ui.js';

interface ProviderResponse {
  items: ProviderSummary[];
  nextCursor: string | null;
  total: number;
}

export function ExplorePage() {
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState('consideration');
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api<{ items: Domain[] }>('/api/v1/domains'),
  });
  const providers = useQuery({
    queryKey: ['providers', search, domain, kind, sort],
    queryFn: () => {
      const parameters = new URLSearchParams({ sort, limit: '50' });
      if (search.trim()) parameters.set('search', search.trim());
      if (domain) parameters.set('domain', domain);
      if (kind) parameters.set('kind', kind);
      return api<ProviderResponse>(`/api/v1/providers?${parameters}`);
    },
  });

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Reviewed capability catalog"
        title="Explore credible options"
        description="Browse source-backed capability records. General consideration describes catalog evidence—not whether a provider fits your project."
        action={
          <Link className="button secondary" to="/consider">
            Consider a URL
          </Link>
        }
      />

      <section className="filter-bar" aria-label="Catalog filters">
        <label>
          Search names, aliases, capabilities
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Try context, workflow, Python…"
          />
        </label>
        <label>
          Domain
          <select value={domain} onChange={(event) => setDomain(event.target.value)}>
            <option value="">All reviewed domains</option>
            {domains.data?.items.map((item) => (
              <option key={item.id} value={item.key}>
                {item.label} ({item.providerCount})
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider kind
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">All kinds</option>
            {[
              'oss_project',
              'product',
              'service',
              'api',
              'mcp_server',
              'plugin',
              'skill',
              'model',
              'agent',
              'framework',
              'runtime',
              'library',
              'language',
              'protocol',
              'registry',
              'workflow',
              'other',
            ].map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="consideration">Strongest supported consideration</option>
            <option value="evidence">Evidence strength</option>
            <option value="freshness">Recently supported</option>
            <option value="verification">Verification value</option>
            <option value="name">Name</option>
          </select>
        </label>
      </section>

      {providers.isPending ? <Loading /> : null}
      {providers.isError ? <ErrorPanel error={providers.error} /> : null}
      {providers.data ? (
        <section aria-labelledby="catalog-results">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Current review set</p>
              <h2 id="catalog-results">{providers.data.total} capabilities found</h2>
            </div>
            <p className="hint">
              Scores are deterministic, decomposable, and conservative about missing data.
            </p>
          </div>
          {providers.data.items.length === 0 ? (
            <Empty title="No lexical match">
              Reviewed records exist, but none match these filters. Clear a filter or try an alias
              or capability name.
            </Empty>
          ) : (
            <div className="catalog-grid">
              {providers.data.items.map((provider) => {
                const missing = provider.dimensions.flatMap((dimension) => dimension.missing);
                const reasons = provider.dimensions
                  .flatMap((dimension) => dimension.reasons)
                  .slice(0, 2);
                const freshness = provider.dimensions.find(
                  (dimension) => dimension.key === 'freshness_support',
                );
                const security = provider.dimensions.find(
                  (dimension) => dimension.key === 'security_provenance',
                );
                return (
                  <article className="provider-card" key={provider.id}>
                    <div className="card-topline">
                      <Badge>{label(provider.kind)}</Badge>
                      <StateBadge state={provider.lifecycleState} />
                    </div>
                    <h3>
                      <Link to={`/providers/${provider.id}`}>{provider.name}</Link>
                    </h3>
                    <p>{provider.description}</p>
                    <div className="tag-row">
                      {provider.domains.slice(0, 3).map((item) => (
                        <span key={item.key}>{item.label}</span>
                      ))}
                    </div>
                    <Score
                      band={provider.considerationBand}
                      lowerBound={provider.considerationLowerBound}
                      uncertainty={provider.scoreUncertainty}
                    />
                    <dl className="compact-metrics">
                      <div>
                        <dt>Evidence coverage</dt>
                        <dd>{formatFractionPercent(provider.evidenceCoverage)}</dd>
                      </div>
                      <div>
                        <dt>Verification value</dt>
                        <dd>{provider.verificationPriority}</dd>
                      </div>
                      <div>
                        <dt>Freshness support</dt>
                        <dd>{freshness ? `${Math.round(freshness.adjusted)}/100` : 'Missing'}</dd>
                      </div>
                      <div>
                        <dt>Security provenance</dt>
                        <dd>
                          {security?.state === 'missing' || !security
                            ? 'Missing'
                            : `${Math.round(security.adjusted)}/100`}
                        </dd>
                      </div>
                    </dl>
                    <div className="reason-block">
                      <strong>Why here</strong>
                      <ul>
                        {reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                    <p className="unknown-line">
                      <strong>Unknowns:</strong>{' '}
                      {missing.length ? missing.slice(0, 2).join('; ') : 'No scored input gaps.'}
                    </p>
                    {provider.matchedFields.length ? (
                      <small>Matched: {provider.matchedFields.join(', ')}</small>
                    ) : null}
                    <Link className="text-link" to={`/providers/${provider.id}`}>
                      Inspect evidence and score <span aria-hidden="true">→</span>
                    </Link>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
