-- Phase 08 retrieval fabric: immutable retriever lineage, fusion comparison,
-- explainable reranking, and bounded pass evidence.

ALTER TABLE workspace.query_result_sets
  ADD COLUMN fusion_policy_version text,
  ADD COLUMN rerank_policy_version text,
  ADD COLUMN candidate_pool_hash text,
  ADD COLUMN retrieval_passes integer,
  ADD COLUMN stop_reason text,
  ADD COLUMN coverage_assessment jsonb;

ALTER TABLE workspace.query_result_sets
  ADD CONSTRAINT query_result_sets_candidate_pool_hash_check
    CHECK (candidate_pool_hash IS NULL OR candidate_pool_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT query_result_sets_retrieval_passes_check
    CHECK (retrieval_passes IS NULL OR retrieval_passes BETWEEN 1 AND 2),
  ADD CONSTRAINT query_result_sets_coverage_assessment_object_check
    CHECK (coverage_assessment IS NULL OR jsonb_typeof(coverage_assessment) = 'object');

CREATE TABLE workspace.query_retrieval_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  pass_index integer NOT NULL CHECK (pass_index BETWEEN 1 AND 2),
  retriever_key text NOT NULL,
  retriever_version integer NOT NULL CHECK (retriever_version > 0),
  source_class text NOT NULL,
  source_identity text NOT NULL,
  plan_route_id text,
  outbound_query text NOT NULL CHECK (length(outbound_query) BETWEEN 1 AND 1000),
  native_result_count integer NOT NULL CHECK (native_result_count >= 0),
  returned_count integer NOT NULL CHECK (
    returned_count >= 0 AND returned_count <= native_result_count
  ),
  response_limitations text NOT NULL,
  rights_retention_notes text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (result_set_id, pass_index, retriever_key),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  CHECK (completed_at >= started_at)
);

CREATE INDEX query_retrieval_runs_result_idx
  ON workspace.query_retrieval_runs (result_set_id, pass_index, retriever_key);

CREATE TABLE workspace.query_retrieval_hits (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  retrieval_run_id uuid NOT NULL,
  candidate_key text NOT NULL,
  provider_id uuid REFERENCES catalog.providers(id),
  document_id uuid REFERENCES catalog.knowledge_documents(id),
  native_rank integer NOT NULL CHECK (native_rank > 0),
  native_score numeric(18,9) NOT NULL CHECK (native_score >= 0),
  matched_terms text[] NOT NULL DEFAULT '{}',
  matched_concept_ids uuid[] NOT NULL DEFAULT '{}',
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retrieval_run_id, native_rank),
  UNIQUE (retrieval_run_id, candidate_key),
  FOREIGN KEY (retrieval_run_id, workspace_id)
    REFERENCES workspace.query_retrieval_runs(id, workspace_id),
  CHECK ((provider_id IS NOT NULL)::integer + (document_id IS NOT NULL)::integer = 1)
);

CREATE INDEX query_retrieval_hits_candidate_idx
  ON workspace.query_retrieval_hits (candidate_key, retrieval_run_id);

CREATE TABLE workspace.query_candidate_fusions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  candidate_key text NOT NULL,
  provider_id uuid REFERENCES catalog.providers(id),
  document_id uuid REFERENCES catalog.knowledge_documents(id),
  candidate_pool_position integer NOT NULL CHECK (candidate_pool_position > 0),
  reciprocal_rank integer NOT NULL CHECK (reciprocal_rank > 0),
  reciprocal_score numeric(18,12) NOT NULL CHECK (reciprocal_score >= 0),
  reciprocal_contributions jsonb NOT NULL CHECK (
    jsonb_typeof(reciprocal_contributions) = 'array'
  ),
  reciprocal_rerank_position integer NOT NULL CHECK (reciprocal_rerank_position > 0),
  reciprocal_rerank_score numeric(12,6) NOT NULL,
  normalized_weighted_rank integer NOT NULL CHECK (normalized_weighted_rank > 0),
  normalized_weighted_score numeric(18,12) NOT NULL CHECK (normalized_weighted_score >= 0),
  normalized_weighted_contributions jsonb NOT NULL CHECK (
    jsonb_typeof(normalized_weighted_contributions) = 'array'
  ),
  normalized_weighted_rerank_position integer NOT NULL
    CHECK (normalized_weighted_rerank_position > 0),
  normalized_weighted_rerank_score numeric(12,6) NOT NULL,
  selected_fusion_policy text NOT NULL CHECK (
    selected_fusion_policy IN ('reciprocal-rank-fusion-v1', 'normalized-weighted-fusion-v1')
  ),
  selected_fusion_rank integer NOT NULL CHECK (selected_fusion_rank > 0),
  rerank_policy text NOT NULL CHECK (rerank_policy = 'structured-rerank-v1'),
  rerank_position integer NOT NULL CHECK (rerank_position > 0),
  rerank_score numeric(12,6) NOT NULL,
  match_score integer NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  matched_terms text[] NOT NULL DEFAULT '{}',
  matched_concept_ids uuid[] NOT NULL DEFAULT '{}',
  entity_resolution jsonb NOT NULL CHECK (jsonb_typeof(entity_resolution) = 'object'),
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_set_id, candidate_key),
  UNIQUE (result_set_id, rerank_position),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  CHECK ((provider_id IS NOT NULL)::integer + (document_id IS NOT NULL)::integer = 1)
);

CREATE INDEX query_candidate_fusions_result_rank_idx
  ON workspace.query_candidate_fusions (result_set_id, rerank_position);

-- The domain concept remains generic. These are conventional terminology labels,
-- not query routes or expected-answer mappings.
INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale)
SELECT '038abb90-d901-4fac-b57b-e030ab0de6c2', c.id,
       'Large language models', 'large language models', 'alternate', 'en'
FROM catalog.concepts c
WHERE c.stable_key = 'ai-models-providers' AND c.facet_key = 'domain'
ON CONFLICT DO NOTHING;

INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale)
SELECT 'a27c1155-0f5f-4a4b-b5bf-d4817f561c7c', c.id,
       'LLM', 'llm', 'alternate', 'en'
FROM catalog.concepts c
WHERE c.stable_key = 'ai-models-providers' AND c.facet_key = 'domain'
ON CONFLICT DO NOTHING;

CREATE TRIGGER query_retrieval_runs_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_retrieval_runs
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

CREATE TRIGGER query_retrieval_hits_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_retrieval_hits
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

CREATE TRIGGER query_candidate_fusions_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_candidate_fusions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
