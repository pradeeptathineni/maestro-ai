import { hashCanonical } from './canonical.js';
import type { CandidateOption, DecisionReceipt, DecisionReceiptInput } from './types.js';

export function validateCandidate(candidate: CandidateOption): void {
  if (candidate.kind === 'provider' && candidate.components.length !== 1) {
    throw new Error('A provider candidate must have exactly one component.');
  }
  if (candidate.kind === 'composition' && candidate.components.length < 2) {
    throw new Error('A composition candidate must have at least two components.');
  }
  if (
    (candidate.kind === 'status_quo' || candidate.kind === 'build' || candidate.kind === 'defer') &&
    candidate.components.length !== 0
  ) {
    throw new Error(`${candidate.kind} candidates cannot fabricate provider components.`);
  }
  const primaryCount = candidate.components.filter(
    (component) => component.role === 'primary',
  ).length;
  if ((candidate.kind === 'provider' || candidate.kind === 'composition') && primaryCount !== 1) {
    throw new Error('Provider-backed candidates require exactly one primary component.');
  }
}

export function createDecisionReceipt(input: DecisionReceiptInput): DecisionReceipt {
  const canonicalInput: DecisionReceiptInput = {
    ...input,
    candidateIds: [...input.candidateIds].sort(),
    scoreRunIds: [...input.scoreRunIds].sort(),
    fitAssessmentIds: [...input.fitAssessmentIds].sort(),
    evidenceIds: [...input.evidenceIds].sort(),
    policyVersions: [...input.policyVersions].sort(),
    conditions: [...input.conditions],
  };
  return { ...canonicalInput, inputHash: hashCanonical(canonicalInput) };
}

export function replayDecisionReceipt(receipt: DecisionReceipt): boolean {
  const { inputHash, ...input } = receipt;
  return hashCanonical(input) === inputHash;
}
