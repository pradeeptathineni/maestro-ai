-- The released model-research migration already introduced the immutable many-to-many
-- discovery-operation/candidate link. This continuation reuses that single canonical table
-- rather than creating a second shape for the same relationship.

-- structured-rerank-v2 moves entity-class compatibility into the shared Match assessment. Keep
-- v1 readable for historical result sets while allowing new immutable receipts to name v2.
ALTER TABLE workspace.query_candidate_fusions
  DROP CONSTRAINT IF EXISTS query_candidate_fusions_rerank_policy_check;
ALTER TABLE workspace.query_candidate_fusions
  ADD CONSTRAINT query_candidate_fusions_rerank_policy_check
    CHECK (rerank_policy IN ('structured-rerank-v1', 'structured-rerank-v2'));
