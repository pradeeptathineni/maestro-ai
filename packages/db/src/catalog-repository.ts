import type { Pool } from 'pg';
import { calculateConsiderationV1, type DimensionInput } from '../../scoring/src/index.js';

export type CatalogSort = 'consideration' | 'evidence' | 'freshness' | 'verification' | 'name';

export interface CatalogQuery {
  search?: string;
  kind?: string;
  domain?: string;
  sort?: CatalogSort;
  cursor?: string;
  limit?: number;
}

type JsonRow = Record<string, unknown>;

interface ProviderListRow extends JsonRow {
  total: number;
  evidence_adjusted: number | null;
  freshness_adjusted: number | null;
  verification_priority: number | null;
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (Number.isInteger(value.offset) && (value.offset as number) >= 0) {
      return value.offset as number;
    }
  } catch {
    // Deliberately return the safe first page for an opaque malformed cursor.
  }
  return 0;
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

const sortSql: Record<CatalogSort, string> = {
  consideration: 'score_data.lower_bound DESC NULLS LAST, p.canonical_name ASC, p.id ASC',
  evidence: 'score_data.evidence_adjusted DESC NULLS LAST, p.canonical_name ASC, p.id ASC',
  freshness: 'score_data.freshness_adjusted DESC NULLS LAST, p.canonical_name ASC, p.id ASC',
  verification: 'verification_data.priority DESC NULLS LAST, p.canonical_name ASC, p.id ASC',
  name: 'p.canonical_name ASC, p.id ASC',
};

export async function listDomains(pool: Pool): Promise<JsonRow[]> {
  const result = await pool.query<JsonRow>(`
    SELECT d.id, d.stable_key AS "key", d.label, d.definition,
           parent.stable_key AS "parentKey", t.taxonomy_key AS "taxonomyKey",
           t.version AS "taxonomyVersion", count(dm.provider_id)::int AS "providerCount"
    FROM catalog.domain_nodes d
    JOIN catalog.domain_taxonomy_versions t ON t.id = d.taxonomy_version_id
    LEFT JOIN catalog.domain_nodes parent ON parent.id = d.parent_id
    LEFT JOIN catalog.domain_memberships dm ON dm.domain_node_id = d.id
    WHERE t.status = 'active' AND d.status = 'active'
    GROUP BY d.id, parent.stable_key, t.taxonomy_key, t.version
    ORDER BY COALESCE(parent.stable_key, d.stable_key), d.label
  `);
  return result.rows;
}

