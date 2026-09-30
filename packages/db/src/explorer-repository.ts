import type { Pool, PoolClient } from 'pg';
import type {
  BundleExportBody,
  ExplorerQueryBody,
  ResultPageQuery,
  ShortlistBody,
} from '../../contracts/src/index.js';
import {
  assessResearchCoverage,
  buildDiscoveryPlan,
  compileLexicalRelevance,
  createVerificationBundle,
  hashCanonical,
  interpretQuery,
  lexicalRelevance,
  newOpaqueId,
  type QueryInterpretation,
} from '../../domain/src/index.js';
import {
  calculateQuerySignalV2,
  querySignalKindProfile,
  querySignalPolicyV2,
  type QuerySignalResult,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import { DomainValidationError, NotFoundError } from './errors.js';
import { loadQueryKnowledge } from './taxonomy-repository.js';
import { inTransaction } from './transaction.js';

type JsonRow = Record<string, unknown>;

const retrievalPolicyVersion = 'lexical-concept-v4';

interface ProjectionRow {
  projectionId: string;
  providerId: string;
  providerRevision: number;
  displayRevisionId: string;
  publicationState: 'lead' | 'proposed' | 'reviewed' | 'stale' | 'withdrawn';
  entityClass: string;
  kind: string;
  name: string;
  summary: string;
  searchText: string;
  aliases: string[];
  capabilities: string[];
  domainLabels: string[];
  valueProfile: QueryValueInput[];
  evidenceIds: string[];
}

interface MaterializedResult {
  projection: ProjectionRow;
  relevance: ReturnType<typeof lexicalRelevance>;
  signal: QuerySignalResult;
  explanation: string;
  caveats: string[];
  capabilityGroup: string;
}

interface DocumentRow {
  documentId: string;
  publicationState: 'proposed' | 'reviewed' | 'stale';
  kind: 'article' | 'research' | 'resource' | 'specification' | 'standard';
  entityClass: 'document';
  name: string;
  summary: string;
  searchText: string;
  aliases: string[];
  mechanisms: string[];
  publisher: string;
  canonicalUri: string;
  valueProfile: QueryValueInput[];
}

interface MaterializedDocument {
  document: DocumentRow;
  relevance: ReturnType<typeof lexicalRelevance>;
  signal: QuerySignalResult;
  explanation: string;
  caveats: string[];
  capabilityGroup: string;
}

interface ResultItemRow extends JsonRow {
  id: string;
  position: number;
  providerId: string | null;
  documentId: string | null;
  name: string;
  kind: string;
  relevanceValue: number;
  signalUnrounded: number;
  signalDisplay: number | null;
  evidenceCoverage: number;
  valueConservative: number;
  displayState: string;
  capabilityGroup: string;
  subjectType: 'implementation' | 'document';
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function capabilityGroup(projection: ProjectionRow, interpretation: QueryInterpretation): string {
  return projection.domainLabels[0] ?? interpretation.capabilityGroups[0] ?? 'Other';
}

function explanationFor(
  relevance: ReturnType<typeof lexicalRelevance>,
  projection: ProjectionRow,
): string {
  if (relevance.ordinal === 'direct') {
    return `Direct rule match through the indexed ${relevance.matchedFields.join(' and ')} fields.`;
  }
  if (relevance.ordinal === 'partial') {
    return `Addresses a material part of the request through ${relevance.matchedFields.join(' and ')}; one or more qualifiers remain unresolved.`;
  }
  if (relevance.ordinal === 'complementary') {
    return `Supports an adjacent part of this query as a ${projection.kind.replaceAll('_', ' ')}.`;
  }
  return `An indexed field mentions part of this request; inspect scope before treating it as an option.`;
}

function kindMatchesTarget(kind: string, target: string | null): boolean {
  if (!target) return true;
  if (target === 'model') return kind === 'model';
  if (target === 'provider') return ['service', 'platform', 'api'].includes(kind);
  if (target === 'standard') return ['standard', 'protocol'].includes(kind);
  if (target === 'practice') return ['practice', 'technique', 'concept', 'workflow'].includes(kind);
  if (target === 'implementation') {
    return !['article', 'research', 'resource', 'specification', 'standard'].includes(kind);
  }
  if (target === 'article') return false;
  return true;
}

function validateValueProfile(value: unknown): QueryValueInput[] {
  if (!Array.isArray(value)) throw new DomainValidationError('Knowledge value profile is invalid.');
  return value as QueryValueInput[];
}

async function loadProjectionCandidates(
  client: PoolClient,
  interpretation: QueryInterpretation,
): Promise<{
  rows: ProjectionRow[];
  availableCount: number;
  projectionCount: number;
  indexRevision: string;
}> {
  const metadata = await client.query<{ projectionCount: number; indexRevision: string }>(`
    SELECT count(*)::int AS "projectionCount",
           encode(digest(convert_to(COALESCE(string_agg(
             kp.id::text || ':' || kp.provider_revision::text, ','
             ORDER BY kp.preferred_label, kp.id
           ), ''), 'UTF8'), 'sha256'), 'hex') AS "indexRevision"
    FROM catalog.knowledge_projections kp
    WHERE kp.publication_state <> 'withdrawn'
      AND (kp.expires_at IS NULL OR kp.expires_at > now())
  `);
  const projectionCount = metadata.rows[0]!.projectionCount;
  const indexRevision = metadata.rows[0]!.indexRevision;
  const requestedKind = interpretation.explicitFacets.find(
    (facet) => facet.key === 'candidate_kind',
  )?.value;
  const assessRelevance = compileLexicalRelevance(interpretation);
  const index = await client.query<{
    projectionId: string;
    providerId: string;
    kind: string;
    name: string;
    searchText: string;
    aliases: string[];
    capabilities: string[];
    valueConservative: number;
  }>(
    `SELECT kp.id AS "projectionId", kp.provider_id AS "providerId",
            kp.kind_profile AS kind, kp.preferred_label AS name,
            concat_ws(' ', kp.search_text, identity_data.identities) AS "searchText",
            kp.aliases, kp.capability_keys AS capabilities,
            kp.query_value_conservative::float8 AS "valueConservative"
     FROM catalog.knowledge_projections kp
     LEFT JOIN (
       SELECT pi.provider_id,
              string_agg(pi.normalized_value, ' ' ORDER BY pi.normalized_value) AS identities
       FROM catalog.provider_identities pi
       WHERE pi.valid_to IS NULL
       GROUP BY pi.provider_id
     ) identity_data ON identity_data.provider_id = kp.provider_id
     WHERE kp.publication_state <> 'withdrawn'
       AND (kp.expires_at IS NULL OR kp.expires_at > now())
       AND ($1::text IS NULL OR kp.kind_profile = $1)`,
    [requestedKind ?? null],
  );
  const ranked = index.rows
    .map((projection) => ({
      ...projection,
      relevance: assessRelevance(projection),
    }))
    .filter((projection) => projection.relevance.value > 0)
    .filter((projection) => kindMatchesTarget(projection.kind, interpretation.typedTarget))
    .sort(
      (left, right) =>
        right.relevance.value - left.relevance.value ||
        right.valueConservative - left.valueConservative ||
        left.name.localeCompare(right.name) ||
        left.providerId.localeCompare(right.providerId),
    );
  const selectedIds = ranked.slice(0, 100).map((projection) => projection.projectionId);
  const result = selectedIds.length
    ? await client.query<ProjectionRow>(
        `SELECT kp.id AS "projectionId", kp.provider_id AS "providerId",
                kp.provider_revision AS "providerRevision", pdr.id AS "displayRevisionId",
                kp.publication_state AS "publicationState", kp.kind_profile AS kind,
                COALESCE((
                  SELECT replace(class_concept.stable_key, 'entity-class:', '')
                  FROM catalog.knowledge_entities entity
                  JOIN catalog.knowledge_entity_revisions entity_revision
                    ON entity_revision.entity_id = entity.id
                  JOIN catalog.concepts class_concept
                    ON class_concept.id = entity_revision.entity_class_concept_id
                  WHERE entity.provider_id = kp.provider_id
                  ORDER BY entity_revision.revision DESC, entity_revision.created_at DESC,
                           entity_revision.id DESC
                  LIMIT 1
                ), 'implementation') AS "entityClass",
                kp.preferred_label AS name, kp.summary,
                concat_ws(' ', kp.search_text, identity_data.identities) AS "searchText",
                kp.aliases, kp.capability_keys AS capabilities, kp.value_profile AS "valueProfile",
                COALESCE((SELECT array_agg(dn.label ORDER BY dn.label)
                          FROM catalog.domain_memberships dm
                          JOIN catalog.domain_nodes dn ON dn.id = dm.domain_node_id
                          WHERE dm.provider_id = kp.provider_id), '{}') AS "domainLabels",
                COALESCE((SELECT array_agg(peb.evidence_item_id ORDER BY peb.evidence_item_id)
                          FROM catalog.provider_evidence_bindings peb
                          WHERE peb.provider_id = kp.provider_id), '{}') AS "evidenceIds"
         FROM catalog.knowledge_projections kp
         JOIN catalog.provider_display_revisions pdr
           ON pdr.provider_id = kp.provider_id AND pdr.revision = kp.provider_revision
         LEFT JOIN (
           SELECT pi.provider_id,
                  string_agg(pi.normalized_value, ' ' ORDER BY pi.normalized_value) AS identities
           FROM catalog.provider_identities pi
           WHERE pi.valid_to IS NULL
           GROUP BY pi.provider_id
         ) identity_data ON identity_data.provider_id = kp.provider_id
         WHERE kp.id = ANY($1::uuid[])
         ORDER BY array_position($1::uuid[], kp.id)`,
        [selectedIds],
      )
    : { rows: [] as ProjectionRow[] };
  return {
    rows: result.rows.map((row) => ({
      ...row,
      valueProfile: validateValueProfile(row.valueProfile),
    })),
    availableCount: ranked.length,
    projectionCount,
    indexRevision,
  };
}

function materialize(
  projection: ProjectionRow,
  interpretation: QueryInterpretation,
): MaterializedResult | null {
  const requestedKind = interpretation.explicitFacets.find(
    (facet) => facet.key === 'candidate_kind',
  )?.value;
  if (requestedKind && projection.kind !== requestedKind) return null;
  const relevance = lexicalRelevance(interpretation, {
    name: projection.name,
    aliases: projection.aliases,
    capabilities: projection.capabilities,
    searchText: projection.searchText,
  });
  if (relevance.value === 0) return null;
  const signal = calculateQuerySignalV2({
    relevanceOrdinal: relevance.ordinal,
    relevanceMethod: 'rule',
    dimensions: projection.valueProfile,
    kindProfile: querySignalKindProfile(projection.kind),
    provisional:
      projection.publicationState === 'lead' || projection.publicationState === 'proposed',
  });
  const missing = signal.dimensions.flatMap((dimension) => dimension.missing);
  const caveats = [
    ...(projection.publicationState !== 'reviewed'
      ? [
          `Source review state is ${projection.publicationState}; the signal is a low-confidence estimate from currently bound evidence.`,
        ]
      : []),
    ...missing,
  ].slice(0, 3);
  return {
    projection,
    relevance,
    signal,
    explanation: explanationFor(relevance, projection),
    caveats,
    capabilityGroup: capabilityGroup(projection, interpretation),
  };
}

async function loadDocumentCandidates(
  client: PoolClient,
  interpretation: QueryInterpretation,
): Promise<DocumentRow[]> {
  if (interpretation.typedTarget && !['article', 'standard'].includes(interpretation.typedTarget)) {
    return [];
  }
  const result = await client.query<DocumentRow>(
    `SELECT kd.id AS "documentId", kd.publication_state AS "publicationState",
            kd.document_kind AS kind, 'document'::text AS "entityClass",
            kd.title AS name, kd.summary,
            kd.search_text AS "searchText", kd.aliases, kd.mechanism_keys AS mechanisms,
            kd.publisher, kd.canonical_uri AS "canonicalUri", kd.value_profile AS "valueProfile"
     FROM catalog.knowledge_documents kd
     WHERE kd.publication_state <> 'withdrawn'
     ORDER BY kd.title, kd.id`,
  );
  return result.rows
    .map((row) => ({ ...row, valueProfile: validateValueProfile(row.valueProfile) }))
    .filter((row) => {
      if (interpretation.typedTarget === 'article') {
        return ['article', 'research', 'resource'].includes(row.kind);
      }
      if (interpretation.typedTarget === 'standard') {
        return ['standard', 'specification'].includes(row.kind);
      }
      return true;
    });
}

function materializeDocument(
  document: DocumentRow,
  interpretation: QueryInterpretation,
): MaterializedDocument | null {
  const relevance = lexicalRelevance(interpretation, {
    name: document.name,
    aliases: document.aliases,
    capabilities: document.mechanisms,
    searchText: document.searchText,
  });
  if (relevance.value === 0) return null;
  const signal = calculateQuerySignalV2({
    relevanceOrdinal: relevance.ordinal,
    relevanceMethod: 'rule',
    dimensions: document.valueProfile,
    kindProfile: 'knowledge_document',
    provisional: document.publicationState !== 'reviewed',
  });
  return {
    document,
    relevance,
    signal,
    explanation:
      relevance.ordinal === 'direct'
        ? `Direct document match through ${relevance.matchedFields.join(' and ')}.`
        : `This ${document.kind} explains or evaluates a related mechanism.`,
    caveats: [
      ...(document.publicationState !== 'reviewed'
        ? ['Document subject mapping is proposed and does not establish independent usefulness.']
        : []),
      ...signal.dimensions.flatMap((dimension) => dimension.missing),
    ].slice(0, 3),
    capabilityGroup: document.mechanisms[0]?.replaceAll('-', ' ') ?? 'Research and learning',
  };
}

type RankedMaterial =
  | { subjectType: 'implementation'; item: MaterializedResult }
  | { subjectType: 'document'; item: MaterializedDocument };

function explicitSpecificity(
  candidates: RankedMaterial[],
  interpretation: QueryInterpretation,
): Map<RankedMaterial, number> {
  const explicitTerms = interpretation.terms.filter(
    (term) => term !== 'ai' || interpretation.terms.length === 1,
  );
  const documentFrequency = new Map(
    explicitTerms.map((term) => [
      term,
      candidates.filter((candidate) => candidate.item.relevance.matchedTerms.includes(term)).length,
    ]),
  );
  return new Map(
    candidates.map((candidate) => [
      candidate,
      explicitTerms
        .filter((term) => candidate.item.relevance.matchedTerms.includes(term))
        .reduce(
          (sum, term) =>
            sum + Math.log((candidates.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)),
          0,
        ),
    ]),
  );
}

function rankMaterial(
  providers: MaterializedResult[],
  documents: MaterializedDocument[],
  interpretation: QueryInterpretation,
): RankedMaterial[] {
  const candidates: RankedMaterial[] = [
    ...providers.map((item): RankedMaterial => ({ subjectType: 'implementation', item })),
    ...documents.map((item): RankedMaterial => ({ subjectType: 'document', item })),
  ];
  const specificity = explicitSpecificity(candidates, interpretation);
  const ranked = candidates.sort((left, right) => {
    const leftName =
      left.subjectType === 'implementation' ? left.item.projection.name : left.item.document.name;
    const rightName =
      right.subjectType === 'implementation'
        ? right.item.projection.name
        : right.item.document.name;
    return (
      right.item.relevance.value - left.item.relevance.value ||
      (specificity.get(right) ?? 0) - (specificity.get(left) ?? 0) ||
      right.item.signal.signalUnrounded - left.item.signal.signalUnrounded ||
      leftName.localeCompare(rightName)
    );
  });
  if (interpretation.intentMode !== 'broad_landscape') return ranked;
  const result: RankedMaterial[] = [];
  for (const relevanceValue of [100, 75, 50, 25]) {
    const tier = ranked.filter((candidate) => candidate.item.relevance.value === relevanceValue);
    const deferred: RankedMaterial[] = [];
    const kindCounts = new Map<string, number>();
    const groupCounts = new Map<string, number>();
    for (const candidate of tier) {
      const kind =
        candidate.subjectType === 'implementation'
          ? candidate.item.projection.kind
          : candidate.item.document.kind;
      const group = candidate.item.capabilityGroup;
      const kindLimit = 3;
      const groupLimit = 2;
      const fits =
        (kindCounts.get(kind) ?? 0) < kindLimit && (groupCounts.get(group) ?? 0) < groupLimit;
      if (!fits) {
        deferred.push(candidate);
        continue;
      }
      result.push(candidate);
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
      groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
    }
    result.push(...deferred);
  }
  return result;
}

interface PreparedSnapshot {
  bounded: MaterializedResult[];
  documents: MaterializedDocument[];
  ranked: RankedMaterial[];
  availableCount: number;
  projectionCount: number;
  indexRevision: string;
  resultHash: string;
}

async function prepareSnapshot(
  client: PoolClient,
  interpretation: QueryInterpretation,
): Promise<PreparedSnapshot> {
  const loaded = await loadProjectionCandidates(client, interpretation);
  const providers = loaded.rows
    .map((projection) => materialize(projection, interpretation))
    .filter((item): item is MaterializedResult => item !== null)
    .sort(
      (left, right) =>
        right.relevance.value - left.relevance.value ||
        right.signal.signalUnrounded - left.signal.signalUnrounded ||
        left.projection.name.localeCompare(right.projection.name) ||
        left.projection.providerId.localeCompare(right.projection.providerId),
    );
  const documents = (await loadDocumentCandidates(client, interpretation))
    .map((document) => materializeDocument(document, interpretation))
    .filter((item): item is MaterializedDocument => item !== null);
  const ranked = rankMaterial(providers, documents, interpretation).slice(0, 100);
  const bounded = ranked
    .filter(
      (candidate): candidate is { subjectType: 'implementation'; item: MaterializedResult } =>
        candidate.subjectType === 'implementation',
    )
    .map((candidate) => candidate.item);
  const boundedDocuments = ranked
    .filter(
      (candidate): candidate is { subjectType: 'document'; item: MaterializedDocument } =>
        candidate.subjectType === 'document',
    )
    .map((candidate) => candidate.item);
  const resultHash = hashCanonical(
    ranked.map((candidate) =>
      candidate.subjectType === 'implementation'
        ? {
            subjectType: candidate.subjectType,
            providerId: candidate.item.projection.providerId,
            revision: candidate.item.projection.providerRevision,
            signal: candidate.item.signal.signalUnrounded,
            relevance: candidate.item.relevance.ordinal,
          }
        : {
            subjectType: candidate.subjectType,
            documentId: candidate.item.document.documentId,
            signal: candidate.item.signal.signalUnrounded,
            relevance: candidate.item.relevance.ordinal,
          },
    ),
  );
  return {
    bounded,
    documents: boundedDocuments,
    ranked,
    availableCount: loaded.availableCount + documents.length,
    projectionCount: loaded.projectionCount,
    indexRevision: hashCanonical({
      providers: loaded.indexRevision,
      documents: boundedDocuments.map((item) => ({
        id: item.document.documentId,
        state: item.document.publicationState,
        searchText: item.document.searchText,
      })),
    }),
    resultHash,
  };
}

async function insertResultSetRevision(
  client: PoolClient,
  input: {
    workspaceId: string;
    sessionId: string;
    query: string;
    projectContextId: string | null;
    interpretation: QueryInterpretation;
    revision: number;
    predecessorId: string | null;
    retentionUntil: Date;
    createdAt: Date;
    prepared: PreparedSnapshot;
  },
): Promise<string> {
  const resultSetId = newOpaqueId();
  const { bounded, documents, ranked, availableCount, indexRevision, projectionCount, resultHash } =
    input.prepared;
  await client.query(
    `INSERT INTO workspace.query_result_sets
       (id, workspace_id, query_session_id, revision, predecessor_id, status,
        retrieval_policy_version, signal_policy_version, index_revision, assessed_count,
        available_count, truncated_count, diagnostics, result_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15)`,
    [
      resultSetId,
      input.workspaceId,
      input.sessionId,
      input.revision,
      input.predecessorId,
      retrievalPolicyVersion,
      querySignalPolicyV2.version,
      indexRevision,
      ranked.length,
      availableCount,
      Math.max(0, availableCount - bounded.length),
      json({
        coverageState: input.interpretation.coverageState,
        indexedProjectionCount: projectionCount,
        indexedDocumentCount: documents.length,
        intentMode: input.interpretation.intentMode,
        landscapeFacets: input.interpretation.landscapeFacets,
        externalDiscoveryAttempted: false,
        projectFitState: input.projectContextId ? 'unknown_blocked' : 'not_applicable',
        projectContextAffectsSignal: false,
      }),
      resultHash,
      input.createdAt,
      input.retentionUntil,
    ],
  );
  const policy = await client.query<{ id: string }>(
    `SELECT id FROM catalog.score_policies WHERE version = $1 AND policy_key = 'query-signal'`,
    [querySignalPolicyV2.version],
  );
  if (!policy.rowCount) throw new Error('query-signal-v2 policy record is missing.');
  const providerPositions = new Map(
    ranked.flatMap((candidate, index) =>
      candidate.subjectType === 'implementation'
        ? [[candidate.item.projection.providerId, index + 1] as const]
        : [],
    ),
  );
  const rows = bounded.map((item) => {
    const signalRunId = newOpaqueId();
    const resultItemId = newOpaqueId();
    const inputHash = hashCanonical({
      queryHash: hashCanonical(input.query.trim()),
      projectionHash: item.projection.projectionId,
      policy: querySignalPolicyV2.version,
      relevance: item.relevance,
      values: item.signal.dimensions,
    });
    return {
      signal: {
        id: signalRunId,
        workspace_id: input.workspaceId,
        result_set_id: resultSetId,
        provider_id: item.projection.providerId,
        provider_revision: item.projection.providerRevision,
        provider_display_revision_id: item.projection.displayRevisionId,
        policy_id: policy.rows[0]!.id,
        policy_version: item.signal.policyVersion,
        relevance_ordinal: item.signal.relevanceOrdinal,
        relevance_value: item.signal.relevanceValue,
        relevance_anchors: {
          projectionId: item.projection.projectionId,
          matchedFields: item.relevance.matchedFields,
        },
        value_inputs: item.signal.dimensions,
        value_central: item.signal.valueCentral,
        value_uncertainty: item.signal.valueUncertainty,
        value_conservative: item.signal.valueConservative,
        evidence_coverage: item.signal.evidenceCoverage,
        signal_unrounded: item.signal.signalUnrounded,
        signal_display: item.signal.signalDisplay,
        display_state: item.signal.displayState,
        missing: item.signal.dimensions.flatMap((dimension) => dimension.missing),
        input_hash: inputHash,
        generated_at: input.createdAt.toISOString(),
      },
      result: {
        id: resultItemId,
        workspace_id: input.workspaceId,
        result_set_id: resultSetId,
        query_signal_run_id: signalRunId,
        provider_id: item.projection.providerId,
        provider_revision: item.projection.providerRevision,
        position: providerPositions.get(item.projection.providerId)!,
        capability_group: item.capabilityGroup,
        matched_fields: item.relevance.matchedFields,
        explanation: item.explanation,
        caveats: item.caveats,
        created_at: input.createdAt.toISOString(),
      },
      evidence: item.signal.dimensions.flatMap((dimension) =>
        dimension.evidenceIds.map((evidenceId) => ({
          query_signal_run_id: signalRunId,
          workspace_id: input.workspaceId,
          provider_id: item.projection.providerId,
          evidence_item_id: evidenceId,
          dimension_key: dimension.key,
        })),
      ),
    };
  });
  if (rows.length) {
    await client.query(
      `INSERT INTO workspace.query_signal_runs
         (id, workspace_id, result_set_id, provider_id, provider_revision,
          provider_display_revision_id, policy_id, policy_version, relevance_ordinal,
          relevance_value, relevance_method, relevance_anchors, value_inputs,
          value_central, value_uncertainty, value_conservative, evidence_coverage,
          signal_unrounded, signal_display, display_state, exclusions, missing,
          input_hash, generated_at)
       SELECT record.id, record.workspace_id, record.result_set_id, record.provider_id,
              record.provider_revision, record.provider_display_revision_id, record.policy_id,
              record.policy_version, record.relevance_ordinal, record.relevance_value, 'rule',
              record.relevance_anchors, record.value_inputs, record.value_central,
              record.value_uncertainty, record.value_conservative, record.evidence_coverage,
              record.signal_unrounded, record.signal_display, record.display_state, '{}',
              ARRAY(SELECT jsonb_array_elements_text(record.missing)), record.input_hash,
              record.generated_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, provider_id uuid,
         provider_revision integer, provider_display_revision_id uuid, policy_id uuid,
         policy_version text, relevance_ordinal text, relevance_value integer,
         relevance_anchors jsonb, value_inputs jsonb, value_central numeric,
         value_uncertainty numeric, value_conservative numeric, evidence_coverage numeric,
         signal_unrounded numeric, signal_display integer, display_state text, missing jsonb,
         input_hash text, generated_at timestamptz
       )`,
      [json(rows.map((row) => row.signal))],
    );
    const evidenceRows = rows.flatMap((row) => row.evidence);
    if (evidenceRows.length) {
      await client.query(
        `INSERT INTO workspace.query_signal_evidence_bindings
           (query_signal_run_id, workspace_id, provider_id, evidence_item_id,
            dimension_key, applicability_scope)
         SELECT record.query_signal_run_id, record.workspace_id, record.provider_id,
                record.evidence_item_id, record.dimension_key, 'query-signal-v2'
         FROM jsonb_to_recordset($1::jsonb) AS record(
           query_signal_run_id uuid, workspace_id uuid, provider_id uuid,
           evidence_item_id uuid, dimension_key text
         )
         ON CONFLICT DO NOTHING`,
        [json(evidenceRows)],
      );
    }
    await client.query(
      `INSERT INTO workspace.query_result_items
         (id, workspace_id, result_set_id, query_signal_run_id, provider_id,
          provider_revision, position, capability_group, matched_fields, explanation,
          caveats, created_at)
       SELECT record.id, record.workspace_id, record.result_set_id,
              record.query_signal_run_id, record.provider_id, record.provider_revision,
              record.position, record.capability_group,
              ARRAY(SELECT jsonb_array_elements_text(record.matched_fields)),
              record.explanation,
              ARRAY(SELECT jsonb_array_elements_text(record.caveats)), record.created_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, query_signal_run_id uuid,
         provider_id uuid, provider_revision integer, position integer,
         capability_group text, matched_fields jsonb, explanation text, caveats jsonb,
         created_at timestamptz
       )`,
      [json(rows.map((row) => row.result))],
    );
  }
  if (documents.length) {
    const documentPositions = new Map(
      ranked.flatMap((candidate, index) =>
        candidate.subjectType === 'document'
          ? [[candidate.item.document.documentId, index + 1] as const]
          : [],
      ),
    );
    const documentRows = documents.map((item) => ({
      id: newOpaqueId(),
      workspace_id: input.workspaceId,
      result_set_id: resultSetId,
      document_id: item.document.documentId,
      rank_position: documentPositions.get(item.document.documentId)!,
      relevance_ordinal: item.relevance.ordinal,
      relevance_value: item.relevance.value,
      relevance_anchors: {
        matchedTerms: item.relevance.matchedTerms,
        publisher: item.document.publisher,
        canonicalUri: item.document.canonicalUri,
      },
      matched_fields: item.relevance.matchedFields,
      signal_policy_version: item.signal.policyVersion,
      kind_profile: item.signal.kindProfile,
      value_conservative: item.signal.valueConservative,
      signal_unrounded: item.signal.signalUnrounded,
      signal_display: item.signal.signalDisplay,
      evidence_coverage: item.signal.evidenceCoverage,
      value_inputs: item.signal.dimensions,
      display_state: item.signal.displayState,
      explanation: item.explanation,
      caveats: item.caveats,
      missing: item.signal.dimensions.flatMap((dimension) => dimension.missing),
      input_hash: hashCanonical({
        queryHash: hashCanonical(input.query.trim()),
        documentId: item.document.documentId,
        documentDigest: item.document.searchText,
        policy: item.signal.policyVersion,
        relevance: item.relevance,
      }),
      created_at: input.createdAt.toISOString(),
    }));
    await client.query(
      `INSERT INTO workspace.query_document_results
         (id, workspace_id, result_set_id, document_id, rank_position,
          relevance_ordinal, relevance_value, relevance_anchors, matched_fields,
          signal_policy_version, kind_profile, value_conservative, signal_unrounded,
          signal_display, evidence_coverage, value_inputs, display_state, explanation, caveats, missing,
          input_hash, created_at)
       SELECT record.id, record.workspace_id, record.result_set_id, record.document_id,
              record.rank_position, record.relevance_ordinal, record.relevance_value,
              record.relevance_anchors,
              ARRAY(SELECT jsonb_array_elements_text(record.matched_fields)),
              record.signal_policy_version, record.kind_profile, record.value_conservative,
              record.signal_unrounded, record.signal_display, record.evidence_coverage,
              record.value_inputs, record.display_state, record.explanation,
              ARRAY(SELECT jsonb_array_elements_text(record.caveats)),
              ARRAY(SELECT jsonb_array_elements_text(record.missing)),
              record.input_hash, record.created_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, document_id uuid,
         rank_position integer, relevance_ordinal text, relevance_value integer,
         relevance_anchors jsonb, matched_fields jsonb, signal_policy_version text,
         kind_profile text, value_conservative numeric, signal_unrounded numeric,
         signal_display integer, evidence_coverage numeric, value_inputs jsonb, display_state text,
         explanation text, caveats jsonb, missing jsonb, input_hash text,
         created_at timestamptz
       )`,
      [json(documentRows)],
    );
  }
  return resultSetId;
}

export async function createExplorerSession(
  pool: Pool,
  workspaceId: string,
  input: ExplorerQueryBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    if (input.projectContextId) {
      const context = await client.query<{ id: string }>(
        `SELECT id FROM workspace.project_contexts WHERE id = $1 AND workspace_id = $2`,
        [input.projectContextId, workspaceId],
      );
      if (!context.rowCount) throw new NotFoundError('Project context not found.');
    }
    // Project fit is a separate assessment layer. Binding private context to a
    // snapshot must not silently change query relevance or query-signal-v2.
    const knowledge = await loadQueryKnowledge(client);
    const initialInterpretation = interpretQuery(
      input.query,
      input.explicitFacets ?? {},
      knowledge,
    );
    const prepared = await prepareSnapshot(client, initialInterpretation);
    const interpretation: QueryInterpretation = {
      ...initialInterpretation,
      coverageState:
        initialInterpretation.missingContext.some(
          (facet) => facet.key === 'independent_evidence',
        ) ||
        (initialInterpretation.terms.length <= 2 &&
          initialInterpretation.inferredFacets.some((facet) => facet.key === 'integration_target'))
          ? 'partial'
          : prepared.ranked.length
            ? 'maintained'
            : initialInterpretation.coverageState,
    };
    const coverageAssessment = assessResearchCoverage(
      interpretation,
      prepared.ranked.map((candidate) =>
        candidate.subjectType === 'implementation'
          ? {
              entityClass: candidate.item.projection.entityClass,
              group: candidate.item.capabilityGroup,
            }
          : {
              entityClass: candidate.item.document.entityClass,
              group: candidate.item.capabilityGroup,
            },
      ),
    );
    const plan = buildDiscoveryPlan(input.query, interpretation, {
      coverageAssessment,
      externalSourcesEnabled: input.searchConnectedSources ?? false,
    });
    const sessionId = newOpaqueId();
    const createdAt = new Date();
    const retentionUntil = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO workspace.query_sessions
         (id, workspace_id, project_context_id, query_text, query_hash, normalized_intent,
          explicit_facets, inferred_facets, interpretation_method, interpretation_state,
          retrieval_policy_version, index_revision, state, retention_until, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deterministic-v3', 'deterministic',
               $9, $10, 'active', $11, $12)`,
      [
        sessionId,
        workspaceId,
        input.projectContextId ?? null,
        input.query.trim(),
        hashCanonical(input.query.trim()),
        json(interpretation),
        json({ interpreted: interpretation.explicitFacets, supplied: input.explicitFacets ?? {} }),
        json(interpretation.inferredFacets),
        retrievalPolicyVersion,
        prepared.indexRevision,
        retentionUntil,
        createdAt,
      ],
    );
    await client.query(
      `INSERT INTO workspace.query_plans
         (id, workspace_id, query_session_id, policy_version, intent_mode, plan, plan_hash,
          budgets, stop_policy, stop_reason, coverage_assessment, planned_passes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        newOpaqueId(),
        workspaceId,
        sessionId,
        plan.policyVersion,
        plan.intentMode,
        json(plan),
        plan.planHash,
        json(plan.budgets),
        json(plan.stopPolicy),
        plan.stopReason,
        json(plan.coverageAssessment ?? {}),
        plan.secondPass.state === 'planned' ? 2 : 1,
        createdAt,
      ],
    );
    const resultSetId = await insertResultSetRevision(client, {
      workspaceId,
      sessionId,
      query: input.query,
      projectContextId: input.projectContextId ?? null,
      interpretation,
      revision: 1,
      predecessorId: null,
      retentionUntil,
      createdAt,
      prepared,
    });
    return {
      id: sessionId,
      resultSetId,
      resultSetRevision: 1,
      status: 'complete',
      interpretation,
      plan,
      counts: {
        assessed: prepared.ranked.length,
        available: prepared.availableCount,
        truncated: Math.max(0, prepared.availableCount - prepared.ranked.length),
      },
      retentionUntil: retentionUntil.toISOString(),
      externalDiscovery: { attempted: false, state: 'disabled_by_default' },
      projectFit: input.projectContextId
        ? {
            state: 'unknown_blocked',
            orderingApplied: false,
            explanation:
              'Project context is bound to the snapshot, but provider-specific gates and preferences are not assessed in query-signal-v2.',
          }
        : { state: 'not_applicable', orderingApplied: false },
    };
  });
}

