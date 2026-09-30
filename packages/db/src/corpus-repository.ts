import type { Pool } from 'pg';
import type { CorpusBrowseQuery, CorpusSearchBody } from '../../contracts/src/index.js';
import {
  compileLexicalRelevance,
  hashCanonical,
  interpretQuery,
  type QueryInterpretation,
} from '../../domain/src/index.js';
import {
  calculateCompatibilityIntrinsicSignal,
  calculateQuerySignalV2,
  querySignalKindProfile,
  querySignalPolicyV2,
  type IntrinsicSignalResult,
  type QuerySignalResult,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import { postgresPrefixTsQuery, uniqueCandidateTerms } from './candidate-search.js';
import { scoreDiscoveryCandidate } from './discovery-repository.js';
import { DomainValidationError } from './errors.js';
import { loadQueryKnowledge } from './taxonomy-repository.js';

type CorpusLayer = 'indexed_knowledge' | 'knowledge_document' | 'source_lead';

const corpusCandidateThreshold = 5_000;
const corpusCandidateLimit = 50;
const corpusCandidateOverfetch = 100;

interface CorpusRow {
  id: string;
  layer: CorpusLayer;
  entityClass: string;
  providerId: string | null;
  documentId: string | null;
  name: string;
  summary: string;
  kind: string;
  state: 'reviewed' | 'proposed' | 'stale' | 'lead';
  aliases: string[];
  capabilities: string[];
  searchText: string;
  sources: string[];
  canonicalUri: string | null;
  observedAt: string;
  valueProfile: unknown;
  cachedValueConservative: number | null;
  cachedEvidenceCoverage: number | null;
  sourcePayload: unknown;
}

interface ScoredCorpusRow extends CorpusRow {
  matchedTerms: string[];
  relevanceOrdinal: QuerySignalResult['relevanceOrdinal'] | null;
  relevanceValue: number | null;
  signalDisplay: number | null;
  signalUnrounded: number | null;
  evidenceCoverage: number | null;
  displayState: QuerySignalResult['displayState'] | null;
  signalBand: QuerySignalResult['band'] | IntrinsicSignalResult['band'] | null;
  signalPolicyVersion:
    QuerySignalResult['policyVersion'] | IntrinsicSignalResult['policyVersion'] | null;
  evidenceConfidence: number | null;
  evidenceConfidenceDetail: IntrinsicSignalResult['evidenceConfidence'] | null;
  trend: IntrinsicSignalResult['trend'] | null;
  signalExplanation: string | null;
}

function encodeCursor(offset: number, viewHash: string): string {
  return Buffer.from(JSON.stringify({ offset, viewHash }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, viewHash: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
      viewHash?: unknown;
    };
    if (
      Number.isInteger(decoded.offset) &&
      Number(decoded.offset) >= 0 &&
      decoded.viewHash === viewHash
    ) {
      return Number(decoded.offset);
    }
  } catch {
    // The public error below intentionally does not reveal cursor internals.
  }
  throw new DomainValidationError('Corpus cursor does not belong to this filtered view.');
}

function valueProfile(value: unknown): QueryValueInput[] {
  if (!Array.isArray(value)) throw new DomainValidationError('Knowledge value profile is invalid.');
  return value as QueryValueInput[];
}

function cachedImplementationSignal(
  row: CorpusRow,
  relevanceValue: number,
): Pick<
  QuerySignalResult,
  | 'signalDisplay'
  | 'signalUnrounded'
  | 'evidenceCoverage'
  | 'displayState'
  | 'band'
  | 'policyVersion'
> | null {
  if (
    row.layer !== 'indexed_knowledge' ||
    querySignalKindProfile(row.kind) !== 'implementation' ||
    row.cachedValueConservative === null ||
    row.cachedEvidenceCoverage === null
  ) {
    return null;
  }
  const signalUnrounded =
    Math.round(
      ((relevanceValue / 100) * row.cachedValueConservative + Number.EPSILON) * 1_000_000,
    ) / 1_000_000;
  const displayState =
    row.state !== 'reviewed'
      ? 'provisional'
      : row.cachedEvidenceCoverage <= querySignalPolicyV2.coverageThreshold
        ? 'insufficient_evidence'
        : 'available';
  const signalDisplay = Math.floor(signalUnrounded + 0.5);
  const band =
    signalDisplay >= 75
      ? 'Strong consideration'
      : signalDisplay >= 60
        ? 'Promising'
        : signalDisplay >= 40
          ? 'Investigate'
          : 'Weak consideration';
  return {
    signalDisplay,
    signalUnrounded,
    evidenceCoverage: row.cachedEvidenceCoverage,
    displayState,
    band,
    policyVersion: querySignalPolicyV2.version,
  };
}

function countFacets(
  rows: ScoredCorpusRow[],
  key: 'entityClass' | 'kind' | 'state',
): Array<{
  value: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function sourceFacets(rows: ScoredCorpusRow[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const source of new Set(row.sources)) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function intrinsicCorpusSignal(row: CorpusRow): IntrinsicSignalResult {
  const values = valueProfile(row.valueProfile);
  const observedAt = new Date(row.observedAt);
  const windowEnd = Number.isFinite(observedAt.valueOf()) ? observedAt : new Date(0);
  return calculateCompatibilityIntrinsicSignal({
    kind: row.kind,
    valueProfile: values,
    observedAt: windowEnd.toISOString(),
    evidenceSourceGroups: row.sources,
    freshness: row.state === 'stale' ? 0.2 : 0.8,
    provisional: row.state !== 'reviewed',
  });
}

function assessRow(
  row: CorpusRow,
  interpretation: QueryInterpretation | null,
  assessRelevance: ReturnType<typeof compileLexicalRelevance> | null,
): ScoredCorpusRow | null {
  if (!interpretation) {
    const intrinsic = row.layer === 'source_lead' ? null : intrinsicCorpusSignal(row);
    return {
      ...row,
      matchedTerms: [],
      relevanceOrdinal: null,
      relevanceValue: null,
      signalDisplay: intrinsic?.display ?? null,
      signalUnrounded: intrinsic?.conservative ?? null,
      evidenceCoverage: intrinsic?.evidenceConfidence.coverage ?? null,
      displayState: intrinsic?.displayState ?? null,
      signalBand: intrinsic?.band ?? null,
      signalPolicyVersion: intrinsic?.policyVersion ?? null,
      evidenceConfidence: intrinsic?.evidenceConfidence.score ?? null,
      evidenceConfidenceDetail: intrinsic?.evidenceConfidence ?? null,
      trend: intrinsic?.trend ?? null,
      signalExplanation: intrinsic
        ? row.state === 'reviewed'
          ? 'Query-independent intrinsic estimate from the current type-aware value profile and bound evidence.'
          : `Query-independent intrinsic estimate from a ${row.state} index record; review state qualifies confidence.`
        : null,
    };
  }
  if (row.layer === 'source_lead') {
    const scored = scoreDiscoveryCandidate(interpretation, {
      id: row.id,
      title: row.name,
      summary: row.summary,
      kindHint: row.kind,
      sourcePayload: row.sourcePayload,
    });
    if (scored.relevanceOrdinal === 'no_match') return null;
    return {
      ...row,
      matchedTerms: scored.matchedTerms as string[],
      relevanceOrdinal: scored.relevanceOrdinal as QuerySignalResult['relevanceOrdinal'],
      relevanceValue: Number(scored.relevanceValue),
      signalDisplay: Number(scored.signalDisplay),
      signalUnrounded: Number(scored.signalUnrounded),
      evidenceCoverage: Number(scored.evidenceCoverage),
      displayState: scored.displayState as QuerySignalResult['displayState'],
      signalBand: scored.signalBand as QuerySignalResult['band'],
      signalPolicyVersion: scored.signalPolicyVersion as QuerySignalResult['policyVersion'],
      evidenceConfidence: Number(scored.evidenceCoverage),
      evidenceConfidenceDetail: null,
      trend: null,
      signalExplanation:
        'Preliminary estimate from query relevance and attributed source metadata. It is not reviewed knowledge.',
    };
  }
  const relevance = assessRelevance!({
    name: row.name,
    aliases: row.aliases,
    capabilities: row.capabilities,
    searchText: row.searchText,
  });
  if (relevance.ordinal === 'no_match') return null;
  const legacyValue =
    cachedImplementationSignal(row, relevance.value) ??
    calculateQuerySignalV2({
      relevanceOrdinal: relevance.ordinal,
      relevanceMethod: 'rule',
      dimensions: valueProfile(row.valueProfile),
      kindProfile: querySignalKindProfile(row.kind),
      provisional: row.state !== 'reviewed',
    });
  const intrinsic = intrinsicCorpusSignal(row);
  return {
    ...row,
    matchedTerms: relevance.matchedTerms,
    relevanceOrdinal: relevance.ordinal,
    relevanceValue: relevance.value,
    signalDisplay: intrinsic.display,
    signalUnrounded: intrinsic.conservative,
    evidenceCoverage: legacyValue.evidenceCoverage,
    displayState: intrinsic.displayState,
    signalBand: intrinsic.band,
    signalPolicyVersion: intrinsic.policyVersion,
    evidenceConfidence: intrinsic.evidenceConfidence.score,
    evidenceConfidenceDetail: intrinsic.evidenceConfidence,
    trend: intrinsic.trend,
    signalExplanation:
      row.state === 'reviewed'
        ? 'Query-independent intrinsic estimate from the current type-aware value profile and bound evidence.'
        : `Query-independent intrinsic estimate from a ${row.state} index record; review state qualifies confidence.`,
  };
}

async function loadCorpus(
  pool: Pool,
  workspaceId: string,
  interpretation: QueryInterpretation | null,
): Promise<{ rows: CorpusRow[]; total: number; candidateSelectionApplied: boolean }> {
  const totals = await pool.query<{ total: number }>(
    `
    SELECT (
      (SELECT count(*) FROM catalog.knowledge_projections kp
       WHERE kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now()))
      + (SELECT count(*) FROM catalog.knowledge_documents kd
         WHERE kd.publication_state <> 'withdrawn')
      + (SELECT count(DISTINCT dc.canonical_uri) FROM ops.discovery_candidates dc
         WHERE dc.workspace_id = $1 AND dc.review_state = 'lead'
           AND NOT EXISTS (
             SELECT 1
             FROM ops.discovery_candidates admitted_candidate
             JOIN ops.discovery_admissions admission
               ON admission.discovery_candidate_id = admitted_candidate.id
             WHERE admitted_candidate.workspace_id = dc.workspace_id
               AND admitted_candidate.canonical_uri = dc.canonical_uri
           ))
    )::int AS total
  `,
    [workspaceId],
  );
  const total = totals.rows[0]!.total;
  const candidateSelectionApplied = Boolean(interpretation && total > corpusCandidateThreshold);
  const candidateTerms = interpretation
    ? uniqueCandidateTerms([
        interpretation.terms,
        interpretation.expandedTerms,
        interpretation.canonicalConcepts,
        interpretation.mechanismTerms,
      ])
    : [];
  const tsQuery = postgresPrefixTsQuery(candidateTerms);
  const exactEntityIds = interpretation?.exactEntities.map((entity) => entity.entityId) ?? [];
  const resolvedConceptIds =
    interpretation?.resolvedConcepts.map((concept) => concept.conceptId) ?? [];
  const result = await pool.query<CorpusRow>(
    `WITH priority_projection_ids AS (
       SELECT kp.id,
              CASE WHEN entity.id = ANY($6::uuid[]) THEN 0 ELSE 1 END AS selection_priority
       FROM catalog.knowledge_projections kp
       JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
       WHERE $2::boolean
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())
         AND (
           entity.id = ANY($6::uuid[])
           OR EXISTS (
             SELECT 1 FROM catalog.entity_facet_assignments selected_assignment
             WHERE selected_assignment.entity_id = entity.id
               AND selected_assignment.concept_id = ANY($7::uuid[])
               AND selected_assignment.valid_to IS NULL
           )
         )
     ), lexical_projection_ids AS (
       SELECT kp.id, 2 AS selection_priority
       FROM catalog.knowledge_projections kp
       WHERE $2::boolean
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())
         AND (
           kp.aliases && $4::text[]
           OR kp.capability_keys && $4::text[]
           OR to_tsvector(
                'simple'::regconfig,
                kp.preferred_label || ' ' || kp.summary || ' ' || kp.search_text
              ) @@ to_tsquery('simple'::regconfig, NULLIF($3, ''))
         )
       ORDER BY kp.id
       LIMIT $8
     ), all_projection_ids AS (
       SELECT kp.id, 2 AS selection_priority
       FROM catalog.knowledge_projections kp
       WHERE NOT $2::boolean
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())
     ), candidate_projection_ids AS (
       SELECT id, min(selection_priority) AS selection_priority
       FROM (
         SELECT * FROM priority_projection_ids
         UNION ALL SELECT * FROM lexical_projection_ids
         UNION ALL SELECT * FROM all_projection_ids
       ) candidates
       GROUP BY id
     ), selected_projections AS (
       SELECT kp.id, candidates.selection_priority,
         ts_rank_cd(
           to_tsvector(
             'simple'::regconfig,
             kp.preferred_label || ' ' || kp.summary || ' ' || kp.search_text
           ),
           to_tsquery('simple'::regconfig, NULLIF($3, ''))
         ) AS lexical_rank
       FROM candidate_projection_ids candidates
       JOIN catalog.knowledge_projections kp ON kp.id = candidates.id
       ORDER BY candidates.selection_priority, lexical_rank DESC, kp.preferred_label, kp.id
       LIMIT $5
     ), selected_documents AS (
       SELECT kd.id
       FROM catalog.knowledge_documents kd
       WHERE kd.publication_state <> 'withdrawn'
         AND (
           NOT $2::boolean
           OR kd.aliases && $4::text[]
           OR kd.mechanism_keys && $4::text[]
           OR to_tsvector(
                'simple'::regconfig,
                kd.title || ' ' || kd.summary || ' ' || kd.search_text
              ) @@ to_tsquery('simple'::regconfig, NULLIF($3, ''))
         )
       ORDER BY
         ts_rank_cd(
           to_tsvector(
             'simple'::regconfig,
             kd.title || ' ' || kd.summary || ' ' || kd.search_text
           ),
           to_tsquery('simple'::regconfig, NULLIF($3, ''))
         ) DESC,
         kd.title, kd.id
       LIMIT $5
     ), latest_leads AS (
       SELECT DISTINCT ON (dc.canonical_uri)
              dc.id, dc.canonical_uri, dc.title, dc.summary, dc.kind_hint,
              dc.source_payload, dc.provenance, dc.created_at
       FROM ops.discovery_candidates dc
       WHERE dc.workspace_id = $1
         AND dc.review_state = 'lead'
         AND NOT EXISTS (
           SELECT 1
           FROM ops.discovery_candidates admitted_candidate
           JOIN ops.discovery_admissions admission
             ON admission.discovery_candidate_id = admitted_candidate.id
           WHERE admitted_candidate.workspace_id = dc.workspace_id
             AND admitted_candidate.canonical_uri = dc.canonical_uri
         )
       ORDER BY dc.canonical_uri, dc.created_at DESC, dc.id DESC
     )
     SELECT kp.id::text AS id, 'indexed_knowledge'::text AS layer,
            COALESCE(revision_data."entityClass", 'implementation') AS "entityClass",
            kp.provider_id::text AS "providerId", NULL::text AS "documentId",
            kp.preferred_label AS name,
            kp.summary, kp.kind_profile AS kind, kp.publication_state AS state,
            kp.aliases, kp.capability_keys AS capabilities, kp.search_text AS "searchText",
            COALESCE(source_data.sources, ARRAY['local_catalog']::text[]) AS sources,
            source_data."canonicalUri", COALESCE(source_data."observedAt", kp.indexed_at)::text AS "observedAt",
            kp.value_profile AS "valueProfile",
            kp.query_value_conservative::float8 AS "cachedValueConservative",
            kp.query_evidence_coverage::float8 AS "cachedEvidenceCoverage",
            NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_projections kp
     JOIN selected_projections selected ON selected.id = kp.id
     LEFT JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
     LEFT JOIN LATERAL (
       SELECT replace(class_concept.stable_key, 'entity-class:', '') AS "entityClass"
       FROM catalog.knowledge_entity_revisions entity_revision
       JOIN catalog.concepts class_concept
         ON class_concept.id = entity_revision.entity_class_concept_id
       WHERE entity_revision.entity_id = entity.id
       ORDER BY entity_revision.revision DESC, entity_revision.created_at DESC
       LIMIT 1
     ) revision_data ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT source.source_type ORDER BY source.source_type) AS sources,
              (array_agg(source.canonical_uri ORDER BY observation.observed_at DESC, source.id))[1]
                AS "canonicalUri",
              max(observation.observed_at) AS "observedAt"
       FROM catalog.knowledge_projection_sources projection_source
       JOIN catalog.source_observations observation
         ON observation.id = projection_source.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       WHERE projection_source.projection_id = kp.id
     ) source_data ON true
     WHERE kp.publication_state <> 'withdrawn'
       AND (kp.expires_at IS NULL OR kp.expires_at > now())
     UNION ALL
     SELECT kd.id::text AS id, 'knowledge_document'::text AS layer,
            'document'::text AS "entityClass",
            NULL::text AS "providerId", kd.id::text AS "documentId", kd.title AS name,
            kd.summary, kd.document_kind AS kind, kd.publication_state AS state,
            kd.aliases, kd.mechanism_keys AS capabilities, kd.search_text AS "searchText",
            ARRAY[s.source_type] AS sources, kd.canonical_uri AS "canonicalUri",
            kd.observed_at::text AS "observedAt", kd.value_profile AS "valueProfile",
            NULL::float8 AS "cachedValueConservative",
            NULL::float8 AS "cachedEvidenceCoverage",
            NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_documents kd
     JOIN selected_documents selected ON selected.id = kd.id
     JOIN catalog.source_observations so ON so.id = kd.source_observation_id
     JOIN catalog.sources s ON s.id = so.source_id
     WHERE kd.publication_state <> 'withdrawn'
     UNION ALL
     SELECT lead.id::text AS id, 'source_lead'::text AS layer,
            'lead'::text AS "entityClass", NULL::text AS "providerId",
            NULL::text AS "documentId",
            lead.title AS name, lead.summary, COALESCE(lead.kind_hint, 'other') AS kind,
            'lead'::text AS state, ARRAY[]::text[] AS aliases, ARRAY[]::text[] AS capabilities,
            concat_ws(' ', lead.title, lead.summary, lead.kind_hint) AS "searchText",
            ARRAY(
              SELECT DISTINCT sibling.adapter_key
              FROM ops.discovery_candidates sibling
              WHERE sibling.workspace_id = $1 AND sibling.canonical_uri = lead.canonical_uri
              ORDER BY sibling.adapter_key
            ) AS sources,
            lead.canonical_uri AS "canonicalUri",
            COALESCE(lead.provenance->>'observedAt', lead.created_at::text) AS "observedAt",
            NULL::jsonb AS "valueProfile",
            NULL::float8 AS "cachedValueConservative",
            NULL::float8 AS "cachedEvidenceCoverage",
            jsonb_build_object(
              'stars', lead.source_payload->'stars',
              'archived', lead.source_payload->'archived',
              'updatedAt', lead.source_payload->'updatedAt'
            ) AS "sourcePayload"
     FROM latest_leads lead`,
    [
      workspaceId,
      candidateSelectionApplied,
      tsQuery,
      candidateTerms,
      candidateSelectionApplied ? corpusCandidateLimit : Math.max(total, 1),
      exactEntityIds,
      resolvedConceptIds,
      corpusCandidateOverfetch,
    ],
  );
  return { rows: result.rows, total, candidateSelectionApplied };
}

export async function listResearchCorpus(
  pool: Pool,
  workspaceId: string,
  query: CorpusBrowseQuery | CorpusSearchBody,
): Promise<unknown> {
  const normalizedQuery =
    ('query' in query ? query.query : null)?.normalize('NFKC').trim().replace(/\s+/g, ' ') || null;
  const view = {
    query: normalizedQuery,
    layer: query.layer ?? null,
    state: query.state ?? null,
    source: query.source ?? null,
    kind: query.kind ?? null,
    entityClass: query.entityClass ?? null,
  };
  const viewHash = hashCanonical(view);
  const offset = decodeCursor(query.cursor, viewHash);
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
  const knowledge = normalizedQuery ? await loadQueryKnowledge(pool, normalizedQuery) : null;
  const interpretation = normalizedQuery
    ? interpretQuery(normalizedQuery, {}, knowledge ?? undefined)
    : null;
  const corpusSelection = await loadCorpus(pool, workspaceId, interpretation);
  const corpus = corpusSelection.rows;
  const assessRelevance = interpretation ? compileLexicalRelevance(interpretation) : null;
  const matched = corpus
    .map((row) => assessRow(row, interpretation, assessRelevance))
    .filter((row): row is ScoredCorpusRow => row !== null);
  const facets = {
    layers: [
      {
        value: 'indexed_knowledge',
        count: matched.filter((row) => row.layer === 'indexed_knowledge').length,
      },
      {
        value: 'knowledge_document',
        count: matched.filter((row) => row.layer === 'knowledge_document').length,
      },
      {
        value: 'source_lead',
        count: matched.filter((row) => row.layer === 'source_lead').length,
      },
    ],
    states: countFacets(matched, 'state'),
    sources: sourceFacets(matched),
    kinds: countFacets(matched, 'kind'),
    entityClasses: countFacets(matched, 'entityClass'),
  };
  const filtered = matched
    .filter((row) => !query.layer || row.layer === query.layer)
    .filter((row) => !query.state || row.state === query.state)
    .filter((row) => !query.source || row.sources.includes(query.source))
    .filter((row) => !query.kind || row.kind === query.kind)
    .filter((row) => !query.entityClass || row.entityClass === query.entityClass)
    .sort((left, right) => {
      if (normalizedQuery) {
        return (
          (right.relevanceValue ?? -1) - (left.relevanceValue ?? -1) ||
          (right.signalUnrounded ?? -1) - (left.signalUnrounded ?? -1) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id)
        );
      }
      return (
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      );
    });
  const items = filtered.slice(offset, offset + limit).map((row) => {
    const publicRow = { ...row };
    delete (publicRow as Partial<ScoredCorpusRow>).sourcePayload;
    delete (publicRow as Partial<ScoredCorpusRow>).valueProfile;
    delete (publicRow as Partial<ScoredCorpusRow>).cachedValueConservative;
    delete (publicRow as Partial<ScoredCorpusRow>).cachedEvidenceCoverage;
    return publicRow;
  });
  const nextOffset = offset + items.length;
  return {
    scope: {
      label: 'Local research corpus',
      statement:
        'Indexed knowledge and attributed source leads are separate layers. A saved lead is not reviewed knowledge.',
    },
    query: normalizedQuery,
    scoringApplied: normalizedQuery !== null,
    corpusCount: corpusSelection.total,
    candidateSelection: {
      policyVersion: 'postgres-lexical-candidates-v1',
      applied: corpusSelection.candidateSelectionApplied,
      assessedCount: corpus.length,
      limit: corpusSelection.candidateSelectionApplied ? corpusCandidateLimit : null,
      facetScope: corpusSelection.candidateSelectionApplied ? 'candidate_pool' : 'full_corpus',
    },
    matchedCount: matched.length,
    filteredCount: filtered.length,
    facets,
    items,
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset, viewHash) : null,
  };
}
