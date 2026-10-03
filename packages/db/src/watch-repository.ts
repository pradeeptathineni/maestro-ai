import type { Pool, PoolClient } from 'pg';
import type { GitHubMetadataAdapter } from '../../adapters/src/index.js';
import type {
  ChangeDispositionBody,
  WatchBody,
  WatchCheckBody,
  WatchStateBody,
} from '../../contracts/src/index.js';
import {
  deriveRefreshCadence,
  hashCanonical,
  newOpaqueId,
  type WatchTargetKind,
} from '../../domain/src/index.js';
import { ConflictError, DomainValidationError, NotFoundError } from './errors.js';
import { refreshExplorerSession } from './explorer-repository.js';
import { inTransaction } from './transaction.js';

type JsonRow = Record<string, unknown>;

interface WatchRow {
  id: string;
  workspaceId: string;
  providerId: string | null;
  sourceId: string | null;
  querySessionId: string | null;
  conceptId: string | null;
  knowledgeEntityId: string | null;
  cadence: 'manual' | 'daily' | 'weekly' | 'adaptive';
  cadenceHours: number | null;
  state: 'active' | 'paused' | 'disabled';
  sourceWatermark: string | null;
  failureCount: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
}

interface CheckOptions {
  actorType: 'human' | 'system';
  retrievalMethod: string;
  adapterVersion: string;
  trustBoundary: 'remote_untrusted' | 'human_entered';
  excerpt?: string;
  expectedLeaseToken?: string;
  recordSourceObservation?: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function nextDue(
  cadence: WatchRow['cadence'],
  cadenceHours: number | null,
  from = new Date(),
  consecutiveFailures = 0,
): Date | null {
  if (cadence === 'manual') return null;
  const hours = cadence === 'adaptive' ? cadenceHours : cadence === 'daily' ? 24 : 7 * 24;
  if (!hours) return null;
  const cadenceMs = hours * 60 * 60 * 1000;
  const delayMs = consecutiveFailures
    ? Math.min(cadenceMs, 15 * 60 * 1000 * 2 ** Math.min(consecutiveFailures - 1, 10))
    : cadenceMs;
  return new Date(from.getTime() + delayMs);
}

async function localTargetWatermark(
  client: Pool | PoolClient,
  target: Pick<WatchRow, 'querySessionId' | 'conceptId' | 'knowledgeEntityId'>,
): Promise<string | null> {
  if (target.querySessionId) {
    const result = await client.query<{ resultHash: string }>(
      `SELECT result_hash AS "resultHash"
       FROM workspace.query_result_sets
       WHERE query_session_id = $1 ORDER BY revision DESC LIMIT 1`,
      [target.querySessionId],
    );
    return result.rows[0]?.resultHash ?? null;
  }
  if (target.conceptId) {
    const concept = await client.query<JsonRow>(
      `SELECT id, concept_scheme_id AS "conceptSchemeId", facet_key AS "facetKey",
              stable_key AS "stableKey", preferred_label AS "preferredLabel",
              definition, status
       FROM catalog.concepts WHERE id = $1`,
      [target.conceptId],
    );
    const labels = await client.query<JsonRow>(
      `SELECT label, normalized_label AS "normalizedLabel", label_kind AS "labelKind", locale,
              source_observation_id AS "sourceObservationId"
       FROM catalog.concept_labels WHERE concept_id = $1
       ORDER BY normalized_label, label_kind, locale, id`,
      [target.conceptId],
    );
    const relations = await client.query<JsonRow>(
      `SELECT subject_concept_id AS "subjectConceptId", relation_type AS "relationType",
              object_concept_id AS "objectConceptId", confidence::float8,
              evidence_basis AS "evidenceBasis", valid_from AS "validFrom",
              valid_to AS "validTo"
       FROM catalog.concept_relations
       WHERE subject_concept_id = $1 OR object_concept_id = $1
       ORDER BY subject_concept_id, relation_type, object_concept_id, valid_from, id`,
      [target.conceptId],
    );
    const assignments = await client.query<JsonRow>(
      `SELECT entity_id AS "entityId", facet_key AS "facetKey", confidence::float8,
              rationale, valid_from AS "validFrom", valid_to AS "validTo",
              supersedes_id AS "supersedesId"
       FROM catalog.entity_facet_assignments WHERE concept_id = $1
       ORDER BY entity_id, valid_from, id`,
      [target.conceptId],
    );
    if (!concept.rowCount) return null;
    return hashCanonical({
      concept: concept.rows[0],
      labels: labels.rows,
      relations: relations.rows,
      assignments: assignments.rows,
    });
  }
  if (target.knowledgeEntityId) {
    const entity = await client.query<JsonRow>(
      `SELECT id, source_kind AS "sourceKind", provider_id AS "providerId",
              document_id AS "documentId"
       FROM catalog.knowledge_entities WHERE id = $1`,
      [target.knowledgeEntityId],
    );
    const revisions = await client.query<JsonRow>(
      `SELECT revision, entity_class_concept_id AS "entityClassConceptId",
              preferred_label AS "preferredLabel", summary, lifecycle_state AS "lifecycleState",
              source_observation_id AS "sourceObservationId", predecessor_id AS "predecessorId",
              content_hash AS "contentHash"
       FROM catalog.knowledge_entity_revisions WHERE entity_id = $1
       ORDER BY revision, id`,
      [target.knowledgeEntityId],
    );
    const facets = await client.query<JsonRow>(
      `SELECT concept_id AS "conceptId", facet_key AS "facetKey", origin,
              confidence::float8, rationale, source_observation_id AS "sourceObservationId",
              evidence_item_ids AS "evidenceItemIds", valid_from AS "validFrom",
              valid_to AS "validTo", supersedes_id AS "supersedesId"
       FROM catalog.entity_facet_assignments WHERE entity_id = $1
       ORDER BY facet_key, concept_id, valid_from, id`,
      [target.knowledgeEntityId],
    );
    const relationships = await client.query<JsonRow>(
      `SELECT subject_entity_id AS "subjectEntityId", relation_type AS "relationType",
              object_entity_id AS "objectEntityId", object_concept_id AS "objectConceptId",
              direction, confidence::float8, revision_scope AS "revisionScope",
              valid_from AS "validFrom", valid_to AS "validTo", state,
              supersedes_id AS "supersedesId"
       FROM catalog.knowledge_relationships
       WHERE subject_entity_id = $1 OR object_entity_id = $1
       ORDER BY subject_entity_id, relation_type, object_entity_id, object_concept_id,
                valid_from, id`,
      [target.knowledgeEntityId],
    );
    const documentRevisions = await client.query<JsonRow>(
      `SELECT revision, predecessor_id AS "predecessorId",
              supersedes_document_id AS "supersedesDocumentId", content_digest AS "contentDigest",
              publication_state AS "publicationState", observed_at AS "observedAt", change_kind AS "changeKind"
       FROM catalog.knowledge_document_revisions
       WHERE document_id = (SELECT document_id FROM catalog.knowledge_entities WHERE id = $1)
       ORDER BY revision, id`,
      [target.knowledgeEntityId],
    );
    if (!entity.rowCount) return null;
    return hashCanonical({
      entity: entity.rows[0],
      revisions: revisions.rows,
      facets: facets.rows,
      relationships: relationships.rows,
      documentRevisions: documentRevisions.rows,
    });
  }
  return null;
}

async function enqueueWatch(
  client: PoolClient,
  watchId: string,
  workspaceId: string,
  dueAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.outbox
       (id, operation_key, task_name, payload, state, available_at)
     VALUES ($1, $2, 'refresh_watch_v2', $3, 'pending', $4)
     ON CONFLICT (operation_key) DO NOTHING`,
    [
      newOpaqueId(),
      `watch:${watchId}:${dueAt.toISOString()}`,
      json({ watchId, workspaceId }),
      dueAt,
    ],
  );
}

async function readWatchForUpdate(
  client: PoolClient,
  workspaceId: string,
  watchId: string,
): Promise<WatchRow> {
  const result = await client.query<WatchRow>(
    `SELECT watch.id, watch.workspace_id AS "workspaceId",
            COALESCE(watch.provider_id, entity.provider_id) AS "providerId",
            watch.source_id AS "sourceId", watch.query_session_id AS "querySessionId",
            watch.concept_id AS "conceptId", watch.knowledge_entity_id AS "knowledgeEntityId",
            watch.cadence, watch.cadence_hours AS "cadenceHours", watch.state,
            watch.source_watermark AS "sourceWatermark", watch.failure_count AS "failureCount",
            watch.lease_token AS "leaseToken", watch.lease_until AS "leaseUntil"
     FROM workspace.watches watch
     LEFT JOIN catalog.knowledge_entities entity ON entity.id = watch.knowledge_entity_id
     WHERE watch.id = $1 AND watch.workspace_id = $2 FOR UPDATE OF watch`,
    [watchId, workspaceId],
  );
  if (!result.rowCount) throw new NotFoundError('Watch not found.');
  return result.rows[0]!;
}

export async function createWatch(
  pool: Pool,
  workspaceId: string,
  input: WatchBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const providerId = 'providerId' in input ? input.providerId : null;
    const querySessionId = 'querySessionId' in input ? input.querySessionId : null;
    const conceptId = 'conceptId' in input ? input.conceptId : null;
    const knowledgeEntityId = 'knowledgeEntityId' in input ? input.knowledgeEntityId : null;
    const targetKind: WatchTargetKind = providerId
      ? 'provider'
      : querySessionId
        ? 'query'
        : conceptId
          ? 'concept'
          : 'entity';
    const target = await client.query<{
      providerId: string | null;
      sourceId: string | null;
      watermark: string | null;
      entityClass: string | null;
      documentType: string | null;
    }>(
      providerId
        ? `SELECT p.id AS "providerId", latest.source_id AS "sourceId",
                  latest.content_digest AS watermark, class.stable_key AS "entityClass",
                  NULL::text AS "documentType"
           FROM catalog.providers p
           LEFT JOIN catalog.knowledge_entities ke ON ke.provider_id = p.id
           LEFT JOIN LATERAL (
             SELECT c.stable_key
             FROM catalog.knowledge_entity_revisions revision
             JOIN catalog.concepts c ON c.id = revision.entity_class_concept_id
             WHERE revision.entity_id = ke.id ORDER BY revision.revision DESC LIMIT 1
           ) class ON true
           LEFT JOIN LATERAL (
             SELECT so.source_id, so.content_digest
             FROM catalog.provider_evidence_bindings peb
             JOIN catalog.evidence_items ei ON ei.id = peb.evidence_item_id
             JOIN catalog.source_observations so ON so.id = ei.source_observation_id
             WHERE peb.provider_id = p.id
             ORDER BY so.observed_at DESC, so.id DESC LIMIT 1
           ) latest ON true
           WHERE p.id = $1`
        : querySessionId
          ? `SELECT NULL::uuid AS "providerId", NULL::uuid AS "sourceId",
                    NULL::text AS watermark, NULL::text AS "entityClass",
                    NULL::text AS "documentType"
             FROM workspace.query_sessions
             WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`
          : conceptId
            ? `SELECT NULL::uuid AS "providerId", NULL::uuid AS "sourceId",
                      NULL::text AS watermark, NULL::text AS "entityClass",
                      NULL::text AS "documentType"
               FROM catalog.concepts WHERE id = $1 AND status = 'active'`
            : `SELECT ke.provider_id AS "providerId",
                      COALESCE(provider_source.source_id, document_source.source_id) AS "sourceId",
                      COALESCE(provider_source.content_digest, document_source.content_digest) AS watermark,
                      class.stable_key AS "entityClass", document_type.stable_key AS "documentType"
               FROM catalog.knowledge_entities ke
               JOIN LATERAL (
                 SELECT c.stable_key
                 FROM catalog.knowledge_entity_revisions revision
                 JOIN catalog.concepts c ON c.id = revision.entity_class_concept_id
                 WHERE revision.entity_id = ke.id ORDER BY revision.revision DESC LIMIT 1
               ) class ON true
               LEFT JOIN LATERAL (
                 SELECT so.source_id, so.content_digest
                 FROM catalog.provider_evidence_bindings peb
                 JOIN catalog.evidence_items ei ON ei.id = peb.evidence_item_id
                 JOIN catalog.source_observations so ON so.id = ei.source_observation_id
                 WHERE peb.provider_id = ke.provider_id
                 ORDER BY so.observed_at DESC, so.id DESC LIMIT 1
               ) provider_source ON true
               LEFT JOIN LATERAL (
                 SELECT so.source_id, so.content_digest
                 FROM catalog.knowledge_documents document
                 JOIN catalog.source_observations so ON so.id = document.source_observation_id
                 WHERE document.id = ke.document_id LIMIT 1
               ) document_source ON true
               LEFT JOIN LATERAL (
                 SELECT c.stable_key
                 FROM catalog.entity_facet_assignments assignment
                 JOIN catalog.concepts c ON c.id = assignment.concept_id
                 WHERE assignment.entity_id = ke.id AND assignment.facet_key = 'document_type'
                   AND assignment.valid_to IS NULL
                 ORDER BY assignment.confidence DESC, assignment.created_at DESC LIMIT 1
               ) document_type ON true
               WHERE ke.id = $1`,
      querySessionId
        ? [querySessionId, workspaceId]
        : [providerId ?? conceptId ?? knowledgeEntityId],
    );
    if (!target.rowCount) throw new NotFoundError(`${targetKind} watch target not found.`);
    const localWatermark = providerId
      ? null
      : await localTargetWatermark(client, { querySessionId, conceptId, knowledgeEntityId });
    const cadenceDecision = deriveRefreshCadence({
      targetKind,
      entityClass: target.rows[0]!.entityClass,
      documentType: target.rows[0]!.documentType,
    });
    const cadenceHours =
      input.cadence === 'adaptive'
        ? cadenceDecision.cadenceHours
        : input.cadence === 'daily'
          ? 24
          : input.cadence === 'weekly'
            ? 168
            : null;
    const existing = await client.query<JsonRow>(
      `SELECT id, state, cadence, next_due_at AS "nextDueAt"
       FROM workspace.watches
       WHERE workspace_id = $1 AND cadence = $2
         AND (($3::uuid IS NOT NULL AND provider_id = $3) OR
              ($4::uuid IS NOT NULL AND query_session_id = $4) OR
              ($5::uuid IS NOT NULL AND concept_id = $5) OR
              ($6::uuid IS NOT NULL AND knowledge_entity_id = $6))
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, input.cadence, providerId, querySessionId, conceptId, knowledgeEntityId],
    );
    if (existing.rowCount) return { ...existing.rows[0], duplicate: true };
    const watchId = newOpaqueId();
    const initialDue = input.cadence === 'manual' ? null : new Date();
    const created = await client.query<JsonRow>(
      `INSERT INTO workspace.watches
         (id, workspace_id, provider_id, source_id, query_session_id, concept_id,
          knowledge_entity_id, cadence, cadence_hours, cadence_policy_version,
          cadence_reason, priority, state, source_watermark, next_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13, $14)
       RETURNING id, provider_id AS "providerId", source_id AS "sourceId",
                 query_session_id AS "querySessionId", concept_id AS "conceptId",
                 knowledge_entity_id AS "knowledgeEntityId", cadence,
                 cadence_hours AS "cadenceHours", cadence_policy_version AS "cadencePolicyVersion",
                 cadence_reason AS "cadenceReason", priority, state,
                 source_watermark AS "sourceWatermark",
                 next_due_at AS "nextDueAt", created_at AS "createdAt"`,
      [
        watchId,
        workspaceId,
        providerId,
        providerId ? target.rows[0]!.sourceId : null,
        querySessionId,
        conceptId,
        knowledgeEntityId,
        input.cadence,
        cadenceHours,
        input.cadence === 'adaptive' ? cadenceDecision.policyVersion : 'legacy-fixed-v1',
        input.cadence === 'adaptive'
          ? cadenceDecision.reason
          : `Explicit ${input.cadence} cadence selected by the workspace actor.`,
        input.priority ?? 50,
        providerId ? target.rows[0]!.watermark : localWatermark,
        initialDue,
      ],
    );
    if (initialDue) await enqueueWatch(client, watchId, workspaceId, initialDue);
    return { ...created.rows[0], duplicate: false };
  });
}

