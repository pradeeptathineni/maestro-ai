import { hashCanonical, normalizeConsiderUrl } from '../../domain/src/index.js';
import {
  fetchFixedPublicResource,
  readBoundedResponse,
  validateExplicitLocalEndpoint,
  validateFixedPublicUrl,
} from './network-policy.js';

export interface DiscoveryLead {
  externalId: string;
  canonicalUri: string;
  title: string;
  summary: string;
  kindHint: string;
  payload: Record<string, unknown>;
  provenance: {
    adapter: string;
    adapterVersion: string;
    source: string;
    observedAt: string;
    reviewState: 'lead';
  };
}

export type DiscoveryResult =
  | {
      state: 'complete' | 'partial';
      leads: DiscoveryLead[];
      responseBytes: number;
      httpStatus: number;
      rateLimit: { remaining: number | null; resetAt: string | null; retryAfter: string | null };
    }
  | {
      state: 'failed';
      leads: [];
      responseBytes: number;
      httpStatus: number | null;
      errorCode: 'timeout' | 'rate_limited' | 'upstream' | 'invalid_response' | 'too_large';
    };

export interface DiscoveryAdapter {
  key: 'github' | 'mcp_registry' | 'searxng';
  version: string;
  search(query: string, limit?: number): Promise<DiscoveryResult>;
}

interface AdapterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maximumBytes?: number;
}

async function requestJson(
  url: URL,
  options: AdapterOptions & { headers?: HeadersInit },
): Promise<
  | {
      ok: true;
      value: unknown;
      bytes: number;
      status: number;
      headers: Headers;
    }
  | DiscoveryResult
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const defaultFetch = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
      ? fetch
      : fetchFixedPublicResource;
    const response = await (options.fetchImpl ?? defaultFetch)(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: options.headers,
      signal: controller.signal,
    });
    if (response.status === 429) {
      return {
        state: 'failed',
        leads: [],
        responseBytes: 0,
        httpStatus: 429,
        errorCode: 'rate_limited',
      };
    }
    if (!response.ok) {
      return {
        state: 'failed',
        leads: [],
        responseBytes: 0,
        httpStatus: response.status,
        errorCode: 'upstream',
      };
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      return {
        state: 'failed',
        leads: [],
        responseBytes: 0,
        httpStatus: response.status,
        errorCode: 'invalid_response',
      };
    }
    try {
      const body = await readBoundedResponse(response, options.maximumBytes ?? 524_288);
      return {
        ok: true,
        value: JSON.parse(body.text) as unknown,
        bytes: body.bytes,
        status: response.status,
        headers: response.headers,
      };
    } catch (error) {
      return {
        state: 'failed',
        leads: [],
        responseBytes: 0,
        httpStatus: response.status,
        errorCode: error instanceof RangeError ? 'too_large' : 'invalid_response',
      };
    }
  } catch (error) {
    return {
      state: 'failed',
      leads: [],
      responseBytes: 0,
      httpStatus: null,
      errorCode: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'upstream',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 10, 1), 20);
}

function cleanQuery(query: string): string {
  const clean = query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 300)
    throw new TypeError('Discovery query must be 1–300 characters.');
  return clean;
}

function normalizedPublicLeadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return normalizeConsiderUrl(value).normalizedUrl;
  } catch {
    return null;
  }
}

export function createGitHubDiscoveryAdapter(options: AdapterOptions = {}): DiscoveryAdapter {
  return {
    key: 'github',
    version: 'github-rest-v1',
    async search(query, limit) {
      const url = validateFixedPublicUrl('https://api.github.com/search/repositories', [
        'api.github.com',
      ]);
      url.searchParams.set('q', cleanQuery(query));
      url.searchParams.set('per_page', String(boundedLimit(limit)));
      const result = await requestJson(url, {
        ...options,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'maestro-ai-local-phase06',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!('ok' in result)) return result;
      const record = result.value as { items?: unknown[] };
      const observedAt = new Date().toISOString();
      const leads = (record.items ?? []).flatMap((item): DiscoveryLead[] => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        const canonicalUri = normalizedPublicLeadUrl(value.html_url);
        if (
          typeof value.id !== 'number' ||
          typeof value.full_name !== 'string' ||
          !canonicalUri ||
          new URL(canonicalUri).hostname !== 'github.com'
        ) {
          return [];
        }
        const payload = {
          githubId: value.id,
          fullName: value.full_name,
          description: typeof value.description === 'string' ? value.description : '',
          archived: value.archived === true,
          stars: typeof value.stargazers_count === 'number' ? value.stargazers_count : null,
          updatedAt: typeof value.updated_at === 'string' ? value.updated_at : null,
          license:
            value.license && typeof value.license === 'object'
              ? ((value.license as Record<string, unknown>).spdx_id ?? null)
              : null,
        };
        return [
          {
            externalId: String(value.id),
            canonicalUri,
            title: value.full_name,
            summary:
              typeof value.description === 'string'
                ? value.description
                : 'No description supplied.',
            kindHint: 'oss_project',
            payload,
            provenance: {
              adapter: 'github',
              adapterVersion: 'github-rest-v1',
              source: 'GitHub REST Search repositories',
              observedAt,
              reviewState: 'lead',
            },
          },
        ];
      });
      return {
        state: leads.length < (record.items?.length ?? 0) ? 'partial' : 'complete',
        leads,
        responseBytes: result.bytes,
        httpStatus: result.status,
        rateLimit: {
          remaining: Number.isFinite(Number(result.headers.get('x-ratelimit-remaining')))
            ? Number(result.headers.get('x-ratelimit-remaining'))
            : null,
          resetAt: result.headers.get('x-ratelimit-reset'),
          retryAfter: result.headers.get('retry-after'),
        },
      };
    },
  };
}

