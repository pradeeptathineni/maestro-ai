-- Complete the Prompt 02 data contract without rewriting the already-applied
-- initial migration. All additions are local, additive, and forward-only.

CREATE TABLE IF NOT EXISTS catalog.provider_relations (
  id uuid PRIMARY KEY,
  subject_provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  object_provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  relation_type text NOT NULL CHECK (relation_type IN (
    'implements', 'distributes', 'hosts', 'wraps', 'depends_on',
    'integrates_with', 'alternative_to', 'supersedes', 'fork_of',
    'owned_by', 'compatible_with'
  )),
  applicability_scope text NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subject_provider_id <> object_provider_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (subject_provider_id, object_provider_id, relation_type, valid_from)
);

CREATE TABLE IF NOT EXISTS catalog.identity_resolution_events (
  id uuid PRIMARY KEY,
  identity_scheme text NOT NULL,
  identity_value text NOT NULL,
  from_provider_id uuid REFERENCES catalog.providers(id),
  to_provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  resolution_type text NOT NULL CHECK (resolution_type IN ('linked', 'merged', 'split', 'reverted')),
  rationale text NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  supersedes_id uuid REFERENCES catalog.identity_resolution_events(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.adjudications (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES catalog.claims(id),
  conclusion text NOT NULL CHECK (conclusion IN (
    'accepted_for_scope', 'rejected_for_scope', 'inconclusive', 'requires_verification'
  )),
  scope text NOT NULL,
  evidence_item_ids uuid[] NOT NULL,
  policy_version text NOT NULL,
  rationale text NOT NULL,
  supersedes_id uuid REFERENCES catalog.adjudications(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.evaluation_definitions (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  mode text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS catalog.evaluation_runs (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES catalog.evaluation_definitions(id),
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  provider_version_id uuid REFERENCES catalog.provider_versions(id),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  evidence_item_id uuid REFERENCES catalog.evidence_items(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (definition_id, provider_id, input_hash)
);

CREATE TABLE IF NOT EXISTS catalog.provider_compatibility (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  provider_version_id uuid REFERENCES catalog.provider_versions(id),
  compatibility_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pass', 'fail', 'unknown', 'not_applicable')),
  value jsonb NOT NULL,
  explanation text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (provider_id, provider_version_id, compatibility_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_capability_identity_unique
  ON catalog.provider_capabilities (
    provider_id, provider_version_id, capability_definition_id, delivery_mode
  ) NULLS NOT DISTINCT;

ALTER TABLE workspace.needs ADD COLUMN IF NOT EXISTS stable_id uuid;
UPDATE workspace.needs SET stable_id = id WHERE stable_id IS NULL;
ALTER TABLE workspace.needs ALTER COLUMN stable_id SET NOT NULL;
ALTER TABLE workspace.needs ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES workspace.needs(id);
CREATE UNIQUE INDEX IF NOT EXISTS needs_stable_revision_unique
  ON workspace.needs (workspace_id, stable_id, revision);

CREATE TABLE IF NOT EXISTS workspace.private_sources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  canonical_uri text NOT NULL,
  title text NOT NULL,
  owner text NOT NULL,
  source_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, canonical_uri)
);

CREATE TABLE IF NOT EXISTS workspace.private_evidence_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  source_id uuid REFERENCES workspace.private_sources(id),
  provider_id uuid REFERENCES catalog.providers(id),
  project_context_id uuid NOT NULL REFERENCES workspace.project_contexts(id),
  evidence_type text NOT NULL,
  producer text NOT NULL,
  result jsonb NOT NULL,
  applicability_scope text NOT NULL,
  limitations text[] NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.intake_sources (
  id uuid PRIMARY KEY,
  intake_id uuid NOT NULL UNIQUE REFERENCES ops.intakes(id),
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  submitted_uri text NOT NULL,
  normalized_uri text NOT NULL,
  trust_boundary text NOT NULL DEFAULT 'remote_untrusted'
    CHECK (trust_boundary = 'remote_untrusted'),
  handling_status text NOT NULL DEFAULT 'quarantined'
    CHECK (handling_status IN ('quarantined', 'normalized', 'reviewed', 'rejected')),
  content_digest text CHECK (content_digest IS NULL OR content_digest ~ '^[a-f0-9]{64}$'),
  minimal_metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Composite ownership keys ensure a private child cannot point across workspaces,
-- even if an application bug supplies a valid foreign identifier.
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_workspace_unique
  ON workspace.projects (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_contexts_id_workspace_unique
  ON workspace.project_contexts (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS needs_id_workspace_unique
  ON workspace.needs (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_id_workspace_unique
  ON workspace.candidates (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_id_workspace_need_unique
  ON workspace.candidates (id, workspace_id, need_id);
CREATE UNIQUE INDEX IF NOT EXISTS private_sources_id_workspace_unique
  ON workspace.private_sources (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS intakes_id_workspace_unique
  ON ops.intakes (id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_context_workspace_fk') THEN
    ALTER TABLE workspace.project_contexts ADD CONSTRAINT project_context_workspace_fk
      FOREIGN KEY (project_id, workspace_id) REFERENCES workspace.projects(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'need_context_workspace_fk') THEN
    ALTER TABLE workspace.needs ADD CONSTRAINT need_context_workspace_fk
      FOREIGN KEY (project_context_id, workspace_id)
      REFERENCES workspace.project_contexts(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'constraint_need_workspace_fk') THEN
    ALTER TABLE workspace.constraints ADD CONSTRAINT constraint_need_workspace_fk
      FOREIGN KEY (need_id, workspace_id) REFERENCES workspace.needs(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_need_workspace_fk') THEN
    ALTER TABLE workspace.candidates ADD CONSTRAINT candidate_need_workspace_fk
      FOREIGN KEY (need_id, workspace_id) REFERENCES workspace.needs(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'component_candidate_workspace_fk') THEN
    ALTER TABLE workspace.candidate_components ADD CONSTRAINT component_candidate_workspace_fk
      FOREIGN KEY (candidate_id, workspace_id) REFERENCES workspace.candidates(id, workspace_id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fit_candidate_workspace_fk') THEN
    ALTER TABLE workspace.fit_assessments ADD CONSTRAINT fit_candidate_workspace_fk
      FOREIGN KEY (candidate_id, workspace_id, need_id)
      REFERENCES workspace.candidates(id, workspace_id, need_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fit_need_workspace_fk') THEN
    ALTER TABLE workspace.fit_assessments ADD CONSTRAINT fit_need_workspace_fk
      FOREIGN KEY (need_id, workspace_id) REFERENCES workspace.needs(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fit_context_workspace_fk') THEN
    ALTER TABLE workspace.fit_assessments ADD CONSTRAINT fit_context_workspace_fk
      FOREIGN KEY (project_context_id, workspace_id)
      REFERENCES workspace.project_contexts(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recommendation_need_workspace_fk') THEN
    ALTER TABLE workspace.recommendations ADD CONSTRAINT recommendation_need_workspace_fk
      FOREIGN KEY (need_id, workspace_id) REFERENCES workspace.needs(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recommendation_candidate_workspace_fk') THEN
    ALTER TABLE workspace.recommendations ADD CONSTRAINT recommendation_candidate_workspace_fk
      FOREIGN KEY (candidate_id, workspace_id, need_id)
      REFERENCES workspace.candidates(id, workspace_id, need_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_need_workspace_fk') THEN
    ALTER TABLE workspace.decisions ADD CONSTRAINT decision_need_workspace_fk
      FOREIGN KEY (need_id, workspace_id) REFERENCES workspace.needs(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_context_workspace_fk') THEN
    ALTER TABLE workspace.decisions ADD CONSTRAINT decision_context_workspace_fk
      FOREIGN KEY (project_context_id, workspace_id)
      REFERENCES workspace.project_contexts(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_candidate_workspace_fk') THEN
    ALTER TABLE workspace.decisions ADD CONSTRAINT decision_candidate_workspace_fk
      FOREIGN KEY (selected_candidate_id, workspace_id, need_id)
      REFERENCES workspace.candidates(id, workspace_id, need_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'private_evidence_source_workspace_fk') THEN
    ALTER TABLE workspace.private_evidence_items ADD CONSTRAINT private_evidence_source_workspace_fk
      FOREIGN KEY (source_id, workspace_id)
      REFERENCES workspace.private_sources(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'private_evidence_context_workspace_fk') THEN
    ALTER TABLE workspace.private_evidence_items ADD CONSTRAINT private_evidence_context_workspace_fk
      FOREIGN KEY (project_context_id, workspace_id)
      REFERENCES workspace.project_contexts(id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_source_workspace_fk') THEN
    ALTER TABLE ops.intake_sources ADD CONSTRAINT intake_source_workspace_fk
      FOREIGN KEY (intake_id, workspace_id) REFERENCES ops.intakes(id, workspace_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workspace.enforce_candidate_components() RETURNS trigger AS $$
DECLARE
  target_id uuid;
  target_kind text;
  component_count integer;
  primary_count integer;
BEGIN
  IF TG_TABLE_NAME = 'candidates' THEN
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.candidate_id ELSE NEW.candidate_id END;
  END IF;
  SELECT option_kind INTO target_kind FROM workspace.candidates WHERE id = target_id;
  IF target_kind IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE role = 'primary')
    INTO component_count, primary_count
    FROM workspace.candidate_components WHERE candidate_id = target_id;
  IF target_kind = 'provider' AND (component_count <> 1 OR primary_count <> 1) THEN
    RAISE EXCEPTION 'provider_candidate_component_invariant' USING ERRCODE = '23514';
  ELSIF target_kind = 'composition' AND (component_count < 2 OR primary_count <> 1) THEN
    RAISE EXCEPTION 'composition_candidate_component_invariant' USING ERRCODE = '23514';
  ELSIF target_kind IN ('status_quo', 'build', 'defer') AND component_count <> 0 THEN
    RAISE EXCEPTION 'provider_free_candidate_component_invariant' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidates_component_invariant ON workspace.candidates;
CREATE CONSTRAINT TRIGGER candidates_component_invariant
  AFTER INSERT OR UPDATE ON workspace.candidates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION workspace.enforce_candidate_components();
DROP TRIGGER IF EXISTS candidate_components_invariant ON workspace.candidate_components;
CREATE CONSTRAINT TRIGGER candidate_components_invariant
  AFTER INSERT OR UPDATE OR DELETE ON workspace.candidate_components
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION workspace.enforce_candidate_components();

-- Historical and epistemic records are append-only. Corrections create a new
-- revision or an explicit superseding row.
DROP TRIGGER IF EXISTS provider_relations_immutable ON catalog.provider_relations;
CREATE TRIGGER provider_relations_immutable BEFORE UPDATE OR DELETE ON catalog.provider_relations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS identity_resolution_events_immutable ON catalog.identity_resolution_events;
CREATE TRIGGER identity_resolution_events_immutable BEFORE UPDATE OR DELETE ON catalog.identity_resolution_events
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS evidence_relations_immutable ON catalog.evidence_relations;
CREATE TRIGGER evidence_relations_immutable BEFORE UPDATE OR DELETE ON catalog.evidence_relations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS adjudications_immutable ON catalog.adjudications;
CREATE TRIGGER adjudications_immutable BEFORE UPDATE OR DELETE ON catalog.adjudications
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS evaluation_runs_immutable ON catalog.evaluation_runs;
CREATE TRIGGER evaluation_runs_immutable BEFORE UPDATE OR DELETE ON catalog.evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS dimension_scores_immutable ON catalog.dimension_scores;
CREATE TRIGGER dimension_scores_immutable BEFORE UPDATE OR DELETE ON catalog.dimension_scores
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS verification_assessments_immutable ON catalog.verification_assessments;
CREATE TRIGGER verification_assessments_immutable BEFORE UPDATE OR DELETE ON catalog.verification_assessments
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS needs_immutable ON workspace.needs;
CREATE TRIGGER needs_immutable BEFORE UPDATE OR DELETE ON workspace.needs
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS fit_assessments_immutable ON workspace.fit_assessments;
CREATE TRIGGER fit_assessments_immutable BEFORE UPDATE OR DELETE ON workspace.fit_assessments
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS recommendations_immutable ON workspace.recommendations;
CREATE TRIGGER recommendations_immutable BEFORE UPDATE OR DELETE ON workspace.recommendations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS private_evidence_immutable ON workspace.private_evidence_items;
CREATE TRIGGER private_evidence_immutable BEFORE UPDATE OR DELETE ON workspace.private_evidence_items
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS intake_events_immutable ON ops.intake_events;
CREATE TRIGGER intake_events_immutable BEFORE UPDATE OR DELETE ON ops.intake_events
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS job_attempts_immutable ON ops.job_attempts;
CREATE TRIGGER job_attempts_immutable BEFORE UPDATE OR DELETE ON ops.job_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS audit_events_immutable ON ops.audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON ops.audit_events
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
