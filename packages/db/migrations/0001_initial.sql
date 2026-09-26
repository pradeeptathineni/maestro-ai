CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS workspace;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS catalog.domain_taxonomy_versions (
  id uuid PRIMARY KEY,
  taxonomy_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'draft')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxonomy_key, version)
);

CREATE TABLE IF NOT EXISTS catalog.domain_nodes (
  id uuid PRIMARY KEY,
  taxonomy_version_id uuid NOT NULL REFERENCES catalog.domain_taxonomy_versions(id),
  stable_key text NOT NULL,
  label text NOT NULL,
  definition text NOT NULL,
  parent_id uuid REFERENCES catalog.domain_nodes(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  UNIQUE (taxonomy_version_id, stable_key)
);

CREATE TABLE IF NOT EXISTS catalog.providers (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  canonical_name text NOT NULL,
  description text NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'deprecated', 'archived', 'superseded', 'unknown')),
  visibility text NOT NULL DEFAULT 'global' CHECK (visibility = 'global'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS providers_name_trgm_idx ON catalog.providers USING gin (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS providers_search_idx ON catalog.providers USING gin (
  to_tsvector('simple', canonical_name || ' ' || description)
);

CREATE TABLE IF NOT EXISTS catalog.sources (
  id uuid PRIMARY KEY,
  canonical_uri text NOT NULL UNIQUE,
  title text NOT NULL,
  owner text NOT NULL,
  source_type text NOT NULL,
  authority_scope text NOT NULL,
  visibility text NOT NULL DEFAULT 'global' CHECK (visibility = 'global'),
  redistribution_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.source_observations (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES catalog.sources(id),
  requested_uri text NOT NULL,
  final_uri text NOT NULL,
  observed_at timestamptz NOT NULL,
  retrieval_method text NOT NULL,
  adapter_version text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  excerpt text,
  media_type text,
  trust_boundary text NOT NULL CHECK (trust_boundary IN ('remote_untrusted', 'local_untrusted', 'curated', 'human_entered')),
  handling_status text NOT NULL CHECK (handling_status IN ('quarantined', 'normalized', 'reviewed', 'rejected')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, content_digest, observed_at)
);

CREATE TABLE IF NOT EXISTS catalog.provider_identities (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  scheme text NOT NULL CHECK (length(scheme) BETWEEN 1 AND 100),
  normalized_value text NOT NULL,
  display_value text NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_canonical boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_identity_active_unique
  ON catalog.provider_identities (scheme, normalized_value)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS catalog.provider_aliases (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  alias text NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  UNIQUE (provider_id, alias)
);

CREATE TABLE IF NOT EXISTS catalog.provider_versions (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  upstream_version text NOT NULL,
  normalized_version text,
  release_observed_at timestamptz,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'deprecated', 'archived', 'superseded', 'unknown')),
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, upstream_version)
);

CREATE TABLE IF NOT EXISTS catalog.capability_definitions (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  name text NOT NULL,
  description text NOT NULL,
  input_schema jsonb,
  output_schema jsonb,
  effect_classes text[] NOT NULL DEFAULT '{}',
  parent_id uuid REFERENCES catalog.capability_definitions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stable_key, schema_version)
);

CREATE TABLE IF NOT EXISTS catalog.provider_capabilities (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  provider_version_id uuid REFERENCES catalog.provider_versions(id),
  capability_definition_id uuid NOT NULL REFERENCES catalog.capability_definitions(id),
  delivery_mode text NOT NULL,
  maturity_state text NOT NULL,
  assertion_state text NOT NULL CHECK (assertion_state IN ('publisher_declared', 'observed', 'verified_for_scope', 'disputed', 'unknown')),
  effects text[] NOT NULL DEFAULT '{}',
  constraints jsonb NOT NULL DEFAULT '{}',
  UNIQUE (provider_id, provider_version_id, capability_definition_id, delivery_mode)
);

CREATE TABLE IF NOT EXISTS catalog.domain_memberships (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  domain_node_id uuid NOT NULL REFERENCES catalog.domain_nodes(id),
  origin text NOT NULL CHECK (origin IN ('manual', 'rule', 'source', 'model_proposal')),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale text NOT NULL,
  reviewed boolean NOT NULL DEFAULT false,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  UNIQUE (provider_id, domain_node_id)
);

