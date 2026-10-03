export const refreshCadencePolicyVersion = 'refresh-cadence-v1' as const;
export const sourceValuePolicyVersion = 'source-value-v1' as const;
export const legacyCorroborationPolicyVersion = 'corroboration-v1' as const;
export const corroborationPolicyVersion = 'corroboration-v2' as const;

export type WatchTargetKind = 'provider' | 'query' | 'concept' | 'entity';

export interface RefreshCadenceInput {
  targetKind: WatchTargetKind;
  entityClass?: string | null;
  documentType?: string | null;
  changeRate?: 'rapid' | 'normal' | 'slow' | 'unknown';
  reliability?: 'high' | 'medium' | 'low' | 'unknown';
}

export interface RefreshCadenceDecision {
  policyVersion: typeof refreshCadencePolicyVersion;
  cadenceHours: number;
  reason: string;
}

function normalizedKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_]+/g, '-');
}

/**
 * Selects a review interval from the kind of knowledge being watched. The
 * policy intentionally receives no query text or named product identity.
 */
export function deriveRefreshCadence(input: RefreshCadenceInput): RefreshCadenceDecision {
  const entityClass = normalizedKey(input.entityClass).replace(/^entity-class:/, '');
  const documentType = normalizedKey(input.documentType).replace(/^document-type:/, '');
  let cadenceHours =
    input.targetKind === 'query'
      ? 24
      : input.targetKind === 'concept'
        ? 168
        : entityClass === 'model' || entityClass === 'service'
          ? 24
          : entityClass === 'implementation'
            ? 72
            : entityClass === 'standard' || documentType === 'standard'
              ? 720
              : documentType === 'article'
                ? 72
                : documentType === 'research' || documentType === 'specification'
                  ? 336
                  : 168;

  if (input.changeRate === 'rapid') cadenceHours = Math.min(cadenceHours, 24);
  if (input.changeRate === 'slow') cadenceHours = Math.max(cadenceHours, 336);
  if (input.reliability === 'low') cadenceHours = Math.min(cadenceHours, 72);

  return {
    policyVersion: refreshCadencePolicyVersion,
    cadenceHours,
    reason: `The ${input.targetKind} target uses ${entityClass || documentType || 'general'} change characteristics; change-rate and source-reliability modifiers are ${input.changeRate ?? 'unknown'} and ${input.reliability ?? 'unknown'}.`,
  };
}

export type EvidenceRole = 'primary' | 'publisher' | 'independent' | 'community' | 'aggregator';

export interface CorroborationEvidence {
  sourceId: string;
  independenceGroup: string;
  role: EvidenceRole;
  direction: 'supports' | 'contradicts';
}

export interface CorroborationAssessment {
  policyVersion: typeof corroborationPolicyVersion;
  state: 'corroborated' | 'primary_only' | 'independent_only' | 'conflicted' | 'insufficient';
  primarySourceCount: number;
  independentSourceCount: number;
  communitySourceCount: number;
  reasons: string[];
}

/** Community and aggregator records may reveal attention but never count as
 * independent corroboration of efficacy, security, or quality. */
export function assessCorroboration(evidence: CorroborationEvidence[]): CorroborationAssessment {
  const supporting = evidence.filter((item) => item.direction === 'supports');
  const primaryGroups = new Set(
    supporting
      .filter((item) => item.role === 'primary' || item.role === 'publisher')
      .map((item) => item.independenceGroup),
  );
  const independentGroups = new Set(
    supporting
      .filter(
        (item) =>
          item.role === 'independent' && !primaryGroups.has(item.independenceGroup),
      )
      .map((item) => item.independenceGroup),
  );
  const communityGroups = new Set(
    supporting.filter((item) => item.role === 'community').map((item) => item.independenceGroup),
  );
  const conflicted = evidence.some((item) => item.direction === 'contradicts');
  const state = conflicted
    ? 'conflicted'
    : primaryGroups.size > 0 && independentGroups.size > 0
      ? 'corroborated'
      : primaryGroups.size > 0
        ? 'primary_only'
        : independentGroups.size > 0
          ? 'independent_only'
          : 'insufficient';
  const reasons = [
    `${primaryGroups.size} primary/publisher independence group(s) support the claim.`,
    `${independentGroups.size} independent corroborating group(s) support the claim.`,
  ];
  if (communityGroups.size) {
    reasons.push(
      `${communityGroups.size} community group(s) contribute attention or discovery evidence only.`,
    );
  }
  if (conflicted) reasons.push('At least one evidence item contradicts the claim.');
  return {
    policyVersion: corroborationPolicyVersion,
    state,
    primarySourceCount: primaryGroups.size,
    independentSourceCount: independentGroups.size,
    communitySourceCount: communityGroups.size,
    reasons,
  };
}

export interface SourceYieldObservation {
  adapterKey: string;
  attemptedCalls: number;
  successfulCalls: number;
  uniqueCandidates: number;
  admittedCandidates: number;
  corroboratedCandidates: number;
  durationMs: number;
  health: 'healthy' | 'partial' | 'failed' | 'unknown';
}

export interface SourceValue {
  adapterKey: string;
  value: number;
  reason: string;
}

/** Ranks already-authorized source routes by measured, bounded utility. It
 * never enables a source and never uses raw query text. */
export function rankSourcesByMeasuredValue(
  adapterKeys: string[],
  observations: SourceYieldObservation[],
): SourceValue[] {
  const requested = [...new Set(adapterKeys)];
  return requested
    .map((adapterKey) => {
      const rows = observations.filter((row) => row.adapterKey === adapterKey);
      const totals = rows.reduce(
        (sum, row) => ({
          attempted: sum.attempted + row.attemptedCalls,
          successful: sum.successful + row.successfulCalls,
          unique: sum.unique + row.uniqueCandidates,
          admitted: sum.admitted + row.admittedCandidates,
          corroborated: sum.corroborated + row.corroboratedCandidates,
          duration: sum.duration + row.durationMs,
          failed: sum.failed + (row.health === 'failed' ? 1 : 0),
        }),
        {
          attempted: 0,
          successful: 0,
          unique: 0,
          admitted: 0,
          corroborated: 0,
          duration: 0,
          failed: 0,
        },
      );
      if (!totals.attempted) {
        return {
          adapterKey,
          value: 0,
          reason: 'No measured retrieval window is available; retain declared route order.',
        };
      }
      const successRate = totals.successful / totals.attempted;
      const uniqueYield = Math.min(1, totals.unique / Math.max(1, totals.attempted * 10));
      const admissionYield = Math.min(1, totals.admitted / Math.max(1, totals.unique));
      const corroborationYield = Math.min(1, totals.corroborated / Math.max(1, totals.unique));
      const failureRate = totals.failed / Math.max(1, rows.length);
      const latencyPenalty = Math.min(0.15, totals.duration / totals.attempted / 60_000);
      const value = Math.max(
        0,
        Math.min(
          1,
          0.3 * successRate +
            0.25 * uniqueYield +
            0.2 * admissionYield +
            0.25 * corroborationYield -
            0.2 * failureRate -
            latencyPenalty,
        ),
      );
      return {
        adapterKey,
        value: Number(value.toFixed(6)),
        reason: `${totals.attempted} measured call(s): ${totals.unique} unique lead(s), ${totals.admitted} admitted, ${totals.corroborated} corroborated.`,
      };
    })
    .sort(
      (left, right) =>
        right.value - left.value ||
        requested.indexOf(left.adapterKey) - requested.indexOf(right.adapterKey),
    );
}
