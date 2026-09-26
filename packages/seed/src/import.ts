import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import {
  createDecisionReceipt,
  evaluateHardGates,
  hashCanonical,
  stableUuid,
  type GateResult,
} from '../../domain/src/index.js';
import { createPool } from '../../db/src/index.js';
import {
  calculateConsiderationV1,
  calculateProjectFitV1,
  calculateVerificationPriorityV1,
  considerationPolicyV1,
  type PreferenceInput,
  verificationPolicyV1,
} from '../../scoring/src/index.js';
import { auditSeedManifest } from './audit.js';
import { catalogSeedV1 } from './catalog-v1.js';
import type { SeedProvider } from './types.js';

const namespace = 'maestro-ai:seed:v1';
const scorePolicyId = stableUuid(namespace, 'score-policy:consideration-v1');
export const localWorkspaceId = stableUuid(namespace, 'workspace:local');
export const referenceProjectId = stableUuid(namespace, 'project:local-ai-assisted-development');
export const referenceProjectContextId = stableUuid(
  namespace,
  'project-context:local-ai-assisted-development:1',
);
export const referenceNeedStableId = stableUuid(namespace, 'need-stable:context-efficiency');
export const referenceNeedId = stableUuid(namespace, 'need:context-efficiency:1');

function id(kind: string, value: string): string {
  return stableUuid(namespace, `${kind}:${value}`);
}

