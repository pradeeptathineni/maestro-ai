-- Phase 06 maintained knowledge and immutable query-result snapshots.

CREATE TABLE IF NOT EXISTS catalog.knowledge_projections (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL,
  provider_revision integer NOT NULL CHECK (provider_revision > 0),
  projection_version text NOT NULL,
  publication_state text NOT NULL
    CHECK (publication_state IN ('lead', 'proposed', 'reviewed', 'stale', 'withdrawn')),
  kind_profile text NOT NULL,
  preferred_label text NOT NULL,
  summary text NOT NULL,
  search_text text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  capability_keys text[] NOT NULL DEFAULT '{}',
  value_profile jsonb NOT NULL,
  projection_hash text NOT NULL CHECK (projection_hash ~ '^[a-f0-9]{64}$'),
  indexed_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_revision, projection_version),
  FOREIGN KEY (provider_id, provider_revision)
    REFERENCES catalog.providers(id, revision),
  CHECK (expires_at IS NULL OR expires_at > indexed_at)
);

CREATE INDEX IF NOT EXISTS knowledge_projection_search_idx
  ON catalog.knowledge_projections USING gin (
    to_tsvector('simple'::regconfig, preferred_label || ' ' || summary || ' ' || search_text)
  );
CREATE INDEX IF NOT EXISTS knowledge_projection_label_trgm_idx
  ON catalog.knowledge_projections USING gin (preferred_label gin_trgm_ops);
CREATE INDEX IF NOT EXISTS knowledge_projection_aliases_idx
  ON catalog.knowledge_projections USING gin (aliases);
CREATE INDEX IF NOT EXISTS knowledge_projection_capability_idx
  ON catalog.knowledge_projections USING gin (capability_keys);

CREATE TABLE IF NOT EXISTS catalog.knowledge_projection_sources (
  projection_id uuid NOT NULL REFERENCES catalog.knowledge_projections(id),
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  role text NOT NULL CHECK (role IN ('identity', 'capability', 'value', 'caveat', 'freshness')),
  source_anchor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (projection_id, source_observation_id, role)
);

CREATE TABLE IF NOT EXISTS workspace.query_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  project_context_id uuid,
  query_text text NOT NULL CHECK (length(query_text) BETWEEN 1 AND 1000),
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  normalized_intent jsonb NOT NULL,
  explicit_facets jsonb NOT NULL DEFAULT '{}'::jsonb,
  inferred_facets jsonb NOT NULL DEFAULT '{}'::jsonb,
  interpretation_method text NOT NULL,
  interpretation_state text NOT NULL
    CHECK (interpretation_state IN ('deterministic', 'provisional', 'reviewed')),
  retrieval_policy_version text NOT NULL,
  index_revision text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'saved', 'expired')),
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_context_id, workspace_id)
    REFERENCES workspace.project_contexts(id, workspace_id)
);

CREATE INDEX IF NOT EXISTS query_sessions_retention_idx
  ON workspace.query_sessions (workspace_id, retention_until);

CREATE TABLE IF NOT EXISTS workspace.query_result_sets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  query_session_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  predecessor_id uuid REFERENCES workspace.query_result_sets(id),
  status text NOT NULL CHECK (status IN ('complete', 'partial', 'failed', 'expired')),
  retrieval_policy_version text NOT NULL,
  signal_policy_version text NOT NULL,
  index_revision text NOT NULL,
  assessed_count integer NOT NULL CHECK (assessed_count >= 0),
  available_count integer NOT NULL CHECK (available_count >= assessed_count),
  truncated_count integer NOT NULL CHECK (truncated_count >= 0),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (query_session_id, revision),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS workspace.query_signal_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  provider_revision integer NOT NULL,
  provider_display_revision_id uuid NOT NULL,
  policy_id uuid NOT NULL REFERENCES catalog.score_policies(id),
  policy_version text NOT NULL,
  relevance_ordinal text NOT NULL
    CHECK (relevance_ordinal IN ('no_match', 'incidental', 'complementary', 'partial', 'direct')),
  relevance_value integer NOT NULL CHECK (relevance_value IN (0, 25, 50, 75, 100)),
  relevance_method text NOT NULL CHECK (relevance_method IN ('rule', 'human', 'model_proposal')),
  relevance_anchors jsonb NOT NULL,
  value_inputs jsonb NOT NULL,
  value_central numeric(9,6) NOT NULL CHECK (value_central BETWEEN 0 AND 100),
  value_uncertainty numeric(9,6) NOT NULL CHECK (value_uncertainty BETWEEN 0 AND 1),
  value_conservative numeric(9,6) NOT NULL CHECK (value_conservative BETWEEN 0 AND 100),
  evidence_coverage numeric(9,6) NOT NULL CHECK (evidence_coverage BETWEEN 0 AND 1),
  signal_unrounded numeric(12,8),
  signal_display integer CHECK (signal_display BETWEEN 0 AND 100),
  display_state text NOT NULL
    CHECK (display_state IN ('available', 'insufficient_evidence', 'provisional', 'excluded')),
  exclusions text[] NOT NULL DEFAULT '{}',
  missing text[] NOT NULL DEFAULT '{}',
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  predecessor_id uuid REFERENCES workspace.query_signal_runs(id),
  generated_at timestamptz NOT NULL,
  UNIQUE (result_set_id, provider_id),
  UNIQUE (id, workspace_id),
  UNIQUE (id, workspace_id, result_set_id, provider_id, provider_revision),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  FOREIGN KEY (provider_id, provider_revision)
    REFERENCES catalog.providers(id, revision),
  FOREIGN KEY (provider_display_revision_id, provider_id, provider_revision)
    REFERENCES catalog.provider_display_revisions(id, provider_id, revision)
);