export async function listProviders(
  pool: Pool,
  query: CatalogQuery,
): Promise<{
  items: unknown[];
  nextCursor: string | null;
  total: number;
}> {
  const search = query.search?.trim() || null;
  const kind = query.kind?.trim() || null;
  const domain = query.domain?.trim() || null;
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
  const offset = decodeOffset(query.cursor);
  const order = sortSql[query.sort ?? 'consideration'];
  const values = [search, kind, domain, limit + 1, offset];
  const result = await pool.query<ProviderListRow>(
    `SELECT p.id, p.kind, p.canonical_name AS name, p.description,
            p.lifecycle_state AS "lifecycleState", p.revision,
            COALESCE(alias_data.aliases, '{}') AS aliases,
            COALESCE(domain_data.domains, '[]'::jsonb) AS domains,
            COALESCE(capability_data.capabilities, '[]'::jsonb) AS capabilities,
            score_data.id AS "scoreRunId", score_data.policy_version AS "scorePolicyVersion",
            score_data.central::float8 AS "scoreCentral",
            score_data.uncertainty::float8 AS "scoreUncertainty",
            score_data.evidence_coverage::float8 AS "evidenceCoverage",
            score_data.lower_bound::float8 AS "considerationLowerBound",
            score_data.band AS "considerationBand",
            score_data.generated_at AS "scoreGeneratedAt",
            score_data.dimensions,
            score_data.evidence_adjusted::float8 AS evidence_adjusted,
            score_data.freshness_adjusted::float8 AS freshness_adjusted,
            verification_data.priority AS verification_priority,
            verification_data.state AS "verificationState",
            verification_data.next_plan AS "nextVerification",
            verification_data.adjustments AS "verificationAdjustments",
            CASE WHEN $1::text IS NULL THEN ARRAY[]::text[] ELSE array_remove(ARRAY[
              CASE WHEN p.canonical_name ILIKE '%' || $1 || '%' THEN 'name' END,
              CASE WHEN to_tsvector('simple', p.canonical_name || ' ' || p.description)
                         @@ websearch_to_tsquery('simple', $1) THEN 'full_text' END,
              CASE WHEN p.canonical_name % $1 THEN 'name_trigram' END,
              CASE WHEN EXISTS (
                SELECT 1 FROM catalog.provider_aliases pa
                WHERE pa.provider_id = p.id AND pa.alias ILIKE '%' || $1 || '%'
              ) THEN 'alias' END,
              CASE WHEN EXISTS (
                SELECT 1 FROM catalog.provider_capabilities pc
                JOIN catalog.capability_definitions cd ON cd.id = pc.capability_definition_id
                WHERE pc.provider_id = p.id
                  AND (cd.name ILIKE '%' || $1 || '%' OR cd.description ILIKE '%' || $1 || '%')
              ) THEN 'capability' END,
              CASE WHEN p.description ILIKE '%' || $1 || '%' THEN 'description' END
            ], NULL) END AS "matchedFields",
            count(*) OVER()::int AS total
     FROM catalog.providers p
     LEFT JOIN LATERAL (
       SELECT array_agg(pa.alias ORDER BY pa.alias) AS aliases
       FROM catalog.provider_aliases pa WHERE pa.provider_id = p.id
     ) alias_data ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('key', d.stable_key, 'label', d.label)
                        ORDER BY d.label) AS domains
       FROM catalog.domain_memberships dm
       JOIN catalog.domain_nodes d ON d.id = dm.domain_node_id
       WHERE dm.provider_id = p.id
     ) domain_data ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'key', cd.stable_key, 'name', cd.name, 'description', cd.description,
         'deliveryMode', pc.delivery_mode, 'assertionState', pc.assertion_state,
         'effects', pc.effects
       ) ORDER BY cd.name) AS capabilities
       FROM catalog.provider_capabilities pc
       JOIN catalog.capability_definitions cd ON cd.id = pc.capability_definition_id
       WHERE pc.provider_id = p.id
     ) capability_data ON true
     LEFT JOIN LATERAL (
       SELECT sr.id, sp.version AS policy_version, sr.central, sr.uncertainty,
              sr.evidence_coverage, sr.lower_bound, sr.band, sr.generated_at,
              jsonb_agg(jsonb_build_object(
                'key', ds.dimension_key, 'raw', ds.raw::float8,
                'adjusted', ds.adjusted::float8, 'confidence', ds.confidence::float8,
                'coverage', ds.coverage::float8, 'prior', ds.prior::float8,
                'state', ds.state, 'reasons', ds.reasons, 'missing', ds.missing,
                'evidenceIds', ds.evidence_ids
              ) ORDER BY ds.dimension_key) AS dimensions,
              max(ds.adjusted) FILTER (WHERE ds.dimension_key = 'evidence_strength')
                AS evidence_adjusted,
              max(ds.adjusted) FILTER (WHERE ds.dimension_key = 'freshness_support')
                AS freshness_adjusted
       FROM catalog.score_runs sr
       JOIN catalog.score_policies sp ON sp.id = sr.policy_id
       JOIN catalog.dimension_scores ds ON ds.score_run_id = sr.id
       WHERE sr.provider_id = p.id
       GROUP BY sr.id, sp.version
       ORDER BY sr.generated_at DESC, sr.id DESC LIMIT 1
     ) score_data ON true
     LEFT JOIN LATERAL (
       SELECT va.priority, va.state, va.next_plan, va.adjustments
       FROM catalog.verification_assessments va
       WHERE va.provider_id = p.id
       ORDER BY va.generated_at DESC, va.id DESC LIMIT 1
     ) verification_data ON true
     WHERE ($2::text IS NULL OR p.kind = $2)
       AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM catalog.domain_memberships dm
         JOIN catalog.domain_nodes d ON d.id = dm.domain_node_id
         WHERE dm.provider_id = p.id AND d.stable_key = $3
       ))
       AND ($1::text IS NULL OR
         p.canonical_name ILIKE '%' || $1 || '%' OR
         p.description ILIKE '%' || $1 || '%' OR
         to_tsvector('simple', p.canonical_name || ' ' || p.description)
           @@ websearch_to_tsquery('simple', $1) OR
         p.canonical_name % $1 OR
         EXISTS (SELECT 1 FROM catalog.provider_aliases pa
                 WHERE pa.provider_id = p.id AND pa.alias ILIKE '%' || $1 || '%') OR
         EXISTS (SELECT 1 FROM catalog.provider_capabilities pc
                 JOIN catalog.capability_definitions cd ON cd.id = pc.capability_definition_id
                 WHERE pc.provider_id = p.id
                   AND (cd.name ILIKE '%' || $1 || '%' OR cd.description ILIKE '%' || $1 || '%'))
       )
     ORDER BY ${order}
     LIMIT $4 OFFSET $5`,
    values,
  );
  const hasNext = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const total = Number(rows[0]?.total ?? 0);
  return {
    items: rows.map((row) => ({
      ...Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !['total', 'evidence_adjusted', 'freshness_adjusted', 'verification_priority'].includes(
              key,
            ),
        ),
      ),
      verificationPriority: row.verification_priority,
    })),
    nextCursor: hasNext ? encodeOffset(offset + limit) : null,
    total,
  };
}

