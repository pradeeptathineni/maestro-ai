-- Phase 06 bounded adapters, atomic budgets, review admissions and change attention.

CREATE TABLE IF NOT EXISTS ops.source_adapter_configs (
  adapter_key text PRIMARY KEY,
  adapter_version text NOT NULL,
  source_class text NOT NULL
    CHECK (source_class IN ('native_api', 'metasearch', 'approved_html', 'local_semantic')),
  base_url text,
  allowed_hosts text[] NOT NULL DEFAULT '{}',
  data_disclosure_scope text NOT NULL,
  credential_reference text,
  rights_notes text NOT NULL,
  per_operation_call_limit integer NOT NULL CHECK (per_operation_call_limit BETWEEN 0 AND 100),
  daily_call_limit integer NOT NULL CHECK (daily_call_limit BETWEEN 0 AND 10000),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 45000),
  response_byte_limit integer NOT NULL CHECK (response_byte_limit BETWEEN 1024 AND 2097152),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.source_adapter_configs
  (adapter_key, adapter_version, source_class, base_url, allowed_hosts,
   data_disclosure_scope, rights_notes, per_operation_call_limit, daily_call_limit,
   timeout_ms, response_byte_limit, max_attempts, enabled)
VALUES
  ('github', 'github-rest-v1', 'native_api', 'https://api.github.com', ARRAY['api.github.com'],
   'approved public query text only', 'Public repository metadata; upstream terms and rate limits apply.',
   2, 20, 10000, 524288, 2, false),
  ('mcp_registry', 'mcp-registry-v0.1', 'native_api', 'https://registry.modelcontextprotocol.io',
   ARRAY['registry.modelcontextprotocol.io'], 'approved public query text only',
   'Publisher/registry metadata; registry presence is not installation or safety approval.',
   2, 20, 10000, 524288, 2, false),
  ('searxng', 'searxng-json-v1', 'metasearch', NULL, ARRAY[]::text[],
   'approved public query text is forwarded to configured external engines',
   'Operator must configure a trusted instance with JSON output and acceptable engine terms.',
   1, 10, 10000, 524288, 1, false),
  ('local_semantic', 'ai-sdk-structured-v1', 'local_semantic', NULL, ARRAY[]::text[],
   'explicit public query and selected public source excerpts only; never private context',
   'Explicit loopback endpoint only; no cloud or gateway fallback and no automatic model download.',
   2, 20, 30000, 524288, 1, false)
ON CONFLICT (adapter_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ops.adapter_daily_budgets (
  adapter_key text NOT NULL REFERENCES ops.source_adapter_configs(adapter_key),
  budget_date date NOT NULL,
  reserved_calls integer NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
  consumed_calls integer NOT NULL DEFAULT 0 CHECK (consumed_calls >= 0),
  denied_calls integer NOT NULL DEFAULT 0 CHECK (denied_calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter_key, budget_date)
);

CREATE TABLE IF NOT EXISTS ops.discovery_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  query_session_id uuid NOT NULL,
  result_set_id uuid,
  adapter_key text NOT NULL REFERENCES ops.source_adapter_configs(adapter_key),
  idempotency_key text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('explore', 'deepen', 'refresh', 'semantic_interpretation')),
  outbound_query text,
  outbound_query_hash text NOT NULL CHECK (outbound_query_hash ~ '^[a-f0-9]{64}$'),
  disclosure jsonb NOT NULL,
  state text NOT NULL
    CHECK (state IN ('queued', 'running', 'partial', 'complete', 'failed', 'cancel_requested', 'cancelled', 'not_configured', 'budget_denied')),
  reserved_calls integer NOT NULL CHECK (reserved_calls >= 0),
  consumed_calls integer NOT NULL DEFAULT 0 CHECK (consumed_calls >= 0),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  error_code text,
  safe_detail text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE IF NOT EXISTS ops.discovery_attempts (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('started', 'succeeded', 'partial', 'failed', 'cancelled')),
  http_status integer,
  response_bytes integer CHECK (response_bytes IS NULL OR response_bytes >= 0),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  cost_state text NOT NULL CHECK (cost_state IN ('zero', 'measured', 'unavailable')),
  cost_amount numeric(12,6),
  error_code text,
  safe_detail text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (operation_id, attempt),
  FOREIGN KEY (operation_id, workspace_id)
    REFERENCES ops.discovery_operations(id, workspace_id),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((cost_state = 'measured' AND cost_amount IS NOT NULL) OR
         (cost_state <> 'measured' AND cost_amount IS NULL))
);

