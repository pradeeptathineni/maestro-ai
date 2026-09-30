import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formString, formatDate, label } from '../api.js';
import type { Project } from '../types.js';
import {
  Badge,
  DefinitionList,
  ErrorPanel,
  InputError,
  Loading,
  PageHeader,
  StateBadge,
} from '../ui.js';
import { useWorkspaceProjects } from '../workspace-queries.js';

interface WatchSummary {
  id: string;
  providerName: string | null;
  sourceUrl: string | null;
  cadence: string;
  priority: number;
  state: 'active' | 'paused';
  lastCheckedAt: string | null;
  lastSucceededAt: string | null;
  nextDueAt: string | null;
  pendingChangeCount: number;
}

interface MaterialChange {
  id: string;
  providerName: string | null;
  predicate: string;
  applicabilityScope: string;
  reason: string;
  affectedResultSetId: string | null;
  affectedDecisionId: string | null;
  createdAt: string;
  disposition: string | null;
}

interface IntegrationStatus {
  adapterKey: string;
  adapterVersion: string;
  sourceClass: string;
  enabled: boolean;
  baseUrl: string | null;
  modelIdentifier: string | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  dataDisclosureScope: string;
  rightsNotes: string;
  dailyCallLimit: number;
  reservedCallsToday: number;
  status: string;
  revision: number;
}

interface KnowledgeCoverage {
  scope: { label: string; statement: string; generatedAt: string };
  knowledge: {
    total: number;
    reviewed: number;
    proposed: number;
    lead: number;
    stale: number;
    withdrawn: number;
  };
  domains: Array<{
    key: string;
    label: string;
    total: number;
    reviewed: number;
    proposed: number;
    stale: number;
  }>;
  sourceClasses: Array<{
    sourceType: string;
    knowledgeItems: number;
    sources: number;
    lastObservedAt: string | null;
  }>;
  depth: Array<{ depth: string; items: number }>;
  importantClaims: {
    definition: string;
    total: number;
    reviewed: number;
    stale: number;
    reviewDueSoon: number;
    withoutBoundEvidence: number;
  };
  sourceHealth: Array<{
    adapterKey: string;
    lastSuccessfulAt: string | null;
    lastFailedAt: string | null;
    failures: number;
  }>;
  discovery: {
    operationsToday: number;
    exploreCallsToday: number;
    deepenCallsToday: number;
    successfulCallsToday: number;
    failedCallsToday: number;
    candidatesToday: number;
    exploreCandidatesToday: number;
    admittedToday: number;
    unjudgedCandidates: number;
    actualExploreShare: number | null;
    explorationYield: number | null;
    admissionYield: number | null;
    allocationPolicy: {
      version: string;
      dailyExternalCallLimit: number;
      perSearchCallLimitPerSource: number;
    };
  };
  queryGaps: {
    sessions: number;
    emptySessions: number;
    outsideCoverageSessions: number;
    repeatedEmptyAreas: Array<{ capabilityGroup: string; count: number }>;
  };
}

function lines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function contextFromForm(data: FormData): Record<string, unknown> {
  const optional = (key: string) => formString(data, key).trim();
  return {
    goal: formString(data, 'goal').trim(),
    technologies: lines(formString(data, 'technologies')),
    platforms: lines(formString(data, 'platforms')),
    ...(optional('dataSensitivity') ? { dataSensitivity: optional('dataSensitivity') } : {}),
    allowedEgress: lines(formString(data, 'allowedEgress')),
    allowedEffects: lines(formString(data, 'allowedEffects')),
    ...(optional('budget') ? { budget: optional('budget') } : {}),
    preferences: lines(formString(data, 'preferences')),
    provenance: 'human_declared',
  };
}

