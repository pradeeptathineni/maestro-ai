import type { Pool, PoolClient } from 'pg';
import type {
  CandidateBody,
  DecisionBody,
  NeedBody,
  ReviseNeedBody,
} from '../../contracts/src/index.js';
import {
  createDecisionReceipt,
  evaluateHardGates,
  hashCanonical,
  newOpaqueId,
  replayDecisionReceipt,
  type DecisionReceipt,
  type GateResult,
} from '../../domain/src/index.js';
import { calculateProjectFitV1, type PreferenceInput } from '../../scoring/src/index.js';
import { ConflictError, DomainValidationError, NotFoundError } from './errors.js';

type JsonRow = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function inTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjects(pool: Pool, workspaceId: string): Promise<JsonRow[]> {
  const result = await pool.query<JsonRow>(
    `SELECT p.id, p.name, p.lifecycle_state AS "lifecycleState", p.created_at AS "createdAt",
            pc.id AS "currentContextId", pc.revision AS "contextRevision",
            pc.snapshot_hash AS "snapshotHash", pc.context_document AS context
     FROM workspace.projects p
     LEFT JOIN LATERAL (
       SELECT * FROM workspace.project_contexts current
       WHERE current.project_id = p.id AND current.workspace_id = p.workspace_id
       ORDER BY current.revision DESC LIMIT 1
     ) pc ON true
     WHERE p.workspace_id = $1 ORDER BY p.name`,
    [workspaceId],
  );
  return result.rows;
}

