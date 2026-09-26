export interface Domain {
  id: string;
  key: string;
  label: string;
  definition: string;
  parentKey: string | null;
  taxonomyKey: string;
  taxonomyVersion: number;
  providerCount: number;
}

export interface Dimension {
  key: string;
  raw: number | null;
  adjusted: number;
  confidence: number;
  coverage: number;
  prior: number;
  state: 'present' | 'missing' | 'not_applicable' | 'contradicted' | 'stale';
  reasons: string[];
  missing: string[];
  evidenceIds: string[];
}

export interface ProviderSummary {
  id: string;
  kind: string;
  name: string;
  description: string;
  lifecycleState: string;
  aliases: string[];
  domains: Array<{ key: string; label: string }>;
  capabilities: Array<{
    key: string;
    name: string;
    description: string;
    deliveryMode: string;
    assertionState: string;
  }>;
  scoreRunId: string;
  scorePolicyVersion: string;
  scoreCentral: number;
  scoreUncertainty: number;
  evidenceCoverage: number;
  considerationLowerBound: number;
  considerationBand: string;
  scoreGeneratedAt: string;
  dimensions: Dimension[];
  verificationPriority: number;
  verificationState: string;
  nextVerification: Record<string, unknown>;
  matchedFields: string[];
}

export interface ClaimEvidence {
  direction: string;
  directness: string;
  strength: string;
  applicability: string;
  rationale: string;
  evidenceId: string;
  evidenceType: string;
  producer: string;
  methodVersion: string;
  independence: string;
  limitations: string[];
  reviewAfter: string | null;
}

export interface Claim {
  id: string;
  claimant: string;
  claimantRelation: string;
  predicate: string;
  value: unknown;
  scope: string;
  workflowState: string;
  validFrom: string;
  sourceTitle: string;
  sourceOwner: string;
  sourceUrl: string;
  observedAt: string;
  sourceObservation: string;
  evidence: ClaimEvidence[];
}

export interface ProviderDetail extends Omit<ProviderSummary, 'capabilities' | 'domains'> {
  identities: Array<{
    scheme: string;
    value: string;
    displayValue: string;
    confidence: number;
    isCanonical: boolean;
  }>;
  versions: Array<{
    id: string;
    version: string;
    releasedAt: string | null;
    lifecycleState: string;
  }>;
  capabilities: Array<{
    key: string;
    name: string;
    description: string;
    deliveryMode: string;
    maturityState: string;
    assertionState: string;
    effects: Record<string, unknown>;
    constraints: Record<string, unknown>;
  }>;
  domains: Array<{ key: string; label: string; confidence: number; rationale: string }>;
  claims: Claim[];
  score: {
    id: string;
    policyVersion: string;
    central: number;
    uncertainty: number;
    evidenceCoverage: number;
    lowerBound: number;
    band: string;
    generatedAt: string;
    dimensions: Dimension[];
  } | null;
  verification: VerificationItem[];
  compatibility: Array<{
    key: string;
    state: string;
    value: unknown;
    explanation: string;
    evidenceIds: string[];
    observedAt: string;
  }>;
  executionAvailability: { available: false; explanation: string };
}

export interface GateResult {
  constraintId: string;
  label: string;
  state: 'pass' | 'fail' | 'unknown';
  unknownHandling: string;
  evidenceIds: string[];
  explanation: string;
}

export interface Candidate {
  id: string;
  optionKind: string;
  label: string;
  providerId: string | null;
  providerName: string | null;
  providerKind: string | null;
  scoreRunId: string | null;
  considerationLowerBound: number | null;
  considerationBand: string | null;
  considerationUncertainty: number | null;
  evidenceCoverage: number | null;
  eligibility: 'eligible' | 'ineligible' | 'unknown_blocked';
  gateResults: GateResult[];
  preferenceResult: {
    central: number;
    uncertainty: number;
    lowerBound: number;
    band: string;
    components: Array<{
      key: string;
      label: string;
      adjusted: number;
      missing: string[];
      reasons: string[];
    }>;
  } | null;
  fitRationale: string[];
  fitPolicyVersion: string;
  recommendationOutcome: string;
  recommendationExplanation: string;
  verificationPriority: number | null;
  nextVerification: Record<string, unknown> | null;
}

export interface DecisionSummary {
  id: string;
  outcome: string;
  selectedCandidateId: string | null;
  rationale: string;
  conditions: string[];
  inputHash: string;
  decidedAt: string;
}

export interface NeedSummary {
  id: string;
  stableId: string;
  revision: number;
  title: string;
  desiredOutcome: string;
  successCriteria: string[];
  requiredCapabilityKeys: string[];
  projectId: string;
  projectName: string;
  candidateCount: number;
  eligibleCount: number;
  blockedCount: number;
}

export interface NeedDetail extends NeedSummary {
  projectContextId: string;
  projectContextRevision: number;
  projectSnapshotHash: string;
  projectContext: Record<string, unknown>;
  constraints: Array<{
    id: string;
    kind: string;
    key: string;
    label: string;
    unknownHandling: string;
    weight: number | null;
  }>;
  candidates: Candidate[];
  decisions: DecisionSummary[];
}

export interface DecisionDetail extends DecisionSummary {
  needTitle: string;
  projectName: string;
  selectedCandidateLabel: string | null;
  receipt: {
    receiptVersion: string;
    project: {
      projectId: string;
      projectContextId: string;
      revision: number;
      snapshotHash: string;
    };
    needId: string;
    needRevision: number;
    candidateIds: string[];
    selectedCandidateId?: string;
    scoreRunIds: string[];
    fitAssessmentIds: string[];
    evidenceIds: string[];
    policyVersions: string[];
    outcome: string;
    rationale: string;
    conditions: string[];
    decidedAt: string;
    inputHash: string;
  };
}

export interface VerificationItem {
  id: string;
  providerId: string;
  providerName: string;
  priority: number;
  basePriority: number;
  state: string;
  scope: string;
  modes: string[];
  factors: Array<{ key: string; value: number; explanation: string }>;
  adjustments: Array<{ key: string; value: number; explanation: string }>;
  nextPlan: Record<string, unknown>;
  generatedAt: string;
}

export interface Intake {
  id: string;
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
  foundBy: string;
  state: string;
  failureCode: string | null;
  retryDisposition: string | null;
  revision: number;
  handlingStatus: string;
  minimalMetadata: Record<string, unknown>;
  resolvedProviderId: string | null;
  duplicate?: boolean;
  duplicateReason?: string;
  strongIdentity?: { scheme: string; value: string };
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  lifecycleState: string;
  currentContextId: string;
  contextRevision: number;
  snapshotHash: string;
  context: Record<string, unknown>;
}

export interface ProblemDetails {
  status: number;
  code: string;
  detail: string;
  correlationId: string;
}
