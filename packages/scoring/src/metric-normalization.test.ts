import { describe, expect, it } from 'vitest';
import { normalizeCohortMetricV1 } from './metric-normalization.js';

describe('cohort-percentile-v1', () => {
  it('derives a mid-rank percentile from raw cohort observations', () => {
    expect(
      normalizeCohortMetricV1({
        rawValue: 30,
        referenceValues: [10, 20, 40, 50],
        direction: 'higher_is_better',
      }),
    ).toMatchObject({
      policyVersion: 'cohort-percentile-v1',
      normalized: 50,
      percentile: 50,
      referenceCount: 5,
    });
  });

  it('inverts lower-is-better metrics and clips extreme outliers deterministically', () => {
    const result = normalizeCohortMetricV1({
      rawValue: 10_000,
      referenceValues: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      direction: 'lower_is_better',
    });
    expect(result.outlierClipped).toBe(true);
    expect(result.clippedValue).toBe(result.upperFence);
    expect(result.normalized).toBeLessThan(10);
  });

  it('rejects non-finite observations rather than manufacturing a score', () => {
    expect(() =>
      normalizeCohortMetricV1({
        rawValue: Number.NaN,
        referenceValues: [1, 2],
        direction: 'higher_is_better',
      }),
    ).toThrow(/finite/);
  });
});
