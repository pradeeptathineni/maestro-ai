import type { Pool, PoolClient } from 'pg';
import { hashCanonical } from '../../domain/src/index.js';
import {
  calculateCompatibilityIntrinsicSignal,
  calculateIntrinsicSignalV3,
  calculateTrend,
  intrinsicSignalProfile,
  normalizeCohortMetricV1,
  type IntrinsicDimensionInput,
  type IntrinsicDimensionKey,
  type IntrinsicSignalResult,
  type QueryValueInput,
  type TrendObservation,
} from '../../scoring/src/index.js';

export interface IntrinsicSignalSubject {
  entityId: string;
  kind: string;
  valueProfile: QueryValueInput[];
  observedAt: Date;
  asOf: Date;
  evidenceSourceGroups: string[];
  freshness: number;
  provisional: boolean;
}

interface MetricRow {
  id: string;
  entityId: string;
  metricKey: string;
  intrinsicDimension: IntrinsicDimensionKey | null;
  metricDirection: 'higher_is_better' | 'lower_is_better' | null;
  rawValue: number | null;
  rawUnit: string;
  metricAggregation: 'total' | 'snapshot' | null;
  normalizedValue: number | null;
  cohortKey: string;
  cohortPolicyVersion: string | null;
  normalizationPolicyVersion: string;
  normalizationDetail: unknown;
  normalizationInputHash: string | null;
  windowStart: Date;
  windowEnd: Date;
  independenceGroup: string;
  sourceObservationId: string;
  sourceId: string | null;
  observedAt: Date;
}

const dimensionKeys = [
  'reach',
  'authority',
  'evidence',
  'freshness',
  'impact',
  'momentum',
] as const;

function metricDimension(row: MetricRow): IntrinsicDimensionKey | null {
  return row.normalizationPolicyVersion === 'cohort-percentile-v1'
    ? row.intrinsicDimension
    : null;
}

