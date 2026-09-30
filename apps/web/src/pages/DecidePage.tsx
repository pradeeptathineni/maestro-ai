import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, formString } from '../api.js';
import type { NeedSummary } from '../types.js';
import { Empty, ErrorPanel, InputError, Loading, PageHeader, StateBadge } from '../ui.js';
import { useWorkspaceProjects } from '../workspace-queries.js';

interface NeedCreateResult {
  id: string;
}

export function DecidePage() {
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projects } = useWorkspaceProjects();
  const needs = useQuery({
    queryKey: ['needs'],
    queryFn: () => api<{ items: NeedSummary[] }>('/api/v1/needs'),
  });
  const createNeed = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<NeedCreateResult>('/api/v1/needs', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['needs'] });
      void navigate(`/decide/${created.id}`);
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : 'Could not create need.'),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    const data = new FormData(event.currentTarget);
    const projectId = formString(data, 'projectId');
    if (!projectId) {
      setFormError('Select a project.');
      return;
    }
    const hardLabels = formString(data, 'hardConstraints')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    const preferenceLabels = formString(data, 'preferences')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!hardLabels.length) {
      setFormError('Add at least one explicit hard constraint.');
      return;
    }
    const constraintKey = (prefix: string, value: string, index: number) =>
      `${prefix}-${
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 70) || index + 1
      }`;
    createNeed.mutate({
      projectId,
      title: formString(data, 'title'),
      desiredOutcome: formString(data, 'desiredOutcome'),
      successCriteria: formString(data, 'successCriteria')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      requiredCapabilityKeys: formString(data, 'capabilities')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      constraints: [
        ...hardLabels.map((value, index) => ({
          key: constraintKey('gate', value, index),
          label: value,
          kind: 'hard_gate',
          unknownHandling: 'block',
        })),
        ...preferenceLabels.map((value, index) => ({
          key: constraintKey('preference', value, index),
          label: value,
          kind: 'preference',
          unknownHandling: 'penalize',
          weight: 1 / preferenceLabels.length,
        })),
      ],
    });
  }

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Private decision workspace"
        title="What are you deciding?"
        description="Start with a project need. Hard gates are evaluated before preferences, and no catalog score can override a failed constraint."
        action={
          <button className="button" type="button" onClick={() => setShowForm((open) => !open)}>
            {showForm ? 'Close form' : 'New decision'}
          </button>
        }
      />

      {showForm ? (
        <section className="panel form-panel" aria-labelledby="new-need-heading">
          <p className="eyebrow">Guided setup</p>
          <h2 id="new-need-heading">Define a need</h2>
          <p className="section-intro">
            State the project constraints that actually apply. Maestro does not silently assume an
            operating system, data boundary, or preferred workflow. Revisions remain immutable.
          </p>
          <form onSubmit={submit}>
            <div className="form-grid two-column">
              <label>
                Project
                <select name="projectId" required defaultValue={projects.data?.items[0]?.id ?? ''}>
                  <option value="" disabled>
                    Select a project
                  </option>
                  {projects.data?.items.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Decision title
                <input
                  name="title"
                  required
                  maxLength={240}
                  placeholder="Choose a private search capability"
                />
              </label>
            </div>
            <label>
              Desired outcome
              <textarea
                name="desiredOutcome"
                required
                maxLength={2000}
                rows={3}
                placeholder="Describe the outcome, without naming a preferred option."
              />
            </label>
            <label>
              Success criteria <small>One per line</small>
              <textarea
                name="successCriteria"
                required
                rows={3}
                placeholder={
                  'One measurable outcome per line\nOne safety or reversibility criterion per line'
                }
              />
            </label>
            <label>
              Required capability keys <small>Comma separated</small>
              <input name="capabilities" placeholder="local-search, retrieval, citation" />
            </label>
            <div className="form-grid two-column">
              <label>
                Hard constraints <small>One per line; unknown evidence blocks</small>
                <textarea
                  name="hardConstraints"
                  required
                  rows={4}
                  placeholder={
                    'Must work without public-network egress\nMust support the project runtime'
                  }
                />
              </label>
              <label>
                Preferences{' '}
                <small>One per line; weighted equally and never overrides a failed gate</small>
                <textarea
                  name="preferences"
                  rows={4}
                  placeholder={'Reversible setup\nLow maintenance burden'}
                />
              </label>
            </div>
            <div className="boundary-note">
              <strong>No hidden project assumptions</strong>
              <p>
                Only the constraints written above enter this need. Inspect and revise them before
                recording a decision.
              </p>
            </div>
            <InputError id="need-form-error">{formError}</InputError>
            <div className="form-actions">
              <button className="button" disabled={createNeed.isPending}>
                {createNeed.isPending ? 'Creating…' : 'Create need and compare'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {needs.isPending ? <Loading message="Loading active decisions…" /> : null}
      {needs.isError ? <ErrorPanel error={needs.error} /> : null}
      {needs.data ? (
        <>
          <section aria-labelledby="attention-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Needs attention</p>
                <h2 id="attention-heading">Blocking unknowns and next actions</h2>
              </div>
            </div>
            {needs.data.items.filter((need) => need.blockedCount > 0).length ? (
              <div className="attention-list">
                {needs.data.items
                  .filter((need) => need.blockedCount > 0)
                  .map((need) => (
                    <article key={need.id}>
                      <StateBadge state="unknown_blocked" />
                      <div>
                        <h3>
                          <Link to={`/decide/${need.id}`}>{need.title}</Link>
                        </h3>
                        <p>
                          {need.blockedCount} candidate{need.blockedCount === 1 ? '' : 's'} blocked
                          by unknown hard-gate evidence.
                        </p>
                      </div>
                      <Link className="text-link" to={`/decide/${need.id}`}>
                        Review comparison →
                      </Link>
                    </article>
                  ))}
              </div>
            ) : (
              <Empty title="No blocking unknowns">
                Active comparisons have no candidate blocked by unknown hard gates.
              </Empty>
            )}
          </section>

          <section aria-labelledby="active-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Active decisions</p>
                <h2 id="active-heading">Resume a comparison</h2>
              </div>
              <Link className="text-link" to="/explore">
                Search technologies →
              </Link>
            </div>
            {needs.data.items.length === 0 ? (
              <Empty title="No active decision needs">
                Create a need to compare catalog candidates against private project constraints.
              </Empty>
            ) : (
              <div className="decision-grid">
                {needs.data.items.map((need) => (
                  <article className="decision-card" key={need.id}>
                    <p className="eyebrow">
                      {need.projectName} · revision {need.revision}
                    </p>
                    <h3>
                      <Link to={`/decide/${need.id}`}>{need.title}</Link>
                    </h3>
                    <p>{need.desiredOutcome}</p>
                    <dl className="compact-metrics">
                      <div>
                        <dt>Candidates</dt>
                        <dd>{need.candidateCount}</dd>
                      </div>
                      <div>
                        <dt>Eligible</dt>
                        <dd>{need.eligibleCount}</dd>
                      </div>
                      <div>
                        <dt>Blocked</dt>
                        <dd>{need.blockedCount}</dd>
                      </div>
                    </dl>
                    <Link className="button secondary" to={`/decide/${need.id}`}>
                      Open comparison
                    </Link>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
