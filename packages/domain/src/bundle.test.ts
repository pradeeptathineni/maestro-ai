import { describe, expect, it } from 'vitest';
import { createVerificationBundle, verifyVerificationBundle } from './bundle.js';

describe('portable decision-input bundles', () => {
  it('distinguishes complete and intentionally partial bundles', () => {
    const complete = createVerificationBundle({
      exportedAt: '2026-09-29T00:00:00.000Z',
      sections: { result: { id: 'one', signal: 42 }, evidence: [{ id: 'evidence' }] },
    });
    expect(verifyVerificationBundle(complete)).toMatchObject({
      status: 'complete',
      valid: true,
    });
    const partial = createVerificationBundle({
      exportedAt: '2026-09-29T00:00:00.000Z',
      sections: { result: { id: 'one' } },
      omissions: [{ section: 'query', reason: 'Private query excluded.' }],
    });
    expect(verifyVerificationBundle(partial)).toMatchObject({
      status: 'partial',
      valid: true,
    });
  });

  it('detects a one-byte relevant mutation without reconstructing omissions', () => {
    const bundle = createVerificationBundle({
      exportedAt: '2026-09-29T00:00:00.000Z',
      sections: { result: { signal: 42 } },
      omissions: [{ section: 'query', reason: 'Private query excluded.' }],
    });
    const tampered = structuredClone(bundle);
    (tampered.sections.result as { signal: number }).signal = 43;
    expect(verifyVerificationBundle(tampered)).toMatchObject({
      status: 'tampered',
      valid: false,
      mismatches: expect.arrayContaining(['section:result']),
    });
    expect(tampered.sections).not.toHaveProperty('query');
  });
});
