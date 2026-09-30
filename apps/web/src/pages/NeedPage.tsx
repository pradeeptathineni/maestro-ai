import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formString, formatFractionPercent, label } from '../api.js';
import type { DecisionDetail, NeedDetail, ProviderSummary } from '../types.js';
import {
  Badge,
  Empty,
  ErrorPanel,
  InputError,
  JsonDetails,
  Loading,
  PageHeader,
  Score,
  StateBadge,
} from '../ui.js';

interface ProvidersResponse {
  items: ProviderSummary[];
  total: number;
  nextCursor: string | null;
}

type CandidateKind = 'provider' | 'composition' | 'status_quo' | 'build' | 'defer';

export function NeedPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [decisionError, setDecisionError] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const [candidateKind, setCandidateKind] = useState<CandidateKind>('provider');
  const [addCandidateOpen, setAddCandidateOpen] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseError, setReviseError] = useState('');
  const need = useQuery({
    queryKey: ['need', id],
    queryFn: () => api<NeedDetail>(`/api/v1/needs/${id}`),
  });
  const providers = useQuery({
    queryKey: ['providers-for-candidate'],
    queryFn: () => api<ProvidersResponse>('/api/v1/providers?sort=consideration&limit=50'),
  });
  const addCandidate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/needs/${id}/candidates`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      setCandidateError('');
      setAddCandidateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['need', id] });
      await queryClient.invalidateQueries({ queryKey: ['needs'] });
    },
    onError: (error) =>
      setCandidateError(error instanceof Error ? error.message : 'Could not add candidate.'),
  });
  const recordDecision = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<DecisionDetail>(`/api/v1/needs/${id}/decisions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async (decision) => {
      await queryClient.invalidateQueries({ queryKey: ['need', id] });
      void navigate(`/decisions/${decision.id}`);
    },
    onError: (error) =>
      setDecisionError(error instanceof Error ? error.message : 'Could not record decision.'),
  });
  const reviseNeed = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string }>(`/api/v1/needs/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: async (revision) => {
      await queryClient.invalidateQueries({ queryKey: ['needs'] });
      void navigate(`/decide/${revision.id}`);
    },
    onError: (error) =>
      setReviseError(error instanceof Error ? error.message : 'Could not create need revision.'),
  });

  function submitCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCandidateError('');
    const data = new FormData(event.currentTarget);
    const description = formString(data, 'description').trim();
    if (candidateKind === 'status_quo') {
      addCandidate.mutate({ optionKind: 'status_quo', label: 'Current workflow / no change' });
      return;
    }
    if (candidateKind === 'provider') {
      const selection = formString(data, 'providerId');
      const provider = providers.data?.items.find((item) => item.id === selection);
      if (!provider) {
        setCandidateError('Select a catalog provider or practice.');
        return;
      }
      addCandidate.mutate({
        optionKind: 'provider',
        providerId: provider.id,
        label: provider.name,
      });
      return;
    }
    const customLabel = formString(data, 'label').trim();
    if (candidateKind === 'composition') {
      const providerIds = data.getAll('providerIds').map(String).filter(Boolean);
      if (providerIds.length < 2 || providerIds.length > 5) {
        setCandidateError('Select between two and five components.');
        return;
      }
      addCandidate.mutate({
        optionKind: 'composition',
        providerIds,
        label: customLabel || 'Composed option',
        ...(description ? { description } : {}),
      });
      return;
    }
    addCandidate.mutate({
      optionKind: candidateKind,
      label: customLabel || (candidateKind === 'build' ? 'Build a bounded solution' : 'Defer'),
      ...(description ? { description } : {}),
    });
  }

  function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDecisionError('');
    const data = new FormData(event.currentTarget);
    const outcome = formString(data, 'outcome');
    const selectedCandidateId = formString(data, 'selectedCandidateId');
    recordDecision.mutate({
      outcome,
      ...(selectedCandidateId ? { selectedCandidateId } : {}),
      rationale: formString(data, 'rationale'),
      conditions: formString(data, 'conditions')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    });
  }

  function submitRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReviseError('');
    const current = need.data;
    if (!current) {
      setReviseError('The current need is not available.');
      return;
    }
    const data = new FormData(event.currentTarget);
    reviseNeed.mutate({
      projectId: current.projectId,
      expectedRevision: current.revision,
      title: formString(data, 'title'),
      desiredOutcome: formString(data, 'desiredOutcome'),
      successCriteria: formString(data, 'successCriteria')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      requiredCapabilityKeys: current.requiredCapabilityKeys,
      constraints: current.constraints.map((constraint) => ({
        key: constraint.key,
        label: constraint.label,
        kind: constraint.kind,
        unknownHandling: constraint.unknownHandling,
        ...(constraint.weight === null ? {} : { weight: constraint.weight }),
      })),
    });
  }

  if (need.isPending)
    return (
      <div className="page-shell">
        <Loading message="Evaluating gates and fit…" />
      </div>
    );
  if (need.isError)
    return (
      <div className="page-shell">
        <ErrorPanel error={need.error} />
      </div>
    );
  const item = need.data;
  const providerOptions = providers.data?.items.map((provider) => (
    <option value={provider.id} key={provider.id}>
      {provider.name} · {label(provider.kind)}
    </option>
  ));

  return (
    <div className="page-shell">
      <div className="breadcrumb">
        <Link to="/decide">Decide</Link>
        <span aria-hidden="true">/</span>
        {item.title}
      </div>
      <PageHeader
        eyebrow={`${item.projectName} · need revision ${item.revision}`}
        title={item.title}
        description={item.desiredOutcome}
        action={
          <div className="button-group">
            <button
              type="button"
              className="button secondary"
              onClick={() => setReviseOpen((open) => !open)}
            >
              {reviseOpen ? 'Close revision' : 'Revise need'}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setAddCandidateOpen((open) => !open)}
            >
              {addCandidateOpen ? 'Close candidate' : 'Add candidate'}
            </button>
          </div>
        }
      />

      <section className="boundary-note prominent">
        <strong>Two separate questions</strong>
        <p>
          <b>General consideration</b> reflects public catalog evidence. <b>Project fit</b> uses
          this private need and its immutable project-context snapshot. Hard gates run first.
        </p>
      </section>

      {reviseOpen ? (
        <section className="panel form-panel" aria-labelledby="revise-need-heading">
          <p className="eyebrow">Optimistic revision</p>
          <h2 id="revise-need-heading">Create need revision {item.revision + 1}</h2>
          <p className="section-intro">
            The prior revision and its decisions remain immutable. Current constraints and required
            capabilities carry forward; this form revises the outcome contract.
          </p>
          <form onSubmit={submitRevision}>
            <label>
              Decision title
              <input name="title" required maxLength={240} defaultValue={item.title} />
            </label>
            <label>
              Desired outcome
              <textarea
                name="desiredOutcome"
                required
                rows={3}
                maxLength={2000}
                defaultValue={item.desiredOutcome}
              />
            </label>
            <label>
              Success criteria <small>One per line</small>
              <textarea
                name="successCriteria"
                required
                rows={4}
                defaultValue={item.successCriteria.join('\n')}
              />
            </label>
            <InputError id="revise-error">{reviseError}</InputError>
            <div className="form-actions">
              <button className="button" disabled={reviseNeed.isPending}>
                {reviseNeed.isPending ? 'Creating revision…' : 'Create immutable revision'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {addCandidateOpen ? (
        <section className="panel form-panel" aria-labelledby="add-candidate-heading">
          <h2 id="add-candidate-heading">Add a comparison candidate</h2>
          <p className="section-intro">
            Compare a cataloged provider or practice with a composition, a bounded build, deferral,
            or the current workflow. Non-provider options remain unknown until evidence is added.
          </p>
          <form onSubmit={submitCandidate}>
            <div className="form-grid two-column">
              <label>
                Option kind
                <select
                  aria-label="Candidate option kind"
                  value={candidateKind}
                  onChange={(event) => setCandidateKind(event.target.value as CandidateKind)}
                >
                  <option value="provider">Catalog provider or practice</option>
                  <option value="composition">Composition of 2–5 providers</option>
                  <option value="status_quo">Current workflow / no change</option>
                  <option value="build">Build a bounded solution</option>
                  <option value="defer">Defer the decision</option>
                </select>
              </label>
              {candidateKind === 'provider' ? (
                <label>
                  Catalog option
                  <select name="providerId" defaultValue="" required>
                    <option value="" disabled>
                      Select an option
                    </option>
                    {providerOptions}
                  </select>
                </label>
              ) : null}
              {candidateKind === 'composition' ? (
                <label>
                  Components <small>Select 2–5</small>
                  <select name="providerIds" multiple required size={6}>
                    {providerOptions}
                  </select>
                </label>
              ) : null}
              {candidateKind === 'composition' ||
              candidateKind === 'build' ||
              candidateKind === 'defer' ? (
                <label>
                  Option label
                  <input
                    name="label"
                    maxLength={240}
                    placeholder={
                      candidateKind === 'composition'
                        ? 'Local runtime + evaluation harness'
                        : candidateKind === 'build'
                          ? 'Build a small repository-native adapter'
                          : 'Defer until evidence is available'
                    }
                  />
                </label>
              ) : null}
            </div>
            {candidateKind === 'composition' || candidateKind === 'build' ? (
              <label>
                Scope note <small>Optional; no capability is inferred from this prose</small>
                <textarea name="description" rows={2} maxLength={2000} />
              </label>
            ) : null}
            <div className="form-actions">
              <button className="button" disabled={addCandidate.isPending}>
                {addCandidate.isPending ? 'Assessing…' : 'Add and assess'}
              </button>
            </div>
            <InputError id="candidate-error">{candidateError}</InputError>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="constraints-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Decision contract</p>
            <h2 id="constraints-heading">Hard gates and preferences</h2>
          </div>
          <Badge>{item.projectSnapshotHash.slice(0, 10)}… snapshot</Badge>
        </div>
        <div className="constraint-grid">
          {item.constraints.map((constraint) => (
            <article key={constraint.id}>
              <StateBadge state={constraint.kind} />
              <h3>{constraint.label}</h3>
              <p>
                {constraint.kind === 'hard_gate'
                  ? `Unknown handling: ${label(constraint.unknownHandling)}`
                  : `Weight: ${Math.round((constraint.weight ?? 0) * 100)}%`}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="comparison-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Candidate comparison</p>
            <h2 id="comparison-heading">Gates first, preference fit second</h2>
          </div>
        </div>
        {item.candidates.length === 0 ? (
          <Empty title="No candidates yet">
            Add at least one catalog provider and a current-workflow baseline.
          </Empty>
        ) : (
          <div className="comparison-grid">
            {item.candidates.map((candidate) => (
              <article className="candidate-card" key={candidate.id}>
                <div className="card-topline">
                  <Badge>{label(candidate.optionKind)}</Badge>
                  <StateBadge state={candidate.eligibility} />
                </div>
                <h3>
                  {candidate.providerId ? (
                    <Link to={`/providers/${candidate.providerId}`}>{candidate.label}</Link>
                  ) : (
                    candidate.label
                  )}
                </h3>
                <p>{candidate.recommendationExplanation}</p>
                <div className="comparison-section">
                  <h4>Hard gates</h4>
                  {candidate.gateResults.map((gate) => (
                    <div className="gate-row" key={gate.constraintId}>
                      <div>
                        <StateBadge state={gate.state} />
                        <strong>{gate.label}</strong>
                      </div>
                      <p>{gate.explanation}</p>
                    </div>
                  ))}
                </div>
                <div className="comparison-section">
                  <h4>Project fit</h4>
                  {candidate.eligibility === 'eligible' && candidate.preferenceResult ? (
                    <Score
                      band={candidate.preferenceResult.band}
                      lowerBound={candidate.preferenceResult.lowerBound}
                      uncertainty={candidate.preferenceResult.uncertainty}
                    />
                  ) : (
                    <p className="missing-text">
                      No preference score: hard gates did not establish eligibility.
                    </p>
                  )}
                </div>
                <div className="comparison-section">
                  <h4>General consideration</h4>
                  <Score
                    band={candidate.considerationBand}
                    lowerBound={candidate.considerationLowerBound}
                    uncertainty={candidate.considerationUncertainty}
                  />
                </div>
                <dl className="compact-metrics">
                  <div>
                    <dt>Evidence</dt>
                    <dd>
                      {candidate.evidenceCoverage === null
                        ? 'N/A'
                        : formatFractionPercent(candidate.evidenceCoverage)}
                    </dd>
                  </div>
                  <div>
                    <dt>Verify</dt>
                    <dd>{candidate.verificationPriority ?? 'N/A'}</dd>
                  </div>
                </dl>
                {candidate.nextVerification ? (
                  <JsonDetails
                    summary="Next verification plan"
                    value={candidate.nextVerification}
                  />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel decision-panel" aria-labelledby="record-heading">
        <p className="eyebrow">Human decision</p>
        <h2 id="record-heading">Record an immutable receipt</h2>
        <p className="section-intro">
          Your rationale is not generated or silently accepted. The receipt binds this need
          revision, context snapshot, candidate set, policy runs, and evidence IDs.
        </p>
        <form onSubmit={submitDecision}>
          <div className="form-grid two-column">
            <label>
              Outcome
              <select name="outcome" defaultValue="trial">
                <option value="trial">Trial</option>
                <option value="adopt">Adopt</option>
                <option value="defer">Defer</option>
                <option value="avoid">Avoid</option>
                <option value="no_decision">No decision</option>
              </select>
            </label>
            <label>
              Selected candidate <small>Leave empty only for no decision</small>
              <select
                name="selectedCandidateId"
                defaultValue={
                  item.candidates.find((candidate) => candidate.eligibility === 'eligible')?.id ??
                  ''
                }
              >
                <option value="">No candidate selected</option>
                {item.candidates.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>
                    {candidate.label} · {label(candidate.eligibility)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Rationale
            <textarea
              name="rationale"
              required
              maxLength={5000}
              rows={4}
              defaultValue="Run a bounded, reversible trial before considering adoption; preserve the hard privacy gates and measure task quality as well as context reduction."
            />
          </label>
          <label>
            Conditions <small>One per line</small>
            <textarea
              name="conditions"
              rows={3}
              defaultValue={
                'Do not send source code to a new remote service\nMeasure representative task quality and context usage\nReview results before any wider adoption'
              }
            />
          </label>
          <InputError id="decision-error">{decisionError}</InputError>
          <div className="form-actions">
            <button
              className="button"
              disabled={recordDecision.isPending || item.candidates.length === 0}
            >
              {recordDecision.isPending ? 'Recording…' : 'Record decision receipt'}
            </button>
          </div>
        </form>
        {item.decisions.length ? (
          <div className="prior-decisions">
            <h3>Previous receipts</h3>
            {item.decisions.map((decision) => (
              <Link key={decision.id} to={`/decisions/${decision.id}`}>
                {label(decision.outcome)} · {new Date(decision.decidedAt).toLocaleString()}
              </Link>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
