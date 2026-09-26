export type GateResultState = 'pass' | 'fail' | 'unknown';
export type UnknownHandling = 'block' | 'penalize' | 'allow_with_warning';

export interface GateResult {
  constraintId: string;
  label: string;
  state: GateResultState;
  unknownHandling: UnknownHandling;
  evidenceIds: string[];
  explanation: string;
}

export type Eligibility = 'eligible' | 'ineligible' | 'unknown_blocked';

export interface GateEvaluation {
  eligibility: Eligibility;
  results: GateResult[];
  reasons: string[];
}

export function evaluateHardGates(results: GateResult[]): GateEvaluation {
  const failed = results.filter((result) => result.state === 'fail');
  const blocked = results.filter(
    (result) => result.state === 'unknown' && result.unknownHandling === 'block',
  );
  const eligibility: Eligibility = failed.length
    ? 'ineligible'
    : blocked.length
      ? 'unknown_blocked'
      : 'eligible';
  return {
    eligibility,
    results,
    reasons: [...failed, ...blocked].map((result) => result.explanation),
  };
}