export async function getProviderDetail(pool: Pool, providerId: string): Promise<JsonRow | null> {
  const providerResult = await pool.query<JsonRow>(
    `SELECT p.id, p.kind, p.canonical_name AS name, p.description,
            p.lifecycle_state AS "lifecycleState", p.revision,
            p.created_at AS "createdAt", p.updated_at AS "updatedAt"
     FROM catalog.providers p WHERE p.id = $1`,
    [providerId],
  );
  if (!providerResult.rowCount) return null;
  const [
    identities,
    aliases,
    versions,
    capabilities,
    domains,
    claims,
    score,
    verification,
    compatibility,
  ] = await Promise.all([
    pool.query<JsonRow>(
      `SELECT scheme, normalized_value AS value, display_value AS "displayValue",
                confidence::float8, is_canonical AS "isCanonical", valid_from AS "validFrom",
                valid_to AS "validTo"
         FROM catalog.provider_identities WHERE provider_id = $1
         ORDER BY is_canonical DESC, scheme, normalized_value`,
      [providerId],
    ),
    pool.query<{ alias: string }>(
      'SELECT alias FROM catalog.provider_aliases WHERE provider_id = $1 ORDER BY alias',
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT id, upstream_version AS version, release_observed_at AS "releasedAt",
                lifecycle_state AS "lifecycleState"
         FROM catalog.provider_versions WHERE provider_id = $1 ORDER BY created_at DESC`,
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT cd.stable_key AS key, cd.name, cd.description, cd.schema_version AS "schemaVersion",
                cd.effect_classes AS "declaredEffects", pc.delivery_mode AS "deliveryMode",
                pc.maturity_state AS "maturityState", pc.assertion_state AS "assertionState",
                pc.effects, pc.constraints
         FROM catalog.provider_capabilities pc
         JOIN catalog.capability_definitions cd ON cd.id = pc.capability_definition_id
         WHERE pc.provider_id = $1 ORDER BY cd.name`,
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT d.stable_key AS key, d.label, d.definition, dm.origin,
                dm.confidence::float8, dm.rationale, dm.reviewed
         FROM catalog.domain_memberships dm
         JOIN catalog.domain_nodes d ON d.id = dm.domain_node_id
         WHERE dm.provider_id = $1 ORDER BY d.label`,
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT c.id, c.claimant, c.claimant_relation AS "claimantRelation", c.predicate,
                c.value, c.scope, c.workflow_state AS "workflowState", c.valid_from AS "validFrom",
                s.title AS "sourceTitle", s.owner AS "sourceOwner", s.canonical_uri AS "sourceUrl",
                so.observed_at AS "observedAt", so.excerpt AS "sourceObservation",
                COALESCE(jsonb_agg(jsonb_build_object(
                  'direction', er.direction, 'directness', er.directness,
                  'strength', er.strength, 'applicability', er.applicability,
                  'rationale', er.rationale, 'evidenceId', ei.id,
                  'evidenceType', ei.evidence_type, 'producer', ei.producer,
                  'methodVersion', ei.method_version, 'independence', ei.independence,
                  'limitations', ei.limitations, 'reviewAfter', ei.review_after
                )) FILTER (WHERE er.id IS NOT NULL), '[]'::jsonb) AS evidence
         FROM catalog.claims c
         JOIN catalog.source_observations so ON so.id = c.source_observation_id
         JOIN catalog.sources s ON s.id = so.source_id
         LEFT JOIN catalog.evidence_relations er ON er.claim_id = c.id
         LEFT JOIN catalog.evidence_items ei ON ei.id = er.evidence_item_id
         WHERE c.provider_id = $1
         GROUP BY c.id, s.id, so.id ORDER BY c.created_at, c.id`,
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT sr.id, sp.version AS "policyVersion", sp.policy_document AS "policyDocument",
                sr.input_hash AS "inputHash", sr.central::float8, sr.uncertainty::float8,
                sr.evidence_coverage::float8 AS "evidenceCoverage",
                sr.lower_bound::float8 AS "lowerBound", sr.band,
                sr.evidence_ids AS "evidenceIds", sr.generated_at AS "generatedAt",
                COALESCE(jsonb_agg(jsonb_build_object(
                  'key', ds.dimension_key, 'raw', ds.raw::float8,
                  'adjusted', ds.adjusted::float8, 'confidence', ds.confidence::float8,
                  'coverage', ds.coverage::float8, 'prior', ds.prior::float8,
                  'state', ds.state, 'reasons', ds.reasons, 'missing', ds.missing,
                  'evidenceIds', ds.evidence_ids
                ) ORDER BY ds.dimension_key), '[]'::jsonb) AS dimensions
         FROM catalog.score_runs sr
         JOIN catalog.score_policies sp ON sp.id = sr.policy_id
         JOIN catalog.dimension_scores ds ON ds.score_run_id = sr.id
         WHERE sr.provider_id = $1
         GROUP BY sr.id, sp.id ORDER BY sr.generated_at DESC LIMIT 1`,
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT id, policy_version AS "policyVersion", scope, priority, base_priority AS "basePriority",
                state, modes, factors, adjustments, next_plan AS "nextPlan",
                evidence_ids AS "evidenceIds", generated_at AS "generatedAt"
         FROM catalog.verification_assessments WHERE provider_id = $1
         ORDER BY generated_at DESC, id DESC`,
      [providerId],
    ),
    pool.query<JsonRow>(
      `SELECT compatibility_key AS key, state, value, explanation,
                evidence_ids AS "evidenceIds", observed_at AS "observedAt"
         FROM catalog.provider_compatibility WHERE provider_id = $1 ORDER BY compatibility_key`,
      [providerId],
    ),
  ]);
  return {
    ...providerResult.rows[0],
    identities: identities.rows,
    aliases: aliases.rows.map((row) => row.alias),
    versions: versions.rows,
    capabilities: capabilities.rows,
    domains: domains.rows,
    claims: claims.rows,
    score: score.rows[0] ?? null,
    verification: verification.rows,
    compatibility: compatibility.rows,
    executionAvailability: {
      available: false,
      explanation:
        'Maestro v0 records evidence and decisions; it cannot install or execute providers.',
    },
  };
}

