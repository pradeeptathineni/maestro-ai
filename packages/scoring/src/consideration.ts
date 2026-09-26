export const considerationPolicyV1 = {
  id: 'consideration',
  version: 'consideration-v1',
  coverageThreshold: 0.45,
  uncertaintyDeduction: 20,
  dimensions: {
    maturity: { weight: 0.2, prior: 50 },
    evidence_strength: { weight: 0.25, prior: 35 },
    freshness_support: { weight: 0.15, prior: 50 },
    security_provenance: { weight: 0.25, prior: 35, highPrivilegePrior: 25 },
    domain_confidence: { weight: 0.15, prior: 50 },
  },
} as const;

export type DimensionKey = keyof typeof considerationPolicyV1.dimensions;
export type DimensionApplicability = 'applicable' | 'not_applicable';

export interface DimensionInput {
  key: DimensionKey;
  raw: number | null;
  confidence: number;
  coverage: number;
  applicability: DimensionApplicability;
  highPrivilege?: boolean;
  state: 'present' | 'missing' | 'zero' | 'stale' | 'contradicted' | 'not_applicable';
  reasons: string[];
  missing: string[];
  evidenceIds: string[];
}

export interface DimensionResult extends DimensionInput {
  weight: number;
  prior: number;
  adjusted: number | null;
}

export interface ConsiderationResult {
  policyVersion: 'consideration-v1';
  dimensions: DimensionResult[];
  central: number;
  uncertainty: number;
  evidenceCoverage: number;
  lowerBound: number;
  band:
    | 'Strong consideration'
    | 'Promising'
    | 'Mixed / investigate'
    | 'Weak consideration'
    | 'Insufficient evidence';
  rankKey: [number, number, number];
  inputEvidenceIds: string[];
}

export interface ConsiderationReplay {
  matches: boolean;
  current: ConsiderationResult;
}

function assertBounded(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function bandFor(lowerBound: number, coverage: number): ConsiderationResult['band'] {
  if (coverage < considerationPolicyV1.coverageThreshold) return 'Insufficient evidence';
  if (lowerBound >= 75) return 'Strong consideration';
  if (lowerBound >= 60) return 'Promising';
  if (lowerBound >= 40) return 'Mixed / investigate';
  return 'Weak consideration';
}

export function calculateConsiderationV1(inputs: DimensionInput[]): ConsiderationResult {
  const byKey = new Map(inputs.map((input) => [input.key, input]));
  const orderedKeys = Object.keys(considerationPolicyV1.dimensions) as DimensionKey[];
  if (
    inputs.length !== orderedKeys.length ||
    byKey.size !== orderedKeys.length ||
    orderedKeys.some((key) => !byKey.has(key))
  ) {
    throw new Error('Every v1 dimension must be provided exactly once.');
  }

  const dimensions = orderedKeys.map((key): DimensionResult => {
    const input = byKey.get(key)!;
    assertBounded(input.confidence, 0, 1, `${key}.confidence`);
    assertBounded(input.coverage, 0, 1, `${key}.coverage`);
    if (input.raw !== null) assertBounded(input.raw, 0, 100, `${key}.raw`);
    if (input.applicability === 'not_applicable') {
      if (input.state !== 'not_applicable' || input.raw !== null) {
        throw new Error(`${key} must preserve an explicit not_applicable state without a value.`);
      }
      return { ...input, weight: 0, prior: 0, adjusted: null };
    }
    if (input.state === 'not_applicable') {
      throw new Error(`${key} cannot be not_applicable when the dimension is applicable.`);
    }
    if (input.raw === null && input.confidence !== 0) {
      throw new Error(`${key} cannot have confidence without a defensible raw value.`);
    }
    if (input.state === 'missing' && (input.raw !== null || input.confidence !== 0)) {
      throw new Error(`${key} missing state requires a null raw value and zero confidence.`);
    }
    if (input.state === 'zero' && input.raw !== 0) {
      throw new Error(`${key} zero state requires a raw value of zero.`);
    }
    if (['present', 'stale', 'contradicted'].includes(input.state) && input.raw === null) {
      throw new Error(`${key} ${input.state} state requires a defensible raw value.`);
    }
    const policy = considerationPolicyV1.dimensions[key];
    const prior =
      input.highPrivilege && 'highPrivilegePrior' in policy
        ? policy.highPrivilegePrior
        : policy.prior;
    const adjusted =
      input.raw === null ? prior : input.confidence * input.raw + (1 - input.confidence) * prior;
    return {
      ...input,
      weight: policy.weight,
      prior,
      adjusted: round(adjusted),
      evidenceIds: [...input.evidenceIds].sort(),
    };
  });

  const applicable = dimensions.filter((dimension) => dimension.applicability === 'applicable');
  const totalWeight = applicable.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (totalWeight === 0) throw new Error('At least one dimension must be applicable.');
  const weighted = (selector: (dimension: DimensionResult) => number): number =>
    applicable.reduce((sum, dimension) => sum + dimension.weight * selector(dimension), 0) /
    totalWeight;
  const central = round(weighted((dimension) => dimension.adjusted!));
  const uncertainty = round(1 - weighted((dimension) => dimension.confidence));
  const evidenceCoverage = round(weighted((dimension) => dimension.coverage));
  const lowerBound = round(
    Math.min(100, Math.max(0, central - considerationPolicyV1.uncertaintyDeduction * uncertainty)),
  );
  const evidence = dimensions.find((dimension) => dimension.key === 'evidence_strength')!;
  const freshness = dimensions.find((dimension) => dimension.key === 'freshness_support')!;
  return {
    policyVersion: considerationPolicyV1.version,
    dimensions,
    central,
    uncertainty,
    evidenceCoverage,
    lowerBound,
    band: bandFor(lowerBound, evidenceCoverage),
    rankKey: [lowerBound, evidence.adjusted ?? 0, freshness.adjusted ?? 0],
    inputEvidenceIds: [...new Set(dimensions.flatMap((dimension) => dimension.evidenceIds))].sort(),
  };
}

export function replayConsiderationV1(
  inputs: DimensionInput[],
  expected: ConsiderationResult,
): ConsiderationReplay {
  const current = calculateConsiderationV1(inputs);
  return {
    matches: JSON.stringify(current) === JSON.stringify(expected),
    current,
  };
}
