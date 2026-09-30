import type { QueryValueInput } from './query-signal.js';

export type IntrinsicSignalProfile =
  'implementation' | 'model' | 'practice' | 'standard' | 'knowledge_document';

export type IntrinsicDimensionKey =
  'reach' | 'authority' | 'evidence' | 'freshness' | 'impact' | 'momentum';

export type IntrinsicDimensionState =
  'present' | 'missing' | 'zero' | 'stale' | 'contradicted' | 'not_applicable';

export interface NormalizationProvenance {
  method: 'cohort_percentile' | 'bounded_score' | 'compatibility_projection';
  cohort: string;
  observedAt: string;
  window?: string;
  sourceMetric?: string;
}

export interface IntrinsicDimensionInput {
  key: IntrinsicDimensionKey;
  normalized: number | null;
  confidence: number;
  coverage: number;
  applicability: 'applicable' | 'not_applicable';
  state: IntrinsicDimensionState;
  normalization: NormalizationProvenance;
  reasons: string[];
  missing: string[];
  evidenceIds: string[];
}

export interface IntrinsicDimensionResult extends IntrinsicDimensionInput {
  weight: number;
  prior: number;
  adjusted: number | null;
}

export interface EvidenceConfidenceInput {
  directness: number;
  independence: number;
  applicability: number;
  freshness: number;
  coverage: number;
  contradiction: number;
  sourceGroupIds: string[];
  evidenceIds: string[];
}

export interface EvidenceConfidenceResult extends EvidenceConfidenceInput {
  policyVersion: 'evidence-confidence-v1';
  score: number;
  display: number;
  band: 'High' | 'Moderate' | 'Low' | 'Insufficient';
  limitations: string[];
}

export interface TrendObservation {
  observedAt: string;
  value: number;
  sourceId: string;
  independenceGroup: string;
}

export interface TrendResult {
  policyVersion: 'trend-v1';
  state:
    'new' | 'rapidly_rising' | 'rising' | 'stable' | 'cooling' | 'declining' | 'stale' | 'unknown';
  windowStart: string;
  windowEnd: string;
  observationCount: number;
  independentSourceCount: number;
  change: number | null;
  reasons: string[];
}

export interface IntrinsicSignalResult {
  policyVersion: 'intrinsic-signal-v3';
  profile: IntrinsicSignalProfile;
  dimensions: IntrinsicDimensionResult[];
  central: number;
  uncertainty: number;
  conservative: number;
  display: number;
  displayState: 'available' | 'insufficient_evidence' | 'provisional';
  band: 'High signal' | 'Notable' | 'Developing' | 'Weak signal';
  evidenceConfidence: EvidenceConfidenceResult;
  trend: TrendResult;
  inputEvidenceIds: string[];
}

export interface CompatibilityIntrinsicSignalInput {
  kind: string;
  valueProfile: QueryValueInput[];
  observedAt: string;
  evidenceSourceGroups: string[];
  freshness: number;
  provisional: boolean;
}

const dimensions: IntrinsicDimensionKey[] = [
  'reach',
  'authority',
  'evidence',
  'freshness',
  'impact',
  'momentum',
];

export const intrinsicSignalPolicyV3 = {
  id: 'intrinsic-signal',
  version: 'intrinsic-signal-v3',
  evidenceCoverageThreshold: 0.45,
  uncertaintyDeduction: 20,
  profiles: {
    implementation: {
      reach: { weight: 0.25, prior: 35 },
      authority: { weight: 0.15, prior: 40 },
      evidence: { weight: 0.2, prior: 35 },
      freshness: { weight: 0.15, prior: 45 },
      impact: { weight: 0.15, prior: 35 },
      momentum: { weight: 0.1, prior: 40 },
    },
    model: {
      reach: { weight: 0.2, prior: 35 },
      authority: { weight: 0.15, prior: 40 },
      evidence: { weight: 0.25, prior: 30 },
      freshness: { weight: 0.15, prior: 45 },
      impact: { weight: 0.15, prior: 35 },
      momentum: { weight: 0.1, prior: 40 },
    },
    practice: {
      reach: { weight: 0.15, prior: 35 },
      authority: { weight: 0.2, prior: 40 },
      evidence: { weight: 0.25, prior: 35 },
      freshness: { weight: 0.1, prior: 50 },
      impact: { weight: 0.2, prior: 35 },
      momentum: { weight: 0.1, prior: 40 },
    },
    standard: {
      reach: { weight: 0.2, prior: 35 },
      authority: { weight: 0.25, prior: 45 },
      evidence: { weight: 0.2, prior: 40 },
      freshness: { weight: 0.1, prior: 50 },
      impact: { weight: 0.2, prior: 40 },
      momentum: { weight: 0.05, prior: 45 },
    },
    knowledge_document: {
      reach: { weight: 0.1, prior: 30 },
      authority: { weight: 0.25, prior: 40 },
      evidence: { weight: 0.25, prior: 35 },
      freshness: { weight: 0.2, prior: 45 },
      impact: { weight: 0.1, prior: 30 },
      momentum: { weight: 0.1, prior: 40 },
    },
  },
} as const;