CREATE TABLE IF NOT EXISTS catalog.claims (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  claimant text NOT NULL CHECK (length(claimant) > 0),
  claimant_relation text NOT NULL CHECK (claimant_relation IN ('publisher', 'independent', 'derived', 'user')),
  predicate text NOT NULL,
  value jsonb NOT NULL,
  scope text NOT NULL,
  workflow_state text NOT NULL CHECK (workflow_state IN ('extracted', 'normalized', 'reviewed', 'disputed', 'superseded', 'withdrawn')),
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS catalog.evidence_items (
  id uuid PRIMARY KEY,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  evidence_type text NOT NULL,
  producer text NOT NULL,
  method_version text NOT NULL,
  result jsonb NOT NULL,
  independence text NOT NULL CHECK (independence IN ('publisher_only', 'partially_independent', 'independent')),
  applicability_scope text NOT NULL,
  limitations text[] NOT NULL DEFAULT '{}',
  quality_flags text[] NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  review_after timestamptz,
  visibility text NOT NULL DEFAULT 'global' CHECK (visibility = 'global'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.evidence_relations (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES catalog.claims(id),
  evidence_item_id uuid NOT NULL REFERENCES catalog.evidence_items(id),
  direction text NOT NULL CHECK (direction IN ('supports', 'contradicts', 'qualifies', 'does_not_address')),
  directness text NOT NULL CHECK (directness IN ('direct', 'derived', 'proxy')),
  strength text NOT NULL CHECK (strength IN ('weak', 'moderate', 'strong')),
  applicability text NOT NULL CHECK (applicability IN ('exact', 'partial', 'weak', 'unknown')),
  rationale text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  UNIQUE (claim_id, evidence_item_id, direction)
);

CREATE TABLE IF NOT EXISTS catalog.score_policies (
  id uuid PRIMARY KEY,
  policy_key text NOT NULL,
  version text NOT NULL,
  policy_document jsonb NOT NULL,
  code_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_key, version)
);

CREATE TABLE IF NOT EXISTS catalog.score_runs (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  provider_version_id uuid REFERENCES catalog.provider_versions(id),
  domain_node_id uuid NOT NULL REFERENCES catalog.domain_nodes(id),
  policy_id uuid NOT NULL REFERENCES catalog.score_policies(id),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  central numeric(7,4) NOT NULL CHECK (central BETWEEN 0 AND 100),
  uncertainty numeric(5,4) NOT NULL CHECK (uncertainty BETWEEN 0 AND 1),
  evidence_coverage numeric(5,4) NOT NULL CHECK (evidence_coverage BETWEEN 0 AND 1),
  lower_bound numeric(7,4) NOT NULL CHECK (lower_bound BETWEEN 0 AND 100),
  band text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL,
  superseded_by uuid REFERENCES catalog.score_runs(id),
  UNIQUE (provider_id, domain_node_id, policy_id, input_hash)
);

CREATE TABLE IF NOT EXISTS catalog.dimension_scores (
  id uuid PRIMARY KEY,
  score_run_id uuid NOT NULL REFERENCES catalog.score_runs(id),
  dimension_key text NOT NULL,
  raw numeric(7,4),
  adjusted numeric(7,4),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  coverage numeric(5,4) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  prior numeric(7,4) NOT NULL,
  state text NOT NULL CHECK (state IN ('present', 'missing', 'zero', 'stale', 'contradicted', 'not_applicable')),
  reasons text[] NOT NULL DEFAULT '{}',
  missing text[] NOT NULL DEFAULT '{}',
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (score_run_id, dimension_key)
);

CREATE TABLE IF NOT EXISTS catalog.verification_assessments (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  claim_id uuid REFERENCES catalog.claims(id),
  policy_version text NOT NULL,
  scope text NOT NULL,
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
  base_priority integer NOT NULL CHECK (base_priority BETWEEN 0 AND 100),
  state text NOT NULL CHECK (state IN ('not_needed_for_scope', 'candidate', 'planned', 'in_progress', 'partially_verified', 'verified_for_scope', 'contradicted', 'inconclusive', 'expired', 'cancelled')),
  modes text[] NOT NULL,
  factors jsonb NOT NULL,
  adjustments text[] NOT NULL DEFAULT '{}',
  next_plan text,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace.workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace.projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  name text NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'paused', 'retired', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS workspace.project_contexts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  project_id uuid NOT NULL REFERENCES workspace.projects(id),
  revision integer NOT NULL CHECK (revision > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  context_document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, revision),
  UNIQUE (project_id, snapshot_hash)
);

CREATE TABLE IF NOT EXISTS workspace.needs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  project_context_id uuid NOT NULL REFERENCES workspace.project_contexts(id),
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL,
  desired_outcome text NOT NULL,
  success_criteria text[] NOT NULL,
  required_capability_keys text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'active', 'decided', 'superseded', 'closed')),
  decision_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace.constraints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  need_id uuid NOT NULL REFERENCES workspace.needs(id),
  kind text NOT NULL CHECK (kind IN ('hard_gate', 'preference')),
  constraint_key text NOT NULL,
  label text NOT NULL,
  operator text NOT NULL,
  expected_value jsonb NOT NULL,
  unknown_handling text NOT NULL CHECK (unknown_handling IN ('block', 'penalize', 'allow_with_warning')),
  weight numeric(6,4),
  UNIQUE (need_id, constraint_key)
);

