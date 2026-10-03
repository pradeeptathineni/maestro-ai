import type { Pool } from 'pg';
import {
  assessCorroboration,
  corroborationPolicyVersion,
  hashCanonical,
  newOpaqueId,
  type CorroborationEvidence,
  type EvidenceRole,
} from '../../domain/src/index.js';
import {
  cohortMetricNormalizationPolicyV1,
  normalizeCohortMetricV1,
  type IntrinsicDimensionKey,
  type MetricDirection,
} from '../../scoring/src/index.js';
import { DomainValidationError, NotFoundError } from './errors.js';
import { inTransaction } from './transaction.js';

function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function recordSourceReliability(
  pool: Pool,
  input: {
    sourceId: string;
    authorityClass: 'primary' | 'official' | 'independent' | 'community' | 'aggregator' | 'unknown';
    availabilityState: 'available' | 'degraded' | 'unavailable' | 'unknown';
    rightsState: 'allowed' | 'restricted' | 'prohibited' | 'unknown';
    reliabilityScore: number | null;
    evidenceBasis: Record<string, unknown>;
    sourceObservationIds: string[];
    observedAt: Date;
  },
): Promise<string> {
  return inTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('source-reliability:' || $1::text))`,
      [input.sourceId],
    );
    const source = await client.query('SELECT id FROM catalog.sources WHERE id = $1', [
      input.sourceId,
    ]);
    if (!source.rowCount) throw new NotFoundError('Source not found.');
    const observationIds = [...new Set(input.sourceObservationIds)].sort();
    if (!observationIds.length) {
      throw new DomainValidationError(
        'A source reliability assessment requires at least one source observation.',
      );
    }
    const observations = await client.query<{ id: string; observedAt: Date }>(
      `SELECT id::text AS id, observed_at AS "observedAt" FROM catalog.source_observations
       WHERE source_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id`,
      [input.sourceId, observationIds],
    );
    if (observations.rows.length !== observationIds.length) {
      throw new DomainValidationError(
        'Every reliability observation must belong to the assessed source.',
      );
    }
    if (observations.rows.some((observation) => observation.observedAt > input.observedAt)) {
      throw new DomainValidationError(
        'A source reliability assessment cannot predate its bound observation.',
      );
    }
    const predecessor = await client.query<{ id: string }>(
      `SELECT id FROM catalog.source_reliability_assessments
       WHERE source_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
      [input.sourceId],
    );
    const id = newOpaqueId();
    await client.query(
      `INSERT INTO catalog.source_reliability_assessments
         (id, source_id, policy_version, authority_class, availability_state,
          rights_state, reliability_score, evidence_basis, source_observation_ids,
          observed_at, predecessor_id, created_at)
       VALUES ($1, $2, 'source-reliability-v2', $3, $4, $5, $6, $7, $8, $9, $10,
               clock_timestamp())`,
      [
        id,
        input.sourceId,
        input.authorityClass,
        input.availabilityState,
        input.rightsState,
        input.reliabilityScore,
        json(input.evidenceBasis),
        observationIds,
        input.observedAt,
        predecessor.rows[0]?.id ?? null,
      ],
    );
    for (const observationId of observationIds) {
      await client.query(
        `INSERT INTO catalog.source_reliability_observation_bindings
           (assessment_id, source_id, source_observation_id)
         VALUES ($1, $2, $3)`,
        [id, input.sourceId, observationId],
      );
    }
    return id;
  });
}

