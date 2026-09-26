import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical } from './canonical.js';
import { createDecisionReceipt, replayDecisionReceipt, validateCandidate } from './decision.js';
import { evaluateHardGates } from './gates.js';
import { normalizeConsiderUrl, UrlPolicyError } from './url.js';

describe('canonical values and receipts', () => {
  it('produces byte-stable JSON independent of object insertion order', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: 'x' } })).toBe(
      canonicalJson({ a: { b: 'x', y: true }, z: 1 }),
    );
    expect(hashCanonical({ b: 2, a: 1 })).toHaveLength(64);
  });

  it('binds a receipt to the immutable project context and inputs', () => {
    const receipt = createDecisionReceipt({
      receiptVersion: 'decision-receipt-v1',
      workspaceId: 'workspace',
      project: {
        projectId: 'project',
        projectContextId: 'context',
        revision: 1,
        snapshotHash: 'snapshot',
      },
      needId: 'need',
      needRevision: 1,
      candidateIds: ['b', 'a'],
      selectedCandidateId: 'a',
      scoreRunIds: ['score'],
      fitAssessmentIds: ['fit'],
      evidenceIds: ['evidence'],
      policyVersions: ['consideration-v1'],
      outcome: 'trial',
      rationale: 'Measure representative tasks first.',
      conditions: ['No source egress.'],
      decidedAt: '2026-09-25T12:00:00.000Z',
    });
    expect(replayDecisionReceipt(receipt)).toBe(true);
    expect(replayDecisionReceipt({ ...receipt, rationale: 'Changed later.' })).toBe(false);
  });

  it('keeps no-change options provider-free', () => {
    expect(() =>
      validateCandidate({
        id: 'status',
        kind: 'status_quo',
        label: 'Current workflow',
        components: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateCandidate({
        id: 'bad',
        kind: 'status_quo',
        label: 'Fake provider',
        components: [{ providerId: 'provider', role: 'primary' }],
      }),
    ).toThrow(/cannot fabricate/i);
  });
});

describe('hard gates', () => {
  it('gives a failure precedence over scores and unknowns', () => {
    const result = evaluateHardGates([
      {
        constraintId: 'privacy',
        label: 'No source egress',
        state: 'unknown',
        unknownHandling: 'block',
        evidenceIds: [],
        explanation: 'Source egress is unknown.',
      },
      {
        constraintId: 'platform',
        label: 'macOS',
        state: 'fail',
        unknownHandling: 'block',
        evidenceIds: ['platform-evidence'],
        explanation: 'macOS is unsupported.',
      },
    ]);
    expect(result.eligibility).toBe('ineligible');
  });

  it('blocks configured unknowns', () => {
    expect(
      evaluateHardGates([
        {
          constraintId: 'privacy',
          label: 'No source egress',
          state: 'unknown',
          unknownHandling: 'block',
          evidenceIds: [],
          explanation: 'Source egress is unknown.',
        },
      ]).eligibility,
    ).toBe('unknown_blocked');
  });
});

describe('Consider URL policy', () => {
  it('normalizes tracking parameters and extracts a strong GitHub identity', () => {
    const result = normalizeConsiderUrl(
      'https://GitHub.com/OpenHands/software-agent-sdk/?utm_source=x#readme',
    );
    expect(result.normalizedUrl).toBe('https://github.com/OpenHands/software-agent-sdk');
    expect(result.strongIdentity).toEqual({
      scheme: 'github_repository',
      value: 'openhands/software-agent-sdk',
    });
    expect(result.fetchDisposition).toBe('allowlisted_metadata');
  });

  it.each([
    'not a URL',
    'http://example.com',
    'file:///etc/passwd',
    'https://user:password@example.com/repository',
    'https://example.com:8443/repository',
    'https://localhost/repository',
    'https://service.local/repository',
    'https://127.0.0.1/a',
    'https://127.1/a',
    'https://0x7f000001/a',
    'https://10.0.0.1/a',
    'https://100.64.0.1/a',
    'https://169.254.169.254/latest/meta-data',
    'https://172.31.1.1/a',
    'https://192.0.2.1/a',
    'https://192.168.1.1/a',
    'https://198.18.0.1/a',
    'https://198.51.100.1/a',
    'https://203.0.113.1/a',
    'https://%31%32%37.0.0.1/a',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[2001:db8::1]/',
    'https://[fd00::1]/',
  ])('rejects unsafe URL %s', (input) => {
    expect(() => normalizeConsiderUrl(input)).toThrow(UrlPolicyError);
  });

  it('supports unknown public hosts through manual review', () => {
    expect(normalizeConsiderUrl('https://example.com/tool').fetchDisposition).toBe(
      'manual_review_required',
    );
  });
});
