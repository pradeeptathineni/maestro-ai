import type { Pool } from 'pg';
import type { TaskList } from 'graphile-worker';
import {
  createGitHubMetadataAdapter,
  type GitHubMetadataAdapter,
} from '../../../packages/adapters/src/index.js';
import {
  processDiscoveryOperation,
  processIntakeMetadata,
  processResearchRun,
  processSemanticInterpretation,
  processWatchRefresh,
} from '../../../packages/db/src/index.js';

interface IntakeTaskPayload {
  intakeId: string;
  workspaceId: string;
}

interface DiscoveryTaskPayload {
  operationId: string;
  workspaceId: string;
}

interface WatchTaskPayload {
  watchId: string;
  workspaceId: string;
}

interface ResearchTaskPayload {
  researchRunId: string;
  workspaceId: string;
}

function isIntakePayload(value: unknown): value is IntakeTaskPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.intakeId === 'string' && typeof record.workspaceId === 'string';
}

function isDiscoveryPayload(value: unknown): value is DiscoveryTaskPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.operationId === 'string' && typeof record.workspaceId === 'string';
}

function isWatchPayload(value: unknown): value is WatchTaskPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.watchId === 'string' && typeof record.workspaceId === 'string';
}

function isResearchPayload(value: unknown): value is ResearchTaskPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.researchRunId === 'string' && typeof record.workspaceId === 'string';
}

export function createTaskList(
  pool: Pool,
  adapter: GitHubMetadataAdapter = createGitHubMetadataAdapter({
    allowNetwork: process.env.MAESTRO_ALLOW_NETWORK_FETCH === 'true',
  }),
): TaskList {
  return {
    consider_url_metadata_v1: async (payload, helpers) => {
      if (!isIntakePayload(payload)) throw new Error('invalid_intake_job_payload');
      await processIntakeMetadata(pool, payload.intakeId, adapter, helpers.job.id);
    },
    discovery_retrieve_v1: async (payload) => {
      if (!isDiscoveryPayload(payload)) throw new Error('invalid_discovery_job_payload');
      await processDiscoveryOperation(pool, payload);
    },
    // Compatibility aliases preserve already-durable Phase 06 outbox rows.
    phase06_discovery_v1: async (payload) => {
      if (!isDiscoveryPayload(payload)) throw new Error('invalid_discovery_job_payload');
      await processDiscoveryOperation(pool, payload);
    },
    phase06_semantic_v1: async (payload) => {
      if (!isDiscoveryPayload(payload)) throw new Error('invalid_semantic_job_payload');
      await processSemanticInterpretation(pool, payload);
    },
    research_run_v1: async (payload) => {
      if (!isResearchPayload(payload)) throw new Error('invalid_research_job_payload');
      await processResearchRun(pool, payload);
    },
    refresh_watch_v2: async (payload) => {
      if (!isWatchPayload(payload)) throw new Error('invalid_watch_job_payload');
      await processWatchRefresh(pool, payload, adapter);
    },
    phase06_refresh_watch_v1: async (payload) => {
      if (!isWatchPayload(payload)) throw new Error('invalid_watch_job_payload');
      await processWatchRefresh(pool, payload, adapter);
    },
  };
}