export async function listWatches(pool: Pool, workspaceId: string): Promise<JsonRow[]> {
  const result = await pool.query<JsonRow>(
    `SELECT w.id, w.provider_id AS "providerId", p.canonical_name AS "providerName",
            w.query_session_id AS "querySessionId", qs.query_text AS "queryText",
            w.concept_id AS "conceptId", concept.preferred_label AS "conceptLabel",
            w.knowledge_entity_id AS "knowledgeEntityId",
            entity_revision.preferred_label AS "entityLabel",
            CASE WHEN w.provider_id IS NOT NULL THEN 'provider'
                 WHEN w.query_session_id IS NOT NULL THEN 'query'
                 WHEN w.concept_id IS NOT NULL THEN 'concept'
                 WHEN w.knowledge_entity_id IS NOT NULL THEN 'entity' ELSE 'source' END AS "targetKind",
            w.source_id AS "sourceId", s.canonical_uri AS "sourceUrl", w.cadence,
            w.cadence_hours AS "cadenceHours",
            w.cadence_policy_version AS "cadencePolicyVersion",
            w.cadence_reason AS "cadenceReason",
            w.priority, w.state, w.last_checked_at AS "lastCheckedAt",
            w.last_succeeded_at AS "lastSucceededAt",
            w.source_watermark AS "sourceWatermark", w.next_due_at AS "nextDueAt",
            w.failure_count AS "failureCount", w.lease_until AS "leaseUntil",
            w.last_error_code AS "lastErrorCode",
            count(mc.id) FILTER (WHERE cns.disposition IS NULL)::int AS "pendingChangeCount"
     FROM workspace.watches w
     LEFT JOIN catalog.providers p ON p.id = w.provider_id
     LEFT JOIN catalog.sources s ON s.id = w.source_id
     LEFT JOIN workspace.query_sessions qs
       ON qs.id = w.query_session_id AND qs.workspace_id = w.workspace_id
     LEFT JOIN catalog.concepts concept ON concept.id = w.concept_id
     LEFT JOIN LATERAL (
       SELECT revision.preferred_label
       FROM catalog.knowledge_entity_revisions revision
       WHERE revision.entity_id = w.knowledge_entity_id
       ORDER BY revision.revision DESC LIMIT 1
     ) entity_revision ON true
     LEFT JOIN workspace.material_changes mc
       ON mc.watch_id = w.id AND mc.workspace_id = w.workspace_id
     LEFT JOIN workspace.change_notice_states cns
       ON cns.change_id = mc.id AND cns.workspace_id = mc.workspace_id
     WHERE w.workspace_id = $1
     GROUP BY w.id, p.id, s.id, qs.id, concept.id, entity_revision.preferred_label
     ORDER BY w.priority DESC, w.created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function setWatchState(
  pool: Pool,
  workspaceId: string,
  watchId: string,
  input: WatchStateBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const watch = await readWatchForUpdate(client, workspaceId, watchId);
    const dueAt = input.state === 'active' && watch.cadence !== 'manual' ? new Date() : null;
    const result = await client.query<JsonRow>(
      `UPDATE workspace.watches
       SET state = $3, next_due_at = $4, lease_token = NULL, lease_until = NULL,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2
       RETURNING id, state, next_due_at AS "nextDueAt"`,
      [watchId, workspaceId, input.state, dueAt],
    );
    if (dueAt) await enqueueWatch(client, watchId, workspaceId, dueAt);
    return result.rows[0];
  });
}

async function adapterForSource(
  client: PoolClient,
  sourceId: string | null,
): Promise<string | null> {
  if (!sourceId) return null;
  const result = await client.query<{ canonicalUri: string }>(
    `SELECT canonical_uri AS "canonicalUri" FROM catalog.sources WHERE id = $1`,
    [sourceId],
  );
  const uri = result.rows[0]?.canonicalUri ?? '';
  if (/^https:\/\/(api\.)?github\.com\//i.test(uri)) return 'github';
  if (/^https:\/\/registry\.modelcontextprotocol\.io\//i.test(uri)) return 'mcp_registry';
  return null;
}

export async function recordWatchCheck(
  pool: Pool,
  workspaceId: string,
  watchId: string,
  input: WatchCheckBody,
  options: CheckOptions = {
    actorType: 'human',
    retrievalMethod: 'human_refresh_observation',
    adapterVersion: 'manual-check-v1',
    trustBoundary: 'human_entered',
  },
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const watch = await readWatchForUpdate(client, workspaceId, watchId);
    if (options.expectedLeaseToken && watch.leaseToken !== options.expectedLeaseToken) {
      return {
        watchId,
        outcome: 'superseded',
        observationId: null,
        materialChange: null,
        nextDueAt: null,
      };
    }
    if (watch.state !== 'active') throw new ConflictError('Paused watches cannot record checks.');
    if (
      !options.expectedLeaseToken &&
      watch.leaseToken &&
      watch.leaseUntil &&
      watch.leaseUntil > new Date()
    ) {
      throw new ConflictError('A scheduled refresh currently owns this watch.');
    }
    const recordSourceObservation =
      options.recordSourceObservation ??
      Boolean(
        watch.sourceId && !watch.querySessionId && !watch.conceptId && !watch.knowledgeEntityId,
      );
    if (input.outcome !== 'failed' && !input.watermark) {
      throw new DomainValidationError('Successful checks require a content watermark.');
    }
    if (
      input.outcome === 'unchanged' &&
      watch.sourceWatermark &&
      input.watermark !== watch.sourceWatermark
    ) {
      throw new DomainValidationError('An unchanged check must retain the prior watermark.');
    }
    if (input.outcome === 'changed' && input.watermark === watch.sourceWatermark) {
      throw new DomainValidationError('A changed check requires a new watermark.');
    }
    const checkedAt = new Date();
    const failureCount = input.outcome === 'failed' ? Math.min(20, watch.failureCount + 1) : 0;
    const dueAt = nextDue(watch.cadence, watch.cadenceHours, checkedAt, failureCount);
    let observationId: string | null = null;
    let priorObservationId: string | null = null;
    let change: JsonRow | null = null;
    if (input.outcome === 'changed') {
      if (recordSourceObservation) {
        if (!watch.sourceId) {
          throw new DomainValidationError('A changed source check requires a bound source.');
        }
        const source = await client.query<{ uri: string }>(
          `SELECT canonical_uri AS uri FROM catalog.sources WHERE id = $1`,
          [watch.sourceId],
        );
        if (!source.rowCount) throw new NotFoundError('Watched source not found.');
        const prior = await client.query<{ id: string }>(
          `SELECT id FROM catalog.source_observations
           WHERE source_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1`,
          [watch.sourceId],
        );
        priorObservationId = prior.rows[0]?.id ?? null;
        observationId = newOpaqueId();
        await client.query(
          `INSERT INTO catalog.source_observations
             (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
              adapter_version, content_digest, excerpt, media_type, trust_boundary,
              handling_status)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, 'application/json', $9, 'normalized')`,
          [
            observationId,
            watch.sourceId,
            source.rows[0]!.uri,
            checkedAt,
            options.retrievalMethod,
            options.adapterVersion,
            input.watermark,
            options.excerpt ?? input.reason,
            options.trustBoundary,
          ],
        );
      }
      const affectedResult = watch.querySessionId
        ? await client.query<{ id: string }>(
            `SELECT id FROM workspace.query_result_sets
             WHERE workspace_id = $1 AND query_session_id = $2
             ORDER BY revision DESC LIMIT 1`,
            [workspaceId, watch.querySessionId],
          )
        : watch.providerId
          ? await client.query<{ id: string }>(
              `SELECT qri.result_set_id AS id
             FROM workspace.query_result_items qri
             JOIN workspace.query_result_sets qrs ON qrs.id = qri.result_set_id
             WHERE qri.workspace_id = $1 AND qri.provider_id = $2
             ORDER BY qrs.created_at DESC LIMIT 1`,
              [workspaceId, watch.providerId],
            )
          : { rows: [] };
      const affectedDecision = watch.providerId
        ? await client.query<{ id: string }>(
            `SELECT d.id
             FROM workspace.decisions d
             JOIN workspace.candidates c ON c.need_id = d.need_id AND c.workspace_id = d.workspace_id
             JOIN workspace.candidate_components cc ON cc.candidate_id = c.id
             WHERE d.workspace_id = $1 AND cc.provider_id = $2
             ORDER BY d.decided_at DESC LIMIT 1`,
            [workspaceId, watch.providerId],
          )
        : { rows: [] };
      const changeHash = hashCanonical({
        watchId,
        priorObservationId,
        priorWatermark: watch.sourceWatermark,
        newWatermark: input.watermark,
        predicate: input.predicate ?? 'source-content',
        applicabilityScope: input.applicabilityScope ?? 'watched provider',
      });
      const inserted = await client.query<JsonRow>(
        `INSERT INTO workspace.material_changes
           (id, workspace_id, watch_id, provider_id, old_observation_id,
            new_observation_id, predicate, applicability_scope, reason,
            affected_result_set_id, affected_decision_id, change_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (workspace_id, change_hash) DO NOTHING
         RETURNING id, predicate, reason, affected_result_set_id AS "affectedResultSetId",
                   affected_decision_id AS "affectedDecisionId", created_at AS "createdAt"`,
        [
          newOpaqueId(),
          workspaceId,
          watchId,
          watch.providerId,
          priorObservationId,
          observationId,
          input.predicate ?? 'source-content',
          input.applicabilityScope ?? 'watched provider',
          input.reason,
          affectedResult.rows[0]?.id ?? null,
          affectedDecision.rows[0]?.id ?? null,
          changeHash,
        ],
      );
      change = inserted.rows[0] ?? null;
    }
    await client.query(
      `UPDATE workspace.watches
       SET last_checked_at = $3,
           last_succeeded_at = CASE WHEN $4 = 'failed' THEN last_succeeded_at ELSE $3 END,
           source_watermark = CASE WHEN $4 = 'failed' THEN source_watermark ELSE $5 END,
           next_due_at = $6, failure_count = $7,
           last_error_code = CASE WHEN $4 = 'failed' THEN 'refresh_failed' ELSE NULL END,
           lease_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [
        watchId,
        workspaceId,
        checkedAt,
        input.outcome,
        input.watermark ?? null,
        dueAt,
        failureCount,
      ],
    );
    const adapterKey = await adapterForSource(client, watch.sourceId);
    if (adapterKey && recordSourceObservation) {
      await client.query(
        `INSERT INTO ops.source_health_events
           (id, adapter_key, source_id, state, safe_detail, observation_id, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          newOpaqueId(),
          adapterKey,
          watch.sourceId,
          input.outcome,
          input.reason,
          observationId,
          checkedAt,
        ],
      );
    }
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, correlation_id,
          after_hash, safe_metadata)
       VALUES ($1, $2, $3, $4, 'watch', $5, $6, $7, $8)`,
      [
        newOpaqueId(),
        workspaceId,
        options.actorType,
        `watch.check.${input.outcome}`,
        watchId,
        newOpaqueId(),
        hashCanonical({ watchId, outcome: input.outcome, watermark: input.watermark ?? null }),
        json({ outcome: input.outcome, reason: input.reason, observationId }),
      ],
    );
    if (dueAt) await enqueueWatch(client, watchId, workspaceId, dueAt);
    return {
      watchId,
      outcome: input.outcome,
      observationId,
      materialChange: change,
      nextDueAt: dueAt?.toISOString() ?? null,
    };
  });
}

