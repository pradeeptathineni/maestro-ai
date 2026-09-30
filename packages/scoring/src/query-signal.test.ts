import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calculateQuerySignalV1,
  type QueryValueInput,
  type QueryValueKey,
} from './query-signal.js';

const keys: QueryValueKey[] = ['reuse_leverage', 'adoption_ease', 'maturity', 'provenance_clarity'];

function values(raws: number[], confidence = 1): QueryValueInput[] {
  return keys.map((key, index) => ({
    key,
    raw: raws[index]!,
    confidence,
    coverage: confidence > 0 ? 1 : 0,
    applicability: 'applicable',
    highPrivilege: key === 'provenance_clarity',
    state: raws[index] === 0 ? 'zero' : 'present',
    reasons: ['Synthetic policy fixture.'],
    missing: [],
    evidenceIds: [`evidence-${index}`],
  }));
}

describe('query-signal-v1', () => {
  it('matches the normative direct and complementary arithmetic', () => {
    const direct = calculateQuerySignalV1({
      relevanceOrdinal: 'direct',
      relevanceMethod: 'rule',
      dimensions: values([90, 80, 85, 75]),
    });
    expect(direct.valueCentral).toBe(84.25);
    expect(direct.signalDisplay).toBe(84);

    const complementary = calculateQuerySignalV1({
      relevanceOrdinal: 'complementary',
      relevanceMethod: 'rule',
      dimensions: values([95, 95, 95, 95]),
    });
    expect(complementary.signalDisplay).toBe(48);
  });

  it('shrinks weak claims and still returns an explicitly low-confidence estimate', () => {
    const weak = calculateQuerySignalV1({
      relevanceOrdinal: 'direct',
      relevanceMethod: 'rule',
      dimensions: values([100, 100, 100, 100], 0.35),
    });
    expect(weak.valueConservative).toBe(49.625);
    expect(weak.signalDisplay).toBe(50);

    const sparse = values([100, 100, 100, 100], 1).map((item, index) =>
      index === 0
        ? item
        : { ...item, raw: null, confidence: 0, coverage: 0, state: 'missing' as const },
    );
    const sparseResult = calculateQuerySignalV1({
      relevanceOrdinal: 'direct',
      relevanceMethod: 'rule',
      dimensions: sparse,
    });
    expect(sparseResult).toMatchObject({
      displayState: 'insufficient_evidence',
      signalDisplay: 51,
      band: 'Investigate',
    });
    expect(sparseResult.evidenceCoverage).toBe(0.4);
  });

  it('marks model-proposed relevance provisional without suppressing its estimate', () => {
    expect(
      calculateQuerySignalV1({
        relevanceOrdinal: 'direct',
        relevanceMethod: 'model_proposal',
        dimensions: values([75, 75, 75, 75]),
      }),
    ).toMatchObject({
      displayState: 'provisional',
      signalDisplay: 75,
      band: 'Strong consideration',
    });
  });

  it('is bounded and competitor-independent', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 4, maxLength: 4 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (raws, confidence) => {
          const input = {
            relevanceOrdinal: 'partial' as const,
            relevanceMethod: 'rule' as const,
            dimensions: values(raws, confidence),
          };
          const before = calculateQuerySignalV1(input);
          const afterUnrelatedCandidateExists = calculateQuerySignalV1(input);
          expect(afterUnrelatedCandidateExists.signalUnrounded).toBe(before.signalUnrounded);
          expect(before.signalUnrounded).toBeGreaterThanOrEqual(0);
          expect(before.signalUnrounded).toBeLessThanOrEqual(100);
        },
      ),
    );
  });
});
