import type { Pool } from 'pg';
import type { CorpusBrowseQuery, CorpusSearchBody } from '../../contracts/src/index.js';
import {
  hashCanonical,
  interpretQuery,
  lexicalRelevance,
  type QueryInterpretation,
} from '../../domain/src/index.js';
import {
  calculateQuerySignalV1,
  type QuerySignalResult,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import { scoreDiscoveryCandidate } from './discovery-repository.js';
import { DomainValidationError } from './errors.js';

type CorpusLayer = 'indexed_knowledge' | 'source_lead';

interface CorpusRow {
  id: string;
  layer: CorpusLayer;
  providerId: string | null;
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
  signalBand: QuerySignalResult['band'] | null;
  signalPolicyVersion: QuerySignalResult['policyVersion'] | null;
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

function countFacets(
  rows: ScoredCorpusRow[],
  key: 'kind' | 'state',
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

function assessRow(
  row: CorpusRow,
  interpretation: QueryInterpretation | null,
): ScoredCorpusRow | null {
  if (!interpretation) {
    return {
      ...row,
      matchedTerms: [],
      relevanceOrdinal: null,
      relevanceValue: null,
      signalDisplay: null,
      signalUnrounded: null,
      evidenceCoverage: null,
      displayState: null,
      signalBand: null,
      signalPolicyVersion: null,
      signalExplanation: null,
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
      signalExplanation:
        'Preliminary estimate from query relevance and attributed source metadata. It is not reviewed knowledge.',
    };
  }
  const relevance = lexicalRelevance(interpretation, {
    name: row.name,
    aliases: row.aliases,
    capabilities: row.capabilities,
    searchText: row.searchText,
  });
  if (relevance.ordinal === 'no_match') return null;
  const signal = calculateQuerySignalV1({
    relevanceOrdinal: relevance.ordinal,
    relevanceMethod: 'rule',
    dimensions: valueProfile(row.valueProfile),
    provisional: row.state !== 'reviewed',
  });
  return {
    ...row,
    matchedTerms: relevance.matchedTerms,
    relevanceOrdinal: relevance.ordinal,
    relevanceValue: relevance.value,
    signalDisplay: signal.signalDisplay,
    signalUnrounded: signal.signalUnrounded,
    evidenceCoverage: signal.evidenceCoverage,
    displayState: signal.displayState,
    signalBand: signal.band,
    signalPolicyVersion: signal.policyVersion,
    signalExplanation:
      row.state === 'reviewed'
        ? 'Query-specific estimate from the current indexed value profile and bound evidence.'
        : `Query-specific estimate from a ${row.state} index record; review state qualifies confidence.`,
  };
}

async function loadCorpus(pool: Pool, workspaceId: string): Promise<CorpusRow[]> {
  const result = await pool.query<CorpusRow>(
    `WITH latest_leads AS (
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
            kp.provider_id::text AS "providerId", kp.preferred_label AS name,
            kp.summary, kp.kind_profile AS kind, kp.publication_state AS state,
            kp.aliases, kp.capability_keys AS capabilities, kp.search_text AS "searchText",
            COALESCE(source_data.sources, ARRAY['local_catalog']::text[]) AS sources,
            source_data."canonicalUri", COALESCE(source_data."observedAt", kp.indexed_at)::text AS "observedAt",
            kp.value_profile AS "valueProfile", NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_projections kp
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
     SELECT lead.id::text AS id, 'source_lead'::text AS layer, NULL::text AS "providerId",
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
            jsonb_build_object(
              'stars', lead.source_payload->'stars',
              'archived', lead.source_payload->'archived',
              'updatedAt', lead.source_payload->'updatedAt'
            ) AS "sourcePayload"
     FROM latest_leads lead`,
    [workspaceId],
  );
  return result.rows;
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
  };
  const viewHash = hashCanonical(view);
  const offset = decodeCursor(query.cursor, viewHash);
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
  const corpus = await loadCorpus(pool, workspaceId);
  const interpretation = normalizedQuery ? interpretQuery(normalizedQuery) : null;
  const matched = corpus
    .map((row) => assessRow(row, interpretation))
    .filter((row): row is ScoredCorpusRow => row !== null);
  const facets = {
    layers: [
      {
        value: 'indexed_knowledge',
        count: matched.filter((row) => row.layer === 'indexed_knowledge').length,
      },
      {
        value: 'source_lead',
        count: matched.filter((row) => row.layer === 'source_lead').length,
      },
    ],
    states: countFacets(matched, 'state'),
    sources: sourceFacets(matched),
    kinds: countFacets(matched, 'kind'),
  };
  const filtered = matched
    .filter((row) => !query.layer || row.layer === query.layer)
    .filter((row) => !query.state || row.state === query.state)
    .filter((row) => !query.source || row.sources.includes(query.source))
    .filter((row) => !query.kind || row.kind === query.kind)
    .sort((left, right) => {
      if (normalizedQuery) {
        return (
          (right.signalUnrounded ?? -1) - (left.signalUnrounded ?? -1) ||
          (right.relevanceValue ?? -1) - (left.relevanceValue ?? -1) ||
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
    corpusCount: corpus.length,
    matchedCount: matched.length,
    filteredCount: filtered.length,
    facets,
    items,
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset, viewHash) : null,
  };
}
