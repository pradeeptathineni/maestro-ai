-- Immutable query-value derivatives remove repeated JSON policy evaluation from
-- cached lexical queries. The function and columns are explicitly versioned;
-- a policy change must add new lineage rather than reinterpret old snapshots.

CREATE OR REPLACE FUNCTION ops.query_value_summary_v1(profile jsonb) RETURNS jsonb AS $$
  WITH dimensions AS (
    SELECT
      element->>'key' AS key,
      CASE element->>'key'
        WHEN 'reuse_leverage' THEN 0.40::numeric
        WHEN 'adoption_ease' THEN 0.25::numeric
        WHEN 'maturity' THEN 0.20::numeric
        WHEN 'provenance_clarity' THEN 0.15::numeric
      END AS weight,
      (element->>'confidence')::numeric AS confidence,
      (element->>'coverage')::numeric AS coverage,
      CASE
        WHEN element->>'key' = 'reuse_leverage' THEN 50::numeric
        WHEN element->>'key' = 'adoption_ease' THEN 35::numeric
        WHEN element->>'key' = 'maturity' THEN 50::numeric
        WHEN element->>'key' = 'provenance_clarity'
          AND COALESCE((element->>'highPrivilege')::boolean, false) THEN 25::numeric
        WHEN element->>'key' = 'provenance_clarity' THEN 35::numeric
      END AS prior,
      CASE WHEN element->>'raw' IS NULL THEN NULL ELSE (element->>'raw')::numeric END AS raw
    FROM jsonb_array_elements(profile) element
    WHERE element->>'applicability' = 'applicable'
  ), adjusted AS (
    SELECT *, CASE WHEN raw IS NULL THEN prior
                   ELSE confidence * raw + (1 - confidence) * prior END AS value
    FROM dimensions
  ), metrics AS (
    SELECT round(sum(weight * value) / sum(weight), 6) AS central,
           round(1 - sum(weight * confidence) / sum(weight), 6) AS uncertainty,
           round(sum(weight * coverage) / sum(weight), 6) AS evidence_coverage
    FROM adjusted
  )
  SELECT jsonb_build_object(
    'valueConservative', round(greatest(0, least(100, central - 20 * uncertainty)), 6),
    'evidenceCoverage', evidence_coverage
  )
  FROM metrics
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

ALTER TABLE catalog.knowledge_projections
  ADD COLUMN IF NOT EXISTS query_value_policy_version text NOT NULL DEFAULT 'query-signal-v1'
    CHECK (query_value_policy_version = 'query-signal-v1'),
  ADD COLUMN IF NOT EXISTS query_value_conservative numeric(9,6)
    GENERATED ALWAYS AS (
      ((ops.query_value_summary_v1(value_profile)->>'valueConservative')::numeric)
    ) STORED,
  ADD COLUMN IF NOT EXISTS query_evidence_coverage numeric(9,6)
    GENERATED ALWAYS AS (
      ((ops.query_value_summary_v1(value_profile)->>'evidenceCoverage')::numeric)
    ) STORED;

CREATE INDEX IF NOT EXISTS knowledge_projection_query_value_idx
  ON catalog.knowledge_projections
    (query_value_policy_version, query_value_conservative DESC, preferred_label, provider_id)
  WHERE publication_state <> 'withdrawn';