export async function refreshExplorerSession(
  pool: Pool,
  workspaceId: string,
  sessionId: string,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const session = await client.query<{
      query: string;
      interpretation: QueryInterpretation;
      projectContextId: string | null;
      retentionUntil: Date;
    }>(
      `SELECT query_text AS query, normalized_intent AS interpretation,
              project_context_id AS "projectContextId", retention_until AS "retentionUntil"
       FROM workspace.query_sessions
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [sessionId, workspaceId],
    );
    if (!session.rowCount) throw new NotFoundError('Query session not found.');
    const current = await client.query<{
      id: string;
      revision: number;
      indexRevision: string;
      resultHash: string;
    }>(
      `SELECT id, revision, index_revision AS "indexRevision", result_hash AS "resultHash"
       FROM workspace.query_result_sets
       WHERE query_session_id = $1 AND workspace_id = $2
       ORDER BY revision DESC LIMIT 1`,
      [sessionId, workspaceId],
    );
    if (!current.rowCount) throw new NotFoundError('Query result set not found.');
    const row = session.rows[0]!;
    const previous = current.rows[0]!;
    const prepared = await prepareSnapshot(client, row.interpretation);
    if (
      previous.indexRevision === prepared.indexRevision &&
      previous.resultHash === prepared.resultHash
    ) {
      return {
        state: 'unchanged',
        resultSetId: previous.id,
        resultSetRevision: previous.revision,
        predecessorId: null,
      };
    }
    const createdAt = new Date();
    const resultSetId = await insertResultSetRevision(client, {
      workspaceId,
      sessionId,
      query: row.query,
      projectContextId: row.projectContextId,
      interpretation: row.interpretation,
      revision: previous.revision + 1,
      predecessorId: previous.id,
      retentionUntil: row.retentionUntil,
      createdAt,
      prepared,
    });
    return {
      state: 'refreshed',
      resultSetId,
      resultSetRevision: previous.revision + 1,
      predecessorId: previous.id,
      counts: {
        assessed: prepared.ranked.length,
        available: prepared.availableCount,
        truncated: Math.max(0, prepared.availableCount - prepared.ranked.length),
      },
    };
  });
}

function cursorView(query: ResultPageQuery): Record<string, unknown> {
  return {
    sort: query.sort ?? 'recommended',
    kind: query.kind ?? null,
    capability: query.capability ?? null,
    evidenceState: query.evidenceState ?? null,
  };
}

function encodeCursor(resultSetId: string, lastId: string, viewHash: string): string {
  return Buffer.from(JSON.stringify({ resultSetId, lastId, viewHash }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string | undefined,
): { resultSetId: string; lastId: string; viewHash: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.resultSetId === 'string' &&
      typeof parsed.lastId === 'string' &&
      typeof parsed.viewHash === 'string'
    ) {
      return parsed as { resultSetId: string; lastId: string; viewHash: string };
    }
  } catch {
    // Fall through to the stable validation error below.
  }
  throw new DomainValidationError('Result cursor is malformed.');
}

function sortRows(rows: ResultItemRow[], sort: ResultPageQuery['sort']): ResultItemRow[] {
  const copy = [...rows];
  if (!sort) return copy.sort((left, right) => left.position - right.position);
  const byNumber = (selector: (row: ResultItemRow) => number) =>
    copy.sort(
      (left, right) =>
        selector(right) - selector(left) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  switch (sort) {
    case 'recommended':
      return copy.sort((left, right) => left.position - right.position);
    case 'relevance':
      return byNumber((row) => row.relevanceValue);
    case 'evidence':
      return byNumber((row) => row.evidenceCoverage);
    case 'maintenance':
      return byNumber((row) => row.valueConservative);
    case 'adoption':
      return byNumber((row) => row.signalUnrounded);
    case 'name':
      return copy.sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    case 'signal':
      return byNumber((row) => row.signalUnrounded);
  }
}

async function resultRows(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  query: ResultPageQuery,
): Promise<{ metadata: JsonRow; rows: ResultItemRow[] }> {
  const metadata = await pool.query<JsonRow>(
    `SELECT qrs.id, qrs.revision, qrs.status, qrs.assessed_count AS "assessedCount",
            qrs.available_count AS "availableCount", qrs.truncated_count AS "truncatedCount",
            qrs.retrieval_policy_version AS "retrievalPolicyVersion",
            qrs.signal_policy_version AS "signalPolicyVersion", qrs.index_revision AS "indexRevision",
            qrs.created_at AS "createdAt", qrs.expires_at AS "expiresAt", qrs.diagnostics,
            qs.id AS "querySessionId", qs.query_text AS query,
            qs.normalized_intent AS interpretation, qs.project_context_id AS "projectContextId",
            qp.plan AS "queryPlan"
     FROM workspace.query_result_sets qrs
     JOIN workspace.query_sessions qs ON qs.id = qrs.query_session_id
     LEFT JOIN workspace.query_plans qp
       ON qp.query_session_id = qs.id AND qp.workspace_id = qs.workspace_id
     WHERE qrs.id = $1 AND qrs.workspace_id = $2 AND qs.deleted_at IS NULL`,
    [resultSetId, workspaceId],
  );
  if (!metadata.rowCount) throw new NotFoundError('Query result set not found.');
  const providerValues: unknown[] = [resultSetId, workspaceId];
  const providerFilters = [
    'qri.result_set_id = $1',
    'qri.workspace_id = $2',
    query.kind ? `p.kind = $${providerValues.push(query.kind)}` : null,
    query.capability ? `$${providerValues.push(query.capability)} = ANY(kp.capability_keys)` : null,
    query.evidenceState ? `qsr.display_state = $${providerValues.push(query.evidenceState)}` : null,
  ].filter(Boolean);
  const providerRows = await pool.query<ResultItemRow>(
    `SELECT qri.id, qri.position, qri.provider_id AS "providerId",
            NULL::uuid AS "documentId", 'implementation'::text AS "subjectType",
            qri.provider_revision AS "providerRevision", qri.capability_group AS "capabilityGroup",
            qri.matched_fields AS "matchedFields", qri.explanation, qri.caveats,
            p.canonical_name AS name, p.kind, p.description,
            kp.publication_state AS "publicationState", kp.aliases,
            kp.capability_keys AS capabilities,
            qsr.relevance_ordinal AS "relevanceOrdinal",
            qsr.relevance_value AS "relevanceValue", qsr.relevance_method AS "relevanceMethod",
            qsr.value_central::float8 AS "valueCentral",
            qsr.value_uncertainty::float8 AS "valueUncertainty",
            qsr.value_conservative::float8 AS "valueConservative",
            qsr.evidence_coverage::float8 AS "evidenceCoverage",
            qsr.signal_unrounded::float8 AS "signalUnrounded", qsr.signal_display AS "signalDisplay",
            qsr.display_state AS "displayState", qsr.missing, qsr.policy_version AS "policyVersion"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_runs qsr ON qsr.id = qri.query_signal_run_id
     JOIN catalog.providers p ON p.id = qri.provider_id
     JOIN catalog.knowledge_projections kp
       ON kp.provider_id = qri.provider_id AND kp.provider_revision = qri.provider_revision
     WHERE ${providerFilters.join(' AND ')}`,
    providerValues,
  );
  const documentValues: unknown[] = [resultSetId, workspaceId];
  const documentFilters = [
    'qdr.result_set_id = $1',
    'qdr.workspace_id = $2',
    query.kind ? `kd.document_kind = $${documentValues.push(query.kind)}` : null,
    query.capability ? `$${documentValues.push(query.capability)} = ANY(kd.mechanism_keys)` : null,
    query.evidenceState ? `qdr.display_state = $${documentValues.push(query.evidenceState)}` : null,
  ].filter(Boolean);
  const documentRows = await pool.query<ResultItemRow>(
    `SELECT qdr.id, qdr.rank_position AS position, NULL::uuid AS "providerId",
            qdr.document_id AS "documentId", 'document'::text AS "subjectType",
            NULL::integer AS "providerRevision",
            COALESCE(kd.mechanism_keys[1], 'Research and learning') AS "capabilityGroup",
            qdr.matched_fields AS "matchedFields", qdr.explanation, qdr.caveats,
            kd.title AS name, kd.document_kind AS kind, kd.summary AS description,
            kd.publication_state AS "publicationState", kd.aliases,
            kd.mechanism_keys AS capabilities, qdr.relevance_ordinal AS "relevanceOrdinal",
            qdr.relevance_value AS "relevanceValue", 'rule'::text AS "relevanceMethod",
            qdr.value_conservative::float8 AS "valueCentral", 0::float8 AS "valueUncertainty",
            qdr.value_conservative::float8 AS "valueConservative",
            qdr.evidence_coverage::float8 AS "evidenceCoverage",
            qdr.signal_unrounded::float8 AS "signalUnrounded",
            qdr.signal_display AS "signalDisplay", qdr.display_state AS "displayState",
            qdr.missing, qdr.signal_policy_version AS "policyVersion",
            kd.publisher, kd.canonical_uri AS "canonicalUri"
     FROM workspace.query_document_results qdr
     JOIN catalog.knowledge_documents kd ON kd.id = qdr.document_id
     WHERE ${documentFilters.join(' AND ')}`,
    documentValues,
  );
  return {
    metadata: metadata.rows[0]!,
    rows: sortRows([...providerRows.rows, ...documentRows.rows], query.sort),
  };
}

export async function getExplorerResultPage(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  query: ResultPageQuery,
): Promise<unknown> {
  const [page, discoveryOperations] = await Promise.all([
    resultRows(pool, workspaceId, resultSetId, query),
    pool.query<{ id: string; adapterKey: string; state: string }>(
      `SELECT id, adapter_key AS "adapterKey", state, plan_route_id AS "planRouteId",
              variant_index AS "variantIndex", routing_reason AS "routingReason",
              source_plan_state AS "sourcePlanState", safe_detail AS "safeDetail"
       FROM ops.discovery_operations
       WHERE result_set_id = $1 AND workspace_id = $2
         AND adapter_key <> 'local_semantic'
       ORDER BY created_at, id`,
      [resultSetId, workspaceId],
    ),
  ]);
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 50);
  const viewHash = hashCanonical(cursorView(query));
  const decoded = decodeCursor(query.cursor);
  if (decoded && (decoded.resultSetId !== resultSetId || decoded.viewHash !== viewHash)) {
    throw new DomainValidationError('Result cursor does not belong to this result-set view.');
  }
  const start = decoded ? page.rows.findIndex((row) => row.id === decoded.lastId) + 1 : 0;
  if (decoded && start === 0) throw new DomainValidationError('Result cursor item is unavailable.');
  const items = page.rows.slice(start, start + limit);
  const hasMore = start + items.length < page.rows.length;
  return {
    resultSet: page.metadata,
    activeOrdering: query.sort ?? 'recommended',
    filters: cursorView(query),
    filteredCount: page.rows.length,
    items,
    discoveryOperations: discoveryOperations.rows,
    nextCursor:
      hasMore && items.length ? encodeCursor(resultSetId, items.at(-1)!.id, viewHash) : null,
  };
}

export async function getExplorerItem(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  itemId: string,
): Promise<unknown> {
  const item = await pool.query<JsonRow>(
    `SELECT qri.id, qri.result_set_id AS "resultSetId", qri.provider_id AS "providerId",
            'implementation'::text AS "subjectType",
            qri.provider_revision AS "providerRevision", qri.capability_group AS "capabilityGroup",
            qri.matched_fields AS "matchedFields", qri.explanation, qri.caveats,
            pdr.canonical_name AS name, pdr.kind, pdr.description,
            kp.publication_state AS "publicationState", kp.capability_keys AS capabilities,
            qsr.relevance_ordinal AS "relevanceOrdinal", qsr.relevance_value AS "relevanceValue",
            qsr.relevance_method AS "relevanceMethod", qsr.relevance_anchors AS "relevanceAnchors",
            qsr.value_inputs AS "valueInputs", qsr.value_central::float8 AS "valueCentral",
            qsr.value_uncertainty::float8 AS "valueUncertainty",
            qsr.value_conservative::float8 AS "valueConservative",
            qsr.evidence_coverage::float8 AS "evidenceCoverage",
            qsr.signal_unrounded::float8 AS "signalUnrounded", qsr.signal_display AS "signalDisplay",
            qsr.display_state AS "displayState", qsr.missing, qsr.policy_version AS "policyVersion",
            qsr.input_hash AS "inputHash", qsr.generated_at AS "generatedAt"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_runs qsr ON qsr.id = qri.query_signal_run_id
     JOIN catalog.provider_display_revisions pdr ON pdr.id = qsr.provider_display_revision_id
     JOIN catalog.knowledge_projections kp
       ON kp.provider_id = qri.provider_id AND kp.provider_revision = qri.provider_revision
     WHERE qri.id = $1 AND qri.result_set_id = $2 AND qri.workspace_id = $3`,
    [itemId, resultSetId, workspaceId],
  );
  if (!item.rowCount) {
    const document = await pool.query<JsonRow>(
      `SELECT qdr.id, qdr.result_set_id AS "resultSetId", 'document'::text AS "subjectType",
              NULL::uuid AS "providerId", qdr.document_id AS "documentId",
              kd.title AS name, kd.document_kind AS kind, kd.summary AS description,
              kd.publication_state AS "publicationState", kd.mechanism_keys AS capabilities,
              kd.publisher, kd.canonical_uri AS "canonicalUri",
              COALESCE(kd.mechanism_keys[1], 'Research and learning') AS "capabilityGroup",
              qdr.matched_fields AS "matchedFields", qdr.explanation, qdr.caveats,
              qdr.relevance_ordinal AS "relevanceOrdinal",
              qdr.relevance_value AS "relevanceValue", 'rule'::text AS "relevanceMethod",
              qdr.relevance_anchors AS "relevanceAnchors", qdr.value_inputs AS "valueInputs",
              qdr.value_conservative::float8 AS "valueConservative",
              qdr.evidence_coverage::float8 AS "evidenceCoverage",
              qdr.signal_unrounded::float8 AS "signalUnrounded",
              qdr.signal_display AS "signalDisplay", qdr.display_state AS "displayState",
              qdr.missing, qdr.signal_policy_version AS "policyVersion",
              qdr.input_hash AS "inputHash", qdr.created_at AS "generatedAt",
              so.id AS "sourceObservationId", so.observed_at AS "observedAt",
              so.retrieval_method AS "retrievalMethod", so.adapter_version AS "adapterVersion",
              so.handling_status AS "handlingStatus", s.title AS "sourceTitle",
              s.owner AS "sourceOwner", s.canonical_uri AS "sourceUrl"
       FROM workspace.query_document_results qdr
       JOIN catalog.knowledge_documents kd ON kd.id = qdr.document_id
       JOIN catalog.source_observations so ON so.id = kd.source_observation_id
       JOIN catalog.sources s ON s.id = so.source_id
       WHERE qdr.id = $1 AND qdr.result_set_id = $2 AND qdr.workspace_id = $3`,
      [itemId, resultSetId, workspaceId],
    );
    if (!document.rowCount) throw new NotFoundError('Query result item not found.');
    const subjects = await pool.query<JsonRow>(
      `SELECT kds.relation_type AS type, kds.rationale,
              p.id AS "targetProviderId", p.canonical_name AS "targetName",
              cd.id AS "targetCapabilityId", cd.name AS "targetCapabilityName",
              'source_supported'::text AS status
       FROM catalog.knowledge_document_subjects kds
       LEFT JOIN catalog.providers p ON p.id = kds.provider_id
       LEFT JOIN catalog.capability_definitions cd ON cd.id = kds.capability_definition_id
       WHERE kds.document_id = $1
       ORDER BY kds.relation_type, COALESCE(p.canonical_name, cd.name)`,
      [document.rows[0]!.documentId],
    );
    const sourceEvidence = {
      id: document.rows[0]!.sourceObservationId,
      evidenceType: 'knowledge_document',
      producer: document.rows[0]!.publisher,
      methodVersion: document.rows[0]!.adapterVersion,
      dimensionKey: 'document_identity',
      independence: 'publisher_only',
      applicabilityScope: 'document identity and stated subject',
      observedAt: document.rows[0]!.observedAt,
      sourceTitle: document.rows[0]!.sourceTitle,
      sourceOwner: document.rows[0]!.sourceOwner,
      sourceUrl: document.rows[0]!.sourceUrl,
      retrievalMethod: document.rows[0]!.retrievalMethod,
      adapterVersion: document.rows[0]!.adapterVersion,
      handlingStatus: document.rows[0]!.handlingStatus,
      limitations: ['Document usefulness and independent confirmation remain separate.'],
    };
    return { ...document.rows[0], evidence: [sourceEvidence], relations: subjects.rows };
  }
  const evidence = await pool.query<JsonRow>(
    `SELECT ei.id, ei.evidence_type AS "evidenceType", ei.producer, ei.method_version AS "methodVersion",
            ei.independence, ei.applicability_scope AS "applicabilityScope", ei.limitations,
            ei.quality_flags AS "qualityFlags", ei.observed_at AS "observedAt",
            s.title AS "sourceTitle", s.owner AS "sourceOwner", s.canonical_uri AS "sourceUrl",
            so.retrieval_method AS "retrievalMethod", so.adapter_version AS "adapterVersion",
            so.handling_status AS "handlingStatus", qseb.dimension_key AS "dimensionKey"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_evidence_bindings qseb
       ON qseb.query_signal_run_id = qri.query_signal_run_id
     JOIN catalog.evidence_items ei ON ei.id = qseb.evidence_item_id
     LEFT JOIN catalog.source_observations so ON so.id = ei.source_observation_id
     LEFT JOIN catalog.sources s ON s.id = so.source_id
     WHERE qri.id = $1 AND qri.result_set_id = $2 AND qri.workspace_id = $3
     ORDER BY qseb.dimension_key, ei.observed_at DESC, ei.id`,
    [itemId, resultSetId, workspaceId],
  );
  const relations = await pool.query<JsonRow>(
    `SELECT pr.relation_type AS type, pr.applicability_scope AS scope,
            pr.confidence::float8, pr.object_provider_id AS "targetProviderId",
            target.canonical_name AS "targetName", s.canonical_uri AS "sourceUrl",
            CASE WHEN pr.source_observation_id IS NULL THEN 'provisional' ELSE 'source_supported' END AS status
     FROM catalog.provider_relations pr
     JOIN catalog.providers target ON target.id = pr.object_provider_id
     LEFT JOIN catalog.source_observations so ON so.id = pr.source_observation_id
     LEFT JOIN catalog.sources s ON s.id = so.source_id
     WHERE pr.subject_provider_id = $1 AND (pr.valid_to IS NULL OR pr.valid_to > now())
     ORDER BY pr.relation_type, target.canonical_name`,
    [item.rows[0]!.providerId],
  );
  return { ...item.rows[0], evidence: evidence.rows, relations: relations.rows };
}

export async function getExplorerGraph(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  query: ResultPageQuery & { limit?: number },
): Promise<unknown> {
  const page = await resultRows(pool, workspaceId, resultSetId, query);
  const limit = Math.min(Math.max(query.limit ?? 40, 1), 150);
  const visible = page.rows.slice(0, limit);
  const groupNames = [...new Set(visible.map((row) => row.capabilityGroup))].sort();
  const groupNodes = groupNames.map((group) => ({
    id: `group:${hashCanonical(group).slice(0, 16)}`,
    type: 'capability_group',
    label: group,
    group,
    status: 'group',
  }));
  const providerNodes = visible.map((row) => ({
    id: row.id,
    resultItemId: row.id,
    providerId: row.providerId,
    documentId: row.documentId,
    type: row.subjectType,
    label: row.name,
    kind: row.kind,
    group: row.capabilityGroup,
    signalDisplay: row.signalDisplay,
    displayState: row.displayState,
  }));
  const groupId = new Map(groupNodes.map((node) => [node.group, node.id]));
  const edges = visible.map((row) => ({
    id: `${row.subjectType === 'document' ? 'about' : 'provides'}:${row.id}`,
    source: row.id,
    target: groupId.get(row.capabilityGroup),
    type: row.subjectType === 'document' ? 'about' : 'provides',
    scope:
      row.subjectType === 'document'
        ? 'document subject grouping'
        : 'query-result capability grouping',
    status: row.publicationState === 'reviewed' ? 'source_supported' : 'provisional',
  }));
  return {
    resultSetId,
    resultSetRevision: page.metadata.revision,
    filteredCount: page.rows.length,
    visibleCount: visible.length,
    hiddenCount: Math.max(0, page.rows.length - visible.length),
    nodes: [...groupNodes, ...providerNodes],
    edges,
    accessibleItems: visible.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      group: row.capabilityGroup,
      explanation: row.explanation,
      relation: {
        type: row.subjectType === 'document' ? 'about' : 'provides',
        scope:
          row.subjectType === 'document'
            ? 'document subject grouping'
            : 'query-result capability grouping',
        status: row.publicationState === 'reviewed' ? 'source_supported' : 'provisional',
      },
    })),
  };
}

export async function compareExplorerItems(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  resultItemIds: string[],
): Promise<unknown> {
  const items = await Promise.all(
    resultItemIds.map((itemId) => getExplorerItem(pool, workspaceId, resultSetId, itemId)),
  );
  return {
    resultSetId,
    items,
    differenceFields: [
      'relevanceOrdinal',
      'displayState',
      'signalDisplay',
      'evidenceCoverage',
      'kind',
      'capabilities',
      'caveats',
    ],
    authority: 'Comparison is decision input only; it grants no install or execution authority.',
  };
}

export async function saveShortlist(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  input: ShortlistBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const context = await client.query(
      `SELECT id FROM workspace.project_contexts WHERE id = $1 AND workspace_id = $2`,
      [input.projectContextId, workspaceId],
    );
    if (!context.rowCount) throw new NotFoundError('Project context not found.');
    const items = await client.query<{ id: string; kind: 'implementation' | 'document' }>(
      `SELECT id, 'implementation'::text AS kind FROM workspace.query_result_items
       WHERE result_set_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])
       UNION ALL
       SELECT id, 'document'::text AS kind FROM workspace.query_document_results
       WHERE result_set_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])`,
      [resultSetId, workspaceId, input.resultItemIds],
    );
    if (items.rowCount !== input.resultItemIds.length) {
      throw new DomainValidationError('Every shortlist item must belong to this result set.');
    }
    const shortlistId = newOpaqueId();
    await client.query(
      `INSERT INTO workspace.shortlists
         (id, workspace_id, project_context_id, result_set_id, name)
       VALUES ($1, $2, $3, $4, $5)`,
      [shortlistId, workspaceId, input.projectContextId, resultSetId, input.name],
    );
    const itemKinds = new Map(items.rows.map((item) => [item.id, item.kind]));
    for (const resultItemId of [...input.resultItemIds].sort()) {
      if (itemKinds.get(resultItemId) === 'document') {
        await client.query(
          `INSERT INTO workspace.shortlist_document_items
             (shortlist_id, workspace_id, query_document_result_id)
           VALUES ($1, $2, $3)`,
          [shortlistId, workspaceId, resultItemId],
        );
      } else {
        await client.query(
          `INSERT INTO workspace.shortlist_items (shortlist_id, workspace_id, result_item_id)
           VALUES ($1, $2, $3)`,
          [shortlistId, workspaceId, resultItemId],
        );
      }
    }
    return { id: shortlistId, name: input.name, resultSetId, itemCount: items.rowCount };
  });
}

export async function listExplorerSessions(pool: Pool, workspaceId: string): Promise<unknown[]> {
  const result = await pool.query<JsonRow>(
    `SELECT qs.id, qs.query_text AS query, qs.state, qs.created_at AS "createdAt",
            qs.retention_until AS "retentionUntil", qrs.id AS "resultSetId",
            qrs.revision AS "resultSetRevision", qrs.assessed_count AS "assessedCount", qrs.status,
            qs.normalized_intent->>'coverageState' AS "coverageState"
     FROM workspace.query_sessions qs
     JOIN LATERAL (
       SELECT * FROM workspace.query_result_sets current
       WHERE current.query_session_id = qs.id ORDER BY current.revision DESC LIMIT 1
     ) qrs ON true
     WHERE qs.workspace_id = $1 AND qs.deleted_at IS NULL
     ORDER BY qs.created_at DESC LIMIT 50`,
    [workspaceId],
  );
  return result.rows;
}

export async function redactExplorerSession(
  pool: Pool,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE workspace.query_sessions SET
       query_text = '[deleted by user]', normalized_intent = '{}'::jsonb,
       explicit_facets = '{}'::jsonb, inferred_facets = '{}'::jsonb,
       state = 'expired', deleted_at = now()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [sessionId, workspaceId],
  );
  if (!result.rowCount) throw new NotFoundError('Query session not found.');
}

export async function exportExplorerBundle(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  input: BundleExportBody,
): Promise<unknown> {
  const page = await resultRows(pool, workspaceId, resultSetId, { sort: 'signal' });
  const details = await Promise.all(
    page.rows.map((row) => getExplorerItem(pool, workspaceId, resultSetId, row.id)),
  );
  const metadata = page.metadata as {
    query?: unknown;
    projectContextId?: unknown;
    querySessionId?: unknown;
    interpretation?: unknown;
  };
  const projectContext =
    input.includeProjectContext && typeof metadata.projectContextId === 'string'
      ? await pool.query<JsonRow>(
          `SELECT id, project_id AS "projectId", revision, snapshot_hash AS "snapshotHash",
                  context_document AS context, created_at AS "createdAt"
           FROM workspace.project_contexts WHERE id = $1 AND workspace_id = $2`,
          [metadata.projectContextId, workspaceId],
        )
      : null;
  const omissions = [
    ...(!input.includePrivateQuery
      ? [{ section: 'query', reason: 'Private query excluded by explicit export choice.' }]
      : []),
    ...(!input.includeProjectContext && metadata.projectContextId
      ? [
          {
            section: 'projectContext',
            reason: 'Private project context excluded by explicit export choice.',
          },
        ]
      : []),
    ...(!input.includePrivateQuery || (!input.includeProjectContext && metadata.projectContextId)
      ? [
          {
            section: 'queryInterpretation',
            reason:
              'Interpretation excluded because it can contain private query or project-context terms.',
          },
        ]
      : []),
  ];
  const publicResultMetadata = { ...page.metadata };
  delete publicResultMetadata.query;
  delete publicResultMetadata.interpretation;
  delete publicResultMetadata.queryPlan;
  delete publicResultMetadata.projectContextId;
  delete publicResultMetadata.querySessionId;
  const mayIncludeInterpretation =
    input.includePrivateQuery &&
    (input.includeProjectContext || typeof metadata.projectContextId !== 'string');
  return createVerificationBundle({
    exportedAt: new Date().toISOString(),
    sections: {
      resultSet: {
        ...publicResultMetadata,
        ...(input.includePrivateQuery ? { query: metadata.query } : {}),
        ...(mayIncludeInterpretation ? { interpretation: metadata.interpretation } : {}),
        ...(input.includePrivateQuery && 'queryPlan' in page.metadata
          ? { queryPlan: page.metadata.queryPlan }
          : {}),
        ...(input.includeProjectContext && metadata.projectContextId
          ? { projectContextId: metadata.projectContextId }
          : {}),
      },
      resultItems: details,
      ...(projectContext?.rowCount ? { projectContext: projectContext.rows[0] } : {}),
      authority: {
        executionGranted: false,
        statement:
          'This bundle preserves decision inputs; it is not installation or execution authority.',
      },
    },
    omissions,
  });
}
