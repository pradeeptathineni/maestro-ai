export const verificationPolicyV1 = {
  version: 'verification-priority-v1',
  factors: {
    evidence_gap: 0.2,
    privilege_blast_radius: 0.18,
    project_criticality: 0.14,
    novelty_provenance: 0.12,
    claim_magnitude_conflict: 0.12,
    benchmarkability: 0.1,
    decision_urgency: 0.08,
    irreversibility_switching_cost: 0.06,
  },
} as const;

export type VerificationFactorKey = keyof typeof verificationPolicyV1.factors;

export interface VerificationFactor {
  key: VerificationFactorKey;
  value: number;
  reasons: string[];
  evidenceIds: string[];
}

export interface VerificationContext {
  highPrivilegeWithUnknownSecurity?: boolean;
  blockingUnknownNearDecision?: boolean;
  largeQuantitativeClaimWithBoundedTest?: boolean;
  noActiveDecisionInReviewHorizon?: boolean;
  existingSafetyExposure?: boolean;
}

export interface VerificationPriorityResult {
  policyVersion: 'verification-priority-v1';
  priority: number;
  basePriority: number;
  factors: Array<VerificationFactor & { weight: number; contribution: number }>;
  adjustments: string[];
  evidenceIds: string[];
}

export function calculateVerificationPriorityV1(
  factors: VerificationFactor[],
  context: VerificationContext = {},
): VerificationPriorityResult {
  const byKey = new Map(factors.map((factor) => [factor.key, factor]));
  const orderedKeys = Object.keys(verificationPolicyV1.factors) as VerificationFactorKey[];
  if (byKey.size !== orderedKeys.length || orderedKeys.some((key) => !byKey.has(key))) {
    throw new Error('Every v1 verification factor must be provided exactly once.');
  }
  const detailed = orderedKeys.map((key) => {
    const factor = byKey.get(key)!;
    if (!Number.isInteger(factor.value) || factor.value < 0 || factor.value > 4) {
      throw new RangeError(`${key} must be an integer from 0 through 4.`);
    }
    const weight = verificationPolicyV1.factors[key];
    return {
      ...factor,
      evidenceIds: [...factor.evidenceIds].sort(),
      weight,
      contribution: Math.round(25 * weight * factor.value * 100) / 100,
    };
  });
  const basePriority = Math.round(detailed.reduce((sum, factor) => sum + factor.contribution, 0));
  let priority = basePriority;
  const adjustments: string[] = [];
  const applyFloor = (floor: number, reason: string): void => {
    if (priority < floor) {
      priority = floor;
      adjustments.push(reason);
    }
  };
  if (context.highPrivilegeWithUnknownSecurity) {
    applyFloor(80, 'Floor 80: high privilege with unknown security/provenance.');
  }
  if (context.blockingUnknownNearDecision) {
    applyFloor(75, 'Floor 75: a blocking hard-gate unknown affects a near-term decision.');
  }
  if (context.largeQuantitativeClaimWithBoundedTest) {
    applyFloor(70, 'Floor 70: a large quantitative claim has a feasible bounded reproduction.');
  }
  if (context.noActiveDecisionInReviewHorizon && !context.existingSafetyExposure && priority > 40) {
    priority = 40;
    adjustments.push('Cap 40: no active decision or expected action in the review horizon.');
  }
  return {
    policyVersion: verificationPolicyV1.version,
    priority,
    basePriority,
    factors: detailed,
    adjustments,
    evidenceIds: [...new Set(detailed.flatMap((factor) => factor.evidenceIds))].sort(),
  };
}