function ContextFields({ context = {} }: { context?: Record<string, unknown> }) {
  const arrayValue = (key: string) =>
    Array.isArray(context[key]) ? (context[key] as string[]).join('\n') : '';
  const textValue = (key: string) => (typeof context[key] === 'string' ? String(context[key]) : '');
  return (
    <>
      <label>
        Goal
        <textarea
          name="goal"
          required
          maxLength={2000}
          rows={3}
          defaultValue={textValue('goal')}
          placeholder="What should this project accomplish?"
        />
      </label>
      <div className="form-grid two-column">
        <label>
          Technologies <small>One per line</small>
          <textarea name="technologies" rows={3} defaultValue={arrayValue('technologies')} />
        </label>
        <label>
          Platforms <small>One per line</small>
          <textarea name="platforms" rows={3} defaultValue={arrayValue('platforms')} />
        </label>
        <label>
          Data sensitivity
          <textarea
            name="dataSensitivity"
            rows={2}
            defaultValue={textValue('dataSensitivity')}
            placeholder="What may or may not leave the workspace?"
          />
        </label>
        <label>
          Budget
          <textarea
            name="budget"
            rows={2}
            defaultValue={textValue('budget')}
            placeholder="Time, money, or operating limits"
          />
        </label>
        <label>
          Allowed egress <small>One destination or rule per line</small>
          <textarea name="allowedEgress" rows={3} defaultValue={arrayValue('allowedEgress')} />
        </label>
        <label>
          Allowed effects <small>One permitted effect per line</small>
          <textarea name="allowedEffects" rows={3} defaultValue={arrayValue('allowedEffects')} />
        </label>
      </div>
      <label>
        Preferences <small>One per line</small>
        <textarea name="preferences" rows={3} defaultValue={arrayValue('preferences')} />
      </label>
    </>
  );
}

