-- Typed Signal observations are valid only when their normalized values can be replayed from a
-- versioned raw-metric policy and their independence grouping is bound to durable source identity.
-- Historical rows remain readable with NULL provenance columns and use the compatibility path.

ALTER TABLE catalog.entity_metric_observations
  ADD COLUMN intrinsic_dimension text,
  ADD COLUMN metric_direction text,
  ADD COLUMN entity_revision_id uuid,
  ADD COLUMN metric_aggregation text,
  ADD COLUMN comparison_value numeric,
  ADD COLUMN comparison_unit text,
  ADD COLUMN source_id uuid REFERENCES catalog.sources(id),
  ADD COLUMN source_reliability_assessment_id uuid
    REFERENCES catalog.source_reliability_assessments(id),
  ADD COLUMN cohort_policy_version text,
  ADD COLUMN normalization_input_hash text;

ALTER TABLE catalog.entity_metric_observations
  ADD CONSTRAINT entity_metric_intrinsic_dimension_check CHECK (
    intrinsic_dimension IS NULL OR intrinsic_dimension IN (
      'reach', 'authority', 'evidence', 'freshness', 'impact', 'momentum'
    )
  ),
  ADD CONSTRAINT entity_metric_direction_check CHECK (
    metric_direction IS NULL OR metric_direction IN ('higher_is_better', 'lower_is_better')
  ),
  ADD CONSTRAINT entity_metric_aggregation_check CHECK (
    metric_aggregation IS NULL OR metric_aggregation IN ('total', 'snapshot')
  ),
  ADD CONSTRAINT entity_metric_normalization_hash_check CHECK (
    normalization_input_hash IS NULL OR normalization_input_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT entity_metric_cohort_policy_check CHECK (
    cohort_policy_version IS NULL OR cohort_policy_version = 'entity-class-cohort-v1'
  ),
  ADD CONSTRAINT entity_metric_typed_policy_complete_check CHECK (
    normalization_policy_version <> 'cohort-percentile-v1' OR (
      raw_value IS NOT NULL AND normalized_value IS NOT NULL AND
      intrinsic_dimension IS NOT NULL AND metric_direction IS NOT NULL AND
      entity_revision_id IS NOT NULL AND metric_aggregation IS NOT NULL AND
      comparison_value IS NOT NULL AND comparison_unit IS NOT NULL AND
      source_id IS NOT NULL AND cohort_policy_version = 'entity-class-cohort-v1' AND
      normalization_input_hash IS NOT NULL
    )
  );

ALTER TABLE catalog.entity_metric_observations
  ADD CONSTRAINT entity_metric_revision_same_entity_fkey
  FOREIGN KEY (entity_revision_id, knowledge_entity_id)
  REFERENCES catalog.knowledge_entity_revisions(id, entity_id);

CREATE UNIQUE INDEX source_observations_id_source_unique
  ON catalog.source_observations (id, source_id);

ALTER TABLE catalog.entity_metric_observations
  ADD CONSTRAINT entity_metric_observation_source_fkey
  FOREIGN KEY (source_observation_id, source_id)
  REFERENCES catalog.source_observations(id, source_id);

ALTER TABLE catalog.entity_metric_observations
  ADD CONSTRAINT entity_metric_reliability_source_fkey
  FOREIGN KEY (source_reliability_assessment_id, source_id)
  REFERENCES catalog.source_reliability_assessments(id, source_id);

CREATE OR REPLACE FUNCTION catalog.validate_typed_metric_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_cohort text;
  expected_group text;
BEGIN
  IF NEW.normalization_policy_version <> 'cohort-percentile-v1' THEN
    RETURN NEW;
  END IF;

  SELECT 'entity-class-v1:' || concept.stable_key
    INTO expected_cohort
  FROM catalog.knowledge_entity_revisions revision
  JOIN catalog.concepts concept ON concept.id = revision.entity_class_concept_id
  WHERE revision.id = NEW.entity_revision_id AND revision.entity_id = NEW.knowledge_entity_id;

  SELECT 'owner:' || lower(regexp_replace(trim(source.owner), '\s+', '-', 'g'))
    INTO expected_group
  FROM catalog.sources source
  WHERE source.id = NEW.source_id;

  IF expected_cohort IS NULL OR NEW.cohort_key <> expected_cohort THEN
    RAISE EXCEPTION 'typed metric cohort is not bound to the entity class'
      USING ERRCODE = '23514', CONSTRAINT = 'entity_metric_typed_cohort_binding';
  END IF;
  IF expected_group IS NULL OR NEW.independence_group <> expected_group THEN
    RAISE EXCEPTION 'typed metric independence group is not bound to source ownership'
      USING ERRCODE = '23514', CONSTRAINT = 'entity_metric_source_group_binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_metric_typed_binding
  BEFORE INSERT ON catalog.entity_metric_observations
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_typed_metric_binding();

ALTER TABLE catalog.intrinsic_signal_runs
  ADD COLUMN input_references jsonb;

UPDATE catalog.intrinsic_signal_runs
SET input_references = jsonb_build_object(
  'evidenceItemIds', to_jsonb(evidence_ids),
    'metricObservationIds', '[]'::jsonb,
    'sourceObservationIds', '[]'::jsonb,
    'normalizationInputHashes', '[]'::jsonb,
    'asOf', to_jsonb(generated_at)
);

ALTER TABLE catalog.intrinsic_signal_runs
  ALTER COLUMN input_references SET NOT NULL,
  ALTER COLUMN input_references SET DEFAULT
    '{"evidenceItemIds":[],"metricObservationIds":[],"sourceObservationIds":[],"normalizationInputHashes":[],"asOf":null}'::jsonb;

ALTER TABLE catalog.intrinsic_signal_runs
  ADD CONSTRAINT intrinsic_signal_input_references_object_check
    CHECK (jsonb_typeof(input_references) = 'object');
