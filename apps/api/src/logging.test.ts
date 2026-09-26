import { describe, expect, it } from 'vitest';
import { redactForLog } from './logging.js';

describe('safe structured logging', () => {
  it('redacts secrets, private notes, prompts, and nested credential material', () => {
    expect(
      redactForLog({
        request: { authorization: 'Bearer secret', cookie: 'session=x' },
        note: 'private project detail',
        nested: { apiToken: 'token', prompt: 'instructions', safeCode: 'timeout' },
      }),
    ).toEqual({
      request: { authorization: '[REDACTED]', cookie: '[REDACTED]' },
      note: '[REDACTED]',
      nested: { apiToken: '[REDACTED]', prompt: '[REDACTED]', safeCode: 'timeout' },
    });
  });
});
