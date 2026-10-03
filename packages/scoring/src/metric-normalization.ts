export const cohortMetricNormalizationPolicyV1 = 'cohort-percentile-v1' as const;

export type MetricDirection = 'higher_is_better' | 'lower_is_better';

export interface CohortMetricNormalization {
  policyVersion: typeof cohortMetricNormalizationPolicyV1;
  normalized: number;
  percentile: number;
  clippedValue: number;
  lowerFence: number;
  upperFence: number;
  referenceCount: number;
  outlierClipped: boolean;
  direction: MetricDirection;
}

function precise(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Versioned, query-independent normalization for a raw metric within a named cohort and bounded
 * time window. The caller owns cohort selection and persists that provenance. This policy only
 * accepts finite raw observations, applies deterministic 5/95 winsorization, and uses a mid-rank
 * percentile so duplicate values cannot gain order-dependent scores.
 */
export function normalizeCohortMetricV1(input: {
  rawValue: number;
  referenceValues: number[];
  direction: MetricDirection;
}): CohortMetricNormalization {
  const values = [...input.referenceValues, input.rawValue];
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Cohort metric values must be finite numbers.');
  }
  const sorted = values.sort((left, right) => left - right);
  const lowerFence = quantile(sorted, 0.05);
  const upperFence = quantile(sorted, 0.95);
  const clipped = sorted.map((value) => Math.max(lowerFence, Math.min(upperFence, value)));
  const clippedValue = Math.max(lowerFence, Math.min(upperFence, input.rawValue));
  const below = clipped.filter((value) => value < clippedValue).length;
  const equal = clipped.filter((value) => value === clippedValue).length;
  const percentile = ((below + equal / 2) / clipped.length) * 100;
  const normalized = input.direction === 'higher_is_better' ? percentile : 100 - percentile;
  return {
    policyVersion: cohortMetricNormalizationPolicyV1,
    normalized: precise(normalized),
    percentile: precise(percentile),
    clippedValue: precise(clippedValue),
    lowerFence: precise(lowerFence),
    upperFence: precise(upperFence),
    referenceCount: clipped.length,
    outlierClipped: clippedValue !== input.rawValue,
    direction: input.direction,
  };
}
