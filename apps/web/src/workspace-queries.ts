import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import type { Project } from './types.js';

export interface WorkspaceSummary {
  id: string;
  boundary: string;
  modelRequired: boolean;
  executionAvailable: boolean;
}

export function useWorkspaceProjects() {
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<WorkspaceSummary>('/api/v1/workspace'),
  });
  const projects = useQuery({
    queryKey: ['projects', workspace.data?.id],
    enabled: Boolean(workspace.data?.id),
    queryFn: () => api<{ items: Project[] }>(`/api/v1/workspaces/${workspace.data!.id}/projects`),
  });
  return { workspace, projects };
}
