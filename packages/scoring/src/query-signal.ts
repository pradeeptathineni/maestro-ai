export const querySignalPolicyV1 = {
  id: 'query-signal',
  version: 'query-signal-v1',
  coverageThreshold: 0.45,
  uncertaintyDeduction: 20,
  dimensions: {
    reuse_leverage: { weight: 0.4, prior: 50 },
    adoption_ease: { weight: 0.25, prior: 35 },
    maturity: { weight: 0.2, prior: 50 },
    provenance_clarity: { weight: 0.15, prior: 35, highPrivilegePrior: 25 },
  },
} as const;

export type QueryValueKey = keyof typeof querySignalPolicyV1.dimensions;
export type QueryValueState =
  'present' | 'missing' | 'zero' | 'stale' | 'contradicted' | 'not_applicable';

export interface QueryValueInput {
  key: QueryValueKey;
  raw: number | null;
  confidence: number;
  coverage: number;
  applicability: 'applicable' | 'not_applicable';
  highPrivilege?: boolean;
  state: QueryValueState;
  reasons: string[];
  missing: string[];
  evidenceIds: string[];
}

export interface QueryValueResult extends QueryValueInput {
  weight: number;
  prior: number;
  adjusted: number | null;
}

export interface QuerySignalResult {
  policyVersion: 'query-signal-v1';
  relevanceOrdinal: 'no_match' | 'incidental' | 'complementary' | 'partial' | 'direct';
  relevanceValue: 0 | 25 | 50 | 75 | 100;
  relevanceMethod: 'rule' | 'human' | 'model_proposal';
  dimensions: QueryValueResult[];
  valueCentral: number;
  valueUncertainty: number;
  valueConservative: number;
  evidenceCoverage: number;
  signalUnrounded: number;
  signalDisplay: number | null;
  displayState: 'available' | 'insufficient_evidence' | 'provisional' | 'excluded';
  band: 'Strong consideration' | 'Promising' | 'Investigate' | 'Weak consideration' | 'Excluded';
  inputEvidenceIds: string[];
}

const RELEVANCE_VALUES = {
  no_match: 0,
  incidental: 25,
  complementary: 50,
  partial: 75,
  direct: 100,
} as const;

function bounded(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
}

function precise(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function calculateQuerySignalV1(input: {
  relevanceOrdinal: QuerySignalResult['relevanceOrdinal'];
  relevanceMethod: QuerySignalResult['relevanceMethod'];
  dimensions: QueryValueInput[];
  excluded?: boolean;
  provisional?: boolean;
}): QuerySignalResult {
  const orderedKeys = Object.keys(querySignalPolicyV1.dimensions) as QueryValueKey[];
  const byKey = new Map(input.dimensions.map((dimension) => [dimension.key, dimension]));
  if (
    input.dimensions.length !== orderedKeys.length ||
    byKey.size !== orderedKeys.length ||
    orderedKeys.some((key) => !byKey.has(key))
  ) {
    throw new Error('Every query-signal-v1 dimension must be provided exactly once.');
  }
  const dimensions = orderedKeys.map((key): QueryValueResult => {
    const dimension = byKey.get(key)!;
    bounded(dimension.confidence, 0, 1, `${key}.confidence`);
    bounded(dimension.coverage, 0, 1, `${key}.coverage`);
    if (dimension.raw !== null) bounded(dimension.raw, 0, 100, `${key}.raw`);
    if (dimension.applicability === 'not_applicable') {
      if (dimension.state !== 'not_applicable' || dimension.raw !== null) {
        throw new Error(`${key} must preserve a valueless not_applicable state.`);
      }
      return { ...dimension, weight: 0, prior: 0, adjusted: null };
    }
    if (dimension.state === 'not_applicable') {
      throw new Error(`${key} cannot be not_applicable while applicable.`);
    }
    if (dimension.raw === null && (dimension.confidence !== 0 || dimension.state !== 'missing')) {
      throw new Error(
        `${key} missing values require null raw, zero confidence, and missing state.`,
      );
    }
    if (dimension.state === 'zero' && dimension.raw !== 0) {
      throw new Error(`${key} zero state requires raw zero.`);
    }
    const policy = querySignalPolicyV1.dimensions[key];
    const prior =
      dimension.highPrivilege && 'highPrivilegePrior' in policy
        ? policy.highPrivilegePrior
        : policy.prior;
    return {
      ...dimension,
      weight: policy.weight,
      prior,
      adjusted:
        dimension.raw === null
          ? prior
          : precise(dimension.confidence * dimension.raw + (1 - dimension.confidence) * prior),
      evidenceIds: [...new Set(dimension.evidenceIds)].sort(),
    };
  });
  const applicable = dimensions.filter((dimension) => dimension.applicability === 'applicable');
  const totalWeight = applicable.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (totalWeight <= 0) throw new Error('At least one value dimension must be applicable.');
  const weighted = (selector: (dimension: QueryValueResult) => number): number =>
    applicable.reduce((sum, dimension) => sum + dimension.weight * selector(dimension), 0) /
    totalWeight;
  const valueCentral = precise(weighted((dimension) => dimension.adjusted!));
  const valueUncertainty = precise(1 - weighted((dimension) => dimension.confidence));
  const valueConservative = precise(
    Math.max(0, Math.min(100, valueCentral - 20 * valueUncertainty)),
  );
  const evidenceCoverage = precise(weighted((dimension) => dimension.coverage));
  const relevanceValue = RELEVANCE_VALUES[input.relevanceOrdinal];
  const signalUnrounded = precise((relevanceValue / 100) * valueConservative);
  const displayState = input.excluded
    ? 'excluded'
    : input.provisional || input.relevanceMethod === 'model_proposal'
      ? 'provisional'
      : evidenceCoverage < querySignalPolicyV1.coverageThreshold
        ? 'insufficient_evidence'
        : 'available';
  // Confidence and review state qualify the estimate; they do not suppress it.
  // Excluded candidates are not search results and therefore have no public signal.
  const signalDisplay = displayState === 'excluded' ? null : roundHalfUp(signalUnrounded);
  const band =
    displayState === 'excluded'
      ? 'Excluded'
      : signalDisplay! >= 75
        ? 'Strong consideration'
        : signalDisplay! >= 60
          ? 'Promising'
          : signalDisplay! >= 40
            ? 'Investigate'
            : 'Weak consideration';
  return {
    policyVersion: querySignalPolicyV1.version,
    relevanceOrdinal: input.relevanceOrdinal,
    relevanceValue,
    relevanceMethod: input.relevanceMethod,
    dimensions,
    valueCentral,
    valueUncertainty,
    valueConservative,
    evidenceCoverage,
    signalUnrounded,
    signalDisplay,
    displayState,
    band,
    inputEvidenceIds: [...new Set(dimensions.flatMap((dimension) => dimension.evidenceIds))].sort(),
  };
}
