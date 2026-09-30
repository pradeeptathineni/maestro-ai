import type { Pool } from 'pg';

interface CountRow {
  [key: string]: number;
}

const currentProjection = `
  SELECT DISTINCT ON (provider_id)
         id, provider_id, publication_state, indexed_at, expires_at
  FROM catalog.knowledge_projections
  ORDER BY provider_id, provider_revision DESC, indexed_at DESC, id DESC
`;

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

export async function getKnowledgeCoverageReport(
  pool: Pool,
  workspaceId: string,
): Promise<unknown> {
  const [states, domains, sourceClasses, depth, claims, health, discovery, queryGaps] =
    await Promise.all([
      pool.query<CountRow>(`
        WITH current_projection AS (${currentProjection})
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE publication_state = 'reviewed')::int AS reviewed,
               count(*) FILTER (WHERE publication_state = 'proposed')::int AS proposed,
               count(*) FILTER (WHERE publication_state = 'lead')::int AS lead,
               count(*) FILTER (WHERE publication_state = 'stale')::int AS stale,
               count(*) FILTER (WHERE publication_state = 'withdrawn')::int AS withdrawn
        FROM current_projection
      `),
      pool.query<{
        key: string;
        label: string;
        total: number;
        reviewed: number;
        proposed: number;
        stale: number;
      }>(`
        WITH current_projection AS (${currentProjection})
        SELECT dn.stable_key AS key, dn.label,
               count(DISTINCT cp.provider_id)::int AS total,
               count(DISTINCT cp.provider_id) FILTER (WHERE cp.publication_state = 'reviewed')::int AS reviewed,
               count(DISTINCT cp.provider_id) FILTER (WHERE cp.publication_state = 'proposed')::int AS proposed,
               count(DISTINCT cp.provider_id) FILTER (WHERE cp.publication_state = 'stale')::int AS stale
        FROM catalog.domain_nodes dn
        JOIN catalog.domain_memberships dm ON dm.domain_node_id = dn.id
        JOIN current_projection cp ON cp.provider_id = dm.provider_id
        GROUP BY dn.stable_key, dn.label
        ORDER BY total DESC, dn.label
      `),
      pool.query<{
        sourceType: string;
        knowledgeItems: number;
        sources: number;
        lastObservedAt: Date | null;
      }>(`
        WITH current_projection AS (${currentProjection})
        SELECT s.source_type AS "sourceType",
               count(DISTINCT cp.provider_id)::int AS "knowledgeItems",
               count(DISTINCT s.id)::int AS sources,
               max(so.observed_at) AS "lastObservedAt"
        FROM current_projection cp
        JOIN catalog.knowledge_projection_sources kps ON kps.projection_id = cp.id
        JOIN catalog.source_observations so ON so.id = kps.source_observation_id
        JOIN catalog.sources s ON s.id = so.source_id
        GROUP BY s.source_type
        ORDER BY "knowledgeItems" DESC, s.source_type
      `),
      pool.query<{ depth: string; items: number }>(`
        WITH current_projection AS (${currentProjection}),
        evidence_depth AS (
          SELECT cp.provider_id,
                 count(DISTINCT ei.id)::int AS evidence_count,
                 count(DISTINCT ei.source_observation_id)::int AS source_count,
                 bool_or(ei.independence IN ('independent', 'partially_independent')) AS has_independent,
                 bool_or(er.direction = 'contradicts') AS has_contradiction
          FROM current_projection cp
          LEFT JOIN catalog.provider_evidence_bindings peb ON peb.provider_id = cp.provider_id
          LEFT JOIN catalog.evidence_items ei ON ei.id = peb.evidence_item_id
          LEFT JOIN catalog.claims c ON c.provider_id = cp.provider_id
          LEFT JOIN catalog.evidence_relations er
            ON er.claim_id = c.id AND er.evidence_item_id = ei.id
          GROUP BY cp.provider_id
        ), classified AS (
          SELECT CASE
                   WHEN evidence_count = 0 THEN 'no_bound_evidence'
                   WHEN has_contradiction THEN 'conflicted'
                   WHEN has_independent AND source_count >= 2 THEN 'corroborated'
                   WHEN has_independent THEN 'partially_independent'
                   ELSE 'publisher_only'
                 END AS depth
          FROM evidence_depth
        )
        SELECT depth, count(*)::int AS items
        FROM classified GROUP BY depth ORDER BY items DESC, depth
      `),
      pool.query<CountRow>(`
        WITH current_projection AS (${currentProjection}), current_claims AS (
          SELECT c.id, c.workflow_state, c.valid_to, cp.publication_state,
                 EXISTS (
                   SELECT 1 FROM catalog.evidence_relations er WHERE er.claim_id = c.id
                 ) AS source_bound,
                 EXISTS (
                   SELECT 1 FROM catalog.evidence_relations er
                   JOIN catalog.evidence_items ei ON ei.id = er.evidence_item_id
                   WHERE er.claim_id = c.id AND ei.review_after IS NOT NULL AND ei.review_after <= now()
                 ) AS evidence_stale,
                 EXISTS (
                   SELECT 1 FROM catalog.evidence_relations er
                   JOIN catalog.evidence_items ei ON ei.id = er.evidence_item_id
                   WHERE er.claim_id = c.id AND ei.review_after > now()
                     AND ei.review_after <= now() + interval '30 days'
                 ) AS review_due_soon
          FROM catalog.claims c
          JOIN current_projection cp ON cp.provider_id = c.provider_id
          WHERE c.workflow_state NOT IN ('superseded', 'withdrawn')
        )
        SELECT count(*)::int AS total,
               count(*) FILTER (
                 WHERE publication_state = 'reviewed' AND source_bound
               )::int AS reviewed,
               count(*) FILTER (
                 WHERE publication_state = 'stale' OR evidence_stale OR valid_to <= now()
               )::int AS stale,
               count(*) FILTER (WHERE review_due_soon)::int AS "reviewDueSoon",
               count(*) FILTER (WHERE NOT source_bound)::int AS "withoutBoundEvidence"
        FROM current_claims
      `),
      pool.query<{
        adapterKey: string;
        lastSuccessfulAt: Date | null;
        lastFailedAt: Date | null;
        failures: number;
      }>(`
        SELECT config.adapter_key AS "adapterKey",
               max(event.checked_at) FILTER (
                 WHERE event.state IN ('healthy', 'unchanged', 'changed', 'partial')
               ) AS "lastSuccessfulAt",
               max(event.checked_at) FILTER (WHERE event.state = 'failed') AS "lastFailedAt",
               count(event.id) FILTER (WHERE event.state = 'failed')::int AS failures
        FROM ops.source_adapter_configs config
        LEFT JOIN ops.source_health_events event ON event.adapter_key = config.adapter_key
        GROUP BY config.adapter_key ORDER BY config.adapter_key
      `),
      pool.query<{
        operationsToday: number;
        exploreCallsToday: number;
        deepenCallsToday: number;
        successfulCallsToday: number;
        failedCallsToday: number;
        candidatesToday: number;
        exploreCandidatesToday: number;
        admittedToday: number;
        unjudgedCandidates: number;
      }>(
        `
        WITH today_operations AS (
          SELECT * FROM ops.discovery_operations
          WHERE workspace_id = $1 AND created_at >= current_date
        ), today_candidates AS (
          SELECT dc.*, operation.intent
          FROM ops.discovery_candidates dc
          JOIN today_operations operation ON operation.id = dc.operation_id
        )
        SELECT
          (SELECT count(*)::int FROM today_operations) AS "operationsToday",
          (SELECT COALESCE(sum(reserved_calls), 0)::int FROM today_operations WHERE intent = 'explore') AS "exploreCallsToday",
          (SELECT COALESCE(sum(reserved_calls), 0)::int FROM today_operations WHERE intent = 'deepen') AS "deepenCallsToday",
          (SELECT COALESCE(sum(consumed_calls), 0)::int FROM today_operations
           WHERE state IN ('complete', 'partial')) AS "successfulCallsToday",
          (SELECT count(*)::int FROM today_operations WHERE state = 'failed') AS "failedCallsToday",
          (SELECT count(*)::int FROM today_candidates) AS "candidatesToday",
          (SELECT count(*)::int FROM today_candidates WHERE intent = 'explore') AS "exploreCandidatesToday",
          (SELECT count(*)::int FROM ops.discovery_admissions admission
           JOIN ops.discovery_candidates candidate ON candidate.id = admission.discovery_candidate_id
           WHERE admission.workspace_id = $1 AND admission.created_at >= current_date) AS "admittedToday",
          (SELECT count(*)::int FROM ops.discovery_candidates
           WHERE workspace_id = $1 AND review_state = 'lead') AS "unjudgedCandidates"
      `,
        [workspaceId],
      ),
      pool.query<{
        sessions: number;
        emptySessions: number;
        outsideCoverageSessions: number;
        repeatedEmptyAreas: Array<{ capabilityGroup: string; count: number }>;
      }>(
        `
        WITH latest_results AS (
          SELECT DISTINCT ON (query_session_id) query_session_id, assessed_count
          FROM workspace.query_result_sets
          WHERE workspace_id = $1
          ORDER BY query_session_id, revision DESC
        ), sessions AS (
          SELECT qs.id, qs.normalized_intent, latest.assessed_count
          FROM workspace.query_sessions qs
          JOIN latest_results latest ON latest.query_session_id = qs.id
          WHERE qs.workspace_id = $1 AND qs.query_text <> '[deleted by user]'
        ), empty_areas AS (
          SELECT COALESCE(group_name, 'Unclassified') AS capability_group, count(*)::int AS count
          FROM sessions
          LEFT JOIN LATERAL jsonb_array_elements_text(
            COALESCE(sessions.normalized_intent->'capabilityGroups', '[]'::jsonb)
          ) groups(group_name) ON true
          WHERE sessions.assessed_count = 0
          GROUP BY COALESCE(group_name, 'Unclassified')
          HAVING count(*) >= 2
        )
        SELECT (SELECT count(*)::int FROM sessions) AS sessions,
               (SELECT count(*)::int FROM sessions WHERE assessed_count = 0) AS "emptySessions",
               (SELECT count(*)::int FROM sessions
                WHERE normalized_intent->>'coverageState' = 'outside_maintained_coverage') AS "outsideCoverageSessions",
               COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'capabilityGroup', capability_group, 'count', count
               ) ORDER BY count DESC, capability_group) FROM empty_areas), '[]'::jsonb) AS "repeatedEmptyAreas"
      `,
        [workspaceId],
      ),
    ]);

  const state = states.rows[0]!;
  const discoveryState = discovery.rows[0]!;
  const attemptedCalls = discoveryState.exploreCallsToday + discoveryState.deepenCallsToday;
  return {
    scope: {
      label: 'Tracked local corpus',
      statement:
        'Counts describe source-bound records in this Maestro instance, not a percentage of all AI knowledge.',
      generatedAt: new Date().toISOString(),
    },
    knowledge: state,
    domains: domains.rows,
    sourceClasses: sourceClasses.rows,
    depth: depth.rows,
    importantClaims: {
      definition: 'Current, non-withdrawn claims attached to an indexed knowledge projection.',
      ...claims.rows[0],
    },
    sourceHealth: health.rows,
    discovery: {
      ...discoveryState,
      allocationPolicy: {
        version: 'bounded-source-calls-v2',
        dailyExternalCallLimit: 50,
        perSearchCallLimitPerSource: 1,
      },
      actualExploreShare: ratio(discoveryState.exploreCallsToday, attemptedCalls),
      explorationYield: ratio(
        discoveryState.exploreCandidatesToday,
        discoveryState.exploreCallsToday,
      ),
      admissionYield: ratio(discoveryState.admittedToday, discoveryState.candidatesToday),
    },
    queryGaps: queryGaps.rows[0],
  };
}
