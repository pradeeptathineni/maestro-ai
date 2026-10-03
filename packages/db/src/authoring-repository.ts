import type { Pool, PoolClient } from 'pg';
import type {
  KnowledgeOptionBody,
  ProjectBody,
  ProjectContextRevisionBody,
} from '../../contracts/src/index.js';
import { hashCanonical, newOpaqueId, normalizeConsiderUrl } from '../../domain/src/index.js';
import { ConflictError, DomainValidationError, NotFoundError } from './errors.js';
import { inTransaction } from './transaction.js';

function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function createProject(
  pool: Pool,
  workspaceId: string,
  input: ProjectBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const projectId = newOpaqueId();
    const contextId = newOpaqueId();
    const displayId = newOpaqueId();
    const context = { ...input.context, provenance: input.context.provenance ?? 'human_declared' };
    const snapshotHash = hashCanonical(context);
    const displayHash = hashCanonical({
      projectId,
      revision: 1,
      name: input.name,
      lifecycleState: 'active',
    });
    await client.query(
      `INSERT INTO workspace.projects (id, workspace_id, name, lifecycle_state)
       VALUES ($1, $2, $3, 'active')`,
      [projectId, workspaceId, input.name],
    );
    await client.query(
      `INSERT INTO workspace.project_display_revisions
         (id, workspace_id, project_id, revision, name, lifecycle_state, capture_state, display_hash)
       VALUES ($1, $2, $3, 1, $4, 'active', 'authored', $5)`,
      [displayId, workspaceId, projectId, input.name, displayHash],
    );
    await client.query(
      `INSERT INTO workspace.project_contexts
         (id, workspace_id, project_id, revision, snapshot_hash, context_document, created_at)
       VALUES ($1, $2, $3, 1, $4, $5, now())`,
      [contextId, workspaceId, projectId, snapshotHash, json(context)],
    );
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, object_revision,
          correlation_id, after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'project.create', 'project', $3, 1, $4, $5, $6)`,
      [
        newOpaqueId(),
        workspaceId,
        projectId,
        newOpaqueId(),
        snapshotHash,
        json({ provenance: context.provenance }),
      ],
    );
    return {
      id: projectId,
      name: input.name,
      lifecycleState: 'active',
      currentContextId: contextId,
      contextRevision: 1,
      snapshotHash,
      context,
    };
  });
}

export async function reviseProjectContext(
  pool: Pool,
  workspaceId: string,
  projectId: string,
  input: ProjectContextRevisionBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
    const current = await client.query<{
      id: string;
      revision: number;
      snapshotHash: string;
    }>(
      `SELECT pc.id, pc.revision, pc.snapshot_hash AS "snapshotHash"
       FROM workspace.project_contexts pc
       JOIN workspace.projects p ON p.id = pc.project_id AND p.workspace_id = pc.workspace_id
       WHERE pc.project_id = $1 AND pc.workspace_id = $2
       ORDER BY pc.revision DESC LIMIT 1`,
      [projectId, workspaceId],
    );
    if (!current.rowCount) throw new NotFoundError('Project not found.');
    if (current.rows[0]!.revision !== input.expectedRevision) {
      throw new ConflictError(
        `Expected context revision ${input.expectedRevision}, found ${current.rows[0]!.revision}.`,
      );
    }
    const context = { ...input.context, provenance: input.context.provenance ?? 'human_declared' };
    const contextId = newOpaqueId();
    const revision = current.rows[0]!.revision + 1;
    const snapshotHash = hashCanonical(context);
    await client.query(
      `INSERT INTO workspace.project_contexts
         (id, workspace_id, project_id, revision, snapshot_hash, context_document, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [contextId, workspaceId, projectId, revision, snapshotHash, json(context)],
    );
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, object_revision,
          correlation_id, before_hash, after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'project_context.revise', 'project_context', $3, $4,
               $5, $6, $7, $8)`,
      [
        newOpaqueId(),
        workspaceId,
        contextId,
        revision,
        newOpaqueId(),
        current.rows[0]!.snapshotHash,
        snapshotHash,
        json({ supersedesContextId: current.rows[0]!.id }),
      ],
    );
    return { id: contextId, projectId, revision, snapshotHash, context };
  });
}

const allowedKinds = new Set([
  'oss_project',
  'product',
  'service',
  'api',
  'mcp_server',
  'plugin',
  'skill',
  'model',
  'agent',
  'framework',
  'runtime',
  'library',
  'language',
  'protocol',
  'practice',
  'standard',
  'registry',
  'workflow',
  'other',
]);

function initialValueProfile(evidenceId: string, kind: string): unknown[] {
  const highPrivilege = ['agent', 'framework', 'mcp_server', 'plugin', 'runtime'].includes(kind);
  return [
    {
      key: 'reuse_leverage',
      raw: 50,
      confidence: 0.35,
      coverage: 1,
      applicability: 'applicable',
      state: 'present',
      reasons: ['The reviewed source establishes a scoped capability, not measured efficacy.'],
      missing: ['Representative task evidence is not recorded.'],
      evidenceIds: [evidenceId],
    },
    ...(['adoption_ease', 'maturity'] as const).map((key) => ({
      key,
      raw: null,
      confidence: 0,
      coverage: 0,
      applicability: 'applicable',
      state: 'missing',
      reasons: [],
      missing: [`${key.replaceAll('_', ' ')} has not been assessed.`],
      evidenceIds: [],
    })),
    {
      key: 'provenance_clarity',
      raw: 50,
      confidence: 0.35,
      coverage: 1,
      applicability: 'applicable',
      highPrivilege,
      state: 'present',
      reasons: ['Canonical identity and publisher are recorded.'],
      missing: ['Consequential effects and permissions are not fully assessed.'],
      evidenceIds: [evidenceId],
    },
  ];
}

export async function furnishKnowledgeOption(
  pool: Pool,
  workspaceId: string,
  input: KnowledgeOptionBody,
): Promise<unknown> {
  return inTransaction(pool, (client) => furnishKnowledgeOptionWithClient(client, workspaceId, input));
}

export async function furnishKnowledgeOptionWithClient(
  client: PoolClient,
  workspaceId: string,
  input: KnowledgeOptionBody,
): Promise<unknown> {
  if (!allowedKinds.has(input.kind)) throw new DomainValidationError('Unsupported option kind.');
  let normalized: ReturnType<typeof normalizeConsiderUrl>;
  try {
    normalized = normalizeConsiderUrl(input.canonicalUrl);
  } catch {
    throw new DomainValidationError('Knowledge sources require a safe uncredentialed HTTPS URL.');
  }
  const normalizedUrl = normalized.normalizedUrl;
  const url = new URL(normalizedUrl);
  const workspace = await client.query('SELECT id FROM workspace.workspaces WHERE id = $1', [
    workspaceId,
  ]);
    if (!workspace.rowCount) throw new NotFoundError('Workspace not found.');
    const providerId = newOpaqueId();
    const sourceId = newOpaqueId();
    const observationId = newOpaqueId();
    const claimId = newOpaqueId();
    const evidenceId = newOpaqueId();
    const projectionId = newOpaqueId();
    const capabilityId = newOpaqueId();
    const displayId = newOpaqueId();
    const now = new Date();
    const contentDigest = hashCanonical({
      url: normalizedUrl,
      description: input.description,
      capability: input.capabilityKey,
    });
    await client.query(
      `INSERT INTO catalog.sources
         (id, canonical_uri, title, owner, source_type, authority_scope, redistribution_notes)
       VALUES ($1, $2, $3, $4, 'human_supplied_documentation',
               'Identity and stated capability scope',
               'Metadata and bounded paraphrase only; no source mirror.')`,
      [sourceId, normalizedUrl, input.sourceTitle, input.sourceOwner],
    );
    await client.query(
      `INSERT INTO catalog.source_observations
         (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
          adapter_version, content_digest, excerpt, media_type, trust_boundary, handling_status)
       VALUES ($1, $2, $3, $3, $4, 'human_review_submission', 'authoring-v1', $5, $6,
               'text/metadata', 'curated', $7)`,
      [
        observationId,
        sourceId,
        normalizedUrl,
        now,
        contentDigest,
        input.description,
        input.reviewState === 'reviewed' ? 'reviewed' : 'normalized',
      ],
    );
    await client.query(
      `INSERT INTO catalog.providers
         (id, kind, canonical_name, description, lifecycle_state, visibility, revision)
       VALUES ($1, $2, $3, $4, 'unknown', 'global', 1)`,
      [providerId, input.kind, input.name, input.description],
    );
    const identity = normalized.strongIdentity ?? {
      scheme: 'canonical_document' as const,
      value: normalizedUrl,
    };
    await client.query(
      `INSERT INTO catalog.provider_identities
         (id, provider_id, scheme, normalized_value, display_value, source_observation_id,
          confidence, is_canonical, valid_from)
       VALUES ($1, $2, $3, $4, $5, $6, 1, true, $7)`,
      [
        newOpaqueId(),
        providerId,
        identity.scheme,
        identity.value,
        normalizedUrl,
        observationId,
        now,
      ],
    );
    const displayHash = hashCanonical({
      providerId,
      revision: 1,
      kind: input.kind,
      name: input.name,
      description: input.description,
      lifecycleState: 'unknown',
    });
    await client.query(
      `INSERT INTO catalog.provider_display_revisions
         (id, provider_id, revision, kind, canonical_name, description, lifecycle_state,
          source_observation_id, capture_state, display_hash, effective_at)
       VALUES ($1, $2, 1, $3, $4, $5, 'unknown', $6, $7, $8, $9)`,
      [
        displayId,
        providerId,
        input.kind,
        input.name,
        input.description,
        observationId,
        input.reviewState === 'reviewed' ? 'reviewed' : 'observed',
        displayHash,
        now,
      ],
    );
    await client.query(
      `INSERT INTO catalog.capability_definitions
         (id, stable_key, schema_version, name, description, effect_classes)
       VALUES ($1, $2, 1, $3, $4, '{}')
       ON CONFLICT (stable_key, schema_version) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [capabilityId, input.capabilityKey, input.capabilityName, input.description],
    );
    const actualCapability = await client.query<{ id: string }>(
      `SELECT id FROM catalog.capability_definitions
       WHERE stable_key = $1 AND schema_version = 1`,
      [input.capabilityKey],
    );
    await client.query(
      `INSERT INTO catalog.provider_capabilities
         (id, provider_id, capability_definition_id, delivery_mode, maturity_state,
          assertion_state, effects, constraints)
       VALUES ($1, $2, $3, 'documented', 'unknown', $4, '{}', '{}'::jsonb)`,
      [
        newOpaqueId(),
        providerId,
        actualCapability.rows[0]!.id,
        input.reviewState === 'reviewed' ? 'observed' : 'publisher_declared',
      ],
    );
    await client.query(
      `INSERT INTO catalog.claims
         (id, provider_id, source_observation_id, claimant, claimant_relation, predicate,
          value, scope, workflow_state, valid_from)
       VALUES ($1, $2, $3, $4, 'publisher', 'documented_capability_scope', $5,
               'Human-submitted source scope; no efficacy or project-fit conclusion.', $6, $7)`,
      [
        claimId,
        providerId,
        observationId,
        input.sourceOwner,
        json(input.description),
        input.reviewState === 'reviewed' ? 'reviewed' : 'normalized',
        now,
      ],
    );
    await client.query(
      `INSERT INTO catalog.evidence_items
         (id, source_observation_id, evidence_type, producer, method_version, result,
          independence, applicability_scope, limitations, quality_flags, observed_at,
          review_after, visibility)
       VALUES ($1, $2, 'source_review', $3, 'authoring-v1', $4, 'publisher_only',
               'documented capability scope', $5, $6, $7::timestamptz,
               $7::timestamptz + interval '90 days', 'global')`,
      [
        evidenceId,
        observationId,
        input.sourceOwner,
        json({ description: input.description }),
        input.limitations,
        input.reviewState === 'reviewed' ? [] : ['proposed'],
        now,
      ],
    );
    await client.query(
      `INSERT INTO catalog.evidence_relations
         (id, claim_id, evidence_item_id, direction, directness, strength,
          applicability, rationale, reviewed_at)
       VALUES ($1, $2, $3, 'supports', 'direct', 'weak', 'partial',
               'The source supports its attributed scope only.', $4)`,
      [newOpaqueId(), claimId, evidenceId, now],
    );
    await client.query(
      `INSERT INTO catalog.provider_evidence_bindings
         (id, provider_id, evidence_item_id, applicability_scope, binding_basis, reviewed_at)
       VALUES ($1, $2, $3, 'documented capability scope', 'review_admission', $4)`,
      [newOpaqueId(), providerId, evidenceId, input.reviewState === 'reviewed' ? now : null],
    );
    const entityRevision = await client.query<{ entityId: string; revisionId: string }>(
      `SELECT entity.id AS "entityId", revision.id AS "revisionId"
       FROM catalog.knowledge_entities entity
       JOIN catalog.knowledge_entity_revisions revision ON revision.entity_id = entity.id
       WHERE entity.provider_id = $1
       ORDER BY revision.revision DESC, revision.created_at DESC, revision.id DESC
       LIMIT 1`,
      [providerId],
    );
    await client.query(
      `INSERT INTO catalog.knowledge_entity_evidence_bindings
         (id, knowledge_entity_id, entity_revision_id, evidence_item_id, predicate,
          applicability_scope, binding_basis, reviewed_at)
       VALUES ($1, $2, $3, $4, 'documented_capability_scope',
               'Documented capability scope', 'review_admission', $5)`,
      [
        newOpaqueId(),
        entityRevision.rows[0]!.entityId,
        entityRevision.rows[0]!.revisionId,
        evidenceId,
        input.reviewState === 'reviewed' ? now : null,
      ],
    );
    const valueProfile = initialValueProfile(evidenceId, input.kind);
    const projection = {
      providerId,
      revision: 1,
      name: input.name,
      summary: input.description,
      searchTerms: input.searchTerms,
      valueProfile,
    };
    await client.query(
      `INSERT INTO catalog.knowledge_projections
         (id, provider_id, provider_revision, projection_version, publication_state,
          kind_profile, preferred_label, summary, search_text, aliases, capability_keys,
          value_profile, projection_hash, indexed_at)
       VALUES ($1, $2, 1, 'knowledge-projection-v1', $3, $4, $5, $6, $7, '{}',
               ARRAY[$8], $9, $10, $11)`,
      [
        projectionId,
        providerId,
        input.reviewState,
        input.kind,
        input.name,
        input.description,
        `${input.name} ${input.description} ${input.searchTerms.join(' ')}`,
        input.capabilityKey,
        json(valueProfile),
        hashCanonical(projection),
        now,
      ],
    );
    await client.query(
      `INSERT INTO catalog.knowledge_projection_sources
         (projection_id, source_observation_id, role, source_anchor)
       VALUES ($1, $2, 'capability', 'Human-submitted capability description')`,
      [projectionId, observationId],
    );
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, object_revision,
          correlation_id, after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'knowledge_option.furnish', 'provider', $3, 1, $4, $5, $6)`,
      [
        newOpaqueId(),
        workspaceId,
        providerId,
        newOpaqueId(),
        hashCanonical(projection),
        json({ reviewState: input.reviewState, sourceHost: url.hostname }),
      ],
    );
  return {
    id: providerId,
    name: input.name,
    revision: 1,
    projectionId,
    publicationState: input.reviewState,
    evidenceId,
    knowledgeEntityId: entityRevision.rows[0]!.entityId,
    entityRevisionId: entityRevision.rows[0]!.revisionId,
  };
}

const allowedDocumentKinds = new Set([
  'article',
  'research',
  'resource',
  'specification',
  'standard',
]);

export interface KnowledgeDocumentInput {
  title: string;
  summary: string;
  documentKind: string;
  canonicalUrl: string;
  sourceTitle: string;
  publisher: string;
  capabilityKey: string;
  capabilityName: string;
  searchTerms: string[];
  limitations: string[];
  reviewState: 'proposed' | 'reviewed';
}

export async function furnishKnowledgeDocumentWithClient(
  client: PoolClient,
  workspaceId: string,
  input: KnowledgeDocumentInput,
): Promise<{
  id: string;
  revision: 1;
  knowledgeEntityId: string;
  entityRevisionId: string;
  evidenceId: string;
}> {
  if (!allowedDocumentKinds.has(input.documentKind)) {
    throw new DomainValidationError('Unsupported document kind.');
  }
  let normalized: ReturnType<typeof normalizeConsiderUrl>;
  try {
    normalized = normalizeConsiderUrl(input.canonicalUrl);
  } catch {
    throw new DomainValidationError('Knowledge sources require a safe uncredentialed HTTPS URL.');
  }
  const workspace = await client.query('SELECT id FROM workspace.workspaces WHERE id = $1', [
    workspaceId,
  ]);
  if (!workspace.rowCount) throw new NotFoundError('Workspace not found.');
  const normalizedUrl = normalized.normalizedUrl;
  const url = new URL(normalizedUrl);
  const sourceId = newOpaqueId();
  const observationId = newOpaqueId();
  const evidenceId = newOpaqueId();
  const capabilityId = newOpaqueId();
  const documentId = newOpaqueId();
  const now = new Date();
  const contentDigest = hashCanonical({
    url: normalizedUrl,
    title: input.title,
    summary: input.summary,
    capability: input.capabilityKey,
  });
  await client.query(
    `INSERT INTO catalog.sources
       (id, canonical_uri, title, owner, source_type, authority_scope, redistribution_notes)
     VALUES ($1, $2, $3, $4, 'human_supplied_documentation',
             'Identity and bounded source scope',
             'Metadata and bounded paraphrase only; no source mirror.')`,
    [sourceId, normalizedUrl, input.sourceTitle, input.publisher],
  );
  await client.query(
    `INSERT INTO catalog.source_observations
       (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
        adapter_version, content_digest, excerpt, media_type, trust_boundary, handling_status)
     VALUES ($1, $2, $3, $3, $4, 'human_review_submission', 'authoring-v2', $5, $6,
             'text/metadata', 'curated', $7)`,
    [
      observationId,
      sourceId,
      normalizedUrl,
      now,
      contentDigest,
      input.summary,
      input.reviewState === 'reviewed' ? 'reviewed' : 'normalized',
    ],
  );
  await client.query(
    `INSERT INTO catalog.evidence_items
       (id, source_observation_id, evidence_type, producer, method_version, result,
        independence, applicability_scope, limitations, quality_flags, observed_at,
        review_after, visibility)
     VALUES ($1, $2, 'source_review', $3, 'authoring-v2', $4, 'publisher_only',
             'Document identity and described scope', $5, $6, $7,
             $7::timestamptz + interval '90 days', 'global')`,
    [
      evidenceId,
      observationId,
      input.publisher,
      json({ title: input.title, summary: input.summary }),
      input.limitations,
      input.reviewState === 'reviewed' ? [] : ['proposed'],
      now,
    ],
  );
  await client.query(
    `INSERT INTO catalog.capability_definitions
       (id, stable_key, schema_version, name, description, effect_classes)
     VALUES ($1, $2, 1, $3, $4, '{}')
     ON CONFLICT (stable_key, schema_version) DO UPDATE SET name = EXCLUDED.name`,
    [capabilityId, input.capabilityKey, input.capabilityName, input.summary],
  );
  const actualCapability = await client.query<{ id: string }>(
    `SELECT id FROM catalog.capability_definitions
     WHERE stable_key = $1 AND schema_version = 1`,
    [input.capabilityKey],
  );
  const valueProfile = initialValueProfile(evidenceId, input.documentKind);
  await client.query(
    `INSERT INTO catalog.knowledge_documents
       (id, document_kind, title, summary, canonical_uri, publisher, publication_state,
        source_observation_id, search_text, aliases, mechanism_keys, value_profile,
        content_digest, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', '{}', $10, $11, $12)`,
    [
      documentId,
      input.documentKind,
      input.title,
      input.summary,
      normalizedUrl,
      input.publisher,
      input.reviewState,
      observationId,
      `${input.title} ${input.summary} ${input.searchTerms.join(' ')}`,
      json(valueProfile),
      contentDigest,
      now,
    ],
  );
  await client.query(
    `INSERT INTO catalog.knowledge_document_subjects
       (document_id, capability_definition_id, relation_type, source_observation_id, rationale)
     VALUES ($1, $2, 'about', $3, 'Human-reviewed discovery admission.')`,
    [documentId, actualCapability.rows[0]!.id, observationId],
  );
  const entityRevision = await client.query<{ entityId: string; revisionId: string }>(
    `SELECT entity.id AS "entityId", revision.id AS "revisionId"
     FROM catalog.knowledge_entities entity
     JOIN catalog.knowledge_entity_revisions revision ON revision.entity_id = entity.id
     WHERE entity.document_id = $1 AND revision.revision = 1`,
    [documentId],
  );
  await client.query(
    `INSERT INTO catalog.knowledge_entity_evidence_bindings
       (id, knowledge_entity_id, entity_revision_id, evidence_item_id, predicate,
        applicability_scope, binding_basis, reviewed_at)
     VALUES ($1, $2, $3, $4, 'document_source_material',
             'Document identity and described scope', 'review_admission', $5)`,
    [
      newOpaqueId(),
      entityRevision.rows[0]!.entityId,
      entityRevision.rows[0]!.revisionId,
      evidenceId,
      input.reviewState === 'reviewed' ? now : null,
    ],
  );
  await client.query(
    `INSERT INTO ops.audit_events
       (id, workspace_id, actor_type, action, object_type, object_id, object_revision,
        correlation_id, after_hash, safe_metadata)
     VALUES ($1, $2, 'human', 'knowledge_document.furnish', 'knowledge_document', $3, 1,
             $4, $5, $6)`,
    [
      newOpaqueId(),
      workspaceId,
      documentId,
      newOpaqueId(),
      contentDigest,
      json({ reviewState: input.reviewState, sourceHost: url.hostname }),
    ],
  );
  return {
    id: documentId,
    revision: 1,
    knowledgeEntityId: entityRevision.rows[0]!.entityId,
    entityRevisionId: entityRevision.rows[0]!.revisionId,
    evidenceId,
  };
}
