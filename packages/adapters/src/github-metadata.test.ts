import { describe, expect, it, vi } from 'vitest';
import { createGitHubMetadataAdapter } from './github-metadata.js';

describe('allowlisted GitHub metadata adapter', () => {
  it('uses inert identity-only metadata unless network access is explicitly enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createGitHubMetadataAdapter({ fetchImpl });
    await expect(adapter.fetch('Owner/Repository')).resolves.toMatchObject({
      kind: 'success',
      retrieval: 'offline_identity',
      metadata: { identityValue: 'owner/repository' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fixes the destination host and omits credentials and redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          full_name: 'Owner/Repository',
          html_url: 'https://github.com/Owner/Repository',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const adapter = createGitHubMetadataAdapter({ allowNetwork: true, fetchImpl });
    await expect(adapter.fetch('Owner/Repository')).resolves.toMatchObject({
      kind: 'success',
      retrieval: 'live_github_api',
    });
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/Owner/Repository');
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'GET' });
  });

  it('rejects oversized, non-JSON, malformed, and unsupported identities without throwing', async () => {
    const tooLarge = createGitHubMetadataAdapter({
      allowNetwork: true,
      maximumBytes: 5,
      fetchImpl: async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '99' },
        }),
    });
    await expect(tooLarge.fetch('owner/repository')).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'too_large',
    });

    const streamedTooLarge = createGitHubMetadataAdapter({
      allowNetwork: true,
      maximumBytes: 5,
      fetchImpl: async () =>
        new Response('{"larger":true}', {
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(streamedTooLarge.fetch('owner/repository')).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'too_large',
    });

    const wrongType = createGitHubMetadataAdapter({
      allowNetwork: true,
      fetchImpl: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    });
    await expect(wrongType.fetch('owner/repository')).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'unsupported_type',
    });

    const malformed = createGitHubMetadataAdapter({
      allowNetwork: true,
      fetchImpl: async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    });
    await expect(malformed.fetch('owner/repository')).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'parse',
    });
    await expect(malformed.fetch('owner/repository/extra')).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'parse',
    });
  });

  it('classifies bounded retry and terminal HTTP outcomes', async () => {
    const responseAdapter = (status: number) =>
      createGitHubMetadataAdapter({
        allowNetwork: true,
        fetchImpl: async () => new Response('', { status }),
      });
    await expect(responseAdapter(429).fetch('owner/repository')).resolves.toEqual({
      kind: 'transient_failure',
      code: 'rate_limited',
    });
    await expect(responseAdapter(503).fetch('owner/repository')).resolves.toEqual({
      kind: 'transient_failure',
      code: 'upstream',
    });
    await expect(responseAdapter(404).fetch('owner/repository')).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'not_found',
    });
  });
});