export function createMcpRegistryDiscoveryAdapter(options: AdapterOptions = {}): DiscoveryAdapter {
  return {
    key: 'mcp_registry',
    version: 'mcp-registry-v0.1',
    async search(query, limit) {
      const url = validateFixedPublicUrl('https://registry.modelcontextprotocol.io/v0.1/servers', [
        'registry.modelcontextprotocol.io',
      ]);
      url.searchParams.set('search', cleanQuery(query));
      url.searchParams.set('limit', String(boundedLimit(limit)));
      url.searchParams.set('version', 'latest');
      const result = await requestJson(url, options);
      if (!('ok' in result)) return result;
      const record = result.value as { servers?: unknown[] };
      const observedAt = new Date().toISOString();
      const leads = (record.servers ?? []).flatMap((entry): DiscoveryLead[] => {
        if (!entry || typeof entry !== 'object') return [];
        const envelope = entry as Record<string, unknown>;
        const server =
          envelope.server && typeof envelope.server === 'object'
            ? (envelope.server as Record<string, unknown>)
            : envelope;
        if (typeof server.name !== 'string') return [];
        const repository =
          server.repository && typeof server.repository === 'object'
            ? (server.repository as Record<string, unknown>)
            : null;
        const uri =
          normalizedPublicLeadUrl(repository?.url) ??
          `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(server.name)}`;
        const version = typeof server.version === 'string' ? server.version : 'latest';
        return [
          {
            externalId: `${server.name}@${version}`,
            canonicalUri: uri,
            title: server.name,
            summary:
              typeof server.description === 'string' ? server.description : 'Registry entry.',
            kindHint: 'mcp_server',
            payload: { ...server, registryEntryHash: hashCanonical(envelope) },
            provenance: {
              adapter: 'mcp_registry',
              adapterVersion: 'mcp-registry-v0.1',
              source: 'Official MCP Registry API',
              observedAt,
              reviewState: 'lead',
            },
          },
        ];
      });
      return {
        state: leads.length < (record.servers?.length ?? 0) ? 'partial' : 'complete',
        leads,
        responseBytes: result.bytes,
        httpStatus: result.status,
        rateLimit: {
          remaining: null,
          resetAt: null,
          retryAfter: result.headers.get('retry-after'),
        },
      };
    },
  };
}

export function createSearxngDiscoveryAdapter(
  baseUrl: string,
  options: AdapterOptions = {},
): DiscoveryAdapter {
  const endpoint = validateExplicitLocalEndpoint(baseUrl);
  return {
    key: 'searxng',
    version: 'searxng-json-v1',
    async search(query, limit) {
      const url = new URL('/search', endpoint);
      url.searchParams.set('q', cleanQuery(query));
      url.searchParams.set('format', 'json');
      const result = await requestJson(url, options);
      if (!('ok' in result)) return result;
      const record = result.value as { results?: unknown[] };
      const observedAt = new Date().toISOString();
      const leads = (record.results ?? [])
        .slice(0, boundedLimit(limit))
        .flatMap((entry): DiscoveryLead[] => {
          if (!entry || typeof entry !== 'object') return [];
          const value = entry as Record<string, unknown>;
          const canonicalUri = normalizedPublicLeadUrl(value.url);
          if (!canonicalUri || typeof value.title !== 'string') return [];
          return [
            {
              externalId: hashCanonical(canonicalUri),
              canonicalUri,
              title: value.title,
              summary: typeof value.content === 'string' ? value.content : 'Metasearch lead.',
              kindHint: 'other',
              payload: {
                engine: typeof value.engine === 'string' ? value.engine : null,
                publishedDate: value.publishedDate ?? null,
              },
              provenance: {
                adapter: 'searxng',
                adapterVersion: 'searxng-json-v1',
                source: endpoint.origin,
                observedAt,
                reviewState: 'lead',
              },
            },
          ];
        });
      return {
        state:
          leads.length < Math.min(record.results?.length ?? 0, boundedLimit(limit))
            ? 'partial'
            : 'complete',
        leads,
        responseBytes: result.bytes,
        httpStatus: result.status,
        rateLimit: {
          remaining: null,
          resetAt: null,
          retryAfter: result.headers.get('retry-after'),
        },
      };
    },
  };
}