export async function listNeeds(pool: Pool, workspaceId: string): Promise<JsonRow[]> {
  const result = await pool.query<JsonRow>(
    `SELECT n.id, n.stable_id AS "stableId", n.revision, n.title,
            n.desired_outcome AS "desiredOutcome", n.success_criteria AS "successCriteria",
            n.required_capability_keys AS "requiredCapabilityKeys", n.state,
            n.created_at AS "createdAt", p.id AS "projectId", p.name AS "projectName",
            pc.id AS "projectContextId", pc.snapshot_hash AS "projectSnapshotHash",
            count(c.id)::int AS "candidateCount",
            count(c.id) FILTER (WHERE fa.eligibility = 'eligible')::int AS "eligibleCount",
            count(c.id) FILTER (WHERE fa.eligibility = 'unknown_blocked')::int AS "blockedCount"
     FROM workspace.needs n
     JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
     JOIN workspace.projects p ON p.id = pc.project_id
     LEFT JOIN workspace.candidates c ON c.need_id = n.id AND c.workspace_id = n.workspace_id
     LEFT JOIN LATERAL (
       SELECT eligibility FROM workspace.fit_assessments latest
       WHERE latest.candidate_id = c.id AND latest.workspace_id = c.workspace_id
       ORDER BY generated_at DESC LIMIT 1
     ) fa ON true
     WHERE n.workspace_id = $1
       AND NOT EXISTS (SELECT 1 FROM workspace.needs newer WHERE newer.supersedes_id = n.id)
     GROUP BY n.id, p.id, pc.id ORDER BY n.created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function getNeedComparison(
  pool: Pool,
  workspaceId: string,
  needId: string,
): Promise<JsonRow | null> {
  const needResult = await pool.query<JsonRow>(
    `SELECT n.id, n.stable_id AS "stableId", n.revision, n.title,
            n.desired_outcome AS "desiredOutcome", n.success_criteria AS "successCriteria",
            n.required_capability_keys AS "requiredCapabilityKeys", n.state,
            p.id AS "projectId", p.name AS "projectName",
            pc.id AS "projectContextId", pc.revision AS "projectContextRevision",
            pc.snapshot_hash AS "projectSnapshotHash", pc.context_document AS "projectContext"
     FROM workspace.needs n
     JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
     JOIN workspace.projects p ON p.id = pc.project_id
     WHERE n.id = $1 AND n.workspace_id = $2`,
    [needId, workspaceId],
  );
  if (!needResult.rowCount) return null;
  const [constraintResult, candidateResult, decisionResult] = await Promise.all([
    pool.query<JsonRow>(
      `SELECT id, kind, constraint_key AS key, label, operator, expected_value AS "expectedValue",
              unknown_handling AS "unknownHandling", weight::float8
       FROM workspace.constraints WHERE need_id = $1 AND workspace_id = $2
       ORDER BY kind, constraint_key`,
      [needId, workspaceId],
    ),
    pool.query<JsonRow>(
      `SELECT c.id, c.option_kind AS "optionKind", c.label, c.discovery_origin AS "discoveryOrigin",
              c.context_snapshot_hash AS "contextSnapshotHash", c.created_at AS "createdAt",
              p.id AS "providerId", p.canonical_name AS "providerName", p.kind AS "providerKind",
              pv.upstream_version AS "providerVersion", pc.role AS "componentRole",
              sr.id AS "scoreRunId", sr.lower_bound::float8 AS "considerationLowerBound",
              sr.band AS "considerationBand", sr.uncertainty::float8 AS "considerationUncertainty",
              sr.evidence_coverage::float8 AS "evidenceCoverage",
              fa.id AS "fitAssessmentId", fa.eligibility,
              fa.gate_results AS "gateResults", fa.preference_result AS "preferenceResult",
              fa.rationale AS "fitRationale", fa.evidence_ids AS "fitEvidenceIds",
              fa.policy_version AS "fitPolicyVersion", fa.input_hash AS "fitInputHash",
              r.outcome AS "recommendationOutcome", r.explanation AS "recommendationExplanation",
              va.priority AS "verificationPriority", va.next_plan AS "nextVerification"
       FROM workspace.candidates c
       LEFT JOIN workspace.candidate_components pc ON pc.candidate_id = c.id AND pc.role = 'primary'
       LEFT JOIN catalog.providers p ON p.id = pc.provider_id
       LEFT JOIN catalog.provider_versions pv ON pv.id = pc.provider_version_id
       LEFT JOIN LATERAL (
         SELECT current_score.* FROM catalog.score_runs current_score
         WHERE current_score.provider_id = p.id
         ORDER BY current_score.generated_at DESC, current_score.id DESC LIMIT 1
       ) sr ON true
       LEFT JOIN LATERAL (
         SELECT latest_fit.* FROM workspace.fit_assessments latest_fit
         WHERE latest_fit.candidate_id = c.id AND latest_fit.workspace_id = c.workspace_id
         ORDER BY latest_fit.generated_at DESC, latest_fit.id DESC LIMIT 1
       ) fa ON true
       LEFT JOIN LATERAL (
         SELECT latest_rec.* FROM workspace.recommendations latest_rec
         WHERE latest_rec.candidate_id = c.id AND latest_rec.workspace_id = c.workspace_id
         ORDER BY latest_rec.generated_at DESC, latest_rec.id DESC LIMIT 1
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT latest_ver.* FROM catalog.verification_assessments latest_ver
         WHERE latest_ver.provider_id = p.id
         ORDER BY latest_ver.generated_at DESC, latest_ver.id DESC LIMIT 1
       ) va ON true
       WHERE c.need_id = $1 AND c.workspace_id = $2
       ORDER BY
         CASE fa.eligibility WHEN 'eligible' THEN 0 WHEN 'unknown_blocked' THEN 1 ELSE 2 END,
         (fa.preference_result->>'lowerBound')::numeric DESC NULLS LAST,
         sr.lower_bound DESC NULLS LAST,
         c.label`,
      [needId, workspaceId],
    ),
    pool.query<JsonRow>(
      `SELECT id, outcome, selected_candidate_id AS "selectedCandidateId", rationale, conditions,
              input_hash AS "inputHash", decided_at AS "decidedAt"
       FROM workspace.decisions WHERE need_id = $1 AND workspace_id = $2
       ORDER BY decided_at DESC`,
      [needId, workspaceId],
    ),
  ]);
  return {
    ...needResult.rows[0],
    constraints: constraintResult.rows,
    candidates: candidateResult.rows,
    decisions: decisionResult.rows,
  };
}

async function insertConstraints(
  client: PoolClient,
  workspaceId: string,
  needId: string,
  constraints: NeedBody['constraints'],
): Promise<void> {
  const seen = new Set<string>();
  for (const constraint of constraints) {
    if (seen.has(constraint.key))
      throw new DomainValidationError(`Duplicate constraint ${constraint.key}.`);
    seen.add(constraint.key);
    if (constraint.kind === 'preference' && constraint.weight === undefined) {
      throw new DomainValidationError(`Preference ${constraint.key} requires a weight.`);
    }
    await client.query(
      `INSERT INTO workspace.constraints
         (id, workspace_id, need_id, kind, constraint_key, label, operator,
          expected_value, unknown_handling, weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newOpaqueId(),
        workspaceId,
        needId,
        constraint.kind,
        constraint.key,
        constraint.label,
        constraint.kind === 'hard_gate' ? 'equals' : 'maximize',
        json(constraint.kind === 'hard_gate' ? 'pass' : true),
        constraint.unknownHandling,
        constraint.weight ?? null,
      ],
    );
  }
}

