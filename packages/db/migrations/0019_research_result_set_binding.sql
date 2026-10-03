-- Bind research source operations to the run's exact immutable query snapshot.

CREATE OR REPLACE FUNCTION ops.guard_research_discovery_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.research_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ops.research_runs run
    WHERE run.id = NEW.research_run_id
      AND run.workspace_id = NEW.workspace_id
      AND run.query_session_id = NEW.query_session_id
      AND run.result_set_id = NEW.result_set_id
      AND run.finished_at IS NULL
  ) THEN
    RAISE EXCEPTION 'research source operation must match an active run snapshot';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovery_operations_research_parent_guard ON ops.discovery_operations;
CREATE TRIGGER discovery_operations_research_parent_guard
  BEFORE INSERT ON ops.discovery_operations
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_discovery_insert();
