-- Retention control for private queries. Immutable result snapshots remain
-- replayable, while user-authored query text and interpretations can be
-- irreversibly redacted through the one allowed state transition.

ALTER TABLE workspace.query_sessions
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DROP TRIGGER IF EXISTS query_sessions_immutable ON workspace.query_sessions;

CREATE OR REPLACE FUNCTION workspace.enforce_query_session_privacy_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'query_session_delete_requires_redaction' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
     OR NEW.query_text <> '[deleted by user]'
     OR NEW.normalized_intent <> '{}'::jsonb
     OR NEW.explicit_facets <> '{}'::jsonb
     OR NEW.inferred_facets <> '{}'::jsonb
     OR NEW.state <> 'expired'
     OR ROW(NEW.id, NEW.workspace_id, NEW.project_context_id, NEW.query_hash,
            NEW.interpretation_method, NEW.interpretation_state,
            NEW.retrieval_policy_version, NEW.index_revision,
            NEW.retention_until, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.id, OLD.workspace_id, OLD.project_context_id, OLD.query_hash,
            OLD.interpretation_method, OLD.interpretation_state,
            OLD.retrieval_policy_version, OLD.index_revision,
            OLD.retention_until, OLD.created_at)
  THEN
    RAISE EXCEPTION 'query_session_is_immutable_except_privacy_redaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER query_session_privacy_guard
  BEFORE UPDATE OR DELETE ON workspace.query_sessions
  FOR EACH ROW EXECUTE FUNCTION workspace.enforce_query_session_privacy_update();