export async function createNeed(
  pool: Pool,
  workspaceId: string,
  input: NeedBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const context = await client.query<{ id: string }>(
      `SELECT id FROM workspace.project_contexts
       WHERE project_id = $1 AND workspace_id = $2 ORDER BY revision DESC LIMIT 1`,
      [input.projectId, workspaceId],
    );
    if (!context.rowCount) throw new NotFoundError('Project or project context not found.');
    const stableId = newOpaqueId();
    const needId = newOpaqueId();
    const created = await client.query<JsonRow>(
      `INSERT INTO workspace.needs
         (id, workspace_id, project_context_id, stable_id, revision, title, desired_outcome,
          success_criteria, required_capability_keys, state)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 'active')
       RETURNING id, stable_id AS "stableId", revision, title`,
      [
        needId,
        workspaceId,
        context.rows[0]!.id,
        stableId,
        input.title,
        input.desiredOutcome,
        input.successCriteria,
        input.requiredCapabilityKeys,
      ],
    );
    await insertConstraints(client, workspaceId, needId, input.constraints);
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, object_revision,
          correlation_id, after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'need.create', 'need', $3, 1, $4, $5, $6)`,
      [
        newOpaqueId(),
        workspaceId,
        needId,
        newOpaqueId(),
        hashCanonical(input),
        json({ constraintCount: input.constraints.length }),
      ],
    );
    return created.rows[0];
  });
}

export async function reviseNeed(
  pool: Pool,
  workspaceId: string,
  needId: string,
  input: ReviseNeedBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const current = await client.query<{
      stableId: string;
      revision: number;
      projectContextId: string;
      projectId: string;
    }>(
      `SELECT n.stable_id AS "stableId", n.revision,
              n.project_context_id AS "projectContextId", pc.project_id AS "projectId"
       FROM workspace.needs n
       JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
       WHERE n.id = $1 AND n.workspace_id = $2`,
      [needId, workspaceId],
    );
    if (!current.rowCount) throw new NotFoundError('Need not found.');
    const prior = current.rows[0]!;
    if (prior.revision !== input.expectedRevision) {
      throw new ConflictError(
        `Expected revision ${input.expectedRevision}, found ${prior.revision}.`,
      );
    }
    if (prior.projectId !== input.projectId) {
      throw new DomainValidationError('A need revision cannot change its stable project identity.');
    }
    const latest = await client.query<{ revision: number }>(
      `SELECT revision FROM workspace.needs
       WHERE stable_id = $1 AND workspace_id = $2 ORDER BY revision DESC LIMIT 1`,
      [prior.stableId, workspaceId],
    );
    if (latest.rows[0]!.revision !== prior.revision) {
      throw new ConflictError('A newer need revision already exists.');
    }
    const nextId = newOpaqueId();
    const nextRevision = prior.revision + 1;
    const created = await client.query<JsonRow>(
      `INSERT INTO workspace.needs
         (id, workspace_id, project_context_id, stable_id, revision, title, desired_outcome,
          success_criteria, required_capability_keys, state, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
       RETURNING id, stable_id AS "stableId", revision, title`,
      [
        nextId,
        workspaceId,
        prior.projectContextId,
        prior.stableId,
        nextRevision,
        input.title,
        input.desiredOutcome,
        input.successCriteria,
        input.requiredCapabilityKeys,
        needId,
      ],
    );
    await insertConstraints(client, workspaceId, nextId, input.constraints);
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, object_revision,
          correlation_id, before_hash, after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'need.revise', 'need', $3, $4, $5, $6, $7, $8)`,
      [
        newOpaqueId(),
        workspaceId,
        nextId,
        nextRevision,
        newOpaqueId(),
        hashCanonical({ needId, revision: prior.revision }),
        hashCanonical(input),
        json({ supersedesId: needId }),
      ],
    );
    return created.rows[0];
  });
}

