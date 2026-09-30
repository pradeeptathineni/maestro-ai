import type { Pool } from 'pg';
import {
  assessCorroboration,
  corroborationPolicyVersion,
  newOpaqueId,
  type CorroborationEvidence,
} from '../../domain/src/index.js';
import { NotFoundError } from './errors.js';
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
       VALUES ($1, $2, 'source-reliability-v1', $3, $4, $5, $6, $7, $8, $9, $10,
               clock_timestamp())`,
      [
        id,
        input.sourceId,
        input.authorityClass,
        input.availabilityState,
        input.rightsState,
        input.reliabilityScore,
        json(input.evidenceBasis),
        input.sourceObservationIds,
        input.observedAt,
        predecessor.rows[0]?.id ?? null,
      ],
    );
    return id;
  });
}

export async function recordEntityMetricObservation(
  pool: Pool,
  input: {
    knowledgeEntityId: string;
    metricKey: string;
    rawValue: number | null;
    rawUnit: string;
    normalizedValue: number | null;
    cohortKey: string;
    normalizationPolicyVersion: string;
    normalizationDetail: Record<string, unknown>;
    windowStart: Date;
    windowEnd: Date;
    independenceGroup: string;
    sourceObservationId: string;
    observedAt: Date;
  },
): Promise<string> {
  const id = newOpaqueId();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO catalog.entity_metric_observations
       (id, knowledge_entity_id, metric_key, raw_value, raw_unit, normalized_value,
        cohort_key, normalization_policy_version, normalization_detail, window_start,
        window_end, independence_group, source_observation_id, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (knowledge_entity_id, metric_key, source_observation_id, window_start, window_end)
       DO NOTHING
     RETURNING id`,
    [
      id,
      input.knowledgeEntityId,
      input.metricKey,
      input.rawValue,
      input.rawUnit,
      input.normalizedValue,
      input.cohortKey,
      input.normalizationPolicyVersion,
      json(input.normalizationDetail),
      input.windowStart,
      input.windowEnd,
      input.independenceGroup,
      input.sourceObservationId,
      input.observedAt,
    ],
  );
  if (inserted.rows[0]?.id) return inserted.rows[0].id;
  const existing = await pool.query<{ id: string }>(
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
  return existing.rows[0]!.id;
}

export async function recordCorroboration(
  pool: Pool,
  input: {
    knowledgeEntityId: string;
    predicate: string;
    applicabilityScope: string;
    evidence: CorroborationEvidence[];
    sourceObservationIds: string[];
    evidenceItemIds: string[];
    observedAt: Date;
  },
): Promise<{ id: string; state: ReturnType<typeof assessCorroboration>['state'] }> {
  const assessment = assessCorroboration(input.evidence);
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
        input.sourceObservationIds,
        input.evidenceItemIds,
        assessment.reasons.join(' '),
        input.observedAt,
        predecessor.rows[0]?.id ?? null,
      ],
    );
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
