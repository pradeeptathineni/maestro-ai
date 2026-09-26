import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, formatFractionPercent, label } from '../api.js';
import type { ProviderDetail } from '../types.js';
import {
  Badge,
  DefinitionList,
  ErrorPanel,
  JsonDetails,
  Loading,
  PageHeader,
  Score,
  StateBadge,
} from '../ui.js';

export function ProviderPage() {
  const { id = '' } = useParams();
  const provider = useQuery({
    queryKey: ['provider', id],
    queryFn: () => api<ProviderDetail>(`/api/v1/providers/${id}`),
  });

  if (provider.isPending)
    return (
      <div className="page-shell">
        <Loading message="Loading provenance and score components…" />
      </div>
    );
  if (provider.isError)
    return (
      <div className="page-shell">
        <ErrorPanel error={provider.error} />
      </div>
    );
  const item = provider.data;

  return (
    <div className="page-shell">
      <div className="breadcrumb">
        <Link to="/explore">Explore</Link>
        <span aria-hidden="true">/</span>
        {item.name}
      </div>
      <PageHeader
        eyebrow={`${label(item.kind)} · ${label(item.lifecycleState)}`}
        title={item.name}
        description={item.description}
        action={
          <Link className="button" to="/decide">
            Add through a decision
          </Link>
        }
      />

      <section className="summary-strip" aria-label="Provider summary">
        <Score
          band={item.score?.band ?? null}
          lowerBound={item.score?.lowerBound ?? null}
          uncertainty={item.score?.uncertainty}
        />
        <div>
          <span>Evidence coverage</span>
          <strong>
            {item.score ? formatFractionPercent(item.score.evidenceCoverage) : 'Missing'}
          </strong>
        </div>
        <div>
          <span>Calculated</span>
          <strong>{formatDate(item.score?.generatedAt)}</strong>
        </div>
        <div>
          <span>Execution</span>
          <strong>Not available in v0</strong>
        </div>
      </section>

      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel" aria-labelledby="overview-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Overview</p>
                <h2 id="overview-heading">Identity and capabilities</h2>
              </div>
            </div>
            <DefinitionList
              items={[
                [
                  'Canonical identity',
                  item.identities.find((identity) => identity.isCanonical)?.displayValue ??
                    'Missing',
                ],
                ['Aliases', item.aliases.length ? item.aliases.join(', ') : 'None reviewed'],
                ['Domains', item.domains.map((domain) => domain.label).join(', ')],
                [
                  'Versions',
                  item.versions.length
                    ? item.versions.map((version) => version.version).join(', ')
                    : 'No exact version claimed',
                ],
              ]}
            />
            <div className="capability-list">
              {item.capabilities.map((capability) => (
                <article key={capability.key}>
                  <div>
                    <h3>{capability.name}</h3>
                    <Badge>{label(capability.deliveryMode)}</Badge>
                  </div>
                  <p>{capability.description}</p>
                  <small>
                    {label(capability.assertionState)} · {label(capability.maturityState)}
                  </small>
                </article>
              ))}
            </div>
          </section>

          <section className="panel" aria-labelledby="score-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Why consider</p>
                <h2 id="score-heading">Conservative score decomposition</h2>
              </div>
              <Badge>{item.score?.policyVersion ?? 'No policy run'}</Badge>
            </div>
            <p className="section-intro">
              General consideration is not project fit. Missing inputs widen uncertainty instead of
              becoming zero.
            </p>
            {item.score?.dimensions.map((dimension) => (
              <article className="dimension" key={dimension.key}>
                <div className="dimension-heading">
                  <div>
                    <h3>{label(dimension.key)}</h3>
                    <StateBadge state={dimension.state} />
                  </div>
                  <strong>
                    {dimension.adjusted === null ? 'Not applicable' : dimension.adjusted.toFixed(1)}
                  </strong>
                </div>
                {dimension.adjusted === null ? null : (
                  <div
                    className="meter"
                    role="progressbar"
                    aria-label={label(dimension.key)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={dimension.adjusted}
                  >
                    <span style={{ width: `${dimension.adjusted}%` }} />
                  </div>
                )}
                <p>{dimension.reasons.join(' ')}</p>
                {dimension.missing.length ? (
                  <p className="missing-text">
                    <strong>Missing:</strong> {dimension.missing.join('; ')}
                  </p>
                ) : null}
                <small>
                  Raw {dimension.raw ?? 'missing'} · confidence{' '}
                  {Math.round(dimension.confidence * 100)}% · coverage{' '}
                  {Math.round(dimension.coverage * 100)}%
                </small>
              </article>
            ))}
          </section>

          <section className="panel" aria-labelledby="claims-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Claims & evidence</p>
                <h2 id="claims-heading">Trace every material assertion</h2>
              </div>
            </div>
            <div className="claim-list">
              {item.claims.map((claim) => (
                <article key={claim.id}>
                  <div className="card-topline">
                    <Badge tone={claim.claimantRelation === 'publisher' ? 'warning' : 'neutral'}>
                      {label(claim.claimantRelation)} claim
                    </Badge>
                    <StateBadge state={claim.workflowState} />
                  </div>
                  <h3>{label(claim.predicate)}</h3>
                  <p className="claim-value">
                    {typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value)}
                  </p>
                  <p>
                    <strong>Scope:</strong> {claim.scope}
                  </p>
                  <blockquote>{claim.sourceObservation}</blockquote>
                  <p className="source-line">
                    <a href={claim.sourceUrl} target="_blank" rel="noreferrer">
                      {claim.sourceTitle} <span className="sr-only">(opens external site)</span>
                    </a>
                    {' · '}
                    {claim.sourceOwner} · observed {formatDate(claim.observedAt)}
                  </p>
                  {claim.evidence.map((evidence) => (
                    <div className="evidence-row" key={evidence.evidenceId}>
                      <StateBadge state={evidence.direction} />
                      <span>
                        {label(evidence.evidenceType)} · {label(evidence.independence)} ·{' '}
                        {evidence.rationale}
                      </span>
                      {evidence.limitations.length ? (
                        <small>Limits: {evidence.limitations.join('; ')}</small>
                      ) : null}
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="detail-aside" aria-label="Verification and authority">
          <section className="panel sticky-panel">
            <p className="eyebrow">Verification</p>
            <h2>What scrutiny is valuable next?</h2>
            {item.verification.map((verification) => (
              <div className="verification-summary" key={verification.id}>
                <strong>Priority {verification.priority}</strong>
                <StateBadge state={verification.state} />
                <p>{verification.scope}</p>
                <p>
                  <strong>Modes:</strong> {verification.modes.map(label).join(', ')}
                </p>
                <JsonDetails summary="Proposed bounded plan" value={verification.nextPlan} />
              </div>
            ))}
            <h3>Project compatibility observations</h3>
            {item.compatibility.map((fact) => (
              <div className="compatibility" key={fact.key}>
                <div>
                  <strong>{label(fact.key)}</strong>
                  <StateBadge state={fact.state} />
                </div>
                <p>{fact.explanation}</p>
              </div>
            ))}
            <div className="boundary-note">
              <strong>Use & authority</strong>
              <p>{item.executionAvailability.explanation}</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