function detailNumber(row: MetricRow, key: string): number | null {
  if (!row.normalizationDetail || typeof row.normalizationDetail !== 'object') return null;
  const value = (row.normalizationDetail as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function detailStringArray(row: MetricRow, key: string): string[] {
  if (!row.normalizationDetail || typeof row.normalizationDetail !== 'object') return [];
  const value = (row.normalizationDetail as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function metricCombination(row: MetricRow): string {
  return [
    row.metricKey,
    row.cohortKey,
    row.rawUnit,
    row.metricAggregation ?? '',
    row.intrinsicDimension ?? '',
    row.metricDirection ?? '',
  ].join('\u0000');
}

function normalizeForSnapshot(
  targetRows: MetricRow[],
  peerRows: MetricRow[],
  asOf: Date,
): MetricRow[] {
  const earliest = new Date(asOf.getTime() - 365 * 24 * 60 * 60 * 1000);
  return targetRows.flatMap((row) => {
    if (row.rawValue === null || !row.metricDirection || !metricDimension(row)) return [];
    const comparable = peerRows
      .filter(
        (peer) =>
          metricCombination(peer) === metricCombination(row) &&
          peer.rawValue !== null &&
          peer.observedAt <= asOf &&
          peer.observedAt >= earliest,
      )
      .sort(
        (left, right) =>
          right.observedAt.getTime() - left.observedAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    const currentByEntityAndOwner = new Map<string, MetricRow>();
    for (const peer of comparable) {
      const key = `${peer.entityId}:${peer.independenceGroup}`;
      if (!currentByEntityAndOwner.has(key)) currentByEntityAndOwner.set(key, peer);
    }
    const references = [...currentByEntityAndOwner.values()]
      .filter(
        (peer) =>
          !(peer.entityId === row.entityId && peer.independenceGroup === row.independenceGroup),
      )
      .sort(
        (left, right) =>
          left.entityId.localeCompare(right.entityId) ||
          left.independenceGroup.localeCompare(right.independenceGroup) ||
          left.id.localeCompare(right.id),
      );
    const normalization = normalizeCohortMetricV1({
      rawValue: row.rawValue,
      referenceValues: references.map((reference) => reference.rawValue!),
      direction: row.metricDirection,
    });
    const referenceIds = references.map((reference) => reference.id);
    const normalizationInputHash = hashCanonical({
      policyVersion: normalization.policyVersion,
      cohortPolicyVersion: row.cohortPolicyVersion,
      cohortKey: row.cohortKey,
      metricKey: row.metricKey,
      rawUnit: row.rawUnit,
      direction: row.metricDirection,
      target: { id: row.id, rawValue: row.rawValue },
      references: references.map((reference) => ({
        id: reference.id,
        entityId: reference.entityId,
        independenceGroup: reference.independenceGroup,
        rawValue: reference.rawValue,
      })),
      asOf: asOf.toISOString(),
    });
    return [
      {
        ...row,
        normalizedValue: normalization.normalized,
        normalizationInputHash,
        normalizationDetail: {
          ...(row.normalizationDetail && typeof row.normalizationDetail === 'object'
            ? row.normalizationDetail
            : {}),
          activeReferenceCount: normalization.referenceCount,
          activeReferenceIds: referenceIds,
          activePercentile: normalization.percentile,
          activeLowerFence: normalization.lowerFence,
          activeUpperFence: normalization.upperFence,
          activeOutlierClipped: normalization.outlierClipped,
          activeNormalizationInputHash: normalizationInputHash,
          activeAsOf: asOf.toISOString(),
        },
      },
    ];
  });
}

function latestPerMetricAndSource(rows: MetricRow[]): MetricRow[] {
  const latest = new Map<string, MetricRow>();
  for (const row of [...rows].sort(
    (left, right) =>
      right.observedAt.getTime() - left.observedAt.getTime() ||
      right.id.localeCompare(left.id),
  )) {
    const key = `${row.metricKey}:${row.independenceGroup}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()].sort((left, right) => left.metricKey.localeCompare(right.metricKey));
}

function typedDimensions(rows: MetricRow[], observedAt: Date): IntrinsicDimensionInput[] {
  return dimensionKeys.map((key) => {
    const selected = latestPerMetricAndSource(rows.filter((row) => metricDimension(row) === key));
    const measured = selected.filter((row) => row.normalizedValue !== null);
    const normalized = measured.length
      ? measured.reduce((sum, row) => sum + row.normalizedValue!, 0) / measured.length
      : null;
    const groups = new Set(measured.map((row) => row.independenceGroup));
    const cohort = [...new Set(measured.map((row) => row.cohortKey))].sort().join(' + ');
    const referenceConfidence = measured.length
      ? measured.reduce(
          (sum, row) =>
            sum + Math.min(1, (detailNumber(row, 'activeReferenceCount') ?? 1) / 10),
          0,
        ) / measured.length
      : 0;
    const sourceConfidence = measured.length
      ? measured.reduce(
          (sum, row) => sum + (detailNumber(row, 'sourceReliabilityScore') ?? 0.25),
          0,
        ) / measured.length
      : 0;
    const confidence =
      normalized === null
        ? 0
        : Math.min(
            0.95,
            0.15 + Math.min(0.25, groups.size * 0.125) + referenceConfidence * 0.3 + sourceConfidence * 0.3,
          );
    return {
      key,
      normalized,
      confidence,
      coverage:
        normalized === null ? 0 : Math.min(1, measured.length / 2) * referenceConfidence,
      applicability: 'applicable' as const,
      state: normalized === null ? ('missing' as const) : ('present' as const),
      normalization: {
        method: 'cohort_percentile' as const,
        cohort: cohort || 'unobserved',
        observedAt: measured.at(-1)?.observedAt.toISOString() ?? observedAt.toISOString(),
        window:
          measured.length > 0
            ? `${measured[0]!.windowStart.toISOString()}/${measured.at(-1)!.windowEnd.toISOString()}`
            : undefined,
        sourceMetric: measured.map((row) => row.metricKey).join(', ') || 'not_available',
        policyVersion: 'cohort-percentile-v1',
        cohortPolicyVersion: 'entity-class-cohort-v1',
        inputHash: measured.map((row) => row.normalizationInputHash).filter(Boolean).join('+'),
        referenceIds: [
          ...new Set(measured.flatMap((row) => detailStringArray(row, 'activeReferenceIds'))),
        ].sort(),
      },
      reasons:
        normalized === null
          ? []
          : [
              `Aggregated ${measured.length} source-bound cohort-normalized metric(s) across ${groups.size} owner group(s).`,
            ],
      missing: normalized === null ? [`No typed ${key} metric is recorded.`] : [],
      evidenceIds: [],
    };
  });
}

function typedTrend(rows: MetricRow[], observedAt: Date): ReturnType<typeof calculateTrend> {
  const byMetric = new Map<string, MetricRow[]>();
  for (const row of rows.filter((item) => item.normalizedValue !== null)) {
    const values = byMetric.get(row.metricKey) ?? [];
    values.push(row);
    byMetric.set(row.metricKey, values);
  }
  const selected = [...byMetric.values()].sort(
    (left, right) => right.length - left.length || left[0]!.metricKey.localeCompare(right[0]!.metricKey),
  )[0];
  if (!selected?.length) {
    const windowEnd = observedAt;
    const windowStart = new Date(windowEnd.getTime() - 90 * 24 * 60 * 60 * 1000);
    return calculateTrend([], {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      now: windowEnd.toISOString(),
    });
  }
  const windowStart = new Date(Math.min(...selected.map((row) => row.windowStart.getTime())));
  let windowEnd = new Date(Math.max(...selected.map((row) => row.windowEnd.getTime())));
  if (windowEnd <= windowStart) windowEnd = new Date(windowStart.getTime() + 1);
  const observations: TrendObservation[] = selected.map((row) => ({
    observedAt: row.observedAt.toISOString(),
    value: row.normalizedValue!,
    sourceId: row.sourceObservationId,
    independenceGroup: row.independenceGroup,
  }));
  return calculateTrend(observations, {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    now: observedAt.toISOString(),
  });
}

function typedSignal(subject: IntrinsicSignalSubject, rows: MetricRow[]): IntrinsicSignalResult {
  const latest = Math.max(...rows.map((row) => row.observedAt.getTime()));
  const ageDays = Math.max(0, subject.asOf.getTime() - latest) / (24 * 60 * 60 * 1000);
  const groups = [...new Set(rows.map((row) => row.independenceGroup))];
  const dimensions = typedDimensions(rows, subject.asOf);
  const measuredDimensions = dimensions.filter((dimension) => dimension.normalized !== null);
  const signal = calculateIntrinsicSignalV3({
    profile: intrinsicSignalProfile(subject.kind),
    dimensions,
    evidenceConfidence: {
      directness:
        rows.reduce(
          (sum, row) => sum + (detailNumber(row, 'sourceReliabilityScore') ?? 0.25),
          0,
        ) / rows.length,
      independence: Math.min(1, 0.35 + groups.length * 0.25),
      applicability: measuredDimensions.length / dimensionKeys.length,
      freshness: Math.max(0.1, 1 - ageDays / 365),
      coverage:
        dimensions.reduce((sum, dimension) => sum + dimension.coverage, 0) /
        dimensionKeys.length,
      contradiction: rows.some(
        (row) =>
          row.normalizationDetail &&
          typeof row.normalizationDetail === 'object' &&
          (row.normalizationDetail as Record<string, unknown>).contradicted === true,
      )
        ? 1
        : 0,
      sourceGroupIds: groups,
      evidenceIds: [],
    },
    trend: typedTrend(rows, subject.asOf),
    provisional: subject.provisional,
  });
  return {
    ...signal,
    inputEvidenceIds: [],
    inputReferences: {
      evidenceItemIds: [],
      metricObservationIds: [...new Set(rows.map((row) => row.id))].sort(),
      sourceObservationIds: [...new Set(rows.map((row) => row.sourceObservationId))].sort(),
      normalizationInputHashes: [
        ...new Set(rows.map((row) => row.normalizationInputHash).filter(Boolean)),
      ].sort() as string[],
      asOf: subject.asOf.toISOString(),
    },
  };
}

export async function loadIntrinsicSignals(
  pool: Pool | PoolClient,
  subjects: IntrinsicSignalSubject[],
): Promise<Map<string, IntrinsicSignalResult>> {
  if (!subjects.length) return new Map();
  const ids = [...new Set(subjects.map((subject) => subject.entityId))];
  const target = await pool.query<MetricRow>(
    `SELECT id::text AS id, knowledge_entity_id::text AS "entityId", metric_key AS "metricKey",
            intrinsic_dimension AS "intrinsicDimension", metric_direction AS "metricDirection",
            comparison_value::float8 AS "rawValue", comparison_unit AS "rawUnit",
            metric_aggregation AS "metricAggregation",
            normalized_value::float8 AS "normalizedValue", cohort_key AS "cohortKey",
            cohort_policy_version AS "cohortPolicyVersion",
            normalization_policy_version AS "normalizationPolicyVersion",
            normalization_detail AS "normalizationDetail",
            normalization_input_hash AS "normalizationInputHash", window_start AS "windowStart",
            window_end AS "windowEnd", independence_group AS "independenceGroup",
            source_observation_id::text AS "sourceObservationId", source_id::text AS "sourceId",
            observed_at AS "observedAt"
     FROM catalog.entity_metric_observations
     WHERE knowledge_entity_id = ANY($1::uuid[])
     ORDER BY knowledge_entity_id, metric_key, observed_at, id`,
    [ids],
  );
  const combinations = [
    ...new Map(
      target.rows
        .filter((row) => metricDimension(row) !== null)
        .map((row) => [
          metricCombination(row),
          {
            metricKey: row.metricKey,
            cohortKey: row.cohortKey,
            rawUnit: row.rawUnit,
            metricAggregation: row.metricAggregation,
            intrinsicDimension: row.intrinsicDimension,
            metricDirection: row.metricDirection,
          },
        ]),
    ).values(),
  ];
  const maximumAsOf = new Date(Math.max(...subjects.map((subject) => subject.asOf.getTime())));
  const peers = combinations.length
    ? await pool.query<MetricRow>(
        `SELECT observation.id::text AS id,
                observation.knowledge_entity_id::text AS "entityId",
                observation.metric_key AS "metricKey",
                observation.intrinsic_dimension AS "intrinsicDimension",
                observation.metric_direction AS "metricDirection",
                observation.comparison_value::float8 AS "rawValue",
                observation.comparison_unit AS "rawUnit",
                observation.metric_aggregation AS "metricAggregation",
                observation.normalized_value::float8 AS "normalizedValue",
                observation.cohort_key AS "cohortKey",
                observation.cohort_policy_version AS "cohortPolicyVersion",
                observation.normalization_policy_version AS "normalizationPolicyVersion",
                observation.normalization_detail AS "normalizationDetail",
                observation.normalization_input_hash AS "normalizationInputHash",
                observation.window_start AS "windowStart", observation.window_end AS "windowEnd",
                observation.independence_group AS "independenceGroup",
                observation.source_observation_id::text AS "sourceObservationId",
                observation.source_id::text AS "sourceId", observation.observed_at AS "observedAt"
         FROM catalog.entity_metric_observations observation
         JOIN jsonb_to_recordset($1::jsonb) AS requested(
           "metricKey" text, "cohortKey" text, "rawUnit" text,
           "metricAggregation" text,
           "intrinsicDimension" text, "metricDirection" text
         ) ON requested."metricKey" = observation.metric_key
            AND requested."cohortKey" = observation.cohort_key
            AND requested."rawUnit" = observation.comparison_unit
            AND requested."metricAggregation" = observation.metric_aggregation
            AND requested."intrinsicDimension" = observation.intrinsic_dimension
            AND requested."metricDirection" = observation.metric_direction
         WHERE observation.normalization_policy_version = 'cohort-percentile-v1'
           AND observation.observed_at <= $2
         ORDER BY observation.metric_key, observation.cohort_key,
                  observation.knowledge_entity_id, observation.observed_at, observation.id`,
        [JSON.stringify(combinations), maximumAsOf],
      )
    : { rows: [] as MetricRow[] };
  const byEntity = new Map<string, MetricRow[]>();
  for (const row of target.rows) {
    const rows = byEntity.get(row.entityId) ?? [];
    rows.push(row);
    byEntity.set(row.entityId, rows);
  }
  return new Map(
    subjects.map((subject) => {
      const rows = (byEntity.get(subject.entityId) ?? []).filter(
        (row) => row.observedAt <= subject.asOf,
      );
      const typedRows = normalizeForSnapshot(
        rows.filter((row) => metricDimension(row) !== null),
        peers.rows,
        subject.asOf,
      );
      const signal = typedRows.length
        ? typedSignal(subject, typedRows)
        : calculateCompatibilityIntrinsicSignal({
            kind: subject.kind,
            valueProfile: subject.valueProfile,
            observedAt: subject.observedAt.toISOString(),
            evidenceSourceGroups: subject.evidenceSourceGroups,
            freshness: subject.freshness,
            provisional: subject.provisional,
          });
      return [subject.entityId, signal];
    }),
  );
}
