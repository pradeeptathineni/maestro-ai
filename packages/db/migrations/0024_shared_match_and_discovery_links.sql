-- The same canonical discovery candidate may be observed by many operations. Preserve one
-- immutable candidate payload while recording every operation that returned it. This fixes the
-- historical one-operation ownership shortcut without rewriting old candidate records.

CREATE TABLE ops.discovery_operation_candidates (
  operation_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, candidate_id),
  FOREIGN KEY (operation_id, workspace_id)
    REFERENCES ops.discovery_operations(id, workspace_id),
  FOREIGN KEY (candidate_id, workspace_id)
    REFERENCES ops.discovery_candidates(id, workspace_id)
);

CREATE INDEX discovery_operation_candidates_candidate_idx
  ON ops.discovery_operation_candidates (candidate_id, operation_id);

INSERT INTO ops.discovery_operation_candidates
  (operation_id, candidate_id, workspace_id, observed_at)
SELECT operation_id, id, workspace_id, created_at
FROM ops.discovery_candidates
ON CONFLICT DO NOTHING;

CREATE TRIGGER discovery_operation_candidates_immutable
  BEFORE UPDATE OR DELETE ON ops.discovery_operation_candidates
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

-- structured-rerank-v2 moves entity-class compatibility into the shared Match assessment. Keep
-- v1 readable for historical result sets while allowing new immutable receipts to name v2.
ALTER TABLE workspace.query_candidate_fusions
  DROP CONSTRAINT query_candidate_fusions_rerank_policy_check;
ALTER TABLE workspace.query_candidate_fusions
  ADD CONSTRAINT query_candidate_fusions_rerank_policy_check
    CHECK (rerank_policy IN ('structured-rerank-v1', 'structured-rerank-v2'));