function bounded(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
}

function precise(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function intrinsicSignalProfile(kind: string): IntrinsicSignalProfile {
  if (kind === 'model') return 'model';
  if (['practice', 'technique', 'concept', 'convention', 'workflow'].includes(kind)) {
    return 'practice';
  }
  if (['protocol', 'standard', 'specification'].includes(kind)) return 'standard';
  if (['article', 'research', 'resource', 'documentation'].includes(kind)) {
    return 'knowledge_document';
  }
  return 'implementation';
}

export function calculateEvidenceConfidence(
  input: EvidenceConfidenceInput,
): EvidenceConfidenceResult {
  for (const key of [
    'directness',
    'independence',
    'applicability',
    'freshness',
    'coverage',
    'contradiction',
  ] as const) {
    bounded(input[key], 0, 1, `evidence.${key}`);
  }
  const independentSourceCount = new Set(input.sourceGroupIds).size;
  const independenceCeiling = independentSourceCount >= 2 ? 1 : 0.65;
  const independence = Math.min(input.independence, independenceCeiling);
  const score = precise(
    Math.max(
      0,
      Math.min(
        1,
        input.directness * 0.2 +
          independence * 0.2 +
          input.applicability * 0.15 +
          input.freshness * 0.15 +
          input.coverage * 0.2 +
          (1 - input.contradiction) * 0.1,
      ),
    ),
  );
  const display = Math.floor(score * 100 + 0.5);
  const band =
    display >= 75 ? 'High' : display >= 55 ? 'Moderate' : display >= 30 ? 'Low' : 'Insufficient';
  const limitations = [
    independentSourceCount < 2 ? 'Fewer than two independent source groups.' : '',
    input.coverage < 0.5 ? 'Applicable evidence coverage is below 50%.' : '',
    input.freshness < 0.5 ? 'Evidence freshness is weak or unknown.' : '',
    input.contradiction > 0 ? 'Contradicting evidence is present.' : '',
  ].filter(Boolean);
  return {
    ...input,
    sourceGroupIds: unique(input.sourceGroupIds),
    evidenceIds: unique(input.evidenceIds),
    policyVersion: 'evidence-confidence-v1',
    score,
    display,
    band,
    limitations,
  };
}

export function calculateTrend(
  observations: TrendObservation[],
  input: { windowStart: string; windowEnd: string; now: string; newEntity?: boolean },
): TrendResult {
  const windowStart = new Date(input.windowStart);
  const windowEnd = new Date(input.windowEnd);
  const now = new Date(input.now);
  if (!(windowStart < windowEnd) || Number.isNaN(now.valueOf())) {
    throw new Error('Trend window and current time must be valid and ordered.');
  }
  const within = observations
    .map((item) => ({ ...item, timestamp: new Date(item.observedAt).valueOf() }))
    .filter(
      (item) =>
        Number.isFinite(item.timestamp) &&
        item.timestamp >= windowStart.valueOf() &&
        item.timestamp <= windowEnd.valueOf(),
    )
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.sourceId.localeCompare(right.sourceId),
    );
  for (const item of within) bounded(item.value, 0, 100, 'trend.value');
  const independentSourceCount = new Set(within.map((item) => item.independenceGroup)).size;
  const base = {
    policyVersion: 'trend-v1' as const,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    observationCount: within.length,
    independentSourceCount,
  };
  if (input.newEntity && within.length > 0) {
    return {
      ...base,
      state: 'new',
      change: null,
      reasons: ['Entity is new within the stated window.'],
    };
  }
  if (within.length < 2 || independentSourceCount < 1) {
    return {
      ...base,
      state: 'unknown',
      change: null,
      reasons: ['Fewer than two comparable observations.'],
    };
  }
  const lastObserved = within.at(-1)!.timestamp;
  if (now.valueOf() - lastObserved > 2 * (windowEnd.valueOf() - windowStart.valueOf())) {
    return {
      ...base,
      state: 'stale',
      change: null,
      reasons: ['Latest observation is older than two declared windows.'],
    };
  }
  const midpoint = windowStart.valueOf() + (windowEnd.valueOf() - windowStart.valueOf()) / 2;
  const early = within.filter((item) => item.timestamp <= midpoint);
  const late = within.filter((item) => item.timestamp > midpoint);
  if (!early.length || !late.length) {
    return {
      ...base,
      state: 'unknown',
      change: null,
      reasons: ['Observations do not span both halves of the window.'],
    };
  }
  const mean = (items: typeof within) =>
    items.reduce((sum, item) => sum + item.value, 0) / items.length;
  const change = precise(mean(late) - mean(early));
  const state =
    change >= 25
      ? 'rapidly_rising'
      : change >= 8
        ? 'rising'
        : change <= -25
          ? 'declining'
          : change <= -8
            ? 'cooling'
            : 'stable';
  return {
    ...base,
    state,
    change,
    reasons: [`Later-window normalized observations changed by ${change} points.`],
  };
}

