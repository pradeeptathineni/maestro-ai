import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, label } from '../api.js';
import type { VerificationItem } from '../types.js';
import { Empty, ErrorPanel, JsonDetails, Loading, PageHeader, StateBadge } from '../ui.js';

export function EvidencePage() {
  const queue = useQuery({
    queryKey: ['verification'],
    queryFn: () => api<{ items: VerificationItem[] }>('/api/v1/verification'),
  });
  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Evidence attention queue"
        title="Verify what could change a decision"
        description="Priority reflects the value of additional scrutiny for a scope. It is not a universal maturity or audit badge."
      />
      {queue.isPending ? <Loading /> : null}
      {queue.isError ? <ErrorPanel error={queue.error} /> : null}
      {queue.data?.items.length === 0 ? (
        <Empty title="No verification plans">Reviewed providers have no current scoped plan.</Empty>
      ) : null}
      <div className="verification-grid">
        {queue.data?.items.map((item) => (
          <article className="verification-card" key={item.id}>
            <div className="priority-number" aria-label={`Priority ${item.priority}`}>
              {item.priority}
            </div>
            <div>
              <div className="card-topline">
                <StateBadge state={item.state} />
                <span>{item.modes.map(label).join(' · ')}</span>
              </div>
              <h2>
                <Link to={`/providers/${item.providerId}`}>{item.providerName}</Link>
              </h2>
              <p>{item.scope}</p>
              <div className="factor-list">
                {item.factors.map((factor) => (
                  <div key={factor.key}>
                    <span>{label(factor.key)}</span>
                    <strong>{factor.value}</strong>
                    <small>{factor.explanation}</small>
                  </div>
                ))}
              </div>
              <JsonDetails summary="Proposed bounded verification" value={item.nextPlan} />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