export function WorkspacePage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const { workspace, projects } = useWorkspaceProjects();
  const watches = useQuery({
    queryKey: ['watches'],
    queryFn: () => api<{ items: WatchSummary[] }>('/api/v1/watches'),
  });
  const changes = useQuery({
    queryKey: ['material-changes'],
    queryFn: () => api<{ items: MaterialChange[] }>('/api/v1/changes'),
  });
  const coverage = useQuery({
    queryKey: ['knowledge-coverage'],
    queryFn: () => api<KnowledgeCoverage>('/api/v1/knowledge/coverage'),
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<{ items: IntegrationStatus[] }>('/api/v1/integrations'),
  });
  const createProject = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Project>(`/api/v1/workspaces/${workspace.data!.id}/projects`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      setShowCreate(false);
      setNotice('Project and immutable context revision 1 created.');
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : 'Could not create project.'),
  });
  const reviseContext = useMutation({
    mutationFn: ({ project, context }: { project: Project; context: Record<string, unknown> }) =>
      api(`/api/v1/projects/${project.id}/contexts`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: project.contextRevision, context }),
      }),
    onSuccess: async () => {
      setEditingId(null);
      setNotice('A new immutable project-context revision was created.');
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : 'Could not revise context.'),
  });
  const updateWatch = useMutation({
    mutationFn: ({ id, state }: { id: string; state: 'active' | 'paused' }) =>
      api(`/api/v1/watches/${id}/state`, {
        method: 'PUT',
        body: JSON.stringify({ state }),
      }),
    onSuccess: async () => {
      setNotice('Watch state updated.');
      await queryClient.invalidateQueries({ queryKey: ['watches'] });
    },
  });
  const reviewChange = useMutation({
    mutationFn: ({ id, disposition }: { id: string; disposition: string }) =>
      api(`/api/v1/changes/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ disposition }),
      }),
    onSuccess: async () => {
      setNotice('Change disposition recorded without rewriting the affected snapshot or decision.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['watches'] }),
        queryClient.invalidateQueries({ queryKey: ['material-changes'] }),
      ]);
    },
  });
  const configureIntegration = useMutation({
    mutationFn: ({ adapterKey, body }: { adapterKey: string; body: Record<string, unknown> }) =>
      api(`/api/v1/integrations/${adapterKey}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      setNotice(
        'Integration configuration saved. Enabled source adapters run with the next search.',
      );
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  function submitProject(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError('');
    const data = new FormData(event.currentTarget);
    createProject.mutate({ name: formString(data, 'name'), context: contextFromForm(data) });
  }

  function submitRevision(event: FormEvent<HTMLFormElement>, project: Project): void {
    event.preventDefault();
    setFormError('');
    reviseContext.mutate({ project, context: contextFromForm(new FormData(event.currentTarget)) });
  }

  function submitIntegration(
    event: FormEvent<HTMLFormElement>,
    integration: IntegrationStatus,
  ): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const baseUrl = formString(data, 'baseUrl').trim();
    const modelIdentifier = formString(data, 'modelIdentifier').trim();
    configureIntegration.mutate({
      adapterKey: integration.adapterKey,
      body: {
        enabled: true,
        ...(baseUrl ? { baseUrl } : {}),
        ...(modelIdentifier ? { modelIdentifier } : {}),
        ...(integration.adapterKey === 'local_semantic'
          ? {
              maxInputTokens: Number(formString(data, 'maxInputTokens')),
              maxOutputTokens: Number(formString(data, 'maxOutputTokens')),
            }
          : {}),
      },
    });
  }

  function disableIntegration(integration: IntegrationStatus): void {
    configureIntegration.mutate({
      adapterKey: integration.adapterKey,
      body: {
        enabled: false,
        ...(integration.baseUrl ? { baseUrl: integration.baseUrl } : {}),
        ...(integration.modelIdentifier ? { modelIdentifier: integration.modelIdentifier } : {}),
        ...(integration.adapterKey === 'local_semantic'
          ? {
              maxInputTokens: integration.maxInputTokens,
              maxOutputTokens: integration.maxOutputTokens,
            }
          : {}),
      },
    });
  }
  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Local policy boundary"
        title="Workspace"
        description="Private project context stays separate from the public catalog and is bound by hash into decision receipts."
        action={
          <button
            className="button"
            type="button"
            onClick={() => setShowCreate((current) => !current)}
          >
            {showCreate ? 'Close form' : 'New project'}
          </button>
        }
      />
      {notice ? (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      {showCreate ? (
        <section className="panel form-panel" aria-labelledby="new-project-heading">
          <p className="eyebrow">Human-authored boundary</p>
          <h2 id="new-project-heading">Create a project context</h2>
          <p className="section-intro">
            Only information entered here becomes project context. Blank fields stay blank; Maestro
            does not infer private constraints.
          </p>
          <form onSubmit={submitProject}>
            <label>
              Project name
              <input name="name" required maxLength={240} />
            </label>
            <ContextFields />
            <InputError id="project-form-error">{formError}</InputError>
            <div className="form-actions">
              <button className="button" disabled={createProject.isPending}>
                {createProject.isPending ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {workspace.isPending ||
      projects.isPending ||
      watches.isPending ||
      changes.isPending ||
      coverage.isPending ||
      integrations.isPending ? (
        <Loading />
      ) : null}
      {workspace.isError ? <ErrorPanel error={workspace.error} /> : null}
      {projects.isError ? <ErrorPanel error={projects.error} /> : null}
      {watches.isError ? <ErrorPanel error={watches.error} /> : null}
      {changes.isError ? <ErrorPanel error={changes.error} /> : null}
      {coverage.isError ? <ErrorPanel error={coverage.error} /> : null}
      {integrations.isError ? <ErrorPanel error={integrations.error} /> : null}
      {configureIntegration.isError ? <ErrorPanel error={configureIntegration.error} /> : null}
      {workspace.data ? (
        <section className="panel">
          <h2>Boundary</h2>
          <DefinitionList
            items={[
              ['Workspace ID', <code>{workspace.data.id}</code>],
              ['Evidence boundary', label(workspace.data.boundary)],
              ['Model required', workspace.data.modelRequired ? 'Yes' : 'No'],
              [
                'Candidate execution',
                workspace.data.executionAvailable ? 'Available' : 'Unavailable in v0',
              ],
            ]}
          />
          <div className="boundary-note">
            <strong>Current scope</strong>
            <p>
              Maestro owns evidence, selection policy, authority semantics, and receipts. Execution
              planes remain future replaceable adapters; no execution, install, model-routing,
              sandbox, CI/CD, or orchestration controls exist here.
            </p>
          </div>
        </section>
      ) : null}
      {integrations.data ? (
        <section
          id="integrations"
          className="integration-settings"
          aria-labelledby="integrations-heading"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Search connections</p>
              <h2 id="integrations-heading">Sources and local assistance</h2>
            </div>
            <p className="hint">
              Enabled source adapters receive the public search text when you press Search. Local
              semantic assistance remains separately configured and does not determine signals.
            </p>
          </div>
          <div className="integration-grid">
            {integrations.data.items.map((integration) => {
              const configurable = ['searxng', 'local_semantic'].includes(integration.adapterKey);
              return (
                <article className="panel integration-card" key={integration.adapterKey}>
                  <div className="card-topline">
                    <Badge>{label(integration.sourceClass)}</Badge>
                    <StateBadge state={integration.enabled ? 'enabled' : 'disabled'} />
                  </div>
                  <h3>{label(integration.adapterKey)}</h3>
                  <p>{integration.dataDisclosureScope}</p>
                  <p className="hint">{integration.rightsNotes}</p>
                  <DefinitionList
                    items={[
                      ['Adapter', integration.adapterVersion],
                      [
                        'Requests today',
                        `${integration.reservedCallsToday} used or reserved · limit ${integration.dailyCallLimit}`,
                      ],
                      ['Last status', label(integration.status)],
                    ]}
                  />
                  {configurable ? (
                    <form
                      className="integration-form"
                      key={`${integration.adapterKey}:${integration.revision}`}
                      onSubmit={(event) => submitIntegration(event, integration)}
                    >
                      <label>
                        Loopback endpoint
                        <input
                          name="baseUrl"
                          type="url"
                          required
                          defaultValue={integration.baseUrl ?? ''}
                          placeholder={
                            integration.adapterKey === 'searxng'
                              ? 'http://127.0.0.1:8080'
                              : 'http://127.0.0.1:11434/v1'
                          }
                        />
                      </label>
                      {integration.adapterKey === 'local_semantic' ? (
                        <>
                          <label>
                            Model identifier
                            <input
                              name="modelIdentifier"
                              required
                              defaultValue={integration.modelIdentifier ?? ''}
                              placeholder="Exact local server model ID"
                            />
                          </label>
                          <div className="form-grid two-column">
                            <label>
                              Reported input-token limit
                              <input
                                name="maxInputTokens"
                                type="number"
                                min={256}
                                max={32768}
                                defaultValue={integration.maxInputTokens}
                              />
                              <small>
                                Checked against endpoint usage when reported; otherwise recorded as
                                unmeasured.
                              </small>
                            </label>
                            <label>
                              Output-token ceiling
                              <input
                                name="maxOutputTokens"
                                type="number"
                                min={64}
                                max={4096}
                                defaultValue={integration.maxOutputTokens}
                              />
                            </label>
                          </div>
                        </>
                      ) : null}
                      <div className="button-group">
                        <button
                          className="button compact"
                          disabled={configureIntegration.isPending}
                        >
                          Save and enable
                        </button>
                        {integration.enabled ? (
                          <button
                            className="button secondary compact"
                            disabled={configureIntegration.isPending}
                            onClick={() => disableIntegration(integration)}
                            type="button"
                          >
                            Disable
                          </button>
                        ) : null}
                      </div>
                    </form>
                  ) : (
                    <button
                      className="button secondary compact"
                      disabled={configureIntegration.isPending}
                      onClick={() =>
                        integration.enabled
                          ? disableIntegration(integration)
                          : configureIntegration.mutate({
                              adapterKey: integration.adapterKey,
                              body: { enabled: true },
                            })
                      }
                      type="button"
                    >
                      {integration.enabled ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      {coverage.data ? (
        <section className="coverage-panel" aria-labelledby="coverage-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Corpus operations</p>
              <h2 id="coverage-heading">Indexed evidence and source coverage</h2>
            </div>
            <p className="hint">{coverage.data.scope.statement}</p>
          </div>
          <div className="coverage-ledger">
            <div className="coverage-lead">
              <span className="coverage-number">
                {coverage.data.knowledge.reviewed}
                <small>/{coverage.data.knowledge.total}</small>
              </span>
              <strong>items reviewed</strong>
              <p>
                {coverage.data.knowledge.proposed} proposed · {coverage.data.knowledge.stale} stale
                · {coverage.data.discovery.unjudgedCandidates} discovery leads awaiting judgment
              </p>
            </div>
            <div>
              <h3>Evidence depth</h3>
              <ul className="coverage-list">
                {coverage.data.depth.map((item) => (
                  <li key={item.depth}>
                    <span>{label(item.depth)}</span>
                    <strong>{item.items}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Decision-relevant claims</h3>
              <ul className="coverage-list">
                <li>
                  <span>On reviewed items</span>
                  <strong>{coverage.data.importantClaims.reviewed}</strong>
                </li>
                <li>
                  <span>Stale</span>
                  <strong>{coverage.data.importantClaims.stale}</strong>
                </li>
                <li>
                  <span>Due in 30 days</span>
                  <strong>{coverage.data.importantClaims.reviewDueSoon}</strong>
                </li>
                <li>
                  <span>Without bound evidence</span>
                  <strong>{coverage.data.importantClaims.withoutBoundEvidence}</strong>
                </li>
              </ul>
            </div>
          </div>
          <div className="coverage-detail-grid">
            <div>
              <h3>Tracked domains</h3>
              <div className="coverage-tags">
                {coverage.data.domains.map((domain) => (
                  <span key={domain.key}>
                    {domain.label} <b>{domain.total}</b>
                  </span>
                ))}
              </div>
            </div>
            <div>
              <h3>Source classes</h3>
              <div className="coverage-tags">
                {coverage.data.sourceClasses.map((source) => (
                  <span key={source.sourceType}>
                    {label(source.sourceType)} <b>{source.sources}</b>
                  </span>
                ))}
              </div>
            </div>
            <div>
              <h3>Search gaps</h3>
              <p>
                {coverage.data.queryGaps.emptySessions} empty of {coverage.data.queryGaps.sessions}{' '}
                retained sessions · {coverage.data.queryGaps.outsideCoverageSessions} explicitly
                outside coverage
              </p>
              {coverage.data.queryGaps.repeatedEmptyAreas.length ? (
                <ul className="coverage-list compact-list">
                  {coverage.data.queryGaps.repeatedEmptyAreas.map((area) => (
                    <li key={area.capabilityGroup}>
                      <span>{area.capabilityGroup}</span>
                      <strong>{area.count}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">No capability area has repeated empty results yet.</p>
              )}
            </div>
            <div>
              <h3>Source requests today</h3>
              <p>
                {coverage.data.discovery.successfulCallsToday} completed ·{' '}
                {coverage.data.discovery.failedCallsToday} failed ·{' '}
                {coverage.data.discovery.candidatesToday} leads saved
              </p>
              <p className="hint">
                Source-call limits prevent unbounded network use. A saved lead remains preliminary
                until its evidence is reviewed.
              </p>
            </div>
          </div>
        </section>
      ) : null}
      {projects.data ? (
        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Stable projects</p>
              <h2>Projects</h2>
            </div>
          </div>
          <div className="decision-grid">
            {projects.data.items.map((project) => (
              <article className="decision-card" key={project.id}>
                <div className="card-topline">
                  <Badge>{label(project.lifecycleState)}</Badge>
                  <span>Context r{project.contextRevision}</span>
                </div>
                <h3>{project.name}</h3>
                <p>
                  Immutable snapshot <code>{project.snapshotHash.slice(0, 14)}…</code>
                </p>
                <DefinitionList
                  items={Object.entries(project.context)
                    .slice(0, 5)
                    .map(([key, value]) => [
                      label(key),
                      typeof value === 'string' ? value : JSON.stringify(value),
                    ])}
                />
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setFormError('');
                    setEditingId((current) => (current === project.id ? null : project.id));
                  }}
                >
                  {editingId === project.id ? 'Cancel revision' : 'Revise context'}
                </button>
                {editingId === project.id ? (
                  <form
                    className="context-revision-form"
                    key={`${project.id}:${project.contextRevision}`}
                    onSubmit={(event) => submitRevision(event, project)}
                  >
                    <p className="hint">
                      Creates revision {project.contextRevision + 1}; revision{' '}
                      {project.contextRevision} remains unchanged.
                    </p>
                    <ContextFields context={project.context} />
                    <InputError id={`context-error-${project.id}`}>{formError}</InputError>
                    <button className="button" disabled={reviseContext.isPending}>
                      {reviseContext.isPending ? 'Saving…' : 'Save new revision'}
                    </button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {watches.data ? (
        <section aria-labelledby="watches-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Bounded refresh</p>
              <h2 id="watches-heading">Change tracking</h2>
            </div>
            <p className="hint">
              Recurring checks use the existing worker, configured adapters, and shared daily
              budget.
            </p>
          </div>
          {watches.data.items.length ? (
            <div className="watch-list">
              {watches.data.items.map((watch) => (
                <article className="panel" key={watch.id}>
                  <div className="card-topline">
                    <Badge>{label(watch.cadence)}</Badge>
                    <StateBadge state={watch.state} />
                  </div>
                  <h3>{watch.providerName ?? 'Tracked subject'}</h3>
                  <p className="hint">{watch.sourceUrl ?? 'No refreshable source is bound yet.'}</p>
                  <DefinitionList
                    items={[
                      ['Last checked', formatDate(watch.lastCheckedAt)],
                      ['Last succeeded', formatDate(watch.lastSucceededAt)],
                      ['Next due', formatDate(watch.nextDueAt)],
                      ['Pending changes', watch.pendingChangeCount],
                    ]}
                  />
                  <button
                    className="button secondary compact"
                    disabled={updateWatch.isPending}
                    onClick={() =>
                      updateWatch.mutate({
                        id: watch.id,
                        state: watch.state === 'active' ? 'paused' : 'active',
                      })
                    }
                    type="button"
                  >
                    {watch.state === 'active' ? 'Pause watch' : 'Resume watch'}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="hint">
              No tracked items. Open a Search result and choose “Track material changes weekly.”
            </p>
          )}
        </section>
      ) : null}
      {changes.data?.items.length ? (
        <section aria-labelledby="changes-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Review queue</p>
              <h2 id="changes-heading">Material change notices</h2>
            </div>
          </div>
          <div className="change-list">
            {changes.data.items.map((change) => (
              <article className="panel" key={change.id}>
                <div className="card-topline">
                  <Badge>{label(change.predicate)}</Badge>
                  <StateBadge state={change.disposition ?? 'unreviewed'} />
                </div>
                <h3>{change.providerName ?? 'Tracked subject'}</h3>
                <p>{change.reason}</p>
                <small>
                  {change.applicabilityScope} · {formatDate(change.createdAt)}
                </small>
                {!change.disposition ? (
                  <div className="button-group">
                    <button
                      className="button secondary compact"
                      onClick={() =>
                        reviewChange.mutate({ id: change.id, disposition: 'reviewed' })
                      }
                      type="button"
                    >
                      Mark reviewed
                    </button>
                    <button
                      className="button secondary compact"
                      onClick={() => reviewChange.mutate({ id: change.id, disposition: 'requery' })}
                      type="button"
                    >
                      Requery later
                    </button>
                    <button
                      className="button secondary compact"
                      onClick={() =>
                        reviewChange.mutate({ id: change.id, disposition: 'reassess' })
                      }
                      type="button"
                    >
                      Reassess decision
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
