interface Dimension {
  key: string;
  raw: number | null;
  adjusted: number | null;
  confidence: number;
  coverage: number;
  prior: number;
  state: 'present' | 'missing' | 'zero' | 'not_applicable' | 'contradicted' | 'stale';
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

interface ClaimEvidence {
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

interface Claim {
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

interface GateResult {
  constraintId: string;
  label: string;
  state: 'pass' | 'fail' | 'unknown';
  unknownHandling: string;
  evidenceIds: string[];
  explanation: string;
}

interface Candidate {
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

interface DecisionSummary {
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
  receiptVerified: boolean;
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

interface ExplorerInterpretation {
  normalizedText: string;
  canonicalConcepts: string[];
  explicitFacets: Array<{ key: string; label: string; value: string; origin: string }>;
  inferredFacets: Array<{ key: string; label: string; value: string; origin: string }>;
  missingContext: Array<{ key: string; label: string; value: string; origin: string }>;
  capabilityGroups: string[];
  landscapeFacets: string[];
  intentMode: string;
  typedTarget: string | null;
  sourceRoutingHints: string[];
  coverageState: 'maintained' | 'partial' | 'outside_maintained_coverage';
}

export interface ExplorerSession {
  id: string;
  resultSetId: string;
  resultSetRevision: number;
  status: string;
  interpretation: ExplorerInterpretation;
  counts: { assessed: number; available: number; truncated: number };
  retentionUntil: string;
  externalDiscovery: { attempted: boolean; state: string };
  projectFit: { state: string; orderingApplied: boolean; explanation?: string };
}

export interface ExplorerRefresh {
  state: 'unchanged' | 'refreshed';
  resultSetId: string;
  resultSetRevision: number;
  predecessorId: string | null;
  counts?: { assessed: number; available: number; truncated: number };
}

export interface ExplorerResultItem {
  id: string;
  position: number;
  providerId: string | null;
  documentId?: string | null;
  subjectType: 'implementation' | 'document';
  entityClass: string;
  providerRevision: number | null;
  capabilityGroup: string;
  matchedFields: string[];
  explanation: string;
  caveats: string[];
  name: string;
  kind: string;
  description: string;
  publicationState: string;
  aliases: string[];
  capabilities: string[];
  relevanceOrdinal: string;
  relevanceValue: number;
  relevanceMethod: string;
  matchScore: number | null;
  matchBand: 'Direct' | 'Strong' | 'Related' | 'Peripheral' | null;
  matchedConceptIds: string[];
  valueCentral: number;
  valueUncertainty: number;
  valueConservative: number;
  evidenceCoverage: number;
  evidenceConfidence: number;
  evidenceConfidenceDetail: {
    policyVersion: string;
    score: number;
    display: number;
    band: 'High' | 'Moderate' | 'Low' | 'Insufficient';
    directness: number;
    independence: number;
    applicability: number;
    freshness: number;
    coverage: number;
    contradiction: number;
    limitations: string[];
    sourceGroupIds: string[];
    evidenceIds: string[];
  } | null;
  signalUnrounded: number;
  signalDisplay: number | null;
  displayState: string;
  signalBand: string | null;
  trendState: string | null;
  trend: {
    policyVersion: string;
    state: string;
    windowStart: string;
    windowEnd: string;
    observationCount: number;
    independentSourceCount: number;
    change: number | null;
    reasons: string[];
  } | null;
  missing: string[];
  policyVersion: string;
}

export interface ExplorerResultPage {
  resultSet: {
    id: string;
    revision: number;
    querySessionId: string;
    query: string;
    interpretation: ExplorerInterpretation;
    projectContextId: string | null;
    assessedCount: number;
    availableCount: number;
    truncatedCount: number;
    diagnostics: {
      coverageState: string;
      externalDiscoveryAttempted: boolean;
      projectFitState: 'unknown_blocked' | 'not_applicable';
      projectContextAffectsSignal: false;
    };
    queryPlan?: {
      policyVersion: string;
      intentMode: string;
      planHash: string;
      routes: Array<{
        id: string;
        adapterKey: string;
        state: string;
        variant: string | null;
        reason: string;
        callLimit: number;
      }>;
    };
    signalPolicyVersion: string;
    retrievalPolicyVersion: string;
    createdAt: string;
    expiresAt: string;
  };
  activeOrdering: string;
  filters: Record<string, unknown>;
  filteredCount: number;
  items: ExplorerResultItem[];
  discoveryOperations: Array<{
    id: string;
    adapterKey: string;
    state: string;
    planRouteId?: string;
    routingReason?: string;
    sourcePlanState?: string;
    safeDetail?: string;
  }>;
  nextCursor: string | null;
}

export interface ExplorerItemDetail extends ExplorerResultItem {
  resultSetId: string;
  canonicalUri?: string;
  relevanceAnchors: Record<string, unknown>;
  matchedConcepts: Array<{ id: string; facetKey: string; label: string }>;
  valueInputs: Array<{
    key: string;
    raw: number | null;
    confidence: number;
    coverage: number;
    prior: number;
    adjusted: number | null;
    state: string;
    reasons: string[];
    missing: string[];
  }>;
  inputHash: string;
  generatedAt: string;
  evidence: Array<{
    id: string;
    evidenceType: string;
    producer: string;
    methodVersion: string;
    independence: string;
    applicabilityScope: string;
    limitations: string[];
    observedAt: string;
    sourceTitle: string | null;
    sourceOwner: string | null;
    sourceUrl: string | null;
    retrievalMethod: string | null;
    handlingStatus: string | null;
    dimensionKey: string;
  }>;
  relations: Array<{
    type: string;
    scope?: string;
    rationale?: string;
    confidence?: number;
    targetProviderId?: string | null;
    targetName?: string | null;
    targetCapabilityId?: string | null;
    targetCapabilityName?: string | null;
    sourceUrl?: string | null;
    status: string;
  }>;
}

export interface ExplorerGraphData {
  resultSetId: string;
  resultSetRevision: number;
  filteredCount: number;
  visibleCount: number;
  hiddenCount: number;
  nodes: Array<{
    id: string;
    resultItemId?: string;
    providerId?: string;
    type: 'implementation' | 'document' | 'capability_group';
    label: string;
    kind?: string;
    group: string;
    signalDisplay?: number | null;
    displayState: string;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    scope: string;
    status: string;
  }>;
  accessibleItems: Array<{
    id: string;
    name: string;
    kind: string;
    group: string;
    explanation: string;
    matchBand: ExplorerResultItem['matchBand'];
    signalDisplay: number | null;
    evidenceConfidence: number;
    trendState: string | null;
    relation: { type: string; scope: string; status: string };
    relationships: Array<{
      type: string;
      scope: string;
      status: string;
      targetName: string;
    }>;
  }>;
}
