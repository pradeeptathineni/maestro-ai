import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const catalog = pgSchema('catalog');
export const workspace = pgSchema('workspace');
export const ops = pgSchema('ops');

export const domainTaxonomyVersions = catalog.table(
  'domain_taxonomy_versions',
  {
    id: uuid().primaryKey(),
    taxonomyKey: text('taxonomy_key').notNull(),
    version: integer().notNull(),
    status: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.taxonomyKey, table.version)],
);

export const domainNodes = catalog.table(
  'domain_nodes',
  {
    id: uuid().primaryKey(),
    taxonomyVersionId: uuid('taxonomy_version_id')
      .notNull()
      .references(() => domainTaxonomyVersions.id),
    stableKey: text('stable_key').notNull(),
    label: text().notNull(),
    definition: text().notNull(),
    parentId: uuid('parent_id'),
    status: text().notNull().default('active'),
  },
  (table) => [unique().on(table.taxonomyVersionId, table.stableKey)],
);

export const providers = catalog.table('providers', {
  id: uuid().primaryKey(),
  kind: text().notNull(),
  canonicalName: text('canonical_name').notNull(),
  description: text().notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  visibility: text().notNull().default('global'),
  revision: integer().notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sources = catalog.table('sources', {
  id: uuid().primaryKey(),
  canonicalUri: text('canonical_uri').notNull().unique(),
  title: text().notNull(),
  owner: text().notNull(),
  sourceType: text('source_type').notNull(),
  authorityScope: text('authority_scope').notNull(),
  visibility: text().notNull().default('global'),
  redistributionNotes: text('redistribution_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourceObservations = catalog.table('source_observations', {
  id: uuid().primaryKey(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id),
  requestedUri: text('requested_uri').notNull(),
  finalUri: text('final_uri').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  retrievalMethod: text('retrieval_method').notNull(),
  adapterVersion: text('adapter_version').notNull(),
  contentDigest: text('content_digest').notNull(),
  excerpt: text(),
  mediaType: text('media_type'),
  trustBoundary: text('trust_boundary').notNull(),
  handlingStatus: text('handling_status').notNull(),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerIdentities = catalog.table('provider_identities', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  scheme: text().notNull(),
  normalizedValue: text('normalized_value').notNull(),
  displayValue: text('display_value').notNull(),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  confidence: numeric({ precision: 5, scale: 4 }).notNull(),
  isCanonical: boolean('is_canonical').notNull().default(false),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
});

export const providerAliases = catalog.table(
  'provider_aliases',
  {
    id: uuid().primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id),
    alias: text().notNull(),
    sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  },
  (table) => [unique().on(table.providerId, table.alias)],
);

export const providerVersions = catalog.table(
  'provider_versions',
  {
    id: uuid().primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamVersion: text('upstream_version').notNull(),
    normalizedVersion: text('normalized_version'),
    releaseObservedAt: timestamp('release_observed_at', { withTimezone: true }),
    lifecycleState: text('lifecycle_state').notNull(),
    sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.providerId, table.upstreamVersion)],
);

export const capabilityDefinitions = catalog.table(
  'capability_definitions',
  {
    id: uuid().primaryKey(),
    stableKey: text('stable_key').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    name: text().notNull(),
    description: text().notNull(),
    inputSchema: jsonb('input_schema'),
    outputSchema: jsonb('output_schema'),
    effectClasses: text('effect_classes').array().notNull().default([]),
    parentId: uuid('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.stableKey, table.schemaVersion)],
);

export const providerCapabilities = catalog.table('provider_capabilities', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  providerVersionId: uuid('provider_version_id').references(() => providerVersions.id),
  capabilityDefinitionId: uuid('capability_definition_id')
    .notNull()
    .references(() => capabilityDefinitions.id),
  deliveryMode: text('delivery_mode').notNull(),
  maturityState: text('maturity_state').notNull(),
  assertionState: text('assertion_state').notNull(),
  effects: text().array().notNull().default([]),
  constraints: jsonb().notNull().default({}),
});

export const providerRelations = catalog.table('provider_relations', {
  id: uuid().primaryKey(),
  subjectProviderId: uuid('subject_provider_id')
    .notNull()
    .references(() => providers.id),
  objectProviderId: uuid('object_provider_id')
    .notNull()
    .references(() => providers.id),
  relationType: text('relation_type').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  confidence: numeric({ precision: 5, scale: 4 }).notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const identityResolutionEvents = catalog.table('identity_resolution_events', {
  id: uuid().primaryKey(),
  identityScheme: text('identity_scheme').notNull(),
  identityValue: text('identity_value').notNull(),
  fromProviderId: uuid('from_provider_id').references(() => providers.id),
  toProviderId: uuid('to_provider_id')
    .notNull()
    .references(() => providers.id),
  resolutionType: text('resolution_type').notNull(),
  rationale: text().notNull(),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  supersedesId: uuid('supersedes_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const domainMemberships = catalog.table('domain_memberships', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  domainNodeId: uuid('domain_node_id')
    .notNull()
    .references(() => domainNodes.id),
  origin: text().notNull(),
  confidence: numeric({ precision: 5, scale: 4 }).notNull(),
  rationale: text().notNull(),
  reviewed: boolean().notNull().default(false),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
});

export const claims = catalog.table('claims', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  sourceObservationId: uuid('source_observation_id')
    .notNull()
    .references(() => sourceObservations.id),
  claimant: text().notNull(),
  claimantRelation: text('claimant_relation').notNull(),
  predicate: text().notNull(),
  value: jsonb().notNull(),
  scope: text().notNull(),
  workflowState: text('workflow_state').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceItems = catalog.table('evidence_items', {
  id: uuid().primaryKey(),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  evidenceType: text('evidence_type').notNull(),
  producer: text().notNull(),
  methodVersion: text('method_version').notNull(),
  result: jsonb().notNull(),
  independence: text().notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  limitations: text().array().notNull().default([]),
  qualityFlags: text('quality_flags').array().notNull().default([]),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  reviewAfter: timestamp('review_after', { withTimezone: true }),
  visibility: text().notNull().default('global'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceRelations = catalog.table('evidence_relations', {
  id: uuid().primaryKey(),
  claimId: uuid('claim_id')
    .notNull()
    .references(() => claims.id),
  evidenceItemId: uuid('evidence_item_id')
    .notNull()
    .references(() => evidenceItems.id),
  direction: text().notNull(),
  directness: text().notNull(),
  strength: text().notNull(),
  applicability: text().notNull(),
  rationale: text().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
});

export const adjudications = catalog.table('adjudications', {
  id: uuid().primaryKey(),
  claimId: uuid('claim_id')
    .notNull()
    .references(() => claims.id),
  conclusion: text().notNull(),
  scope: text().notNull(),
  evidenceItemIds: uuid('evidence_item_ids').array().notNull(),
  policyVersion: text('policy_version').notNull(),
  rationale: text().notNull(),
  supersedesId: uuid('supersedes_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evaluationDefinitions = catalog.table(
  'evaluation_definitions',
  {
    id: uuid().primaryKey(),
    stableKey: text('stable_key').notNull(),
    version: integer().notNull(),
    mode: text().notNull(),
    definition: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.stableKey, table.version)],
);

export const evaluationRuns = catalog.table('evaluation_runs', {
  id: uuid().primaryKey(),
  definitionId: uuid('definition_id')
    .notNull()
    .references(() => evaluationDefinitions.id),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  providerVersionId: uuid('provider_version_id').references(() => providerVersions.id),
  inputHash: text('input_hash').notNull(),
  result: jsonb().notNull(),
  evidenceItemId: uuid('evidence_item_id').references(() => evidenceItems.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const providerCompatibility = catalog.table('provider_compatibility', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  providerVersionId: uuid('provider_version_id').references(() => providerVersions.id),
  compatibilityKey: text('compatibility_key').notNull(),
  state: text().notNull(),
  value: jsonb().notNull(),
  explanation: text().notNull(),
  evidenceIds: uuid('evidence_ids').array().notNull().default([]),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
});

export const scorePolicies = catalog.table('score_policies', {
  id: uuid().primaryKey(),
  policyKey: text('policy_key').notNull(),
  version: text().notNull(),
  policyDocument: jsonb('policy_document').notNull(),
  codeRevision: text('code_revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scoreRuns = catalog.table('score_runs', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  providerVersionId: uuid('provider_version_id').references(() => providerVersions.id),
  domainNodeId: uuid('domain_node_id')
    .notNull()
    .references(() => domainNodes.id),
  policyId: uuid('policy_id')
    .notNull()
    .references(() => scorePolicies.id),
  inputHash: text('input_hash').notNull(),
  central: numeric({ precision: 7, scale: 4 }).notNull(),
  uncertainty: numeric({ precision: 5, scale: 4 }).notNull(),
  evidenceCoverage: numeric('evidence_coverage', { precision: 5, scale: 4 }).notNull(),
  lowerBound: numeric('lower_bound', { precision: 7, scale: 4 }).notNull(),
  band: text().notNull(),
  evidenceIds: uuid('evidence_ids').array().notNull().default([]),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  supersededBy: uuid('superseded_by'),
  predecessorId: uuid('predecessor_id'),
  scopeKey: text('scope_key').notNull().default('general'),
});

export const dimensionScores = catalog.table('dimension_scores', {
  id: uuid().primaryKey(),
  scoreRunId: uuid('score_run_id')
    .notNull()
    .references(() => scoreRuns.id),
  dimensionKey: text('dimension_key').notNull(),
  raw: numeric({ precision: 7, scale: 4 }),
  adjusted: numeric({ precision: 7, scale: 4 }),
  confidence: numeric({ precision: 5, scale: 4 }).notNull(),
  coverage: numeric({ precision: 5, scale: 4 }).notNull(),
  prior: numeric({ precision: 7, scale: 4 }).notNull(),
  state: text().notNull(),
  reasons: text().array().notNull().default([]),
  missing: text().array().notNull().default([]),
  evidenceIds: uuid('evidence_ids').array().notNull().default([]),
});

export const verificationAssessments = catalog.table('verification_assessments', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  claimId: uuid('claim_id').references(() => claims.id),
  policyVersion: text('policy_version').notNull(),
  scope: text().notNull(),
  priority: integer().notNull(),
  basePriority: integer('base_priority').notNull(),
  state: text().notNull(),
  modes: text().array().notNull(),
  factors: jsonb().notNull(),
  adjustments: text().array().notNull().default([]),
  nextPlan: text('next_plan'),
  evidenceIds: uuid('evidence_ids').array().notNull().default([]),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
});

export const workspaces = workspace.table('workspaces', {
  id: uuid().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = workspace.table('projects', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  name: text().notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectContexts = workspace.table('project_contexts', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  revision: integer().notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  contextDocument: jsonb('context_document').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const needs = workspace.table('needs', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  projectContextId: uuid('project_context_id')
    .notNull()
    .references(() => projectContexts.id),
  stableId: uuid('stable_id').notNull(),
  revision: integer().notNull(),
  title: text().notNull(),
  desiredOutcome: text('desired_outcome').notNull(),
  successCriteria: text('success_criteria').array().notNull(),
  requiredCapabilityKeys: text('required_capability_keys').array().notNull(),
  state: text().notNull(),
  decisionDeadline: timestamp('decision_deadline', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  supersedesId: uuid('supersedes_id'),
});

export const constraints = workspace.table('constraints', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  needId: uuid('need_id')
    .notNull()
    .references(() => needs.id),
  kind: text().notNull(),
  constraintKey: text('constraint_key').notNull(),
  label: text().notNull(),
  operator: text().notNull(),
  expectedValue: jsonb('expected_value').notNull(),
  unknownHandling: text('unknown_handling').notNull(),
  weight: numeric({ precision: 6, scale: 4 }),
});

export const candidates = workspace.table('candidates', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  needId: uuid('need_id')
    .notNull()
    .references(() => needs.id),
  optionKind: text('option_kind').notNull(),
  label: text().notNull(),
  contextSnapshotHash: text('context_snapshot_hash').notNull(),
  discoveryOrigin: text('discovery_origin').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  description: text().notNull().default(''),
  evidenceState: text('evidence_state').notNull().default('unknown'),
});

export const candidateComponents = workspace.table('candidate_components', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  candidateId: uuid('candidate_id')
    .notNull()
    .references(() => candidates.id),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id),
  providerVersionId: uuid('provider_version_id').references(() => providerVersions.id),
  capabilityDefinitionId: uuid('capability_definition_id').references(
    () => capabilityDefinitions.id,
  ),
  role: text().notNull(),
});

export const fitAssessments = workspace.table('fit_assessments', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  candidateId: uuid('candidate_id')
    .notNull()
    .references(() => candidates.id),
  needId: uuid('need_id')
    .notNull()
    .references(() => needs.id),
  projectContextId: uuid('project_context_id')
    .notNull()
    .references(() => projectContexts.id),
  policyVersion: text('policy_version').notNull(),
  eligibility: text().notNull(),
  gateResults: jsonb('gate_results').notNull(),
  preferenceResult: jsonb('preference_result'),
  rationale: text().array().notNull(),
  evidenceIds: uuid('evidence_ids').array().notNull().default([]),
  inputHash: text('input_hash').notNull(),
  authorType: text('author_type').notNull(),
  reviewState: text('review_state').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
});

export const recommendations = workspace.table('recommendations', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  needId: uuid('need_id')
    .notNull()
    .references(() => needs.id),
  candidateId: uuid('candidate_id').references(() => candidates.id),
  outcome: text().notNull(),
  explanation: text().notNull(),
  inputHash: text('input_hash').notNull(),
  policyVersion: text('policy_version').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
});

export const decisions = workspace.table('decisions', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  needId: uuid('need_id')
    .notNull()
    .references(() => needs.id),
  projectContextId: uuid('project_context_id')
    .notNull()
    .references(() => projectContexts.id),
  selectedCandidateId: uuid('selected_candidate_id').references(() => candidates.id),
  outcome: text().notNull(),
  rationale: text().notNull(),
  conditions: text().array().notNull().default([]),
  receipt: jsonb().notNull(),
  inputHash: text('input_hash').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  supersedesId: uuid('supersedes_id'),
});

export const privateSources = workspace.table('private_sources', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  canonicalUri: text('canonical_uri').notNull(),
  title: text().notNull(),
  owner: text().notNull(),
  sourceType: text('source_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const privateEvidenceItems = workspace.table('private_evidence_items', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  sourceId: uuid('source_id').references(() => privateSources.id),
  providerId: uuid('provider_id').references(() => providers.id),
  projectContextId: uuid('project_context_id')
    .notNull()
    .references(() => projectContexts.id),
  evidenceType: text('evidence_type').notNull(),
  producer: text().notNull(),
  result: jsonb().notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  limitations: text().array().notNull().default([]),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const intakes = ops.table('intakes', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  originalUrl: text('original_url').notNull(),
  normalizedUrl: text('normalized_url').notNull(),
  hostname: text().notNull(),
  note: text(),
  foundBy: text('found_by').notNull(),
  strongIdentityScheme: text('strong_identity_scheme'),
  strongIdentityValue: text('strong_identity_value'),
  state: text().notNull(),
  failureCode: text('failure_code'),
  retryDisposition: text('retry_disposition'),
  idempotencyKey: text('idempotency_key'),
  revision: integer().notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const intakeEvents = ops.table('intake_events', {
  id: uuid().primaryKey(),
  intakeId: uuid('intake_id')
    .notNull()
    .references(() => intakes.id),
  state: text().notNull(),
  safeDetail: text('safe_detail').notNull(),
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const intakeSources = ops.table('intake_sources', {
  id: uuid().primaryKey(),
  intakeId: uuid('intake_id')
    .notNull()
    .references(() => intakes.id),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  submittedUri: text('submitted_uri').notNull(),
  normalizedUri: text('normalized_uri').notNull(),
  trustBoundary: text('trust_boundary').notNull().default('remote_untrusted'),
  handlingStatus: text('handling_status').notNull().default('quarantined'),
  contentDigest: text('content_digest'),
  minimalMetadata: jsonb('minimal_metadata').notNull().default({}),
  resolvedProviderId: uuid('resolved_provider_id').references(() => providers.id),
  curatedAt: timestamp('curated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outbox = ops.table('outbox', {
  id: uuid().primaryKey(),
  operationKey: text('operation_key').notNull().unique(),
  taskName: text('task_name').notNull(),
  payload: jsonb().notNull(),
  state: text().notNull().default('pending'),
  attempts: integer().notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobAttempts = ops.table('job_attempts', {
  id: uuid().primaryKey(),
  operationKey: text('operation_key').notNull(),
  taskName: text('task_name').notNull(),
  inputHash: text('input_hash').notNull(),
  adapterVersion: text('adapter_version').notNull(),
  attempt: integer().notNull(),
  state: text().notNull(),
  errorCode: text('error_code'),
  nextAction: text('next_action'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const workerHeartbeats = ops.table('worker_heartbeats', {
  workerKey: text('worker_key').primaryKey(),
  adapterVersion: text('adapter_version').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
});

export const auditEvents = ops.table('audit_events', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  actorType: text('actor_type').notNull(),
  action: text().notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id').notNull(),
  objectRevision: integer('object_revision'),
  correlationId: text('correlation_id').notNull(),
  causationId: text('causation_id'),
  beforeHash: text('before_hash'),
  afterHash: text('after_hash'),
  safeMetadata: jsonb('safe_metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Phase 06 integrity and intelligence-explorer records. These declarations
// intentionally mirror the additive SQL migrations so schema drift is caught.
export const providerDisplayRevisions = catalog.table('provider_display_revisions', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id').notNull(),
  revision: integer().notNull(),
  kind: text().notNull(),
  canonicalName: text('canonical_name').notNull(),
  description: text().notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  sourceObservationId: uuid('source_observation_id'),
  captureState: text('capture_state').notNull(),
  displayHash: text('display_hash').notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerEvidenceBindings = catalog.table('provider_evidence_bindings', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  bindingBasis: text('binding_basis').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scoreRunEvidenceBindings = catalog.table('score_run_evidence_bindings', {
  scoreRunId: uuid('score_run_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dimensionScoreEvidenceBindings = catalog.table('dimension_score_evidence_bindings', {
  dimensionScoreId: uuid('dimension_score_id').notNull(),
  scoreRunId: uuid('score_run_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verificationEvidenceBindings = catalog.table('verification_evidence_bindings', {
  verificationAssessmentId: uuid('verification_assessment_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const compatibilityEvidenceBindings = catalog.table('compatibility_evidence_bindings', {
  compatibilityId: uuid('compatibility_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeProjections = catalog.table('knowledge_projections', {
  id: uuid().primaryKey(),
  providerId: uuid('provider_id').notNull(),
  providerRevision: integer('provider_revision').notNull(),
  projectionVersion: text('projection_version').notNull(),
  publicationState: text('publication_state').notNull(),
  kindProfile: text('kind_profile').notNull(),
  preferredLabel: text('preferred_label').notNull(),
  summary: text().notNull(),
  searchText: text('search_text').notNull(),
  aliases: text().array().notNull().default([]),
  capabilityKeys: text('capability_keys').array().notNull().default([]),
  valueProfile: jsonb('value_profile').notNull(),
  queryValuePolicyVersion: text('query_value_policy_version').notNull().default('query-signal-v1'),
  queryValueConservative: numeric('query_value_conservative', { precision: 9, scale: 6 }),
  queryEvidenceCoverage: numeric('query_evidence_coverage', { precision: 9, scale: 6 }),
  projectionHash: text('projection_hash').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeProjectionSources = catalog.table('knowledge_projection_sources', {
  projectionId: uuid('projection_id').notNull(),
  sourceObservationId: uuid('source_observation_id').notNull(),
  role: text().notNull(),
  sourceAnchor: text('source_anchor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeDocuments = catalog.table('knowledge_documents', {
  id: uuid().primaryKey(),
  documentKind: text('document_kind').notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  canonicalUri: text('canonical_uri').notNull().unique(),
  publisher: text().notNull(),
  publicationState: text('publication_state').notNull(),
  sourceObservationId: uuid('source_observation_id')
    .notNull()
    .references(() => sourceObservations.id),
  searchText: text('search_text').notNull(),
  aliases: text().array().notNull().default([]),
  mechanismKeys: text('mechanism_keys').array().notNull().default([]),
  valueProfile: jsonb('value_profile').notNull(),
  contentDigest: text('content_digest').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeDocumentSubjects = catalog.table(
  'knowledge_document_subjects',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id),
    providerId: uuid('provider_id').references(() => providers.id),
    capabilityDefinitionId: uuid('capability_definition_id').references(
      () => capabilityDefinitions.id,
    ),
    relationType: text('relation_type').notNull(),
    sourceObservationId: uuid('source_observation_id')
      .notNull()
      .references(() => sourceObservations.id),
    rationale: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('knowledge_document_provider_subject_unique')
      .on(table.documentId, table.providerId, table.relationType)
      .where(sql`${table.providerId} IS NOT NULL`),
    uniqueIndex('knowledge_document_capability_subject_unique')
      .on(table.documentId, table.capabilityDefinitionId, table.relationType)
      .where(sql`${table.capabilityDefinitionId} IS NOT NULL`),
  ],
);

export const facetDefinitions = catalog.table('facet_definitions', {
  facetKey: text('facet_key').primaryKey(),
  label: text().notNull(),
  description: text().notNull(),
  selectionMode: text('selection_mode').notNull(),
  displayOrder: integer('display_order').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conceptSchemes = catalog.table(
  'concept_schemes',
  {
    id: uuid().primaryKey(),
    schemeKey: text('scheme_key').notNull(),
    version: integer().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    sourceUri: text('source_uri'),
    supersedesId: uuid('supersedes_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.schemeKey, table.version)],
);

export const concepts = catalog.table(
  'concepts',
  {
    id: uuid().primaryKey(),
    conceptSchemeId: uuid('concept_scheme_id')
      .notNull()
      .references(() => conceptSchemes.id),
    facetKey: text('facet_key')
      .notNull()
      .references(() => facetDefinitions.facetKey),
    stableKey: text('stable_key').notNull(),
    preferredLabel: text('preferred_label').notNull(),
    definition: text().notNull(),
    status: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.conceptSchemeId, table.stableKey)],
);

export const conceptLabels = catalog.table(
  'concept_labels',
  {
    id: uuid().primaryKey(),
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concepts.id),
    label: text().notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    labelKind: text('label_kind').notNull(),
    locale: text().notNull().default('en'),
    sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.conceptId, table.normalizedLabel, table.labelKind, table.locale)],
);

export const conceptRelations = catalog.table('concept_relations', {
  id: uuid().primaryKey(),
  conceptSchemeId: uuid('concept_scheme_id')
    .notNull()
    .references(() => conceptSchemes.id),
  subjectConceptId: uuid('subject_concept_id')
    .notNull()
    .references(() => concepts.id),
  relationType: text('relation_type').notNull(),
  objectConceptId: uuid('object_concept_id')
    .notNull()
    .references(() => concepts.id),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  evidenceBasis: jsonb('evidence_basis').notNull(),
  confidence: numeric({ precision: 5, scale: 4 }).notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeEntities = catalog.table('knowledge_entities', {
  id: uuid().primaryKey(),
  sourceKind: text('source_kind').notNull(),
  providerId: uuid('provider_id').references(() => providers.id),
  documentId: uuid('document_id').references(() => knowledgeDocuments.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeEntityRevisions = catalog.table(
  'knowledge_entity_revisions',
  {
    id: uuid().primaryKey(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => knowledgeEntities.id),
    revision: integer().notNull(),
    entityClassConceptId: uuid('entity_class_concept_id')
      .notNull()
      .references(() => concepts.id),
    entityClassFacetKey: text('entity_class_facet_key').notNull().default('entity_class'),
    preferredLabel: text('preferred_label').notNull(),
    summary: text().notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
    predecessorId: uuid('predecessor_id'),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.entityId, table.revision)],
);

export const intrinsicSignalRuns = catalog.table(
  'intrinsic_signal_runs',
  {
    id: uuid().primaryKey(),
    knowledgeEntityId: uuid('knowledge_entity_id')
      .notNull()
      .references(() => knowledgeEntities.id),
    entityRevisionId: uuid('entity_revision_id')
      .notNull()
      .references(() => knowledgeEntityRevisions.id),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => scorePolicies.id),
    policyVersion: text('policy_version').notNull(),
    profile: text().notNull(),
    inputHash: text('input_hash').notNull(),
    dimensionInputs: jsonb('dimension_inputs').notNull(),
    central: numeric({ precision: 9, scale: 6 }).notNull(),
    uncertainty: numeric({ precision: 9, scale: 6 }).notNull(),
    conservative: numeric({ precision: 9, scale: 6 }).notNull(),
    signalDisplay: integer('signal_display').notNull(),
    displayState: text('display_state').notNull(),
    band: text().notNull(),
    evidenceConfidence: numeric('evidence_confidence', { precision: 9, scale: 6 }).notNull(),
    evidenceConfidenceDetail: jsonb('evidence_confidence_detail').notNull(),
    trendPolicyVersion: text('trend_policy_version').notNull(),
    trendState: text('trend_state').notNull(),
    trendWindowStart: timestamp('trend_window_start', { withTimezone: true }).notNull(),
    trendWindowEnd: timestamp('trend_window_end', { withTimezone: true }).notNull(),
    trendDetail: jsonb('trend_detail').notNull(),
    evidenceIds: uuid('evidence_ids').array().notNull().default([]),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    supersededBy: uuid('superseded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.knowledgeEntityId, table.entityRevisionId, table.policyId, table.inputHash),
  ],
);

export const entityFacetAssignments = catalog.table(
  'entity_facet_assignments',
  {
    id: uuid().primaryKey(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => knowledgeEntities.id),
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concepts.id),
    facetKey: text('facet_key')
      .notNull()
      .references(() => facetDefinitions.facetKey),
    origin: text().notNull(),
    confidence: numeric({ precision: 5, scale: 4 }).notNull(),
    rationale: text().notNull(),
    sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
    evidenceItemIds: uuid('evidence_item_ids').array().notNull().default([]),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    supersedesId: uuid('supersedes_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.entityId, table.conceptId, table.validFrom)],
);

export const knowledgeRelationships = catalog.table('knowledge_relationships', {
  id: uuid().primaryKey(),
  subjectEntityId: uuid('subject_entity_id')
    .notNull()
    .references(() => knowledgeEntities.id),
  relationType: text('relation_type').notNull(),
  objectEntityId: uuid('object_entity_id').references(() => knowledgeEntities.id),
  objectConceptId: uuid('object_concept_id').references(() => concepts.id),
  direction: text().notNull(),
  sourceObservationId: uuid('source_observation_id').references(() => sourceObservations.id),
  evidenceItemIds: uuid('evidence_item_ids').array().notNull().default([]),
  evidenceBasis: jsonb('evidence_basis').notNull(),
  confidence: numeric({ precision: 5, scale: 4 }).notNull(),
  revisionScope: jsonb('revision_scope').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  state: text().notNull(),
  supersedesId: uuid('supersedes_id'),
  legacySourceTable: text('legacy_source_table'),
  legacySourceKey: text('legacy_source_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeDocumentRevisions = catalog.table(
  'knowledge_document_revisions',
  {
    id: uuid().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id),
    revision: integer().notNull(),
    predecessorId: uuid('predecessor_id'),
    supersedesDocumentId: uuid('supersedes_document_id').references(() => knowledgeDocuments.id),
    title: text().notNull(),
    summary: text().notNull(),
    canonicalUri: text('canonical_uri').notNull(),
    publicationState: text('publication_state').notNull(),
    contentDigest: text('content_digest').notNull(),
    sourceObservationId: uuid('source_observation_id')
      .notNull()
      .references(() => sourceObservations.id),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    changeKind: text('change_kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.documentId, table.revision)],
);

export const projectDisplayRevisions = workspace.table('project_display_revisions', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  revision: integer().notNull(),
  name: text().notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  captureState: text('capture_state').notNull(),
  displayHash: text('display_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fitAssessmentEvidenceBindings = workspace.table('fit_assessment_evidence_bindings', {
  id: uuid().primaryKey(),
  fitAssessmentId: uuid('fit_assessment_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  catalogEvidenceId: uuid('catalog_evidence_id'),
  privateEvidenceId: uuid('private_evidence_id'),
  applicabilityScope: text('applicability_scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const decisionDisplaySnapshots = workspace.table('decision_display_snapshots', {
  id: uuid().primaryKey(),
  decisionId: uuid('decision_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  projectName: text('project_name').notNull(),
  needTitle: text('need_title').notNull(),
  candidateLabels: jsonb('candidate_labels').notNull(),
  evidenceManifest: jsonb('evidence_manifest').notNull().default([]),
  captureState: text('capture_state').notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const querySessions = workspace.table('query_sessions', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectContextId: uuid('project_context_id'),
  queryText: text('query_text').notNull(),
  queryHash: text('query_hash').notNull(),
  normalizedIntent: jsonb('normalized_intent').notNull(),
  explicitFacets: jsonb('explicit_facets').notNull().default({}),
  inferredFacets: jsonb('inferred_facets').notNull().default({}),
  interpretationMethod: text('interpretation_method').notNull(),
  interpretationState: text('interpretation_state').notNull(),
  retrievalPolicyVersion: text('retrieval_policy_version').notNull(),
  indexRevision: text('index_revision').notNull(),
  state: text().notNull(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const queryResultSets = workspace.table('query_result_sets', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  querySessionId: uuid('query_session_id').notNull(),
  revision: integer().notNull(),
  predecessorId: uuid('predecessor_id'),
  status: text().notNull(),
  retrievalPolicyVersion: text('retrieval_policy_version').notNull(),
  signalPolicyVersion: text('signal_policy_version').notNull(),
  indexRevision: text('index_revision').notNull(),
  assessedCount: integer('assessed_count').notNull(),
  availableCount: integer('available_count').notNull(),
  truncatedCount: integer('truncated_count').notNull(),
  diagnostics: jsonb().notNull().default({}),
  fusionPolicyVersion: text('fusion_policy_version'),
  rerankPolicyVersion: text('rerank_policy_version'),
  candidatePoolHash: text('candidate_pool_hash'),
  retrievalPasses: integer('retrieval_passes'),
  stopReason: text('stop_reason'),
  coverageAssessment: jsonb('coverage_assessment'),
  resultHash: text('result_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const queryRetrievalRuns = workspace.table(
  'query_retrieval_runs',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    resultSetId: uuid('result_set_id').notNull(),
    passIndex: integer('pass_index').notNull(),
    retrieverKey: text('retriever_key').notNull(),
    retrieverVersion: integer('retriever_version').notNull(),
    sourceClass: text('source_class').notNull(),
    sourceIdentity: text('source_identity').notNull(),
    planRouteId: text('plan_route_id'),
    outboundQuery: text('outbound_query').notNull(),
    nativeResultCount: integer('native_result_count').notNull(),
    returnedCount: integer('returned_count').notNull(),
    responseLimitations: text('response_limitations').notNull(),
    rightsRetentionNotes: text('rights_retention_notes').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.resultSetId, table.passIndex, table.retrieverKey)],
);

export const queryRetrievalHits = workspace.table(
  'query_retrieval_hits',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    retrievalRunId: uuid('retrieval_run_id').notNull(),
    candidateKey: text('candidate_key').notNull(),
    providerId: uuid('provider_id'),
    documentId: uuid('document_id'),
    nativeRank: integer('native_rank').notNull(),
    nativeScore: numeric('native_score', { precision: 18, scale: 9 }).notNull(),
    matchedTerms: text('matched_terms').array().notNull().default([]),
    matchedConceptIds: uuid('matched_concept_ids').array().notNull().default([]),
    explanation: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.retrievalRunId, table.nativeRank),
    unique().on(table.retrievalRunId, table.candidateKey),
  ],
);

export const queryCandidateFusions = workspace.table(
  'query_candidate_fusions',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    resultSetId: uuid('result_set_id').notNull(),
    candidateKey: text('candidate_key').notNull(),
    providerId: uuid('provider_id'),
    documentId: uuid('document_id'),
    candidatePoolPosition: integer('candidate_pool_position').notNull(),
    reciprocalRank: integer('reciprocal_rank').notNull(),
    reciprocalScore: numeric('reciprocal_score', { precision: 18, scale: 12 }).notNull(),
    reciprocalContributions: jsonb('reciprocal_contributions').notNull(),
    reciprocalRerankPosition: integer('reciprocal_rerank_position').notNull(),
    reciprocalRerankScore: numeric('reciprocal_rerank_score', {
      precision: 12,
      scale: 6,
    }).notNull(),
    normalizedWeightedRank: integer('normalized_weighted_rank').notNull(),
    normalizedWeightedScore: numeric('normalized_weighted_score', {
      precision: 18,
      scale: 12,
    }).notNull(),
    normalizedWeightedContributions: jsonb('normalized_weighted_contributions').notNull(),
    normalizedWeightedRerankPosition: integer('normalized_weighted_rerank_position').notNull(),
    normalizedWeightedRerankScore: numeric('normalized_weighted_rerank_score', {
      precision: 12,
      scale: 6,
    }).notNull(),
    selectedFusionPolicy: text('selected_fusion_policy').notNull(),
    selectedFusionRank: integer('selected_fusion_rank').notNull(),
    rerankPolicy: text('rerank_policy').notNull(),
    rerankPosition: integer('rerank_position').notNull(),
    rerankScore: numeric('rerank_score', { precision: 12, scale: 6 }).notNull(),
    matchScore: integer('match_score').notNull(),
    matchBand: text('match_band'),
    matchedTerms: text('matched_terms').array().notNull().default([]),
    matchedConceptIds: uuid('matched_concept_ids').array().notNull().default([]),
    entityResolution: jsonb('entity_resolution').notNull(),
    explanation: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.resultSetId, table.candidateKey),
    unique().on(table.resultSetId, table.rerankPosition),
  ],
);

export const queryPlans = workspace.table(
  'query_plans',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    querySessionId: uuid('query_session_id').notNull(),
    policyVersion: text('policy_version').notNull(),
    intentMode: text('intent_mode').notNull(),
    plan: jsonb().notNull(),
    planHash: text('plan_hash').notNull(),
    budgets: jsonb(),
    stopPolicy: jsonb('stop_policy'),
    stopReason: text('stop_reason'),
    coverageAssessment: jsonb('coverage_assessment'),
    plannedPasses: integer('planned_passes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.querySessionId, table.policyVersion)],
);

export const queryDocumentResults = workspace.table(
  'query_document_results',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    resultSetId: uuid('result_set_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id),
    rankPosition: integer('rank_position').notNull(),
    relevanceOrdinal: text('relevance_ordinal').notNull(),
    relevanceValue: integer('relevance_value').notNull(),
    relevanceAnchors: jsonb('relevance_anchors').notNull(),
    matchedFields: text('matched_fields').array().notNull().default([]),
    signalPolicyVersion: text('signal_policy_version').notNull(),
    kindProfile: text('kind_profile').notNull(),
    valueConservative: numeric('value_conservative', { precision: 9, scale: 6 }).notNull(),
    signalUnrounded: numeric('signal_unrounded', { precision: 12, scale: 8 }).notNull(),
    signalDisplay: integer('signal_display').notNull(),
    evidenceCoverage: numeric('evidence_coverage', { precision: 9, scale: 6 }).notNull(),
    valueInputs: jsonb('value_inputs').notNull(),
    displayState: text('display_state').notNull(),
    explanation: text().notNull(),
    caveats: text().array().notNull().default([]),
    missing: text().array().notNull().default([]),
    inputHash: text('input_hash').notNull(),
    intrinsicSignalRunId: uuid('intrinsic_signal_run_id').references(() => intrinsicSignalRuns.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.resultSetId, table.documentId)],
);

export const querySignalRuns = workspace.table('query_signal_runs', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  resultSetId: uuid('result_set_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  providerRevision: integer('provider_revision').notNull(),
  providerDisplayRevisionId: uuid('provider_display_revision_id').notNull(),
  policyId: uuid('policy_id').notNull(),
  policyVersion: text('policy_version').notNull(),
  relevanceOrdinal: text('relevance_ordinal').notNull(),
  relevanceValue: integer('relevance_value').notNull(),
  relevanceMethod: text('relevance_method').notNull(),
  relevanceAnchors: jsonb('relevance_anchors').notNull(),
  valueInputs: jsonb('value_inputs').notNull(),
  valueCentral: numeric('value_central', { precision: 9, scale: 6 }).notNull(),
  valueUncertainty: numeric('value_uncertainty', { precision: 9, scale: 6 }).notNull(),
  valueConservative: numeric('value_conservative', { precision: 9, scale: 6 }).notNull(),
  evidenceCoverage: numeric('evidence_coverage', { precision: 9, scale: 6 }).notNull(),
  signalUnrounded: numeric('signal_unrounded', { precision: 12, scale: 8 }),
  signalDisplay: integer('signal_display'),
  displayState: text('display_state').notNull(),
  exclusions: text().array().notNull().default([]),
  missing: text().array().notNull().default([]),
  inputHash: text('input_hash').notNull(),
  predecessorId: uuid('predecessor_id'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
});

export const querySignalEvidenceBindings = workspace.table('query_signal_evidence_bindings', {
  querySignalRunId: uuid('query_signal_run_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  dimensionKey: text('dimension_key').notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const queryResultItems = workspace.table('query_result_items', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  resultSetId: uuid('result_set_id').notNull(),
  querySignalRunId: uuid('query_signal_run_id').notNull(),
  intrinsicSignalRunId: uuid('intrinsic_signal_run_id').references(() => intrinsicSignalRuns.id),
  providerId: uuid('provider_id').notNull(),
  providerRevision: integer('provider_revision').notNull(),
  position: integer().notNull(),
  capabilityGroup: text('capability_group').notNull(),
  matchedFields: text('matched_fields').array().notNull().default([]),
  explanation: text().notNull(),
  caveats: text().array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shortlists = workspace.table('shortlists', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectContextId: uuid('project_context_id').notNull(),
  resultSetId: uuid('result_set_id').notNull(),
  name: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shortlistItems = workspace.table('shortlist_items', {
  shortlistId: uuid('shortlist_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  resultItemId: uuid('result_item_id').notNull(),
  note: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shortlistDocumentItems = workspace.table('shortlist_document_items', {
  shortlistId: uuid('shortlist_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  queryDocumentResultId: uuid('query_document_result_id').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourceAdapterConfigs = ops.table('source_adapter_configs', {
  adapterKey: text('adapter_key').primaryKey(),
  adapterVersion: text('adapter_version').notNull(),
  sourceClass: text('source_class').notNull(),
  baseUrl: text('base_url'),
  allowedHosts: text('allowed_hosts').array().notNull().default([]),
  dataDisclosureScope: text('data_disclosure_scope').notNull(),
  credentialReference: text('credential_reference'),
  rightsNotes: text('rights_notes').notNull(),
  perOperationCallLimit: integer('per_operation_call_limit').notNull(),
  dailyCallLimit: integer('daily_call_limit').notNull(),
  timeoutMs: integer('timeout_ms').notNull(),
  responseByteLimit: integer('response_byte_limit').notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  modelIdentifier: text('model_identifier'),
  maxInputTokens: integer('max_input_tokens').notNull().default(4096),
  maxOutputTokens: integer('max_output_tokens').notNull().default(512),
  enabled: boolean().notNull().default(false),
  revision: integer().notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adapterDailyBudgets = ops.table('adapter_daily_budgets', {
  adapterKey: text('adapter_key').notNull(),
  budgetDate: text('budget_date').notNull(),
  reservedCalls: integer('reserved_calls').notNull().default(0),
  consumedCalls: integer('consumed_calls').notNull().default(0),
  deniedCalls: integer('denied_calls').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const discoveryOperations = ops.table('discovery_operations', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  querySessionId: uuid('query_session_id').notNull(),
  resultSetId: uuid('result_set_id'),
  adapterKey: text('adapter_key').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  intent: text().notNull(),
  outboundQuery: text('outbound_query'),
  outboundQueryHash: text('outbound_query_hash').notNull(),
  disclosure: jsonb().notNull(),
  state: text().notNull(),
  reservedCalls: integer('reserved_calls').notNull(),
  consumedCalls: integer('consumed_calls').notNull().default(0),
  resultCount: integer('result_count').notNull().default(0),
  errorCode: text('error_code'),
  safeDetail: text('safe_detail'),
  planRouteId: text('plan_route_id'),
  variantIndex: integer('variant_index').notNull().default(1),
  routingReason: text('routing_reason'),
  sourcePlanState: text('source_plan_state').notNull().default('planned'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const discoveryAttempts = ops.table('discovery_attempts', {
  id: uuid().primaryKey(),
  operationId: uuid('operation_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  attempt: integer().notNull(),
  requestHash: text('request_hash').notNull(),
  state: text().notNull(),
  httpStatus: integer('http_status'),
  responseBytes: integer('response_bytes'),
  resultCount: integer('result_count').notNull().default(0),
  costState: text('cost_state').notNull(),
  costAmount: numeric('cost_amount', { precision: 12, scale: 6 }),
  errorCode: text('error_code'),
  safeDetail: text('safe_detail'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const discoveryCandidates = ops.table('discovery_candidates', {
  id: uuid().primaryKey(),
  operationId: uuid('operation_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  adapterKey: text('adapter_key').notNull(),
  externalId: text('external_id').notNull(),
  canonicalUri: text('canonical_uri').notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  kindHint: text('kind_hint'),
  sourcePayloadHash: text('source_payload_hash').notNull(),
  sourcePayload: jsonb('source_payload').notNull(),
  provenance: jsonb().notNull(),
  reviewState: text('review_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const discoveryAdmissions = ops.table('discovery_admissions', {
  id: uuid().primaryKey(),
  discoveryCandidateId: uuid('discovery_candidate_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  providerRevision: integer('provider_revision').notNull(),
  sourceObservationId: uuid('source_observation_id').notNull(),
  evidenceItemId: uuid('evidence_item_id').notNull(),
  projectionId: uuid('projection_id').notNull(),
  actorType: text('actor_type').notNull(),
  rationale: text().notNull(),
  inputHash: text('input_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const semanticProposals = ops.table('semantic_proposals', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  querySessionId: uuid('query_session_id'),
  operationId: uuid('operation_id'),
  taskKey: text('task_key').notNull(),
  adapterKey: text('adapter_key').notNull(),
  adapterVersion: text('adapter_version').notNull(),
  modelIdentifier: text('model_identifier').notNull(),
  schemaVersion: text('schema_version').notNull(),
  inputHash: text('input_hash').notNull(),
  outputHash: text('output_hash').notNull(),
  output: jsonb().notNull(),
  sourceAnchors: jsonb('source_anchors').notNull(),
  usage: jsonb().notNull().default({}),
  safetyChecks: jsonb('safety_checks').notNull(),
  reviewState: text('review_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const watches = workspace.table('watches', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  providerId: uuid('provider_id'),
  sourceId: uuid('source_id'),
  querySessionId: uuid('query_session_id'),
  cadence: text().notNull(),
  priority: integer().notNull().default(50),
  state: text().notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastSucceededAt: timestamp('last_succeeded_at', { withTimezone: true }),
  sourceWatermark: text('source_watermark'),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const materialChanges = workspace.table('material_changes', {
  id: uuid().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  watchId: uuid('watch_id'),
  providerId: uuid('provider_id'),
  oldObservationId: uuid('old_observation_id'),
  newObservationId: uuid('new_observation_id'),
  predicate: text().notNull(),
  applicabilityScope: text('applicability_scope').notNull(),
  reason: text().notNull(),
  affectedResultSetId: uuid('affected_result_set_id'),
  affectedDecisionId: uuid('affected_decision_id'),
  changeHash: text('change_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const changeNoticeStates = workspace.table('change_notice_states', {
  changeId: uuid('change_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  disposition: text(),
  note: text(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourceHealthEvents = ops.table('source_health_events', {
  id: uuid().primaryKey(),
  adapterKey: text('adapter_key').notNull(),
  sourceId: uuid('source_id'),
  state: text().notNull(),
  safeDetail: text('safe_detail').notNull(),
  observationId: uuid('observation_id'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