export async function listMaterialChanges(pool: Pool, workspaceId: string): Promise<JsonRow[]> {
  const result = await pool.query<JsonRow>(
    `SELECT mc.id, mc.watch_id AS "watchId", mc.provider_id AS "providerId",
            p.canonical_name AS "providerName", mc.predicate,
            mc.applicability_scope AS "applicabilityScope", mc.reason,
            mc.old_observation_id AS "oldObservationId",
            mc.new_observation_id AS "newObservationId",
            mc.affected_result_set_id AS "affectedResultSetId",
            mc.affected_decision_id AS "affectedDecisionId", mc.created_at AS "createdAt",
            cns.seen_at AS "seenAt", cns.disposition, cns.note
     FROM workspace.material_changes mc
     LEFT JOIN catalog.providers p ON p.id = mc.provider_id
     LEFT JOIN workspace.change_notice_states cns
       ON cns.change_id = mc.id AND cns.workspace_id = mc.workspace_id
     WHERE mc.workspace_id = $1 ORDER BY mc.created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function setChangeDisposition(
  pool: Pool,
  workspaceId: string,
  changeId: string,
  input: ChangeDispositionBody,
): Promise<unknown> {
  const change = await pool.query(
    `SELECT id FROM workspace.material_changes WHERE id = $1 AND workspace_id = $2`,
    [changeId, workspaceId],
  );
  if (!change.rowCount) throw new NotFoundError('Material change not found.');
  const result = await pool.query<JsonRow>(
    `INSERT INTO workspace.change_notice_states
       (change_id, workspace_id, seen_at, disposition, note)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (change_id, workspace_id) DO UPDATE
       SET seen_at = now(), disposition = EXCLUDED.disposition,
           note = EXCLUDED.note, updated_at = now()
     RETURNING change_id AS "changeId", seen_at AS "seenAt", disposition, note`,
    [changeId, workspaceId, input.disposition, input.note ?? null],
  );
  return result.rows[0];
}

async function reserveGitHubRefresh(pool: Pool): Promise<'reserved' | 'disabled' | 'denied'> {
  return inTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('discovery-external-daily-budget:' || current_date::text))`,
    );
    const config = await client.query<{ enabled: boolean; dailyLimit: number }>(
      `SELECT enabled, daily_call_limit AS "dailyLimit"
       FROM ops.source_adapter_configs WHERE adapter_key = 'github' FOR UPDATE`,
    );
    if (!config.rows[0]?.enabled) return 'disabled';
    await client.query(
      `INSERT INTO ops.adapter_daily_budgets (adapter_key, budget_date)
       VALUES ('github', current_date) ON CONFLICT DO NOTHING`,
    );
    const totals = await client.query<{ total: number; adapter: number }>(
      `SELECT COALESCE(sum(reserved_calls), 0)::int AS total,
              COALESCE(max(reserved_calls) FILTER (WHERE adapter_key = 'github'), 0)::int AS adapter
       FROM ops.adapter_daily_budgets WHERE budget_date = current_date`,
    );
    if (totals.rows[0]!.total >= 60 || totals.rows[0]!.adapter >= config.rows[0].dailyLimit) {
      await client.query(
        `UPDATE ops.adapter_daily_budgets
         SET denied_calls = denied_calls + 1, updated_at = now()
         WHERE adapter_key = 'github' AND budget_date = current_date`,
      );
      return 'denied';
    }
    await client.query(
      `UPDATE ops.adapter_daily_budgets
       SET reserved_calls = reserved_calls + 1, updated_at = now()
       WHERE adapter_key = 'github' AND budget_date = current_date`,
    );
    return 'reserved';
  });
}