export function calculateIntrinsicSignalV3(input: {
  profile: IntrinsicSignalProfile;
  dimensions: IntrinsicDimensionInput[];
  evidenceConfidence: EvidenceConfidenceInput;
  trend: TrendResult;
  provisional?: boolean;
}): IntrinsicSignalResult {
  const profile = intrinsicSignalPolicyV3.profiles[input.profile];
  const byKey = new Map(input.dimensions.map((dimension) => [dimension.key, dimension]));
  if (input.dimensions.length !== dimensions.length || byKey.size !== dimensions.length) {
    throw new Error('Every intrinsic-signal-v3 dimension must be provided exactly once.');
  }
  const results = dimensions.map((key): IntrinsicDimensionResult => {
    const dimension = byKey.get(key);
    if (!dimension) throw new Error(`Missing intrinsic dimension: ${key}.`);
    bounded(dimension.confidence, 0, 1, `${key}.confidence`);
    bounded(dimension.coverage, 0, 1, `${key}.coverage`);
    if (dimension.normalized !== null) bounded(dimension.normalized, 0, 100, `${key}.normalized`);
    const policy = profile[key];
    if (dimension.applicability === 'not_applicable') {
      if (dimension.state !== 'not_applicable' || dimension.normalized !== null) {
        throw new Error(`${key} must preserve a valueless not_applicable state.`);
      }
      return { ...dimension, weight: 0, prior: 0, adjusted: null };
    }
    if (
      dimension.normalized === null &&
      (dimension.state !== 'missing' || dimension.confidence !== 0)
    ) {
      throw new Error(
        `${key} missing values require null normalized, zero confidence, and missing state.`,
      );
    }
    const adjusted =
      dimension.normalized === null
        ? policy.prior
        : precise(
            dimension.confidence * dimension.normalized + (1 - dimension.confidence) * policy.prior,
          );
    return { ...dimension, weight: policy.weight, prior: policy.prior, adjusted };
  });
  const applicable = results.filter((item) => item.applicability === 'applicable');
  const totalWeight = applicable.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) throw new Error('At least one intrinsic dimension must be applicable.');
  const weighted = (selector: (item: IntrinsicDimensionResult) => number) =>
    applicable.reduce((sum, item) => sum + item.weight * selector(item), 0) / totalWeight;
  const central = precise(weighted((item) => item.adjusted!));
  const uncertainty = precise(1 - weighted((item) => item.confidence));
  const conservative = precise(
    Math.max(0, central - intrinsicSignalPolicyV3.uncertaintyDeduction * uncertainty),
  );
  const evidenceCoverage = weighted((item) => item.coverage);
  const evidenceConfidence = calculateEvidenceConfidence(input.evidenceConfidence);
  const display = Math.floor(conservative + 0.5);
  const displayState = input.provisional
    ? 'provisional'
    : evidenceCoverage < intrinsicSignalPolicyV3.evidenceCoverageThreshold ||
        evidenceConfidence.band === 'Insufficient'
      ? 'insufficient_evidence'
      : 'available';
  return {
    policyVersion: intrinsicSignalPolicyV3.version,
    profile: input.profile,
    dimensions: results,
    central,
    uncertainty,
    conservative,
    display,
    displayState,
    band:
      display >= 75
        ? 'High signal'
        : display >= 60
          ? 'Notable'
          : display >= 40
            ? 'Developing'
            : 'Weak signal',
    evidenceConfidence,
    trend: input.trend,
    inputEvidenceIds: unique([
      ...results.flatMap((item) => item.evidenceIds),
      ...evidenceConfidence.evidenceIds,
    ]),
  };
}