CREATE TABLE IF NOT EXISTS ops.discovery_candidates (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  adapter_key text NOT NULL,
  external_id text NOT NULL,
  canonical_uri text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  kind_hint text,
  source_payload_hash text NOT NULL CHECK (source_payload_hash ~ '^[a-f0-9]{64}$'),
  source_payload jsonb NOT NULL,
  provenance jsonb NOT NULL,
  review_state text NOT NULL CHECK (review_state IN ('lead', 'admitted', 'rejected', 'duplicate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter_key, external_id, source_payload_hash),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (operation_id, workspace_id)
    REFERENCES ops.discovery_operations(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS ops.discovery_admissions (
  id uuid PRIMARY KEY,
  discovery_candidate_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  provider_revision integer NOT NULL,
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  evidence_item_id uuid NOT NULL REFERENCES catalog.evidence_items(id),
  projection_id uuid NOT NULL REFERENCES catalog.knowledge_projections(id),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent_proxy')),
  rationale text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discovery_candidate_id),
  FOREIGN KEY (discovery_candidate_id, workspace_id)
    REFERENCES ops.discovery_candidates(id, workspace_id),
  FOREIGN KEY (provider_id, provider_revision)
    REFERENCES catalog.providers(id, revision)
);

CREATE TABLE IF NOT EXISTS ops.semantic_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  query_session_id uuid,
  task_key text NOT NULL CHECK (task_key IN ('query_interpretation', 'claim_extraction', 'relevance_label')),
  adapter_key text NOT NULL REFERENCES ops.source_adapter_configs(adapter_key),
  adapter_version text NOT NULL,
  model_identifier text NOT NULL,
  schema_version text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text NOT NULL CHECK (output_hash ~ '^[a-f0-9]{64}$'),
  output jsonb NOT NULL,
  source_anchors jsonb NOT NULL,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  safety_checks jsonb NOT NULL,
  review_state text NOT NULL CHECK (review_state IN ('proposed', 'accepted', 'rejected', 'invalid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS workspace.watches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  provider_id uuid REFERENCES catalog.providers(id),
  source_id uuid REFERENCES catalog.sources(id),
  query_session_id uuid,
  cadence text NOT NULL CHECK (cadence IN ('manual', 'daily', 'weekly')),
  priority integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  state text NOT NULL CHECK (state IN ('active', 'paused')),
  last_checked_at timestamptz,
  last_succeeded_at timestamptz,
  source_watermark text,
  next_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id),
  CHECK (provider_id IS NOT NULL OR source_id IS NOT NULL OR query_session_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS workspace.material_changes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  watch_id uuid,
  provider_id uuid REFERENCES catalog.providers(id),
  old_observation_id uuid REFERENCES catalog.source_observations(id),
  new_observation_id uuid REFERENCES catalog.source_observations(id),
  predicate text NOT NULL,
  applicability_scope text NOT NULL,
  reason text NOT NULL,
  affected_result_set_id uuid,
  affected_decision_id uuid,
  change_hash text NOT NULL CHECK (change_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, change_hash),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (watch_id, workspace_id) REFERENCES workspace.watches(id, workspace_id),
  FOREIGN KEY (affected_result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  FOREIGN KEY (affected_decision_id, workspace_id)
    REFERENCES workspace.decisions(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS workspace.change_notice_states (
  change_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  seen_at timestamptz,
  disposition text CHECK (disposition IN ('reviewed', 'irrelevant', 'requery', 'reassess')),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (change_id, workspace_id),
  FOREIGN KEY (change_id, workspace_id)
    REFERENCES workspace.material_changes(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS ops.source_health_events (
  id uuid PRIMARY KEY,
  adapter_key text NOT NULL REFERENCES ops.source_adapter_configs(adapter_key),
  source_id uuid REFERENCES catalog.sources(id),
  state text NOT NULL CHECK (state IN ('healthy', 'unchanged', 'changed', 'partial', 'failed', 'not_configured')),
  safe_detail text NOT NULL,
  observation_id uuid REFERENCES catalog.source_observations(id),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS discovery_attempts_immutable ON ops.discovery_attempts;
CREATE TRIGGER discovery_attempts_immutable
  BEFORE UPDATE OR DELETE ON ops.discovery_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS discovery_candidates_immutable ON ops.discovery_candidates;
CREATE TRIGGER discovery_candidates_immutable
  BEFORE UPDATE OR DELETE ON ops.discovery_candidates
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS discovery_admissions_immutable ON ops.discovery_admissions;
CREATE TRIGGER discovery_admissions_immutable
  BEFORE UPDATE OR DELETE ON ops.discovery_admissions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS semantic_proposals_immutable ON ops.semantic_proposals;
CREATE TRIGGER semantic_proposals_immutable
  BEFORE UPDATE OR DELETE ON ops.semantic_proposals
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS material_changes_immutable ON workspace.material_changes;
CREATE TRIGGER material_changes_immutable
  BEFORE UPDATE OR DELETE ON workspace.material_changes
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS source_health_events_immutable ON ops.source_health_events;
CREATE TRIGGER source_health_events_immutable
  BEFORE UPDATE OR DELETE ON ops.source_health_events
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