export async function processWatchRefresh(
  pool: Pool,
  payload: { watchId: string; workspaceId: string },
  adapter: GitHubMetadataAdapter,
): Promise<void> {
  const leaseToken = newOpaqueId();
  const target = await pool.query<{
    state: string;
    identity: string | null;
    querySessionId: string | null;
    conceptId: string | null;
    knowledgeEntityId: string | null;
    sourceWatermark: string | null;
  }>(
    `UPDATE workspace.watches w
     SET lease_token = $3, lease_until = now() + interval '5 minutes', updated_at = now()
     WHERE w.id = $1 AND w.workspace_id = $2 AND w.state = 'active'
       AND (w.lease_until IS NULL OR w.lease_until < now())
     RETURNING w.state, w.query_session_id AS "querySessionId",
       w.concept_id AS "conceptId", w.knowledge_entity_id AS "knowledgeEntityId",
       w.source_watermark AS "sourceWatermark",
       (SELECT normalized_value
        FROM catalog.provider_identities
        WHERE provider_id = COALESCE(
          w.provider_id,
          (SELECT entity.provider_id FROM catalog.knowledge_entities entity
           WHERE entity.id = w.knowledge_entity_id)
        ) AND scheme = 'github_repository' AND valid_to IS NULL
        ORDER BY is_canonical DESC, confidence DESC LIMIT 1) AS identity
    `,
    [payload.watchId, payload.workspaceId, leaseToken],
  );
  if (!target.rowCount || target.rows[0]!.state !== 'active') return;
  const claimed = target.rows[0]!;
  if (claimed.querySessionId || claimed.conceptId || claimed.knowledgeEntityId) {
    if (claimed.querySessionId) {
      await refreshExplorerSession(pool, payload.workspaceId, claimed.querySessionId);
    }
    const watermark = await localTargetWatermark(pool, claimed);
    if (!watermark) {
      await recordWatchCheck(
        pool,
        payload.workspaceId,
        payload.watchId,
        { outcome: 'failed', reason: 'The watched local target is no longer available.' },
        {
          actorType: 'system',
          retrievalMethod: 'local_corpus_snapshot',
          adapterVersion: 'local-watch-v1',
          trustBoundary: 'human_entered',
          expectedLeaseToken: leaseToken,
          recordSourceObservation: false,
        },
      );
      return;
    }
    const changed = claimed.sourceWatermark !== null && claimed.sourceWatermark !== watermark;
    const targetKind = claimed.querySessionId ? 'query' : claimed.conceptId ? 'concept' : 'entity';
    await recordWatchCheck(
      pool,
      payload.workspaceId,
      payload.watchId,
      {
        outcome: changed ? 'changed' : 'unchanged',
        watermark,
        predicate: `${targetKind}-corpus-snapshot`,
        applicabilityScope: `local ${targetKind} knowledge state`,
        reason: changed
          ? `The watched ${targetKind} changed in the local append-only corpus.`
          : claimed.sourceWatermark
            ? `The watched ${targetKind} is unchanged in the local append-only corpus.`
            : `Established the initial ${targetKind} corpus watermark.`,
      },
      {
        actorType: 'system',
        retrievalMethod: 'local_corpus_snapshot',
        adapterVersion: 'local-watch-v1',
        trustBoundary: 'human_entered',
        expectedLeaseToken: leaseToken,
        recordSourceObservation: false,
      },
    );
    return;
  }
  if (!claimed.identity) {
    await recordWatchCheck(
      pool,
      payload.workspaceId,
      payload.watchId,
      { outcome: 'failed', reason: 'No reviewed GitHub repository identity is available.' },
      {
        actorType: 'system',
        retrievalMethod: 'github_api',
        adapterVersion: adapter.version,
        trustBoundary: 'remote_untrusted',
        expectedLeaseToken: leaseToken,
      },
    );
    return;
  }
  const reservation = await reserveGitHubRefresh(pool);
  if (reservation !== 'reserved') {
    await recordWatchCheck(
      pool,
      payload.workspaceId,
      payload.watchId,
      {
        outcome: 'failed',
        reason:
          reservation === 'disabled'
            ? 'GitHub refresh is not configured; no network request ran.'
            : 'Atomic daily external-call budget denied this refresh.',
      },
      {
        actorType: 'system',
        retrievalMethod: 'github_api',
        adapterVersion: adapter.version,
        trustBoundary: 'remote_untrusted',
        expectedLeaseToken: leaseToken,
      },
    );
    return;
  }
  const result = await adapter.fetch(claimed.identity);
  await pool.query(
    `UPDATE ops.adapter_daily_budgets
     SET consumed_calls = consumed_calls + 1, updated_at = now()
     WHERE adapter_key = 'github' AND budget_date = current_date`,
  );
  if (result.kind !== 'success' || result.retrieval !== 'live_github_api') {
    await recordWatchCheck(
      pool,
      payload.workspaceId,
      payload.watchId,
      {
        outcome: 'failed',
        reason:
          result.kind === 'success'
            ? 'Live network fetch is disabled; offline identity was not treated as a refresh.'
            : `GitHub refresh failed with ${result.code}.`,
      },
      {
        actorType: 'system',
        retrievalMethod: 'github_api',
        adapterVersion: adapter.version,
        trustBoundary: 'remote_untrusted',
        expectedLeaseToken: leaseToken,
      },
    );
    return;
  }
  const changed = claimed.sourceWatermark !== result.digest;
  await recordWatchCheck(
    pool,
    payload.workspaceId,
    payload.watchId,
    {
      outcome: changed ? 'changed' : 'unchanged',
      watermark: result.digest,
      predicate: 'github-repository-metadata',
      applicabilityScope: 'public provider maintenance metadata',
      reason: changed
        ? 'Bounded GitHub repository metadata changed; review before refreshing knowledge.'
        : 'Bounded GitHub repository metadata is unchanged.',
    },
    {
      actorType: 'system',
      retrievalMethod: 'github_api',
      adapterVersion: adapter.version,
      trustBoundary: 'remote_untrusted',
      excerpt: json(result.metadata),
      expectedLeaseToken: leaseToken,
    },
  );
}

