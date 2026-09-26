import { useQuery } from '@tanstack/react-query';
import { api, label } from '../api.js';
import type { Project } from '../types.js';
import { Badge, DefinitionList, ErrorPanel, Loading, PageHeader } from '../ui.js';

interface WorkspaceSummary {
  id: string;
  boundary: string;
  modelRequired: boolean;
  executionAvailable: boolean;
}

export function WorkspacePage() {
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<WorkspaceSummary>('/api/v1/workspace'),
  });
  const projects = useQuery({
    queryKey: ['projects', workspace.data?.id],
    enabled: Boolean(workspace.data?.id),
    queryFn: () => api<{ items: Project[] }>(`/api/v1/workspaces/${workspace.data!.id}/projects`),
  });
  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Local policy boundary"
        title="Workspace"
        description="Private project context stays separate from the public catalog and is bound by hash into decision receipts."
        action={<Badge tone="positive">No model key required</Badge>}
      />
      {workspace.isPending || projects.isPending ? <Loading /> : null}
      {workspace.isError ? <ErrorPanel error={workspace.error} /> : null}
      {projects.isError ? <ErrorPanel error={projects.error} /> : null}
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
            <strong>Deliberate v0 boundary</strong>
            <p>
              Maestro owns evidence, selection policy, authority semantics, and receipts. Execution
              planes remain future replaceable adapters; no execution, install, model-routing,
              sandbox, CI/CD, or orchestration controls exist here.
            </p>
          </div>
        </section>
      ) : null}
      {projects.data ? (
        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Stable projects</p>
              <h2>Project-context revisions</h2>
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
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
