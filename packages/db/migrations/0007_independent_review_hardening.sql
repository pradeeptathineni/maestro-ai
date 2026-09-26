-- Independent-review hardening: bind version ownership and need context at the
-- database boundary, and keep the semantic inputs behind historical receipts
-- append-only once they have been used.

CREATE UNIQUE INDEX IF NOT EXISTS provider_versions_id_provider_unique
  ON catalog.provider_versions (id, provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS needs_id_workspace_context_unique
  ON workspace.needs (id, workspace_id, project_context_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capability_version_provider_fk') THEN
    ALTER TABLE catalog.provider_capabilities ADD CONSTRAINT capability_version_provider_fk
      FOREIGN KEY (provider_version_id, provider_id)
      REFERENCES catalog.provider_versions(id, provider_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_version_provider_fk') THEN
    ALTER TABLE catalog.score_runs ADD CONSTRAINT score_version_provider_fk
      FOREIGN KEY (provider_version_id, provider_id)
      REFERENCES catalog.provider_versions(id, provider_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_version_provider_fk') THEN
    ALTER TABLE catalog.evaluation_runs ADD CONSTRAINT evaluation_version_provider_fk
      FOREIGN KEY (provider_version_id, provider_id)
      REFERENCES catalog.provider_versions(id, provider_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compatibility_version_provider_fk') THEN
    ALTER TABLE catalog.provider_compatibility ADD CONSTRAINT compatibility_version_provider_fk
      FOREIGN KEY (provider_version_id, provider_id)
      REFERENCES catalog.provider_versions(id, provider_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'component_version_provider_fk') THEN
    ALTER TABLE workspace.candidate_components ADD CONSTRAINT component_version_provider_fk
      FOREIGN KEY (provider_version_id, provider_id)
      REFERENCES catalog.provider_versions(id, provider_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fit_need_context_workspace_fk') THEN
    ALTER TABLE workspace.fit_assessments ADD CONSTRAINT fit_need_context_workspace_fk
      FOREIGN KEY (need_id, workspace_id, project_context_id)
      REFERENCES workspace.needs(id, workspace_id, project_context_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_need_context_workspace_fk') THEN
    ALTER TABLE workspace.decisions ADD CONSTRAINT decision_need_context_workspace_fk
      FOREIGN KEY (need_id, workspace_id, project_context_id)
      REFERENCES workspace.needs(id, workspace_id, project_context_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workspace.enforce_candidate_context_snapshot() RETURNS trigger AS $$
DECLARE
  expected_snapshot text;
BEGIN
  SELECT pc.snapshot_hash INTO expected_snapshot
  FROM workspace.needs n
  JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
  WHERE n.id = NEW.need_id AND n.workspace_id = NEW.workspace_id;

  IF expected_snapshot IS NULL OR NEW.context_snapshot_hash IS DISTINCT FROM expected_snapshot THEN
    RAISE EXCEPTION 'candidate_context_snapshot_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidate_context_snapshot_guard ON workspace.candidates;
CREATE TRIGGER candidate_context_snapshot_guard
  BEFORE INSERT OR UPDATE ON workspace.candidates
  FOR EACH ROW EXECUTE FUNCTION workspace.enforce_candidate_context_snapshot();

CREATE OR REPLACE FUNCTION workspace.reject_late_constraint() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace.constraints existing
    WHERE existing.need_id = NEW.need_id
      AND existing.constraint_key = NEW.constraint_key
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspace.fit_assessments
    WHERE need_id = NEW.need_id AND workspace_id = NEW.workspace_id
  ) OR EXISTS (
    SELECT 1 FROM workspace.decisions
    WHERE need_id = NEW.need_id AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'need_constraints_already_sealed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS constraints_seal_before_use ON workspace.constraints;
CREATE TRIGGER constraints_seal_before_use
  BEFORE INSERT ON workspace.constraints
  FOR EACH ROW EXECUTE FUNCTION workspace.reject_late_constraint();

CREATE OR REPLACE FUNCTION workspace.reject_late_candidate_component() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace.candidate_components existing
    WHERE existing.candidate_id = NEW.candidate_id
      AND existing.provider_id = NEW.provider_id
      AND existing.role = NEW.role
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspace.fit_assessments
    WHERE candidate_id = NEW.candidate_id AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'candidate_components_already_assessed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM workspace.candidates c
    JOIN workspace.decisions d
      ON d.need_id = c.need_id AND d.workspace_id = c.workspace_id
    WHERE c.id = NEW.candidate_id
      AND d.receipt->'candidateIds' ? NEW.candidate_id::text
  ) THEN
    RAISE EXCEPTION 'candidate_components_already_sealed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidate_components_seal_after_decision ON workspace.candidate_components;
CREATE TRIGGER candidate_components_seal_after_decision
  BEFORE INSERT ON workspace.candidate_components
  FOR EACH ROW EXECUTE FUNCTION workspace.reject_late_candidate_component();

DROP TRIGGER IF EXISTS score_policies_immutable ON catalog.score_policies;
CREATE TRIGGER score_policies_immutable BEFORE UPDATE OR DELETE ON catalog.score_policies
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS constraints_immutable ON workspace.constraints;
CREATE TRIGGER constraints_immutable BEFORE UPDATE OR DELETE ON workspace.constraints
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS candidates_immutable ON workspace.candidates;
CREATE TRIGGER candidates_immutable BEFORE UPDATE OR DELETE ON workspace.candidates
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS candidate_components_immutable ON workspace.candidate_components;
CREATE TRIGGER candidate_components_immutable BEFORE UPDATE OR DELETE ON workspace.candidate_components
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

-- A started attempt may transition exactly once, and the terminal receipt must
-- carry a coherent error/next-action shape and non-negative elapsed time.
CREATE OR REPLACE FUNCTION ops.enforce_job_attempt_finalize() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'started' OR OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'immutable_record' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.task_name IS DISTINCT FROM OLD.task_name
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.adapter_version IS DISTINCT FROM OLD.adapter_version
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.finished_at IS NULL
     OR NEW.finished_at < NEW.started_at
     OR NOT (
       (NEW.state = 'succeeded' AND NEW.error_code IS NULL AND NEW.next_action = 'human_review')
       OR (NEW.state = 'transient_failure' AND NEW.error_code IS NOT NULL
           AND NEW.next_action = 'bounded_retry')
       OR (NEW.state = 'terminal_failure' AND NEW.error_code IS NOT NULL
           AND NEW.next_action = 'manual_review')
     ) THEN
    RAISE EXCEPTION 'invalid_job_attempt_transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
