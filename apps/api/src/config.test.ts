import { afterEach, describe, expect, it } from 'vitest';
import { apiConfig } from './config.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('v0 API configuration boundary', () => {
  it('normalizes an explicit loopback web origin', () => {
    process.env.MAESTRO_WEB_ORIGIN = 'http://localhost:5173/';
    const config = apiConfig();
    expect(config.allowedOrigins).toContain('http://localhost:5173');
    expect(config.allowedHosts).not.toContain('localhost:5173');
  });

  it.each([
    'https://localhost:5173',
    'http://example.com:5173',
    'http://127.0.0.1:5173/path',
    'http://user:secret@127.0.0.1:5173',
  ])('rejects a non-loopback or non-origin web boundary: %s', (origin) => {
    process.env.MAESTRO_WEB_ORIGIN = origin;
    expect(() => apiConfig()).toThrow(/loopback HTTP origin/);
  });
});