const compatibilityMap: Record<string, string> = {
  'no-remote-source-transfer': 'noRemoteSourceTransfer',
  macos: 'macos',
  'no-automatic-workspace-writes': 'noAutomaticWorkspaceWrites',
};

async function assessCandidate(
  client: PoolClient,
  workspaceId: string,
  needId: string,
  candidateId: string,
  optionKind: CandidateBody['optionKind'],
  providerId?: string,
): Promise<void> {
  const need = await client.query<{ projectContextId: string }>(
    `SELECT project_context_id AS "projectContextId" FROM workspace.needs
     WHERE id = $1 AND workspace_id = $2`,
    [needId, workspaceId],
  );
  const constraints = await client.query<{
    id: string;
    kind: 'hard_gate' | 'preference';
    key: string;
    label: string;
    unknownHandling: GateResult['unknownHandling'];
    weight: number | null;
  }>(
    `SELECT id, kind, constraint_key AS key, label,
            unknown_handling AS "unknownHandling", weight::float8
     FROM workspace.constraints WHERE need_id = $1 AND workspace_id = $2`,
    [needId, workspaceId],
  );
  const compatibility = providerId
    ? await client.query<{
        key: string;
        state: GateResult['state'];
        value: unknown;
        explanation: string;
        evidenceIds: string[];
      }>(
        `SELECT compatibility_key AS key, state, value, explanation,
                evidence_ids AS "evidenceIds"
         FROM catalog.provider_compatibility WHERE provider_id = $1`,
        [providerId],
      )
    : { rows: [] };
  const compatibilityByKey = new Map(compatibility.rows.map((row) => [row.key, row]));
  const gates: GateResult[] = constraints.rows
    .filter((constraint) => constraint.kind === 'hard_gate')
    .map((constraint) => {
      if (optionKind !== 'provider') {
        return {
          constraintId: constraint.id,
          label: constraint.label,
          state: 'unknown' as const,
          unknownHandling: constraint.unknownHandling,
          evidenceIds: [],
          explanation: `No reviewed evidence establishes how this ${optionKind} option satisfies the gate.`,
        };
      }
      const fact = compatibilityByKey.get(compatibilityMap[constraint.key] ?? constraint.key);
      return {
        constraintId: constraint.id,
        label: constraint.label,
        state: fact?.state ?? 'unknown',
        unknownHandling: constraint.unknownHandling,
        evidenceIds: fact?.evidenceIds ?? [],
        explanation: fact?.explanation ?? 'No reviewed compatibility evidence addresses this gate.',
      };
    });
  const gateEvaluation = evaluateHardGates(gates);
  const evidenceIds = [...new Set(gates.flatMap((gate) => gate.evidenceIds))];
  let preferenceResult: ReturnType<typeof calculateProjectFitV1> | null = null;
  if (gateEvaluation.eligibility === 'eligible') {
    const preferences: PreferenceInput[] = constraints.rows
      .filter((constraint) => constraint.kind === 'preference')
      .map((constraint) => {
        const key =
          constraint.key === 'measurable-token-reduction'
            ? 'contextReduction'
            : constraint.key === 'reversible-setup'
              ? 'setupReversibility'
              : '';
        const fact = key ? compatibilityByKey.get(key) : undefined;
        const stringValue = typeof fact?.value === 'string' ? fact.value : undefined;
        const raw =
          optionKind !== 'provider'
            ? constraint.key === 'reversible-setup'
              ? 100
              : constraint.key === 'measurable-token-reduction'
                ? 10
                : 50
            : stringValue === 'yes' || stringValue === 'strong'
              ? 90
              : stringValue === 'no'
                ? 10
                : stringValue === 'mixed'
                  ? 55
                  : null;
        return {
          key: constraint.key,
          label: constraint.label,
          weight: constraint.weight ?? 0,
          raw,
          confidence: raw === null ? 0 : optionKind === 'provider' ? 0.65 : 0.8,
          state: raw === null ? 'missing' : 'present',
          reasons: [fact?.explanation ?? 'Deterministic baseline assessment.'],
          evidenceIds: fact?.evidenceIds ?? [],
        };
      });
    preferenceResult = calculateProjectFitV1(preferences);
  }
  const inputHash = hashCanonical({
    candidateId,
    needId,
    projectContextId: need.rows[0]!.projectContextId,
    gates,
    preferenceResult,
    policyVersion: 'project-fit-v1',
  });
  await client.query(
    `INSERT INTO workspace.fit_assessments
       (id, workspace_id, candidate_id, need_id, project_context_id, policy_version,
        eligibility, gate_results, preference_result, rationale, evidence_ids,
        input_hash, author_type, review_state, generated_at)
     VALUES ($1, $2, $3, $4, $5, 'project-fit-v1', $6, $7, $8, $9, $10,
             $11, 'rule', 'reviewed', now())`,
    [
      newOpaqueId(),
      workspaceId,
      candidateId,
      needId,
      need.rows[0]!.projectContextId,
      gateEvaluation.eligibility,
      json(gates),
      preferenceResult ? json(preferenceResult) : null,
      gateEvaluation.reasons.length ? gateEvaluation.reasons : ['All hard gates pass.'],
      evidenceIds,
      inputHash,
    ],
  );
  const outcome =
    gateEvaluation.eligibility === 'ineligible'
      ? 'avoid'
      : gateEvaluation.eligibility === 'unknown_blocked'
        ? 'no_decision'
        : optionKind === 'status_quo' || optionKind === 'defer'
          ? 'defer'
          : 'consider';
  const recommendationHash = hashCanonical({ candidateId, inputHash, outcome });
  await client.query(
    `INSERT INTO workspace.recommendations
       (id, workspace_id, need_id, candidate_id, outcome, explanation, input_hash,
        policy_version, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'recommendation-v1', now())`,
    [
      newOpaqueId(),
      workspaceId,
      needId,
      candidateId,
      outcome,
      gateEvaluation.reasons.join(' ') || 'Candidate is eligible for preference comparison.',
      recommendationHash,
    ],
  );
  await client.query(
    `INSERT INTO ops.audit_events
       (id, workspace_id, actor_type, action, object_type, object_id, correlation_id,
        after_hash, safe_metadata)
     VALUES ($1, $2, 'system', 'policy.run', 'fit_assessment', $3, $4, $5, $6)`,
    [
      newOpaqueId(),
      workspaceId,
      candidateId,
      newOpaqueId(),
      inputHash,
      json({ policyVersion: 'project-fit-v1', eligibility: gateEvaluation.eligibility, outcome }),
    ],
  );
}

