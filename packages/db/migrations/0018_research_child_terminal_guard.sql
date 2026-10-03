-- Prevent late child records from extending a terminal research history.

CREATE OR REPLACE FUNCTION ops.guard_research_child_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.research_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM ops.research_runs run
    WHERE run.id = NEW.research_run_id AND run.finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'terminal research runs cannot accept new child records';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS semantic_proposals_research_parent_guard ON ops.semantic_proposals;
CREATE TRIGGER semantic_proposals_research_parent_guard
  BEFORE INSERT ON ops.semantic_proposals
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_child_insert();

DROP TRIGGER IF EXISTS discovery_operations_research_parent_guard ON ops.discovery_operations;
CREATE TRIGGER discovery_operations_research_parent_guard
  BEFORE INSERT ON ops.discovery_operations
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_child_insert();

DROP TRIGGER IF EXISTS research_run_events_parent_guard ON ops.research_run_events;
CREATE TRIGGER research_run_events_parent_guard
  BEFORE INSERT ON ops.research_run_events
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_child_insert();

CREATE OR REPLACE FUNCTION ops.guard_research_candidate_link_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ops.discovery_operations operation
    JOIN ops.research_runs run ON run.id = operation.research_run_id
    WHERE operation.id = NEW.operation_id AND run.finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'terminal research runs cannot accept new evidence links';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovery_operation_candidates_research_parent_guard
  ON ops.discovery_operation_candidates;
CREATE TRIGGER discovery_operation_candidates_research_parent_guard
  BEFORE INSERT ON ops.discovery_operation_candidates
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_candidate_link_insert();