CREATE TABLE IF NOT EXISTS workspace.candidates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  need_id uuid NOT NULL REFERENCES workspace.needs(id),
  option_kind text NOT NULL CHECK (option_kind IN ('provider', 'composition', 'status_quo', 'build', 'defer')),
  label text NOT NULL,
  context_snapshot_hash text NOT NULL CHECK (context_snapshot_hash ~ '^[a-f0-9]{64}$'),
  discovery_origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (need_id, label)
);

CREATE TABLE IF NOT EXISTS workspace.candidate_components (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  candidate_id uuid NOT NULL REFERENCES workspace.candidates(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  provider_version_id uuid REFERENCES catalog.provider_versions(id),
  capability_definition_id uuid REFERENCES catalog.capability_definitions(id),
  role text NOT NULL CHECK (role IN ('primary', 'supporting', 'alternative')),
  UNIQUE (candidate_id, provider_id, role)
);

CREATE TABLE IF NOT EXISTS workspace.fit_assessments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  candidate_id uuid NOT NULL REFERENCES workspace.candidates(id),
  need_id uuid NOT NULL REFERENCES workspace.needs(id),
  project_context_id uuid NOT NULL REFERENCES workspace.project_contexts(id),
  policy_version text NOT NULL,
  eligibility text NOT NULL CHECK (eligibility IN ('eligible', 'ineligible', 'unknown_blocked')),
  gate_results jsonb NOT NULL,
  preference_result jsonb,
  rationale text[] NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  author_type text NOT NULL CHECK (author_type IN ('rule', 'human', 'model_proposal')),
  review_state text NOT NULL,
  generated_at timestamptz NOT NULL,
  UNIQUE (candidate_id, policy_version, input_hash)
);

CREATE TABLE IF NOT EXISTS workspace.recommendations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  need_id uuid NOT NULL REFERENCES workspace.needs(id),
  candidate_id uuid REFERENCES workspace.candidates(id),
  outcome text NOT NULL CHECK (outcome IN ('consider', 'trial', 'adopt', 'defer', 'avoid', 'no_decision')),
  explanation text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL,
  generated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace.decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  need_id uuid NOT NULL REFERENCES workspace.needs(id),
  project_context_id uuid NOT NULL REFERENCES workspace.project_contexts(id),
  selected_candidate_id uuid REFERENCES workspace.candidates(id),
  outcome text NOT NULL CHECK (outcome IN ('trial', 'adopt', 'defer', 'avoid', 'no_decision')),
  rationale text NOT NULL,
  conditions text[] NOT NULL DEFAULT '{}',
  receipt jsonb NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  decided_at timestamptz NOT NULL,
  supersedes_id uuid REFERENCES workspace.decisions(id),
  UNIQUE (workspace_id, input_hash)
);

CREATE TABLE IF NOT EXISTS ops.intakes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  original_url text NOT NULL,
  normalized_url text NOT NULL,
  hostname text NOT NULL,
  note text,
  found_by text NOT NULL,
  strong_identity_scheme text,
  strong_identity_value text,
  state text NOT NULL CHECK (state IN ('submitted', 'duplicate', 'rejected_invalid', 'queued', 'fetching_metadata', 'manual_review_required', 'fetched', 'fetch_failed', 'identity_candidates_ready', 'curated', 'rejected', 'merged_duplicate')),
  failure_code text,
  retry_disposition text CHECK (retry_disposition IN ('none', 'transient', 'terminal', 'manual') OR retry_disposition IS NULL),
  idempotency_key text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, normalized_url),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ops.intake_events (
  id uuid PRIMARY KEY,
  intake_id uuid NOT NULL REFERENCES ops.intakes(id),
  state text NOT NULL,
  safe_detail text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.outbox (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  task_name text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.job_attempts (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL,
  task_name text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  adapter_version text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('started', 'succeeded', 'transient_failure', 'terminal_failure')),
  error_code text,
  next_action text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (operation_key, attempt)
);

CREATE TABLE IF NOT EXISTS ops.audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspace.workspaces(id),
  actor_type text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  object_revision integer,
  correlation_id text NOT NULL,
  causation_id text,
  before_hash text,
  after_hash text,
  safe_metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.reject_immutable_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_observations_immutable ON catalog.source_observations;
CREATE TRIGGER source_observations_immutable BEFORE UPDATE OR DELETE ON catalog.source_observations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS claims_immutable ON catalog.claims;
CREATE TRIGGER claims_immutable BEFORE UPDATE OR DELETE ON catalog.claims
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS evidence_items_immutable ON catalog.evidence_items;
CREATE TRIGGER evidence_items_immutable BEFORE UPDATE OR DELETE ON catalog.evidence_items
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS score_runs_immutable ON catalog.score_runs;
CREATE TRIGGER score_runs_immutable BEFORE UPDATE OR DELETE ON catalog.score_runs
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS project_contexts_immutable ON workspace.project_contexts;
CREATE TRIGGER project_contexts_immutable BEFORE UPDATE OR DELETE ON workspace.project_contexts
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS decisions_immutable ON workspace.decisions;
CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE ON workspace.decisions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

