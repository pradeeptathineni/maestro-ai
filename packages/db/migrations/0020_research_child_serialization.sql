-- Serialize research child writes with parent finalization. A child write holds
-- a SHARE row lock on its active parent, so terminalization cannot cross and
-- commit ahead of that write.

CREATE OR REPLACE FUNCTION ops.lock_active_research_parent(
  target_run_id uuid,
  target_workspace_id uuid
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  parent_finished_at timestamptz;
BEGIN
  SELECT run.finished_at INTO parent_finished_at
  FROM ops.research_runs run
  WHERE run.id = target_run_id AND run.workspace_id = target_workspace_id
  FOR SHARE;
  IF NOT FOUND OR parent_finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'terminal research runs cannot accept child writes';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ops.guard_research_child_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.research_run_id IS NOT NULL THEN
    PERFORM ops.lock_active_research_parent(NEW.research_run_id, NEW.workspace_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS semantic_proposals_research_parent_guard ON ops.semantic_proposals;
CREATE TRIGGER semantic_proposals_research_parent_guard
  BEFORE INSERT ON ops.semantic_proposals
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_child_write();

DROP TRIGGER IF EXISTS research_run_events_parent_guard ON ops.research_run_events;
CREATE TRIGGER research_run_events_parent_guard
  BEFORE INSERT ON ops.research_run_events
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_child_write();

CREATE OR REPLACE FUNCTION ops.guard_research_discovery_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.research_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM ops.lock_active_research_parent(NEW.research_run_id, NEW.workspace_id);
  IF NOT EXISTS (
    SELECT 1 FROM ops.research_runs run
    WHERE run.id = NEW.research_run_id
      AND run.workspace_id = NEW.workspace_id
      AND run.query_session_id = NEW.query_session_id
      AND run.result_set_id = NEW.result_set_id
  ) THEN
    RAISE EXCEPTION 'research source operation must match its run snapshot';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovery_operations_research_parent_guard ON ops.discovery_operations;
CREATE TRIGGER discovery_operations_research_parent_guard
  BEFORE INSERT OR UPDATE ON ops.discovery_operations
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_discovery_write();

CREATE OR REPLACE FUNCTION ops.guard_research_operation_child_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_run_id uuid;
BEGIN
  SELECT operation.research_run_id INTO parent_run_id
  FROM ops.discovery_operations operation
  WHERE operation.id = NEW.operation_id AND operation.workspace_id = NEW.workspace_id;
  IF parent_run_id IS NOT NULL THEN
    PERFORM ops.lock_active_research_parent(parent_run_id, NEW.workspace_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovery_operation_candidates_research_parent_guard
  ON ops.discovery_operation_candidates;
CREATE TRIGGER discovery_operation_candidates_research_parent_guard
  BEFORE INSERT ON ops.discovery_operation_candidates
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_operation_child_write();

DROP TRIGGER IF EXISTS discovery_candidates_research_parent_guard ON ops.discovery_candidates;
CREATE TRIGGER discovery_candidates_research_parent_guard
  BEFORE INSERT ON ops.discovery_candidates
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_operation_child_write();

DROP TRIGGER IF EXISTS discovery_attempts_research_parent_guard ON ops.discovery_attempts;
CREATE TRIGGER discovery_attempts_research_parent_guard
  BEFORE INSERT ON ops.discovery_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_operation_child_write();