/**
 * Re-arms every due watch whose prior worker lease expired. The outbox upsert is
 * intentionally recoverable: a process crash after dispatch cannot strand the
 * durable schedule forever, while the worker-side lease prevents concurrent
 * refreshes for the same watch.
 */
export async function recoverDueWatches(pool: Pool, limit = 50): Promise<number> {
  return inTransaction(pool, async (client) => {
    const due = await client.query<{ id: string; workspaceId: string; nextDueAt: Date }>(
      `SELECT id, workspace_id AS "workspaceId", next_due_at AS "nextDueAt"
       FROM workspace.watches
       WHERE state = 'active' AND cadence <> 'manual' AND next_due_at <= now()
         AND (lease_until IS NULL OR lease_until < now())
       ORDER BY priority DESC, next_due_at, id
       FOR UPDATE SKIP LOCKED LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    for (const watch of due.rows) {
      await client.query(
        `INSERT INTO ops.outbox
           (id, operation_key, task_name, payload, state, available_at)
         VALUES ($1, $2, 'refresh_watch_v2', $3, 'pending', now())
         ON CONFLICT (operation_key) DO UPDATE
           SET task_name = 'refresh_watch_v2', payload = EXCLUDED.payload,
               state = 'pending', available_at = now(), attempts = 0,
               last_error_code = NULL, dispatched_at = NULL
           WHERE ops.outbox.state IN ('dispatched', 'failed')`,
        [
          newOpaqueId(),
          `watch:${watch.id}:${watch.nextDueAt.toISOString()}`,
          json({ watchId: watch.id, workspaceId: watch.workspaceId }),
        ],
      );
    }
    return due.rowCount ?? 0;
  });
}
