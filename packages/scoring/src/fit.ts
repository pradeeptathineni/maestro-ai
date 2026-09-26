export const projectFitPolicyV1 = {
  version: 'project-fit-v1',
  uncertaintyDeduction: 20,
} as const;

export interface PreferenceInput {
  key: string;
  label: string;
  weight: number;
  raw: number | null;
  confidence: number;
  state: 'present' | 'missing' | 'zero' | 'stale' | 'contradicted' | 'not_applicable';
  reasons: string[];
  evidenceIds: string[];
}

export interface PreferenceResult extends PreferenceInput {
  adjusted: number | null;
  contribution: number;
}

export interface ProjectFitResult {
  policyVersion: 'project-fit-v1';
  central: number | null;
  uncertainty: number;
  lowerBound: number | null;
  band: 'Strong fit' | 'Promising fit' | 'Mixed fit' | 'Weak fit' | 'Insufficient evidence';
  preferences: PreferenceResult[];
  evidenceIds: string[];
}

function bounded(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function calculateProjectFitV1(inputs: PreferenceInput[]): ProjectFitResult {
  if (inputs.length === 0) {
    return {
      policyVersion: projectFitPolicyV1.version,
      central: null,
      uncertainty: 1,
      lowerBound: null,
      band: 'Insufficient evidence',
      preferences: [],
      evidenceIds: [],
    };
  }
  const keys = new Set<string>();
  for (const input of inputs) {
    if (keys.has(input.key)) throw new Error(`Duplicate preference key: ${input.key}.`);
    keys.add(input.key);
    bounded(input.weight, 0, 1, `${input.key}.weight`);
    bounded(input.confidence, 0, 1, `${input.key}.confidence`);
    if (input.raw !== null) bounded(input.raw, 0, 100, `${input.key}.raw`);
    if (input.raw === null && input.confidence !== 0) {
      throw new Error(`${input.key} cannot have confidence without a raw value.`);
    }
  }
  const applicable = inputs.filter((input) => input.state !== 'not_applicable');
  const totalWeight = applicable.reduce((sum, input) => sum + input.weight, 0);
  if (totalWeight <= 0) throw new Error('At least one preference must have positive weight.');
  const preferences: PreferenceResult[] = inputs.map((input) => {
    if (input.state === 'not_applicable') return { ...input, adjusted: null, contribution: 0 };
    const adjusted =
      input.raw === null ? 50 : input.confidence * input.raw + (1 - input.confidence) * 50;
    return {
      ...input,
      adjusted: round(adjusted),
      contribution: round((input.weight / totalWeight) * adjusted),
      evidenceIds: [...input.evidenceIds].sort(),
    };
  });
  const central = round(preferences.reduce((sum, item) => sum + item.contribution, 0));
  const uncertainty = round(
    1 - applicable.reduce((sum, item) => sum + item.weight * item.confidence, 0) / totalWeight,
  );
  const lowerBound = round(
    Math.max(0, central - projectFitPolicyV1.uncertaintyDeduction * uncertainty),
  );
  const observed = applicable.filter((input) => input.raw !== null).length / applicable.length;
  const band: ProjectFitResult['band'] =
    observed < 0.5
      ? 'Insufficient evidence'
      : lowerBound >= 75
        ? 'Strong fit'
        : lowerBound >= 60
          ? 'Promising fit'
          : lowerBound >= 40
            ? 'Mixed fit'
            : 'Weak fit';
  return {
    policyVersion: projectFitPolicyV1.version,
    central,
    uncertainty,
    lowerBound,
    band,
    preferences,
    evidenceIds: [...new Set(inputs.flatMap((input) => input.evidenceIds))].sort(),
  };
}
