import { hashCanonical } from '../../domain/src/index.js';

export type MetadataAdapterResult =
  | {
      kind: 'success';
      metadata: Record<string, unknown>;
      digest: string;
      retrieval: 'offline_identity' | 'live_github_api';
    }
  | { kind: 'transient_failure'; code: 'timeout' | 'rate_limited' | 'upstream' }
  | { kind: 'terminal_failure'; code: 'not_found' | 'unsupported_type' | 'too_large' | 'parse' };

export interface GitHubMetadataAdapter {
  readonly key: 'github-metadata';
  readonly version: 'github-metadata-v1';
  fetch(repositoryIdentity: string): Promise<MetadataAdapterResult>;
}

export interface GitHubMetadataAdapterOptions {
  allowNetwork?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maximumBytes?: number;
}

function parseIdentity(identity: string): { owner: string; repository: string } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(identity);
  if (!match) return null;
  return { owner: match[1]!, repository: match[2]! };
}

export function createGitHubMetadataAdapter(
  options: GitHubMetadataAdapterOptions = {},
): GitHubMetadataAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const maximumBytes = options.maximumBytes ?? 256_000;
  return {
    key: 'github-metadata',
    version: 'github-metadata-v1',
    async fetch(repositoryIdentity): Promise<MetadataAdapterResult> {
      const parsed = parseIdentity(repositoryIdentity);
      if (!parsed) return { kind: 'terminal_failure', code: 'parse' };
      if (!options.allowNetwork) {
        const metadata = {
          identityScheme: 'github_repository',
          identityValue: `${parsed.owner.toLowerCase()}/${parsed.repository.toLowerCase()}`,
          reviewState: 'identity_only_network_disabled',
        };
        return {
          kind: 'success',
          metadata,
          digest: hashCanonical(metadata),
          retrieval: 'offline_identity',
        };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // The destination host is fixed here; user input only populates encoded path segments.
        const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'maestro-ai-local-v0',
          },
          signal: controller.signal,
        });
        if (response.status === 404) return { kind: 'terminal_failure', code: 'not_found' };
        if (response.status === 429 || response.status >= 500) {
          return {
            kind: 'transient_failure',
            code: response.status === 429 ? 'rate_limited' : 'upstream',
          };
        }
        if (!response.ok) return { kind: 'terminal_failure', code: 'unsupported_type' };
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) {
          return { kind: 'terminal_failure', code: 'unsupported_type' };
        }
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (declaredLength > maximumBytes) return { kind: 'terminal_failure', code: 'too_large' };
        const body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
          return { kind: 'terminal_failure', code: 'too_large' };
        }
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          return { kind: 'terminal_failure', code: 'parse' };
        }
        if (!raw || typeof raw !== 'object') return { kind: 'terminal_failure', code: 'parse' };
        const record = raw as Record<string, unknown>;
        const fullName =
          typeof record.full_name === 'string' ? record.full_name : repositoryIdentity;
        const metadata = {
          identityScheme: 'github_repository',
          identityValue: fullName.toLowerCase(),
          canonicalUrl: typeof record.html_url === 'string' ? record.html_url : undefined,
          description: typeof record.description === 'string' ? record.description : undefined,
          archived: typeof record.archived === 'boolean' ? record.archived : undefined,
          defaultBranch:
            typeof record.default_branch === 'string' ? record.default_branch : undefined,
          license:
            record.license && typeof record.license === 'object'
              ? (record.license as Record<string, unknown>).spdx_id
              : undefined,
        };
        return {
          kind: 'success',
          metadata,
          digest: hashCanonical(metadata),
          retrieval: 'live_github_api',
        };
      } catch (error) {
        return {
          kind: 'transient_failure',
          code: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'upstream',
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