export async function recordEntityMetricObservation(
  pool: Pool,
  input: {
    knowledgeEntityId: string;
    metricKey: string;
    intrinsicDimension: IntrinsicDimensionKey;
    direction: MetricDirection;
    rawValue: number;
    rawUnit: string;
    aggregation: 'total' | 'snapshot';
    windowStart: Date;
    windowEnd: Date;
    sourceObservationId: string;
    observedAt: Date;
  },
): Promise<string> {
  if (!Number.isFinite(input.rawValue)) {
    throw new DomainValidationError('Raw metric value must be a finite number.');
  }
  if (
    !Number.isFinite(input.windowStart.valueOf()) ||
    !Number.isFinite(input.windowEnd.valueOf()) ||
    !Number.isFinite(input.observedAt.valueOf()) ||
    input.windowEnd <= input.windowStart ||
    input.windowEnd > input.observedAt
  ) {
    throw new DomainValidationError(
      'Metric windows must be valid, ordered, and no later than the observation.',
    );
  }
  return inTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext(
         'entity-metric:' || $1::text || ':' || $2 || ':' || $3 || ':' || $4::text || ':' || $5::text
       ))`,
      [
        input.knowledgeEntityId,
        input.metricKey,
        input.sourceObservationId,
        input.windowStart,
        input.windowEnd,
      ],
    );
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM catalog.entity_metric_observations
       WHERE knowledge_entity_id = $1 AND metric_key = $2 AND source_observation_id = $3
         AND window_start = $4 AND window_end = $5`,
      [
        input.knowledgeEntityId,
        input.metricKey,
        input.sourceObservationId,
        input.windowStart,
        input.windowEnd,
      ],
    );
    if (existing.rows[0]?.id) return existing.rows[0].id;

    const source = await client.query<{
      sourceId: string;
      owner: string;
      observationAt: Date;
      reliabilityAssessmentId: string | null;
      reliabilityScore: number | null;
      authorityClass: string | null;
      entityClassConceptId: string;
      entityClassStableKey: string;
      entityRevisionId: string;
    }>(
      `SELECT observation.source_id AS "sourceId", source.owner,
              observation.observed_at AS "observationAt",
              reliability.id AS "reliabilityAssessmentId",
              reliability.reliability_score::float8 AS "reliabilityScore",
              reliability.authority_class AS "authorityClass",
              revision.id AS "entityRevisionId",
              revision.entity_class_concept_id AS "entityClassConceptId",
              class.stable_key AS "entityClassStableKey"
       FROM catalog.knowledge_entities entity
       JOIN LATERAL (
         SELECT current_revision.id, current_revision.entity_class_concept_id
         FROM catalog.knowledge_entity_revisions current_revision
         WHERE current_revision.entity_id = entity.id
           AND current_revision.created_at <= $2
         ORDER BY current_revision.revision DESC, current_revision.created_at DESC,
                  current_revision.id DESC
         LIMIT 1
       ) revision ON true
       JOIN catalog.concepts class ON class.id = revision.entity_class_concept_id
       CROSS JOIN catalog.source_observations observation
       JOIN catalog.sources source ON source.id = observation.source_id
       LEFT JOIN LATERAL (
         SELECT assessment.id, assessment.reliability_score, assessment.authority_class
         FROM catalog.source_reliability_assessments assessment
         WHERE assessment.source_id = observation.source_id
           AND assessment.observed_at <= $2
           AND assessment.policy_version = 'source-reliability-v2'
         ORDER BY assessment.observed_at DESC, assessment.created_at DESC, assessment.id DESC
         LIMIT 1
       ) reliability ON true
       WHERE observation.id = $1 AND entity.id = $3`,
      [input.sourceObservationId, input.observedAt, input.knowledgeEntityId],
    );
    if (!source.rowCount) throw new NotFoundError('Source observation not found.');
    const sourceRow = source.rows[0]!;
    if (sourceRow.observationAt > input.observedAt) {
      throw new DomainValidationError(
        'Metric observation cannot predate its bound source observation.',
      );
    }
    const cohortKey = `entity-class-v1:${sourceRow.entityClassStableKey}`;
    const windowDays =
      (input.windowEnd.getTime() - input.windowStart.getTime()) / (24 * 60 * 60 * 1000);
    const comparisonValue =
      input.aggregation === 'total' ? input.rawValue / windowDays : input.rawValue;
    const comparisonUnit =
      input.aggregation === 'total' ? `${input.rawUnit}/day` : input.rawUnit;
    const reference = await client.query<{
      id: string;
      rawValue: number;
      observedAt: Date;
      sourceId: string | null;
    }>(
      `SELECT id::text AS id, comparison_value::float8 AS "rawValue",
              observed_at AS "observedAt",
              source_id::text AS "sourceId"
       FROM catalog.entity_metric_observations
       WHERE metric_key = $1 AND cohort_key = $2 AND comparison_unit = $3
         AND metric_aggregation = $4
         AND normalization_policy_version = $5 AND comparison_value IS NOT NULL
         AND observed_at >= $6::timestamptz - interval '365 days'
         AND observed_at <= $6::timestamptz
       ORDER BY observed_at, id`,
      [
        input.metricKey,
        cohortKey,
        comparisonUnit,
        input.aggregation,
        cohortMetricNormalizationPolicyV1,
        input.observedAt,
      ],
    );
    const normalization = normalizeCohortMetricV1({
      rawValue: comparisonValue,
      referenceValues: reference.rows.map((row) => row.rawValue),
      direction: input.direction,
    });
    const independenceGroup = `owner:${sourceRow.owner
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/\s+/g, '-')}`;
    const normalizationInput = {
      policyVersion: cohortMetricNormalizationPolicyV1,
      metricKey: input.metricKey,
      intrinsicDimension: input.intrinsicDimension,
      direction: input.direction,
      rawValue: input.rawValue,
      rawUnit: input.rawUnit,
      aggregation: input.aggregation,
      comparisonValue,
      comparisonUnit,
      windowDays,
      cohort: {
        key: cohortKey,
        policyVersion: 'entity-class-cohort-v1',
        entityClassConceptId: sourceRow.entityClassConceptId,
        entityRevisionId: sourceRow.entityRevisionId,
        entityClassStableKey: sourceRow.entityClassStableKey,
        comparisonMetricKey: input.metricKey,
        comparisonRawUnit: input.rawUnit,
      },
      referenceWindowDays: 365,
      references: reference.rows.map((row) => ({
        id: row.id,
        rawValue: row.rawValue,
        observedAt: row.observedAt.toISOString(),
        sourceId: row.sourceId,
      })),
      sourceObservationId: input.sourceObservationId,
      observedAt: input.observedAt.toISOString(),
    };
    const normalizationInputHash = hashCanonical(normalizationInput);
    const id = newOpaqueId();
    await client.query(
      `INSERT INTO catalog.entity_metric_observations
         (id, knowledge_entity_id, metric_key, intrinsic_dimension, metric_direction,
          entity_revision_id, raw_value, raw_unit, metric_aggregation, comparison_value,
          comparison_unit, normalized_value, cohort_key, cohort_policy_version,
          normalization_policy_version,
          normalization_detail, normalization_input_hash, window_start, window_end,
          independence_group, source_id, source_reliability_assessment_id,
          source_observation_id, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, 'entity-class-cohort-v1', $14, $15, $16, $17, $18, $19, $20,
               $21, $22, $23)`,
      [
        id,
        input.knowledgeEntityId,
        input.metricKey,
        input.intrinsicDimension,
        input.direction,
        sourceRow.entityRevisionId,
        input.rawValue,
        input.rawUnit,
        input.aggregation,
        comparisonValue,
        comparisonUnit,
        normalization.normalized,
        cohortKey,
        cohortMetricNormalizationPolicyV1,
        json({
          method: 'cohort_percentile',
          referenceWindowDays: 365,
          referenceCount: normalization.referenceCount,
          percentile: normalization.percentile,
          lowerFence: normalization.lowerFence,
          upperFence: normalization.upperFence,
          clippedValue: normalization.clippedValue,
          outlierClipped: normalization.outlierClipped,
          sourceReliabilityScore: sourceRow.reliabilityScore,
          sourceAuthorityClass: sourceRow.authorityClass ?? 'unknown',
          normalizationInputHash,
        }),
        normalizationInputHash,
        input.windowStart,
        input.windowEnd,
        independenceGroup,
        sourceRow.sourceId,
        sourceRow.reliabilityAssessmentId,
        input.sourceObservationId,
        input.observedAt,
      ],
    );
    return id;
  });
}