export function intrinsicInputsFromLegacyValueProfile(
  values: QueryValueInput[],
  input: { profile: IntrinsicSignalProfile; observedAt: string },
): IntrinsicDimensionInput[] {
  const byKey = new Map(values.map((value) => [value.key, value]));
  const mapping: Record<IntrinsicDimensionKey, QueryValueInput['key'] | null> = {
    reach: 'reuse_leverage',
    authority: 'provenance_clarity',
    evidence: 'provenance_clarity',
    freshness: 'maturity',
    impact: 'reuse_leverage',
    momentum: null,
  };
  return dimensions.map((key) => {
    const legacyKey = mapping[key];
    const source = legacyKey ? byKey.get(legacyKey) : undefined;
    const normalization: NormalizationProvenance = {
      method: 'compatibility_projection',
      cohort: input.profile,
      observedAt: input.observedAt,
      sourceMetric: legacyKey ?? 'not_available',
    };
    if (!source || source.applicability === 'not_applicable') {
      return {
        key,
        normalized: null,
        confidence: 0,
        coverage: 0,
        applicability: key === 'momentum' ? 'applicable' : 'not_applicable',
        state: key === 'momentum' ? 'missing' : 'not_applicable',
        normalization,
        reasons: [],
        missing: [`No ${key} observation is available in the compatibility projection.`],
        evidenceIds: [],
      };
    }
    return {
      key,
      normalized: source.raw,
      confidence: source.confidence,
      coverage: source.coverage,
      applicability: 'applicable',
      state: source.state,
      normalization,
      reasons: [
        ...source.reasons,
        `Projected from historical ${legacyKey}; replace with type-specific cohort evidence.`,
      ],
      missing: source.missing,
      evidenceIds: source.evidenceIds,
    };
  });
}

export function calculateCompatibilityIntrinsicSignal(
  input: CompatibilityIntrinsicSignalInput,
): IntrinsicSignalResult {
  const profile = intrinsicSignalProfile(input.kind);
  const applicable = input.valueProfile.filter(
    (dimension) => dimension.applicability === 'applicable',
  );
  const mean = (selector: (dimension: QueryValueInput) => number): number =>
    applicable.length
      ? applicable.reduce((sum, dimension) => sum + selector(dimension), 0) / applicable.length
      : 0;
  const windowEnd = new Date(input.observedAt);
  if (!Number.isFinite(windowEnd.valueOf())) {
    throw new Error('Compatibility Signal observedAt must be a valid timestamp.');
  }
  const windowStart = new Date(windowEnd.getTime() - 90 * 24 * 60 * 60 * 1000);
  const trend = calculateTrend([], {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    now: windowEnd.toISOString(),
  });
  return calculateIntrinsicSignalV3({
    profile,
    dimensions: intrinsicInputsFromLegacyValueProfile(input.valueProfile, {
      profile,
      observedAt: windowEnd.toISOString(),
    }),
    evidenceConfidence: {
      directness: mean((dimension) => dimension.confidence),
      independence: input.evidenceSourceGroups.length >= 2 ? 0.8 : 0.35,
      applicability: mean((dimension) => dimension.coverage),
      freshness: input.freshness,
      coverage: mean((dimension) => dimension.coverage),
      contradiction: applicable.some((dimension) => dimension.state === 'contradicted') ? 1 : 0,
      sourceGroupIds: input.evidenceSourceGroups,
      evidenceIds: [...new Set(input.valueProfile.flatMap((dimension) => dimension.evidenceIds))],
    },
    trend,
    provisional: input.provisional,
  });
}
