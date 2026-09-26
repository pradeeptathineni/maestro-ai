import type { Pool } from 'pg';
import type { TaskList } from 'graphile-worker';
import {
  createGitHubMetadataAdapter,
  type GitHubMetadataAdapter,
} from '../../../packages/adapters/src/index.js';
import { processIntakeMetadata } from '../../../packages/db/src/index.js';

interface IntakeTaskPayload {
  intakeId: string;
  workspaceId: string;
}

function isIntakePayload(value: unknown): value is IntakeTaskPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.intakeId === 'string' && typeof record.workspaceId === 'string';
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
  };
}