export async function recordCorroboration(
  pool: Pool,
  input: {
    knowledgeEntityId: string;
    predicate: string;
    applicabilityScope: string;
    evidence: Array<{
      sourceObservationId: string;
      evidenceItemId: string;
      direction: 'supports' | 'contradicts';
    }>;
    observedAt: Date;
  },
): Promise<{ id: string; state: ReturnType<typeof assessCorroboration>['state'] }> {
  return inTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('corroboration:' || $1::text || ':' || $2 || ':' || $3)
       )`,
      [input.knowledgeEntityId, input.predicate, input.applicabilityScope],
    );
    const entity = await client.query('SELECT id FROM catalog.knowledge_entities WHERE id = $1', [
      input.knowledgeEntityId,
    ]);
    if (!entity.rowCount) throw new NotFoundError('Knowledge entity not found.');
    const requested = [
      ...new Map(
        input.evidence.map((binding) => [
          `${binding.evidenceItemId}:${binding.direction}`,
          binding,
        ]),
      ).values(),
    ];
    if (!requested.length) {
      throw new DomainValidationError('At least one bound evidence item is required.');
    }
    const bound = await client.query<{
      evidenceItemId: string;
      sourceObservationId: string;
      direction: 'supports' | 'contradicts';
      evidenceIndependence: string;
      evidenceObservedAt: Date;
      sourceId: string;
      sourceOwner: string;
      reliabilityAssessmentId: string | null;
      authorityClass: string | null;
    }>(
      `SELECT evidence.id::text AS "evidenceItemId",
              observation.id::text AS "sourceObservationId", requested.direction,
              evidence.independence AS "evidenceIndependence",
              evidence.observed_at AS "evidenceObservedAt",
              source.id::text AS "sourceId", source.owner AS "sourceOwner",
              reliability.id::text AS "reliabilityAssessmentId",
              reliability.authority_class AS "authorityClass"
       FROM jsonb_to_recordset($1::jsonb) AS requested(
         "sourceObservationId" uuid, "evidenceItemId" uuid, direction text
       )
       JOIN catalog.evidence_items evidence ON evidence.id = requested."evidenceItemId"
       JOIN catalog.source_observations observation
         ON observation.id = requested."sourceObservationId"
        AND observation.id = evidence.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       LEFT JOIN LATERAL (
         SELECT assessment.id, assessment.authority_class
         FROM catalog.source_reliability_assessments assessment
         WHERE assessment.source_id = source.id AND assessment.observed_at <= $2
           AND assessment.policy_version = 'source-reliability-v2'
         ORDER BY assessment.observed_at DESC, assessment.created_at DESC, assessment.id DESC
         LIMIT 1
       ) reliability ON true`,
      [json(requested), input.observedAt],
    );
    if (bound.rows.length !== requested.length) {
      throw new DomainValidationError(
        'Every corroboration item must bind an existing evidence item to its own source observation.',
      );
    }
    if (bound.rows.some((row) => !row.reliabilityAssessmentId)) {
      throw new DomainValidationError(
        'Every corroboration source requires a persisted reliability assessment.',
      );
    }
    if (bound.rows.some((row) => row.evidenceObservedAt > input.observedAt)) {
      throw new DomainValidationError(
        'Corroboration cannot predate one of its bound evidence items.',
      );
    }
    const roleFor = (row: (typeof bound.rows)[number]): EvidenceRole => {
      if (row.authorityClass === 'primary') return 'primary';
      if (row.authorityClass === 'official') return 'publisher';
      if (row.authorityClass === 'community') return 'community';
      if (
        row.authorityClass === 'independent' &&
        row.evidenceIndependence === 'independent'
      ) {
        return 'independent';
      }
      return 'aggregator';
    };
    const normalizedEvidence: CorroborationEvidence[] = bound.rows.map((row) => ({
      sourceId: row.sourceId,
      independenceGroup: `owner:${row.sourceOwner
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase('en-US')
        .replace(/\s+/g, '-')}`,
      role: roleFor(row),
      direction: row.direction,
    }));
    const assessment = assessCorroboration(normalizedEvidence);
    const predecessor = await client.query<{ id: string }>(
      `SELECT id FROM catalog.corroboration_assessments
       WHERE knowledge_entity_id = $1 AND predicate = $2 AND applicability_scope = $3
       ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
      [input.knowledgeEntityId, input.predicate, input.applicabilityScope],
    );
    const id = newOpaqueId();
    await client.query(
      `INSERT INTO catalog.corroboration_assessments
         (id, knowledge_entity_id, policy_version, predicate, applicability_scope,
          state, primary_source_count, independent_source_count, community_source_count,
          source_observation_ids, evidence_item_ids, rationale, observed_at, predecessor_id,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               clock_timestamp())`,
      [
        id,
        input.knowledgeEntityId,
        corroborationPolicyVersion,
        input.predicate,
        input.applicabilityScope,
        assessment.state,
        assessment.primarySourceCount,
        assessment.independentSourceCount,
        assessment.communitySourceCount,
        [...new Set(bound.rows.map((row) => row.sourceObservationId))].sort(),
        [...new Set(bound.rows.map((row) => row.evidenceItemId))].sort(),
        assessment.reasons.join(' '),
        input.observedAt,
        predecessor.rows[0]?.id ?? null,
      ],
    );
    const sourceBindings = [
      ...new Map(
        bound.rows.map((row) => {
          const evidence = normalizedEvidence[bound.rows.indexOf(row)]!;
          return [
            `${row.sourceObservationId}:${row.direction}`,
            {
              ...row,
              role: evidence.role,
              independenceGroup: evidence.independenceGroup,
            },
          ];
        }),
      ).values(),
    ];
    for (const binding of sourceBindings) {
      await client.query(
        `INSERT INTO catalog.corroboration_source_bindings
           (assessment_id, source_observation_id, source_id,
            source_reliability_assessment_id, source_role, independence_group, direction)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          binding.sourceObservationId,
          binding.sourceId,
          binding.reliabilityAssessmentId,
          binding.role,
          binding.independenceGroup,
          binding.direction,
        ],
      );
    }
    for (const binding of bound.rows) {
      await client.query(
        `INSERT INTO catalog.corroboration_evidence_bindings
           (assessment_id, evidence_item_id, source_observation_id, direction)
         VALUES ($1, $2, $3, $4)`,
        [id, binding.evidenceItemId, binding.sourceObservationId, binding.direction],
      );
    }
    return { id, state: assessment.state };
  });
}

export async function getEntityCorpusIntelligence(
  pool: Pool,
  knowledgeEntityId: string,
): Promise<unknown> {
  const entity = await pool.query('SELECT id FROM catalog.knowledge_entities WHERE id = $1', [
    knowledgeEntityId,
  ]);
  if (!entity.rowCount) throw new NotFoundError('Knowledge entity not found.');
  const [metrics, corroboration, sourceReliability] = await Promise.all([
    pool.query(
      `SELECT metric_key AS "metricKey", raw_value::float8 AS "rawValue", raw_unit AS "rawUnit",
              normalized_value::float8 AS "normalizedValue", cohort_key AS "cohortKey",
              normalization_policy_version AS "normalizationPolicyVersion",
              normalization_detail AS "normalizationDetail", window_start AS "windowStart",
              window_end AS "windowEnd", independence_group AS "independenceGroup",
              source_observation_id AS "sourceObservationId", observed_at AS "observedAt"
       FROM catalog.entity_metric_observations WHERE knowledge_entity_id = $1
       ORDER BY metric_key, window_end, observed_at, id`,
      [knowledgeEntityId],
    ),
    pool.query(
      `SELECT DISTINCT ON (predicate, applicability_scope)
              predicate, applicability_scope AS "applicabilityScope", state,
              primary_source_count AS "primarySourceCount",
              independent_source_count AS "independentSourceCount",
              community_source_count AS "communitySourceCount", rationale,
              policy_version AS "policyVersion", observed_at AS "observedAt"
       FROM catalog.corroboration_assessments WHERE knowledge_entity_id = $1
       ORDER BY predicate, applicability_scope, observed_at DESC, id DESC`,
      [knowledgeEntityId],
    ),
    pool.query(
      `SELECT DISTINCT ON (assessment.source_id)
              assessment.source_id AS "sourceId", source.canonical_uri AS "canonicalUri",
              assessment.authority_class AS "authorityClass",
              assessment.availability_state AS "availabilityState",
              assessment.rights_state AS "rightsState",
              assessment.reliability_score::float8 AS "reliabilityScore",
              assessment.policy_version AS "policyVersion", assessment.observed_at AS "observedAt"
       FROM catalog.source_reliability_assessments assessment
       JOIN catalog.sources source ON source.id = assessment.source_id
       JOIN catalog.source_observations observation ON observation.source_id = source.id
       WHERE observation.id IN (
         SELECT source_observation_id FROM catalog.entity_metric_observations
         WHERE knowledge_entity_id = $1
       )
       ORDER BY assessment.source_id, assessment.observed_at DESC, assessment.id DESC`,
      [knowledgeEntityId],
    ),
  ]);
  return {
    knowledgeEntityId,
    trendHistory: metrics.rows,
    corroboration: corroboration.rows,
    sourceReliability: sourceReliability.rows,
  };
}