export async function listVerificationQueue(pool: Pool): Promise<JsonRow[]> {
  const result = await pool.query<JsonRow>(`
    SELECT va.id, va.provider_id AS "providerId", p.canonical_name AS "providerName",
           va.priority, va.base_priority AS "basePriority", va.state, va.scope, va.modes,
           va.factors, va.adjustments, va.next_plan AS "nextPlan",
           va.generated_at AS "generatedAt"
    FROM catalog.verification_assessments va
    JOIN catalog.providers p ON p.id = va.provider_id
    ORDER BY va.priority DESC, p.canonical_name ASC
  `);
  return result.rows;
}

export async function replayStoredScores(pool: Pool): Promise<{
  checked: number;
  mismatches: Array<{ scoreRunId: string; reason: string }>;
}> {
  const runs = await pool.query<{
    id: string;
    central: number;
    uncertainty: number;
    evidenceCoverage: number;
    lowerBound: number;
    band: string;
  }>(`
    SELECT id, central::float8, uncertainty::float8,
           evidence_coverage::float8 AS "evidenceCoverage",
           lower_bound::float8 AS "lowerBound", band
    FROM catalog.score_runs ORDER BY id
  `);
  const mismatches: Array<{ scoreRunId: string; reason: string }> = [];
  for (const run of runs.rows) {
    const dimensions = await pool.query<{
      key: DimensionInput['key'];
      raw: number | null;
      confidence: number;
      coverage: number;
      prior: number;
      state: DimensionInput['state'];
      reasons: string[];
      missing: string[];
      evidenceIds: string[];
    }>(
      `SELECT dimension_key AS key, raw::float8, confidence::float8, coverage::float8,
              prior::float8, state, reasons, missing, evidence_ids AS "evidenceIds"
       FROM catalog.dimension_scores WHERE score_run_id = $1 ORDER BY dimension_key`,
      [run.id],
    );
    const inputs: DimensionInput[] = dimensions.rows.map((dimension) => ({
      key: dimension.key,
      raw: dimension.raw,
      confidence: dimension.confidence,
      coverage: dimension.coverage,
      applicability: dimension.state === 'not_applicable' ? 'not_applicable' : 'applicable',
      highPrivilege: dimension.key === 'security_provenance' && dimension.prior === 25,
      state: dimension.state,
      reasons: dimension.reasons,
      missing: dimension.missing,
      evidenceIds: dimension.evidenceIds,
    }));
    const replay = calculateConsiderationV1(inputs);
    if (
      replay.central !== run.central ||
      replay.uncertainty !== run.uncertainty ||
      replay.evidenceCoverage !== run.evidenceCoverage ||
      replay.lowerBound !== run.lowerBound ||
      replay.band !== run.band
    ) {
      mismatches.push({ scoreRunId: run.id, reason: 'Stored result differs from policy replay.' });
    }
  }
  return { checked: runs.rowCount ?? runs.rows.length, mismatches };
}