CREATE TABLE IF NOT EXISTS workspace.query_signal_evidence_bindings (
  query_signal_run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  evidence_item_id uuid NOT NULL,
  dimension_key text NOT NULL,
  applicability_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (query_signal_run_id, evidence_item_id, dimension_key),
  FOREIGN KEY (query_signal_run_id, workspace_id)
    REFERENCES workspace.query_signal_runs(id, workspace_id),
  FOREIGN KEY (provider_id, evidence_item_id)
    REFERENCES catalog.provider_evidence_bindings(provider_id, evidence_item_id)
);

CREATE OR REPLACE FUNCTION workspace.enforce_query_signal_evidence_subject() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workspace.query_signal_runs qsr
    WHERE qsr.id = NEW.query_signal_run_id
      AND qsr.workspace_id = NEW.workspace_id
      AND qsr.provider_id = NEW.provider_id
  ) THEN
    RAISE EXCEPTION 'query_signal_evidence_subject_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS query_signal_evidence_subject_guard
  ON workspace.query_signal_evidence_bindings;
CREATE TRIGGER query_signal_evidence_subject_guard
  BEFORE INSERT ON workspace.query_signal_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION workspace.enforce_query_signal_evidence_subject();

CREATE TABLE IF NOT EXISTS workspace.query_result_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  query_signal_run_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  provider_revision integer NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  capability_group text NOT NULL,
  matched_fields text[] NOT NULL DEFAULT '{}',
  explanation text NOT NULL,
  caveats text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_set_id, position),
  UNIQUE (result_set_id, provider_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  FOREIGN KEY (query_signal_run_id, workspace_id)
    REFERENCES workspace.query_signal_runs(id, workspace_id),
  FOREIGN KEY (provider_id, provider_revision)
    REFERENCES catalog.providers(id, revision)
);

CREATE TABLE IF NOT EXISTS workspace.shortlists (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  project_context_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_context_id, workspace_id)
    REFERENCES workspace.project_contexts(id, workspace_id),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS workspace.shortlist_items (
  shortlist_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  result_item_id uuid NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shortlist_id, result_item_id),
  FOREIGN KEY (shortlist_id, workspace_id)
    REFERENCES workspace.shortlists(id, workspace_id),
  FOREIGN KEY (result_item_id, workspace_id)
    REFERENCES workspace.query_result_items(id, workspace_id)
);

DROP TRIGGER IF EXISTS knowledge_projections_immutable ON catalog.knowledge_projections;
CREATE TRIGGER knowledge_projections_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_projections
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS knowledge_projection_sources_immutable ON catalog.knowledge_projection_sources;
CREATE TRIGGER knowledge_projection_sources_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_projection_sources
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_sessions_immutable ON workspace.query_sessions;
CREATE TRIGGER query_sessions_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_sessions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_result_sets_immutable ON workspace.query_result_sets;
CREATE TRIGGER query_result_sets_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_result_sets
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_signal_runs_immutable ON workspace.query_signal_runs;
CREATE TRIGGER query_signal_runs_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_signal_runs
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_signal_evidence_bindings_immutable
  ON workspace.query_signal_evidence_bindings;
CREATE TRIGGER query_signal_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_signal_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_result_items_immutable ON workspace.query_result_items;
CREATE TRIGGER query_result_items_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_result_items
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS shortlists_immutable ON workspace.shortlists;
CREATE TRIGGER shortlists_immutable
  BEFORE UPDATE OR DELETE ON workspace.shortlists
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS shortlist_items_immutable ON workspace.shortlist_items;
CREATE TRIGGER shortlist_items_immutable
  BEFORE UPDATE OR DELETE ON workspace.shortlist_items
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
