import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../domain/src/index.js';
import { dimensionFixture, verificationFixture } from '../../test-fixtures/src/scoring.js';
import { calculateConsiderationV1 } from './consideration.js';
import { calculateProjectFitV1 } from './fit.js';
import { calculateVerificationPriorityV1 } from './verification.js';

describe('consideration-v1', () => {
  it('matches the documented missing-security worked example', () => {
    const result = calculateConsiderationV1(dimensionFixture());
    expect(result.central).toBe(57.55);
    expect(result.uncertainty).toBe(0.415);
    expect(result.lowerBound).toBe(49.25);
    expect(result.band).toBe('Mixed / investigate');
    expect(result.dimensions.find((item) => item.key === 'security_provenance')).toMatchObject({
      raw: null,
      prior: 25,
      adjusted: 25,
      state: 'missing',
    });
  });

  it('distinguishes missing, zero, not applicable, stale, and contradicted', () => {
    const result = calculateConsiderationV1(
      dimensionFixture({
        maturity: { raw: 0, state: 'zero' },
        evidence_strength: { state: 'contradicted' },
        freshness_support: { state: 'stale' },
        domain_confidence: {
          raw: null,
          confidence: 0,
          coverage: 0,
          applicability: 'not_applicable',
          state: 'not_applicable',
        },
      }),
    );
    expect(result.dimensions.map((item) => item.state)).toEqual([
      'zero',
      'contradicted',
      'stale',
      'missing',
      'not_applicable',
    ]);
  });

  it('is deterministic for the same canonical inputs', () => {
    const first = calculateConsiderationV1(dimensionFixture());
    const second = calculateConsiderationV1(dimensionFixture());
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('shrinks uncertain observations toward the documented prior', () => {
    const adjusted = (confidence: number) =>
      calculateConsiderationV1(
        dimensionFixture({ maturity: { raw: 100, confidence } }),
      ).dimensions.find((item) => item.key === 'maturity')!.adjusted;
    expect(adjusted(1)).toBe(100);
    expect(adjusted(0.5)).toBe(75);
    expect(adjusted(0)).toBe(50);
  });

  it('always stays within policy bounds', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (raw, confidence) => {
          const result = calculateConsiderationV1(
            dimensionFixture({ maturity: { raw, confidence } }),
          );
          expect(result.central).toBeGreaterThanOrEqual(0);
          expect(result.central).toBeLessThanOrEqual(100);
          expect(result.lowerBound).toBeGreaterThanOrEqual(0);
          expect(result.lowerBound).toBeLessThanOrEqual(100);
        },
      ),
    );
  });

  it('rejects duplicate dimensions and incoherent state/value pairs', () => {
    expect(() => calculateConsiderationV1([...dimensionFixture(), dimensionFixture()[0]!])).toThrow(
      /exactly once/,
    );
    expect(() =>
      calculateConsiderationV1(
        dimensionFixture({ maturity: { state: 'missing', raw: 80, confidence: 0 } }),
      ),
    ).toThrow(/missing state/);
    expect(() =>
      calculateConsiderationV1(dimensionFixture({ maturity: { state: 'zero', raw: 10 } })),
    ).toThrow(/zero state/);
  });
});

describe('project-fit-v1', () => {
  it('rejects incoherent state/value pairs', () => {
    expect(() =>
      calculateProjectFitV1([
        {
          key: 'security',
          label: 'Security',
          weight: 1,
          raw: 80,
          confidence: 0,
          state: 'missing',
          reasons: [],
          evidenceIds: [],
        },
      ]),
    ).toThrow(/missing state/);
  });
});

describe('verification-priority-v1', () => {
  it('applies the large-claim floor and inactivity cap visibly', () => {
    const largeClaim = calculateVerificationPriorityV1(verificationFixture(1), {
      largeQuantitativeClaimWithBoundedTest: true,
    });
    expect(largeClaim.priority).toBe(70);
    expect(largeClaim.adjustments[0]).toMatch(/Floor 70/);

    const inactive = calculateVerificationPriorityV1(verificationFixture(4), {
      noActiveDecisionInReviewHorizon: true,
    });
    expect(inactive.priority).toBe(40);
    expect(inactive.adjustments[0]).toMatch(/Cap 40/);
  });

  it('gives unknown security under high privilege the safety floor', () => {
    expect(
      calculateVerificationPriorityV1(verificationFixture(0), {
        highPrivilegeWithUnknownSecurity: true,
      }).priority,
    ).toBe(80);
  });

  it('rejects duplicate factors even when every required key is represented', () => {
    expect(() =>
      calculateVerificationPriorityV1([...verificationFixture(), verificationFixture()[0]!]),
    ).toThrow(/exactly once/);
  });
});
