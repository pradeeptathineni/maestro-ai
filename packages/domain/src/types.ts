export type OpaqueId = string;
export type Visibility = 'global' | 'workspace';
export type LifecycleState = 'active' | 'deprecated' | 'archived' | 'superseded' | 'unknown';

export const providerKinds = [
  'oss_project',
  'product',
  'service',
  'api',
  'mcp_server',
  'plugin',
  'skill',
  'model',
  'agent',
  'framework',
  'runtime',
  'library',
  'language',
  'protocol',
  'practice',
  'standard',
  'registry',
  'workflow',
  'other',
] as const;

export type ProviderKind = (typeof providerKinds)[number];

export const effectClasses = [
  'read_data',
  'write_data',
  'execute_process',
  'network',
  'credential_use',
  'external_mutation',
  'spend',
  'long_running',
] as const;

export type EffectClass = (typeof effectClasses)[number];

export interface ProviderRef {
  id: OpaqueId;
  versionId?: OpaqueId;
}

export interface ProjectSnapshotRef {
  projectId: OpaqueId;
  projectContextId: OpaqueId;
  revision: number;
  snapshotHash: string;
}

export type CandidateOptionKind = 'provider' | 'composition' | 'status_quo' | 'build' | 'defer';

export interface CandidateComponent {
  providerId: OpaqueId;
  providerVersionId?: OpaqueId;
  capabilityDefinitionId?: OpaqueId;
  role: 'primary' | 'supporting' | 'alternative';
}

export interface CandidateOption {
  id: OpaqueId;
  kind: CandidateOptionKind;
  label: string;
  components: CandidateComponent[];
}

export type EvidenceState =
  'missing' | 'zero' | 'not_applicable' | 'present' | 'stale' | 'contradicted';

export type DecisionOutcome = 'trial' | 'adopt' | 'defer' | 'avoid' | 'no_decision';

export interface DecisionReceiptInput {
  receiptVersion: 'decision-receipt-v1';
  workspaceId: OpaqueId;
  project: ProjectSnapshotRef;
  needId: OpaqueId;
  needRevision: number;
  candidateIds: OpaqueId[];
  selectedCandidateId?: OpaqueId;
  scoreRunIds: OpaqueId[];
  fitAssessmentIds: OpaqueId[];
  evidenceIds: OpaqueId[];
  policyVersions: string[];
  outcome: DecisionOutcome;
  rationale: string;
  conditions: string[];
  decidedAt: string;
}

export interface DecisionReceipt extends DecisionReceiptInput {
  inputHash: string;
}

export interface AdapterDescriptor {
  adapterKey: string;
  adapterVersion: string;
  providerKind: string;
  supportedEffects: EffectClass[];
}

export interface ResolvedActionPlan {
  adapter: AdapterDescriptor;
  provider: ProviderRef;
  normalizedInputs: unknown;
  effects: EffectClass[];
  targets: string[];
  networkDestinations: string[];
  credentialReferences: string[];
  expiresAt: string;
  approvalHash: string;
}

export interface ExecutionReceipt {
  planHash: string;
  externalReference?: { scheme: string; value: string };
  actualEffects: EffectClass[];
  postconditions: Array<{ key: string; state: 'passed' | 'failed' | 'unknown'; detail?: string }>;
  startedAt: string;
  finishedAt: string;
}

/**
 * Architectural seam only in v0. There is deliberately no implementation or route that can invoke it.
 */
export interface CapabilityAdapter {
  descriptor(): AdapterDescriptor;
  inspect(target: ProviderRef): Promise<unknown>;
  plan(request: unknown, authorityContext: unknown): Promise<ResolvedActionPlan>;
  invoke(plan: ResolvedActionPlan): Promise<ExecutionReceipt>;
}
