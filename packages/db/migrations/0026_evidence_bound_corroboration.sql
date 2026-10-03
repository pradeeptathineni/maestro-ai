-- Corroboration v2 derives source role and independence from durable source/evidence records. V1
-- assessments remain immutable and replayable, but new v2 rows require normalized bindings.

ALTER TABLE catalog.source_reliability_assessments
  DROP CONSTRAINT source_reliability_assessments_policy_version_check;
ALTER TABLE catalog.source_reliability_assessments
  ADD CONSTRAINT source_reliability_assessments_policy_version_check
    CHECK (policy_version IN ('source-reliability-v1', 'source-reliability-v2'));

CREATE TABLE catalog.source_reliability_observation_bindings (
  assessment_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_observation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, source_observation_id),
  FOREIGN KEY (assessment_id, source_id)
    REFERENCES catalog.source_reliability_assessments(id, source_id),
  FOREIGN KEY (source_observation_id, source_id)
    REFERENCES catalog.source_observations(id, source_id)
);

CREATE OR REPLACE FUNCTION catalog.validate_source_reliability_v2(target_assessment uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  assessment catalog.source_reliability_assessments%ROWTYPE;
  bound_observations uuid[];
BEGIN
  SELECT * INTO assessment
  FROM catalog.source_reliability_assessments
  WHERE id = target_assessment;
  IF NOT FOUND OR assessment.policy_version <> 'source-reliability-v2' THEN
    RETURN;
  END IF;
  SELECT COALESCE(array_agg(source_observation_id ORDER BY source_observation_id), '{}')
  INTO bound_observations
  FROM catalog.source_reliability_observation_bindings
  WHERE assessment_id = target_assessment;
  IF (SELECT array_agg(value ORDER BY value)
      FROM unnest(assessment.source_observation_ids) value)
     IS DISTINCT FROM bound_observations OR cardinality(bound_observations) = 0 THEN
    RAISE EXCEPTION 'source-reliability-v2 assessment does not match its observations'
      USING ERRCODE = '23514', CONSTRAINT = 'source_reliability_v2_binding_consistency';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM catalog.source_reliability_observation_bindings binding
    JOIN catalog.source_observations observation ON observation.id = binding.source_observation_id
    WHERE binding.assessment_id = target_assessment
      AND observation.observed_at > assessment.observed_at
  ) THEN
    RAISE EXCEPTION 'source-reliability-v2 predates a bound observation'
      USING ERRCODE = '23514', CONSTRAINT = 'source_reliability_v2_temporal_order';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION catalog.validate_source_reliability_v2_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'source_reliability_assessments' THEN
    PERFORM catalog.validate_source_reliability_v2(NEW.id);
  ELSE
    PERFORM catalog.validate_source_reliability_v2(NEW.assessment_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER source_reliability_v2_assessment_consistency
  AFTER INSERT ON catalog.source_reliability_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_source_reliability_v2_trigger();

CREATE CONSTRAINT TRIGGER source_reliability_v2_observation_consistency
  AFTER INSERT ON catalog.source_reliability_observation_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_source_reliability_v2_trigger();

CREATE TRIGGER source_reliability_observation_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.source_reliability_observation_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

ALTER TABLE catalog.corroboration_assessments
  DROP CONSTRAINT corroboration_assessments_policy_version_check;
ALTER TABLE catalog.corroboration_assessments
  ADD CONSTRAINT corroboration_assessments_policy_version_check
    CHECK (policy_version IN ('corroboration-v1', 'corroboration-v2'));

CREATE UNIQUE INDEX evidence_items_id_observation_unique
  ON catalog.evidence_items (id, source_observation_id);

CREATE TABLE catalog.corroboration_source_bindings (
  assessment_id uuid NOT NULL REFERENCES catalog.corroboration_assessments(id),
  source_observation_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_reliability_assessment_id uuid NOT NULL,
  source_role text NOT NULL CHECK (
    source_role IN ('primary', 'publisher', 'independent', 'community', 'aggregator')
  ),
  independence_group text NOT NULL CHECK (length(independence_group) BETWEEN 1 AND 240),
  direction text NOT NULL CHECK (direction IN ('supports', 'contradicts')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, source_observation_id, direction),
  FOREIGN KEY (source_observation_id, source_id)
    REFERENCES catalog.source_observations(id, source_id),
  FOREIGN KEY (source_reliability_assessment_id, source_id)
    REFERENCES catalog.source_reliability_assessments(id, source_id)
);

CREATE TABLE catalog.corroboration_evidence_bindings (
  assessment_id uuid NOT NULL REFERENCES catalog.corroboration_assessments(id),
  evidence_item_id uuid NOT NULL,
  source_observation_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('supports', 'contradicts')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, evidence_item_id, direction),
  FOREIGN KEY (evidence_item_id, source_observation_id)
    REFERENCES catalog.evidence_items(id, source_observation_id),
  FOREIGN KEY (assessment_id, source_observation_id, direction)
    REFERENCES catalog.corroboration_source_bindings(
      assessment_id, source_observation_id, direction
    )
);

