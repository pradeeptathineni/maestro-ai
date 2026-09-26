import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
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