export async function addCandidate(
  pool: Pool,
  workspaceId: string,
  needId: string,
  input: CandidateBody,
): Promise<unknown> {
  if (input.optionKind === 'provider' && !input.providerId) {
    throw new DomainValidationError('Provider candidates require providerId.');
  }
  if (input.optionKind !== 'provider' && input.providerId) {
    throw new DomainValidationError(`${input.optionKind} candidates cannot fabricate a provider.`);
  }
  return inTransaction(pool, async (client) => {
    const need = await client.query<{ snapshotHash: string }>(
      `SELECT pc.snapshot_hash AS "snapshotHash"
       FROM workspace.needs n JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
       WHERE n.id = $1 AND n.workspace_id = $2`,
      [needId, workspaceId],
    );
    if (!need.rowCount) throw new NotFoundError('Need not found.');
    if (input.providerId) {
      const provider = await client.query('SELECT id FROM catalog.providers WHERE id = $1', [
        input.providerId,
      ]);
      if (!provider.rowCount) throw new NotFoundError('Provider not found.');
    }
    const candidateId = newOpaqueId();
    const created = await client.query<JsonRow>(
      `INSERT INTO workspace.candidates
         (id, workspace_id, need_id, option_kind, label, context_snapshot_hash,
          discovery_origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'human')
       RETURNING id, option_kind AS "optionKind", label`,
      [candidateId, workspaceId, needId, input.optionKind, input.label, need.rows[0]!.snapshotHash],
    );
    if (input.providerId) {
      const version = await client.query<{ id: string }>(
        `SELECT id FROM catalog.provider_versions WHERE provider_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [input.providerId],
      );
      await client.query(
        `INSERT INTO workspace.candidate_components
           (id, workspace_id, candidate_id, provider_id, provider_version_id, role)
         VALUES ($1, $2, $3, $4, $5, 'primary')`,
        [newOpaqueId(), workspaceId, candidateId, input.providerId, version.rows[0]?.id ?? null],
      );
    }
    await assessCandidate(
      client,
      workspaceId,
      needId,
      candidateId,
      input.optionKind,
      input.providerId,
    );
    return created.rows[0];
  });
}

export async function recordDecision(
  pool: Pool,
  workspaceId: string,
  needId: string,
  input: DecisionBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const need = await client.query<{
      revision: number;
      projectId: string;
      projectContextId: string;
      contextRevision: number;
      snapshotHash: string;
    }>(
      `SELECT n.revision, pc.project_id AS "projectId", pc.id AS "projectContextId",
              pc.revision AS "contextRevision", pc.snapshot_hash AS "snapshotHash"
       FROM workspace.needs n
       JOIN workspace.project_contexts pc ON pc.id = n.project_context_id
       WHERE n.id = $1 AND n.workspace_id = $2`,
      [needId, workspaceId],
    );
    if (!need.rowCount) throw new NotFoundError('Need not found.');
    const candidates = await client.query<{ id: string }>(
      `SELECT id FROM workspace.candidates WHERE need_id = $1 AND workspace_id = $2 ORDER BY id`,
      [needId, workspaceId],
    );
    if (input.outcome !== 'no_decision' && !input.selectedCandidateId) {
      throw new DomainValidationError('A selected candidate is required for this outcome.');
    }
    if (
      input.selectedCandidateId &&
      !candidates.rows.some((candidate) => candidate.id === input.selectedCandidateId)
    ) {
      throw new DomainValidationError('Selected candidate is outside this need.');
    }
    const scores = await client.query<{ id: string; evidenceIds: string[]; version: string }>(
      `SELECT DISTINCT sr.id, sr.evidence_ids AS "evidenceIds", sp.version
       FROM workspace.candidates c
       JOIN workspace.candidate_components cc ON cc.candidate_id = c.id
       JOIN LATERAL (
         SELECT current.* FROM catalog.score_runs current
         WHERE current.provider_id = cc.provider_id
         ORDER BY current.generated_at DESC, current.id DESC LIMIT 1
       ) sr ON true
       JOIN catalog.score_policies sp ON sp.id = sr.policy_id
       WHERE c.need_id = $1 AND c.workspace_id = $2
       ORDER BY sr.id`,
      [needId, workspaceId],
    );
    const fits = await client.query<{
      id: string;
      evidenceIds: string[];
      policyVersion: string;
    }>(
      `SELECT DISTINCT ON (candidate_id) id, evidence_ids AS "evidenceIds",
              policy_version AS "policyVersion"
       FROM workspace.fit_assessments
       WHERE need_id = $1 AND workspace_id = $2
       ORDER BY candidate_id, generated_at DESC, id DESC`,
      [needId, workspaceId],
    );
    const decidedAt = new Date().toISOString();
    const needRow = need.rows[0]!;
    const receipt = createDecisionReceipt({
      receiptVersion: 'decision-receipt-v1',
      workspaceId,
      project: {
        projectId: needRow.projectId,
        projectContextId: needRow.projectContextId,
        revision: needRow.contextRevision,
        snapshotHash: needRow.snapshotHash,
      },
      needId,
      needRevision: needRow.revision,
      candidateIds: candidates.rows.map((candidate) => candidate.id),
      selectedCandidateId: input.selectedCandidateId,
      scoreRunIds: scores.rows.map((score) => score.id),
      fitAssessmentIds: fits.rows.map((fit) => fit.id),
      evidenceIds: [
        ...new Set([
          ...scores.rows.flatMap((score) => score.evidenceIds),
          ...fits.rows.flatMap((fit) => fit.evidenceIds),
        ]),
      ],
      policyVersions: [
        ...new Set([
          ...scores.rows.map((score) => score.version),
          ...fits.rows.map((fit) => fit.policyVersion),
          'decision-receipt-v1',
        ]),
      ],
      outcome: input.outcome,
      rationale: input.rationale,
      conditions: input.conditions,
      decidedAt,
    });
    const decisionId = newOpaqueId();
    const decision = await client.query<JsonRow>(
      `INSERT INTO workspace.decisions
         (id, workspace_id, need_id, project_context_id, selected_candidate_id, outcome,
          rationale, conditions, receipt, input_hash, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, outcome, selected_candidate_id AS "selectedCandidateId", rationale,
                 conditions, receipt, input_hash AS "inputHash", decided_at AS "decidedAt"`,
      [
        decisionId,
        workspaceId,
        needId,
        needRow.projectContextId,
        input.selectedCandidateId ?? null,
        input.outcome,
        input.rationale,
        input.conditions,
        json(receipt),
        receipt.inputHash,
        decidedAt,
      ],
    );
    await client.query(
      `INSERT INTO ops.audit_events
         (id, workspace_id, actor_type, action, object_type, object_id, correlation_id,
          after_hash, safe_metadata)
       VALUES ($1, $2, 'human', 'decision.record', 'decision', $3, $4, $5, $6)`,
      [
        newOpaqueId(),
        workspaceId,
        decisionId,
        newOpaqueId(),
        receipt.inputHash,
        json({ outcome: input.outcome, conditionCount: input.conditions.length }),
      ],
    );
    return decision.rows[0];
  });
}

export async function getDecision(
  pool: Pool,
  workspaceId: string,
  decisionId: string,
): Promise<JsonRow | null> {
  const result = await pool.query<JsonRow>(
    `SELECT d.id, d.outcome, d.selected_candidate_id AS "selectedCandidateId", d.rationale,
            d.conditions, d.receipt, d.input_hash AS "inputHash", d.decided_at AS "decidedAt",
            n.title AS "needTitle", p.name AS "projectName", c.label AS "selectedCandidateLabel"
     FROM workspace.decisions d
     JOIN workspace.needs n ON n.id = d.need_id
     JOIN workspace.project_contexts pc ON pc.id = d.project_context_id
     JOIN workspace.projects p ON p.id = pc.project_id
     LEFT JOIN workspace.candidates c ON c.id = d.selected_candidate_id
     WHERE d.id = $1 AND d.workspace_id = $2`,
    [decisionId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const receipt = row.receipt as DecisionReceipt;
  return {
    ...row,
    receiptVerified: replayDecisionReceipt(receipt) && row.inputHash === receipt.inputHash,
  };
}