CREATE OR REPLACE FUNCTION catalog.validate_corroboration_v2(target_assessment uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  assessment catalog.corroboration_assessments%ROWTYPE;
  actual_primary integer;
  actual_independent integer;
  actual_community integer;
  actual_state text;
  bound_observations uuid[];
  bound_evidence uuid[];
BEGIN
  SELECT * INTO assessment
  FROM catalog.corroboration_assessments
  WHERE id = target_assessment;

  IF NOT FOUND OR assessment.policy_version <> 'corroboration-v2' THEN
    RETURN;
  END IF;

  SELECT
    count(DISTINCT independence_group) FILTER (
      WHERE direction = 'supports' AND source_role IN ('primary', 'publisher')
    )::integer,
    count(DISTINCT independence_group) FILTER (
      WHERE direction = 'supports' AND source_role = 'independent'
        AND independence_group NOT IN (
          SELECT primary_binding.independence_group
          FROM catalog.corroboration_source_bindings primary_binding
          WHERE primary_binding.assessment_id = target_assessment
            AND primary_binding.direction = 'supports'
            AND primary_binding.source_role IN ('primary', 'publisher')
        )
    )::integer,
    count(DISTINCT independence_group) FILTER (
      WHERE direction = 'supports' AND source_role = 'community'
    )::integer,
    COALESCE(array_agg(DISTINCT source_observation_id ORDER BY source_observation_id), '{}')
  INTO actual_primary, actual_independent, actual_community, bound_observations
  FROM catalog.corroboration_source_bindings
  WHERE assessment_id = target_assessment;

  SELECT COALESCE(array_agg(DISTINCT evidence_item_id ORDER BY evidence_item_id), '{}')
  INTO bound_evidence
  FROM catalog.corroboration_evidence_bindings
  WHERE assessment_id = target_assessment;

  IF EXISTS (
    SELECT 1 FROM catalog.corroboration_source_bindings source_binding
    WHERE source_binding.assessment_id = target_assessment
      AND NOT EXISTS (
        SELECT 1 FROM catalog.corroboration_evidence_bindings evidence_binding
        WHERE evidence_binding.assessment_id = source_binding.assessment_id
          AND evidence_binding.source_observation_id = source_binding.source_observation_id
          AND evidence_binding.direction = source_binding.direction
      )
  ) THEN
    RAISE EXCEPTION 'corroboration source binding has no bound evidence item'
      USING ERRCODE = '23514', CONSTRAINT = 'corroboration_v2_source_evidence_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM catalog.corroboration_source_bindings source_binding
    JOIN catalog.sources source ON source.id = source_binding.source_id
    JOIN catalog.source_reliability_assessments reliability
      ON reliability.id = source_binding.source_reliability_assessment_id
     AND reliability.source_id = source_binding.source_id
    WHERE source_binding.assessment_id = target_assessment
      AND (
        source_binding.independence_group <>
          'owner:' || lower(regexp_replace(trim(source.owner), '\s+', '-', 'g'))
        OR source_binding.source_role <> CASE
          WHEN reliability.authority_class = 'primary' THEN 'primary'
          WHEN reliability.authority_class = 'official' THEN 'publisher'
          WHEN reliability.authority_class = 'community' THEN 'community'
          WHEN reliability.authority_class = 'independent' AND EXISTS (
            SELECT 1
            FROM catalog.corroboration_evidence_bindings evidence_binding
            JOIN catalog.evidence_items evidence
              ON evidence.id = evidence_binding.evidence_item_id
            WHERE evidence_binding.assessment_id = source_binding.assessment_id
              AND evidence_binding.source_observation_id = source_binding.source_observation_id
              AND evidence_binding.direction = source_binding.direction
              AND evidence.independence = 'independent'
          ) THEN 'independent'
          ELSE 'aggregator'
        END
      )
  ) THEN
    RAISE EXCEPTION 'corroboration-v2 source role or owner group is not derived from evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'corroboration_v2_source_derivation';
  END IF;

  actual_state := CASE
    WHEN EXISTS (
      SELECT 1 FROM catalog.corroboration_source_bindings
      WHERE assessment_id = target_assessment AND direction = 'contradicts'
    ) THEN 'conflicted'
    WHEN actual_primary > 0 AND actual_independent > 0 THEN 'corroborated'
    WHEN actual_primary > 0 THEN 'primary_only'
    WHEN actual_independent > 0 THEN 'independent_only'
    ELSE 'insufficient'
  END;

  IF assessment.primary_source_count <> actual_primary
     OR assessment.independent_source_count <> actual_independent
     OR assessment.community_source_count <> actual_community
     OR assessment.state <> actual_state
     OR (SELECT array_agg(value ORDER BY value) FROM unnest(assessment.source_observation_ids) value)
        IS DISTINCT FROM bound_observations
     OR (SELECT array_agg(value ORDER BY value) FROM unnest(assessment.evidence_item_ids) value)
        IS DISTINCT FROM bound_evidence THEN
    RAISE EXCEPTION 'corroboration-v2 assessment does not match its durable bindings'
      USING ERRCODE = '23514', CONSTRAINT = 'corroboration_v2_binding_consistency';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION catalog.validate_corroboration_v2_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'corroboration_assessments' THEN
    PERFORM catalog.validate_corroboration_v2(NEW.id);
  ELSE
    PERFORM catalog.validate_corroboration_v2(NEW.assessment_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER corroboration_v2_assessment_consistency
  AFTER INSERT ON catalog.corroboration_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_corroboration_v2_trigger();

CREATE CONSTRAINT TRIGGER corroboration_v2_source_consistency
  AFTER INSERT ON catalog.corroboration_source_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_corroboration_v2_trigger();

CREATE CONSTRAINT TRIGGER corroboration_v2_evidence_consistency
  AFTER INSERT ON catalog.corroboration_evidence_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_corroboration_v2_trigger();

CREATE TRIGGER corroboration_source_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.corroboration_source_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

CREATE TRIGGER corroboration_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.corroboration_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