function normalizedIdentity(scheme: string, value: string): string {
  return scheme === 'github_repository' ? value.toLowerCase() : value.trim().toLowerCase();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function compatibilityState(key: string, value: string): 'pass' | 'fail' | 'unknown' {
  if (key === 'contextReduction') {
    return value === 'yes' ? 'pass' : value === 'no' ? 'fail' : 'unknown';
  }
  if (key === 'setupReversibility') {
    return value === 'strong' ? 'pass' : 'unknown';
  }
  return value === 'pass' ? 'pass' : value === 'fail' ? 'fail' : 'unknown';
}

interface ImportedProvider {
  providerId: string;
  versionId: string;
  scoreRunId: string;
  evidenceIds: string[];
  manifest: SeedProvider;
}

async function importProvider(
  client: PoolClient,
  provider: SeedProvider,
  domainIds: Map<string, string>,
): Promise<ImportedProvider> {
  const providerId = id('provider', provider.key);
  const sourceObservationIds = new Map<string, string>();
  const sourceObservations = new Map<string, SeedProvider['sources'][number]>();
  for (const source of provider.sources) {
    const proposedSourceId = id('source', source.url);
    const sourceResult = await client.query<{ id: string }>(
      `INSERT INTO catalog.sources
         (id, canonical_uri, title, owner, source_type, authority_scope, redistribution_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (canonical_uri) DO UPDATE SET
         title = EXCLUDED.title,
         owner = EXCLUDED.owner,
         source_type = EXCLUDED.source_type,
         authority_scope = EXCLUDED.authority_scope
       RETURNING id`,
      [
        proposedSourceId,
        source.url,
        source.title,
        source.owner,
        source.type,
        source.authorityScope,
        'Seed stores metadata and a bounded curator observation, not a page mirror.',
      ],
    );
    const sourceId = sourceResult.rows[0]!.id;
    const digest = hashCanonical({
      url: source.url,
      title: source.title,
      observedAt: source.observedAt,
      observation: source.observation,
    });
    const observationId = id('source-observation', `${sourceId}:${digest}:${source.observedAt}`);
    await client.query(
      `INSERT INTO catalog.source_observations
         (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
          adapter_version, content_digest, excerpt, media_type, trust_boundary, handling_status)
       VALUES ($1, $2, $3, $3, $4, 'human_primary_source_review',
               'seed-curation-v1', $5, $6, 'text/metadata', 'curated', 'reviewed')
       ON CONFLICT DO NOTHING`,
      [observationId, sourceId, source.url, source.observedAt, digest, source.observation],
    );
    sourceObservationIds.set(source.key, observationId);
    sourceObservations.set(source.key, source);
  }

  await client.query(
    `INSERT INTO catalog.providers
       (id, kind, canonical_name, description, lifecycle_state, visibility)
     VALUES ($1, $2, $3, $4, $5, 'global')
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       canonical_name = EXCLUDED.canonical_name,
       description = EXCLUDED.description,
       lifecycle_state = EXCLUDED.lifecycle_state,
       revision = catalog.providers.revision + 1,
       updated_at = now()
     WHERE (catalog.providers.kind, catalog.providers.canonical_name,
            catalog.providers.description, catalog.providers.lifecycle_state)
       IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.canonical_name,
                         EXCLUDED.description, EXCLUDED.lifecycle_state)`,
    [providerId, provider.kind, provider.name, provider.description, provider.lifecycle],
  );

  const firstObservationId = sourceObservationIds.values().next().value as string;
  const identityValue = normalizedIdentity(provider.identity.scheme, provider.identity.value);
  await client.query(
    `INSERT INTO catalog.provider_identities
       (id, provider_id, scheme, normalized_value, display_value, source_observation_id,
        confidence, is_canonical, valid_from)
     VALUES ($1, $2, $3, $4, $5, $6, 1, true, $7)
     ON CONFLICT DO NOTHING`,
    [
      id('provider-identity', `${provider.identity.scheme}:${identityValue}`),
      providerId,
      provider.identity.scheme,
      identityValue,
      provider.identity.value,
      firstObservationId,
      catalogSeedV1.observedAt,
    ],
  );
  for (const alias of provider.aliases) {
    await client.query(
      `INSERT INTO catalog.provider_aliases (id, provider_id, alias, source_observation_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (provider_id, alias) DO NOTHING`,
      [id('provider-alias', `${provider.key}:${alias}`), providerId, alias, firstObservationId],
    );
  }

  const versionId = id('provider-version', `${provider.key}:${provider.version.label}`);
  await client.query(
    `INSERT INTO catalog.provider_versions
       (id, provider_id, upstream_version, normalized_version, release_observed_at,
        lifecycle_state, source_observation_id)
     VALUES ($1, $2, $3, $3, $4, $5, $6)
     ON CONFLICT (provider_id, upstream_version) DO NOTHING`,
    [
      versionId,
      providerId,
      provider.version.label,
      provider.version.releasedAt ?? null,
      provider.lifecycle,
      firstObservationId,
    ],
  );

  const capabilityId = id('capability', `${provider.capability.key}:1`);
  await client.query(
    `INSERT INTO catalog.capability_definitions
       (id, stable_key, schema_version, name, description, effect_classes)
     VALUES ($1, $2, 1, $3, $4, $5)
     ON CONFLICT (stable_key, schema_version) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description,
       effect_classes = EXCLUDED.effect_classes`,
    [
      capabilityId,
      provider.capability.key,
      provider.capability.name,
      provider.capability.description,
      provider.capability.effects,
    ],
  );
  await client.query(
    `INSERT INTO catalog.provider_capabilities
       (id, provider_id, provider_version_id, capability_definition_id, delivery_mode,
        maturity_state, assertion_state, effects, constraints)
     VALUES ($1, $2, $3, $4, $5, 'available', $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [
      id('provider-capability', `${provider.key}:${provider.capability.key}`),
      providerId,
      versionId,
      capabilityId,
      provider.capability.deliveryMode,
      provider.capability.assertionState,
      provider.capability.effects,
      json({ licenseBusiness: provider.licenseBusiness }),
    ],
  );
  for (const domainKey of provider.domains) {
    const domainId = domainIds.get(domainKey);
    if (!domainId) throw new Error(`Seed domain ${domainKey} was not imported.`);
    await client.query(
      `INSERT INTO catalog.domain_memberships
         (id, provider_id, domain_node_id, origin, confidence, rationale, reviewed,
          source_observation_id)
       VALUES ($1, $2, $3, 'manual', 0.95,
               'Reviewed against the provider capability and primary sources.', true, $4)
       ON CONFLICT (provider_id, domain_node_id) DO NOTHING`,
      [
        id('domain-membership', `${provider.key}:${domainKey}`),
        providerId,
        domainId,
        firstObservationId,
      ],
    );
  }

  const evidenceIds: string[] = [];
  for (const claim of provider.claims) {
    const observationId = sourceObservationIds.get(claim.sourceKey);
    const source = sourceObservations.get(claim.sourceKey);
    if (!observationId || !source)
      throw new Error(`Claim source ${claim.sourceKey} was not imported.`);
    const claimDocument = {
      providerId,
      observationId,
      claimant: claim.claimant,
      claimantRelation: claim.claimantRelation,
      predicate: claim.predicate,
      value: claim.value,
      scope: claim.scope,
    };
    const claimId = id('claim', `${provider.key}:${claim.key}:${hashCanonical(claimDocument)}`);
    await client.query(
      `INSERT INTO catalog.claims
         (id, provider_id, source_observation_id, claimant, claimant_relation, predicate,
          value, scope, workflow_state, valid_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reviewed', $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        claimId,
        providerId,
        observationId,
        claim.claimant,
        claim.claimantRelation,
        claim.predicate,
        json(claim.value),
        claim.scope,
        source.observedAt,
      ],
    );
    const evidenceId = id('evidence', `${claimId}:${hashCanonical(claim.evidence)}`);
    evidenceIds.push(evidenceId);
    await client.query(
      `INSERT INTO catalog.evidence_items
         (id, source_observation_id, evidence_type, producer, method_version, result,
          independence, applicability_scope, limitations, quality_flags, observed_at,
          review_after, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10,
               $10::timestamptz + interval '180 days', 'global')
       ON CONFLICT (id) DO NOTHING`,
      [
        evidenceId,
        observationId,
        claim.evidence.type,
        claim.evidence.producer,
        claim.evidence.methodVersion,
        json({ observation: source.observation, claimedValue: claim.value }),
        claim.evidence.independence,
        claim.scope,
        claim.evidence.limitations,
        source.observedAt,
      ],
    );
    await client.query(
      `INSERT INTO catalog.evidence_relations
         (id, claim_id, evidence_item_id, direction, directness, strength,
          applicability, rationale, reviewed_at)
       VALUES ($1, $2, $3, $4, 'direct', $5, $6,
               'Primary-source curation supports only the recorded scope.', $7)
       ON CONFLICT (claim_id, evidence_item_id, direction) DO NOTHING`,
      [
        id('evidence-relation', `${claimId}:${evidenceId}:${claim.evidence.direction}`),
        claimId,
        evidenceId,
        claim.evidence.direction,
        claim.evidence.strength,
        claim.evidence.applicability,
        source.observedAt,
      ],
    );
  }

  const dimensions = provider.scoreDimensions.map((dimension) => ({
    ...dimension,
    evidenceIds:
      dimension.state === 'missing' || dimension.state === 'not_applicable'
        ? []
        : [...evidenceIds].sort(),
  }));
  const consideration = calculateConsiderationV1(dimensions);
  const scoreInputHash = hashCanonical({
    providerId,
    versionId,
    policy: considerationPolicyV1,
    dimensions,
  });
  const scoreRunId = id('score-run', `${provider.key}:${scoreInputHash}`);
  const primaryDomainId = domainIds.get(provider.domains[0]!)!;
  await client.query(
    `INSERT INTO catalog.score_runs
       (id, provider_id, provider_version_id, domain_node_id, policy_id, input_hash,
        central, uncertainty, evidence_coverage, lower_bound, band, evidence_ids, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (provider_id, domain_node_id, policy_id, input_hash) DO NOTHING`,
    [
      scoreRunId,
      providerId,
      versionId,
      primaryDomainId,
      scorePolicyId,
      scoreInputHash,
      consideration.central,
      consideration.uncertainty,
      consideration.evidenceCoverage,
      consideration.lowerBound,
      consideration.band,
      consideration.inputEvidenceIds,
      catalogSeedV1.observedAt,
    ],
  );
  for (const dimension of consideration.dimensions) {
    await client.query(
      `INSERT INTO catalog.dimension_scores
         (id, score_run_id, dimension_key, raw, adjusted, confidence, coverage, prior,
          state, reasons, missing, evidence_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (score_run_id, dimension_key) DO NOTHING`,
      [
        id('dimension-score', `${scoreRunId}:${dimension.key}`),
        scoreRunId,
        dimension.key,
        dimension.raw,
        dimension.adjusted,
        dimension.confidence,
        dimension.coverage,
        dimension.prior,
        dimension.state,
        dimension.reasons,
        dimension.missing,
        dimension.evidenceIds,
      ],
    );
  }

  const factors = provider.verificationFactors.map((factor) => ({
    ...factor,
    evidenceIds: factor.value > 0 ? [...evidenceIds] : [],
  }));
  const verification = calculateVerificationPriorityV1(factors, provider.verificationContext);
  await client.query(
    `INSERT INTO catalog.verification_assessments
       (id, provider_id, policy_version, scope, priority, base_priority, state, modes,
        factors, adjustments, next_plan, evidence_ids, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [
      id('verification-assessment', `${provider.key}:${verification.policyVersion}`),
      providerId,
      verification.policyVersion,
      'Generic provider capability; project-specific risks require a separate assessment.',
      verification.priority,
      verification.basePriority,
      provider.verificationState,
      provider.verificationModes,
      json(verification.factors),
      verification.adjustments,
      provider.nextVerification,
      verification.evidenceIds,
      catalogSeedV1.observedAt,
    ],
  );

  for (const [key, value] of Object.entries(provider.compatibility)) {
    await client.query(
      `INSERT INTO catalog.provider_compatibility
         (id, provider_id, provider_version_id, compatibility_key, state, value,
          explanation, evidence_ids, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider_id, provider_version_id, compatibility_key)
       DO UPDATE SET state = EXCLUDED.state, value = EXCLUDED.value,
         explanation = EXCLUDED.explanation, evidence_ids = EXCLUDED.evidence_ids,
         observed_at = EXCLUDED.observed_at`,
      [
        id('compatibility', `${provider.key}:${key}`),
        providerId,
        versionId,
        key,
        compatibilityState(key, value),
        json(value),
        `Curated ${key} state is ${value}; inspect linked evidence and explicit unknowns.`,
        evidenceIds,
        catalogSeedV1.observedAt,
      ],
    );
  }

  return { providerId, versionId, scoreRunId, evidenceIds, manifest: provider };
}

function providerGateResults(provider: ImportedProvider): GateResult[] {
  const compatibility = provider.manifest.compatibility;
  return [
    {
      constraintId: id('constraint', 'context-efficiency:no-remote-source-transfer'),
      label: 'Source code must not be sent to a new remote service',
      state: compatibility.noRemoteSourceTransfer,
      unknownHandling: 'block',
      evidenceIds: provider.evidenceIds,
      explanation:
        compatibility.noRemoteSourceTransfer === 'pass'
          ? 'Curated evidence supports local handling for the recorded scope.'
          : compatibility.noRemoteSourceTransfer === 'fail'
            ? 'The documented delivery path sends project data to a remote service.'
            : 'Source-code egress remains unknown and blocks this hard gate.',
    },
    {
      constraintId: id('constraint', 'context-efficiency:macos'),
      label: 'macOS support required',
      state: compatibility.macos,
      unknownHandling: 'block',
      evidenceIds: provider.evidenceIds,
      explanation:
        compatibility.macos === 'pass'
          ? 'The reviewed source documents macOS support.'
          : compatibility.macos === 'fail'
            ? 'The reviewed source documents that macOS is unsupported.'
            : 'macOS support is not established and blocks this hard gate.',
    },
    {
      constraintId: id('constraint', 'context-efficiency:no-automatic-workspace-writes'),
      label: 'No automatic workspace writes during evaluation',
      state: compatibility.noAutomaticWorkspaceWrites,
      unknownHandling: 'block',
      evidenceIds: provider.evidenceIds,
      explanation:
        compatibility.noAutomaticWorkspaceWrites === 'pass'
          ? 'The reviewed scope does not require automatic workspace writes.'
          : compatibility.noAutomaticWorkspaceWrites === 'fail'
            ? 'The documented capability writes to the workspace automatically.'
            : 'Workspace write behavior is unknown and blocks this hard gate.',
    },
  ];
}

function providerPreferences(provider: ImportedProvider): PreferenceInput[] {
  const compatibility = provider.manifest.compatibility;
  const evidenceDimension = provider.manifest.scoreDimensions.find(
    (dimension) => dimension.key === 'evidence_strength',
  )!;
  return [
    {
      key: 'measurable-token-reduction',
      label: 'Measurable token reduction',
      weight: 0.45,
      raw:
        compatibility.contextReduction === 'yes'
          ? 90
          : compatibility.contextReduction === 'no'
            ? 10
            : null,
      confidence: compatibility.contextReduction === 'unknown' ? 0 : 0.7,
      state: compatibility.contextReduction === 'unknown' ? 'missing' : 'present',
      reasons: ['Derived from the reviewed capability and scoped quantitative evidence.'],
      evidenceIds: provider.evidenceIds,
    },
    {
      key: 'reversible-setup',
      label: 'Reversible setup',
      weight: 0.25,
      raw:
        compatibility.setupReversibility === 'strong'
          ? 90
          : compatibility.setupReversibility === 'mixed'
            ? 55
            : null,
      confidence: compatibility.setupReversibility === 'unknown' ? 0 : 0.65,
      state: compatibility.setupReversibility === 'unknown' ? 'missing' : 'present',
      reasons: ['Setup reversibility is a curated compatibility observation, not a trial result.'],
      evidenceIds: provider.evidenceIds,
    },
    {
      key: 'representative-evidence',
      label: 'Evidence from representative coding tasks',
      weight: 0.3,
      raw: evidenceDimension.raw,
      confidence: evidenceDimension.confidence,
      state: evidenceDimension.state,
      reasons: evidenceDimension.reasons,
      evidenceIds: provider.evidenceIds,
    },
  ];
}

async function importReferenceWorkspace(
  client: PoolClient,
  providers: Map<string, ImportedProvider>,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace.workspaces (id, name) VALUES ($1, 'Local workspace')
     ON CONFLICT (id) DO NOTHING`,
    [localWorkspaceId],
  );
  await client.query(
    `INSERT INTO workspace.projects (id, workspace_id, name, lifecycle_state)
     VALUES ($1, $2, 'Local AI-assisted development', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [referenceProjectId, localWorkspaceId],
  );
  const contextDocument = {
    goal: 'Improve local AI-assisted development without expanding source-code egress.',
    lifecycleStage: 'evaluation',
    environment: { operatingSystem: 'macOS', deploymentBoundary: 'local' },
    dataSensitivity: 'source code is private',
    allowedAuthority: ['read_data'],
    riskTolerance: 'bounded reversible trials only',
  };
  const snapshotHash = hashCanonical(contextDocument);
  await client.query(
    `INSERT INTO workspace.project_contexts
       (id, workspace_id, project_id, revision, snapshot_hash, context_document, created_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      referenceProjectContextId,
      localWorkspaceId,
      referenceProjectId,
      snapshotHash,
      json(contextDocument),
      catalogSeedV1.observedAt,
    ],
  );
  await client.query(
    `INSERT INTO workspace.needs
       (id, workspace_id, project_context_id, stable_id, revision, title, desired_outcome,
        success_criteria, required_capability_keys, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1,
       'Reduce coding-agent context consumption while preserving task quality',
       'Reduce coding-agent context consumption without sending source code to a new remote service.',
       $5, $6, 'active', $7, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      referenceNeedId,
      localWorkspaceId,
      referenceProjectContextId,
      referenceNeedStableId,
      ['Measure token reduction', 'Preserve task quality', 'Keep evaluation reversible'],
      ['context-output-optimization'],
      catalogSeedV1.observedAt,
    ],
  );
  const constraintRows = [
    ['no-remote-source-transfer', 'Source code must not be sent to a new remote service', 'block'],
    ['macos', 'macOS support required', 'block'],
    ['no-automatic-workspace-writes', 'No automatic workspace writes during evaluation', 'block'],
  ] as const;
  for (const [key, label, handling] of constraintRows) {
    await client.query(
      `INSERT INTO workspace.constraints
         (id, workspace_id, need_id, kind, constraint_key, label, operator,
          expected_value, unknown_handling)
       VALUES ($1, $2, $3, 'hard_gate', $4, $5, 'equals', '"pass"', $6)
       ON CONFLICT (need_id, constraint_key) DO NOTHING`,
      [
        id('constraint', `context-efficiency:${key}`),
        localWorkspaceId,
        referenceNeedId,
        key,
        label,
        handling,
      ],
    );
  }
  for (const [key, label, weight] of [
    ['measurable-token-reduction', 'Measurable token reduction', 0.45],
    ['reversible-setup', 'Reversible setup', 0.25],
    ['representative-evidence', 'Evidence from representative coding tasks', 0.3],
  ] as const) {
    await client.query(
      `INSERT INTO workspace.constraints
         (id, workspace_id, need_id, kind, constraint_key, label, operator,
          expected_value, unknown_handling, weight)
       VALUES ($1, $2, $3, 'preference', $4, $5, 'maximize', 'true',
               'allow_with_warning', $6)
       ON CONFLICT (need_id, constraint_key) DO NOTHING`,
      [
        id('constraint', `context-efficiency:${key}`),
        localWorkspaceId,
        referenceNeedId,
        key,
        label,
        weight,
      ],
    );
  }

  const candidateInputs: Array<{
    key: string;
    label: string;
    optionKind: 'provider' | 'status_quo';
    provider?: ImportedProvider;
  }> = [
    {
      key: 'context-mode',
      label: 'Context Mode bounded evaluation',
      optionKind: 'provider',
      provider: providers.get('context-mode'),
    },
    {
      key: 'github-agentic-workflows',
      label: 'GitHub Agentic Workflows',
      optionKind: 'provider',
      provider: providers.get('github-agentic-workflows'),
    },
    {
      key: 'status-quo',
      label: 'Current workflow / no change',
      optionKind: 'status_quo',
    },
  ];

  for (const input of candidateInputs) {
    if (input.optionKind === 'provider' && !input.provider) {
      throw new Error(`Reference provider ${input.key} was not imported.`);
    }
    const candidateId = id('candidate', `context-efficiency:${input.key}`);
    await client.query(
      `INSERT INTO workspace.candidates
         (id, workspace_id, need_id, option_kind, label, context_snapshot_hash,
          discovery_origin, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'curated_reference_scenario', $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        candidateId,
        localWorkspaceId,
        referenceNeedId,
        input.optionKind,
        input.label,
        snapshotHash,
        catalogSeedV1.observedAt,
      ],
    );
    if (input.provider) {
      await client.query(
        `INSERT INTO workspace.candidate_components
           (id, workspace_id, candidate_id, provider_id, provider_version_id, role)
         VALUES ($1, $2, $3, $4, $5, 'primary')
         ON CONFLICT (candidate_id, provider_id, role) DO NOTHING`,
        [
          id('candidate-component', `${candidateId}:${input.provider.providerId}`),
          localWorkspaceId,
          candidateId,
          input.provider.providerId,
          input.provider.versionId,
        ],
      );
    }

    const gateResults: GateResult[] = input.provider
      ? providerGateResults(input.provider)
      : [
          {
            constraintId: id('constraint', 'context-efficiency:no-remote-source-transfer'),
            label: 'Source code must not be sent to a new remote service',
            state: 'pass',
            unknownHandling: 'block',
            evidenceIds: [],
            explanation: 'No new service is introduced by the status quo.',
          },
          {
            constraintId: id('constraint', 'context-efficiency:macos'),
            label: 'macOS support required',
            state: 'pass',
            unknownHandling: 'block',
            evidenceIds: [],
            explanation: 'The current workflow already runs on the project environment.',
          },
          {
            constraintId: id('constraint', 'context-efficiency:no-automatic-workspace-writes'),
            label: 'No automatic workspace writes during evaluation',
            state: 'pass',
            unknownHandling: 'block',
            evidenceIds: [],
            explanation: 'No evaluation integration is introduced by the status quo.',
          },
        ];
    const gateEvaluation = evaluateHardGates(gateResults);
    const evidenceIds = input.provider?.evidenceIds ?? [];
    const preferenceResult =
      gateEvaluation.eligibility === 'eligible'
        ? calculateProjectFitV1(
            input.provider
              ? providerPreferences(input.provider)
              : [
                  {
                    key: 'measurable-token-reduction',
                    label: 'Measurable token reduction',
                    weight: 0.45,
                    raw: 10,
                    confidence: 0.9,
                    state: 'present',
                    reasons: ['The current workflow does not add a context-reduction mechanism.'],
                    evidenceIds: [],
                  },
                  {
                    key: 'reversible-setup',
                    label: 'Reversible setup',
                    weight: 0.25,
                    raw: 100,
                    confidence: 1,
                    state: 'present',
                    reasons: ['No setup change is required.'],
                    evidenceIds: [],
                  },
                  {
                    key: 'representative-evidence',
                    label: 'Evidence from representative coding tasks',
                    weight: 0.3,
                    raw: 55,
                    confidence: 0.6,
                    state: 'present',
                    reasons: ['The baseline still needs measured task evidence.'],
                    evidenceIds: [],
                  },
                ],
          )
        : null;
    const fitInputHash = hashCanonical({
      candidateId,
      needId: referenceNeedId,
      projectContextId: referenceProjectContextId,
      gateResults,
      preferenceResult,
      policyVersion: 'project-fit-v1',
    });
    const fitId = id('fit-assessment', fitInputHash);
    await client.query(
      `INSERT INTO workspace.fit_assessments
         (id, workspace_id, candidate_id, need_id, project_context_id, policy_version,
          eligibility, gate_results, preference_result, rationale, evidence_ids,
          input_hash, author_type, review_state, generated_at)
       VALUES ($1, $2, $3, $4, $5, 'project-fit-v1', $6, $7, $8, $9, $10,
               $11, 'rule', 'reviewed', $12)
       ON CONFLICT (candidate_id, policy_version, input_hash) DO NOTHING`,
      [
        fitId,
        localWorkspaceId,
        candidateId,
        referenceNeedId,
        referenceProjectContextId,
        gateEvaluation.eligibility,
        json(gateResults),
        preferenceResult ? json(preferenceResult) : null,
        gateEvaluation.reasons.length
          ? gateEvaluation.reasons
          : ['All hard gates pass for the recorded scope.'],
        evidenceIds,
        fitInputHash,
        catalogSeedV1.observedAt,
      ],
    );
    const outcome =
      gateEvaluation.eligibility === 'ineligible'
        ? 'avoid'
        : gateEvaluation.eligibility === 'unknown_blocked'
          ? 'no_decision'
          : input.optionKind === 'status_quo'
            ? 'defer'
            : 'consider';
    const recommendationHash = hashCanonical({
      candidateId,
      fitInputHash,
      outcome,
      policyVersion: 'recommendation-v1',
    });
    await client.query(
      `INSERT INTO workspace.recommendations
         (id, workspace_id, need_id, candidate_id, outcome, explanation, input_hash,
          policy_version, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'recommendation-v1', $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        id('recommendation', recommendationHash),
        localWorkspaceId,
        referenceNeedId,
        candidateId,
        outcome,
        gateEvaluation.eligibility === 'unknown_blocked'
          ? 'Resolve blocking compatibility unknowns before adoption; a human may record a bounded trial condition without granting execution authority.'
          : gateEvaluation.eligibility === 'ineligible'
            ? 'A hard constraint fails and cannot be averaged away.'
            : 'Retain as the current baseline while comparing measurable alternatives.',
        recommendationHash,
        catalogSeedV1.observedAt,
      ],
    );
  }
}

export interface SeedImportResult {
  manifestHash: string;
  counts: Record<string, number>;
}

export async function importSeed(connectionString?: string): Promise<SeedImportResult> {
  const audit = auditSeedManifest();
  if (!audit.valid) throw new Error(`Seed provenance audit failed: ${audit.errors.join('; ')}`);
  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taxonomyId = id(
      'taxonomy',
      `${catalogSeedV1.taxonomy.key}:${catalogSeedV1.taxonomy.version}`,
    );
    await client.query(
      `INSERT INTO catalog.domain_taxonomy_versions
         (id, taxonomy_key, version, status, created_at)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (taxonomy_key, version) DO NOTHING`,
      [
        taxonomyId,
        catalogSeedV1.taxonomy.key,
        catalogSeedV1.taxonomy.version,
        catalogSeedV1.observedAt,
      ],
    );
    const domainIds = new Map<string, string>();
    for (const domain of catalogSeedV1.taxonomy.domains) {
      domainIds.set(domain.key, id('domain', `${taxonomyId}:${domain.key}`));
    }
    for (const domain of catalogSeedV1.taxonomy.domains) {
      await client.query(
        `INSERT INTO catalog.domain_nodes
           (id, taxonomy_version_id, stable_key, label, definition, parent_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         ON CONFLICT (taxonomy_version_id, stable_key) DO UPDATE SET
           label = EXCLUDED.label, definition = EXCLUDED.definition,
           parent_id = EXCLUDED.parent_id`,
        [
          domainIds.get(domain.key),
          taxonomyId,
          domain.key,
          domain.label,
          domain.definition,
          domain.parentKey ? domainIds.get(domain.parentKey) : null,
        ],
      );
    }
    await client.query(
      `INSERT INTO catalog.score_policies
         (id, policy_key, version, policy_document, code_revision, created_at)
       VALUES ($1, 'consideration', $2, $3, 'prompt-02-v0', $4)
       ON CONFLICT (policy_key, version) DO NOTHING`,
      [
        scorePolicyId,
        considerationPolicyV1.version,
        json({ consideration: considerationPolicyV1, verification: verificationPolicyV1 }),
        catalogSeedV1.observedAt,
      ],
    );

    const importedProviders = new Map<string, ImportedProvider>();
    for (const provider of catalogSeedV1.providers) {
      importedProviders.set(provider.key, await importProvider(client, provider, domainIds));
    }
    await importReferenceWorkspace(client, importedProviders);
    await client.query(
      `INSERT INTO ops.audit_events
         (id, actor_type, action, object_type, object_id, correlation_id, after_hash,
          safe_metadata, created_at)
       VALUES ($1, 'system', 'seed.import', 'seed_manifest', $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        id('audit-event', catalogSeedV1.seedRevision),
        catalogSeedV1.seedRevision,
        catalogSeedV1.seedRevision,
        audit.manifestHash,
        json({ providerCount: audit.providerCount, claimCount: audit.claimCount }),
        catalogSeedV1.observedAt,
      ],
    );
    await client.query('COMMIT');

    const countsResult = await client.query<Record<string, string>>(`
      SELECT
        (SELECT count(*)::text FROM catalog.providers) AS providers,
        (SELECT count(*)::text FROM catalog.sources) AS sources,
        (SELECT count(*)::text FROM catalog.claims) AS claims,
        (SELECT count(*)::text FROM catalog.evidence_items) AS evidence_items,
        (SELECT count(*)::text FROM catalog.score_runs) AS score_runs,
        (SELECT count(*)::text FROM workspace.projects) AS projects,
        (SELECT count(*)::text FROM workspace.needs) AS needs,
        (SELECT count(*)::text FROM workspace.candidates) AS candidates
    `);
    const row = countsResult.rows[0]!;
    return {
      manifestHash: audit.manifestHash,
      counts: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// The receipt helper is referenced here to keep the seed build linked to the
// same immutable receipt schema without creating a seeded human decision.
void createDecisionReceipt;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await importSeed();
  process.stdout.write(`Seed is current: ${JSON.stringify(result)}\n`);
}
