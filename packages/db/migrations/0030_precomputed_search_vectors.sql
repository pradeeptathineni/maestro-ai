-- The bounded retrieval queries rank a small candidate window, but PostgreSQL otherwise has to
-- tokenize every matching row again for ts_rank_cd. Persist the exact immutable search expression
-- already used by the released GIN indexes so broad local queries stay responsive without changing
-- candidate semantics.

DROP INDEX catalog.knowledge_projection_search_idx;

ALTER TABLE catalog.knowledge_projections
  ADD COLUMN retrieval_search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple'::regconfig,
      preferred_label || ' ' || summary || ' ' || search_text
    )
  ) STORED;

CREATE INDEX knowledge_projection_search_idx
  ON catalog.knowledge_projections USING gin (retrieval_search_vector);

DROP INDEX catalog.knowledge_documents_search_idx;

ALTER TABLE catalog.knowledge_documents
  ADD COLUMN retrieval_search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, title || ' ' || summary || ' ' || search_text)
  ) STORED;

CREATE INDEX knowledge_documents_search_idx
  ON catalog.knowledge_documents USING gin (retrieval_search_vector)
  WHERE publication_state <> 'withdrawn';
