import type { PoolClient } from 'pg';
import { stableUuid } from '../../domain/src/index.js';

const namespace = 'phase08-concept-label-v2';

interface ConceptVocabularyEntry {
  conceptStableKey: string;
  labels: string[];
  relatedConceptStableKeys?: string[];
}

// Alternate labels describe established ecosystem vocabulary. They are taxonomy data, not query
// routes or answer maps; the interpreter applies the same matching rules to every entry.
const conceptVocabularyV1: ConceptVocabularyEntry[] = [
  {
    conceptStableKey: 'ai-development-tools',
    labels: ['AI developer tools', 'AI development tools', 'AI software tools'],
  },
  {
    conceptStableKey: 'capability:agent-tool-integration-platform',
    labels: [
      'Agent integrations',
      'Assistant service connectors',
      'Application integrations',
      'External service integrations',
      'Managed auth',
      'Managed authentication',
      'Managed authorization',
      'Managed OAuth',
      'OAuth integrations',
    ],
  },
  {
    conceptStableKey: 'capability:bounded-agent-delegation',
    labels: ['Multi-agent delegation', 'Parallel specialist agents', 'Specialist task delegation'],
    relatedConceptStableKeys: ['capability:agent-development-methodology'],
  },
  {
    conceptStableKey: 'capability:coding-agent-usage-observability',
    labels: ['Agent token consumption', 'Coding assistant token usage', 'Model usage attribution'],
  },
  {
    conceptStableKey: 'capability:agent-workflow-evaluation',
    labels: ['Agent benchmark evidence', 'Benchmark evidence harness', 'Workflow evidence harness'],
  },
  {
    conceptStableKey: 'capability:model-output-evaluation',
    labels: [
      'AI evaluation harness',
      'Model behavior testing',
      'Prompt evaluation',
      'Repeatable model assertions',
    ],
    relatedConceptStableKeys: ['capability:agent-workflow-evaluation'],
  },
  {
    conceptStableKey: 'capability:multi-model-gateway',
    labels: ['LLM API', 'LLM gateway', 'Model API gateway', 'Multi-provider gateway'],
  },
  {
    conceptStableKey: 'capability:tool-context-interoperability',
    labels: ['Assistant tool protocol', 'Open tool protocol', 'Tool interoperability protocol'],
  },
  {
    conceptStableKey: 'capability:metasearch-discovery',
    labels: ['Federated web search', 'Metasearch API', 'Self-hosted metasearch'],
  },
  {
    conceptStableKey: 'capability:writing-quality-guidance',
    labels: [
      'AI generated prose editing',
      'AI writing style',
      'Machine assisted writing',
      'Machine written prose',
      'Natural language editing',
      'Prose style editing',
      'Writing style guidance',
    ],
    relatedConceptStableKeys: [
      'capability:agent-output-brevity',
      'capability:loss-aware-response-brevity',
    ],
  },
  {
    conceptStableKey: 'capability:repository-agentic-workflows',
    labels: ['Coding agent workflows', 'Repository automation'],
    relatedConceptStableKeys: [
      'capability:agent-development-methodology',
      'capability:agent-execution-control',
    ],
  },
  {
    conceptStableKey: 'capability:open-weight-ai-model-family',
    labels: ['Open weight model', 'Open weights'],
  },
  {
    conceptStableKey: 'capability:model-provider-integration',
    labels: [
      'Model API integration',
      'Schema checked model output',
      'Structured model output',
      'Typed model provider adapter',
      'Provider SDK',
    ],
    relatedConceptStableKeys: ['capability:agent-runtime-orchestration'],
  },
  {
    conceptStableKey: 'capability:local-model-runtime',
    labels: [
      'Local inference API',
      'Local inference runtime',
      'Local model inference',
      'Offline model runtime',
    ],
    relatedConceptStableKeys: ['capability:model-provider-integration'],
  },
  {
    conceptStableKey: 'capability:repository-code-intelligence',
    labels: ['Code dependency graph', 'Dependency blast radius', 'Repository dependency graph'],
    relatedConceptStableKeys: [
      'capability:ranked-repository-mapping',
      'capability:semantic-code-context-retrieval',
    ],
  },
  {
    conceptStableKey: 'capability:interface-design-guidance',
    labels: ['Source backed interface guidance'],
    relatedConceptStableKeys: ['capability:design-reference-discovery'],
  },
  {
    conceptStableKey: 'capability:repeatable-agent-workflows',
    labels: [
      'Codex task instructions',
      'Repeatable assistant instructions',
      'Reusable task instructions',
    ],
    relatedConceptStableKeys: [
      'capability:agent-context-efficiency-guidance',
      'capability:agent-instruction-lifecycle',
      'capability:agent-development-methodology',
      'capability:compaction-continuity',
      'capability:minimal-change-guidance',
    ],
  },
  {
    conceptStableKey: 'capability:plugin-package-distribution',
    labels: [
      'Agent capability packages',
      'Assistant capability packages',
      'Reusable agent capabilities',
    ],
    relatedConceptStableKeys: [
      'capability:capability-configuration-fanout',
      'capability:repeatable-agent-workflows',
      'capability:skill-discovery-planning',
    ],
  },
  {
    conceptStableKey: 'interface:mcp-server',
    labels: ['Published MCP server', 'Model Context Protocol implementation'],
    relatedConceptStableKeys: [
      'capability:mcp-server-discovery',
      'capability:plugin-package-distribution',
      'capability:tool-context-interoperability',
    ],
  },
];

function normalizedLabel(label: string): string {
  return label
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export async function importConceptVocabulary(client: PoolClient): Promise<void> {
  for (const entry of conceptVocabularyV1) {
    const concept = await client.query<{ id: string; conceptSchemeId: string }>(
      `SELECT concept.id::text AS id,
              concept.concept_scheme_id::text AS "conceptSchemeId"
       FROM catalog.concepts concept
       JOIN catalog.current_concept_schemes scheme
         ON scheme.id = concept.concept_scheme_id
       WHERE concept.stable_key = $1 AND concept.status = 'active'`,
      [entry.conceptStableKey],
    );
    if (concept.rowCount !== 1) {
      throw new Error(
        `Concept vocabulary target ${entry.conceptStableKey} is not uniquely active.`,
      );
    }
    for (const label of entry.labels) {
      const normalized = normalizedLabel(label);
      await client.query(
        `INSERT INTO catalog.concept_labels
           (id, concept_id, label, normalized_label, label_kind, locale)
         VALUES ($1, $2, $3, $4, 'alternate', 'en')
         ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING`,
        [
          stableUuid(namespace, `${entry.conceptStableKey}\0${label}`),
          concept.rows[0]!.id,
          label,
          normalized,
        ],
      );
    }
    for (const relatedStableKey of entry.relatedConceptStableKeys ?? []) {
      const related = await client.query<{ id: string; conceptSchemeId: string }>(
        `SELECT concept.id::text AS id,
                concept.concept_scheme_id::text AS "conceptSchemeId"
         FROM catalog.concepts concept
         JOIN catalog.current_concept_schemes scheme
           ON scheme.id = concept.concept_scheme_id
         WHERE concept.stable_key = $1 AND concept.status = 'active'`,
        [relatedStableKey],
      );
      if (related.rowCount !== 1) {
        throw new Error(
          `Related concept vocabulary target ${relatedStableKey} is not uniquely active.`,
        );
      }
      if (related.rows[0]!.conceptSchemeId !== concept.rows[0]!.conceptSchemeId) {
        throw new Error(
          `Related concepts ${entry.conceptStableKey} and ${relatedStableKey} use different schemes.`,
        );
      }
      await client.query(
        `INSERT INTO catalog.concept_relations
           (id, concept_scheme_id, subject_concept_id, relation_type, object_concept_id,
            evidence_basis, confidence, valid_from)
         VALUES ($1, $2, $3, 'related', $4, $5, 0.85, $6)
         ON CONFLICT
           (concept_scheme_id, subject_concept_id, relation_type, object_concept_id, valid_from)
         DO NOTHING`,
        [
          stableUuid(namespace, `${entry.conceptStableKey}\0related\0${relatedStableKey}`),
          concept.rows[0]!.conceptSchemeId,
          concept.rows[0]!.id,
          related.rows[0]!.id,
          JSON.stringify({
            origin: 'curated_ecosystem_vocabulary',
            scope: 'bounded semantic neighborhood; not equivalence or endorsement',
          }),
          '2026-09-30T00:00:00.000Z',
        ],
      );
    }
  }

  const currentAiDevelopmentDomain = await client.query<{ id: string }>(
    `SELECT concept.id::text AS id
     FROM catalog.concepts concept
     JOIN catalog.current_concept_schemes scheme ON scheme.id = concept.concept_scheme_id
     WHERE concept.stable_key = 'ai-development-tools'
       AND concept.facet_key = 'domain' AND concept.status = 'active'`,
  );
  if (currentAiDevelopmentDomain.rowCount !== 1) {
    throw new Error('Current AI development tools domain is not uniquely active.');
  }
  const legacyAiEntities = await client.query<{ entityId: string }>(
    `WITH RECURSIVE legacy_ai_domains AS (
       SELECT concept.id
       FROM catalog.concepts concept
       JOIN catalog.concept_schemes scheme ON scheme.id = concept.concept_scheme_id
       WHERE scheme.scheme_key = 'maestro-domains' AND scheme.version = 1
         AND concept.stable_key = 'ai-engineering'
       UNION
       SELECT relation.subject_concept_id
       FROM catalog.concept_relations relation
       JOIN legacy_ai_domains parent ON parent.id = relation.object_concept_id
       WHERE relation.relation_type = 'broader' AND relation.valid_to IS NULL
     )
     SELECT DISTINCT assignment.entity_id::text AS "entityId"
     FROM catalog.current_entity_facet_assignments assignment
     WHERE assignment.concept_id IN (SELECT id FROM legacy_ai_domains)
     ORDER BY "entityId"`,
  );
  for (const { entityId } of legacyAiEntities.rows) {
    await client.query(
      `INSERT INTO catalog.entity_facet_assignments
         (id, entity_id, concept_id, facet_key, origin, confidence, rationale, valid_from)
       VALUES ($1, $2, $3, 'domain', 'legacy_migration', 1,
               'Additive current-scheme projection of the retained v1 AI engineering assignment.',
               $4)
       ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING`,
      [
        stableUuid(namespace, `ai-development-tools\0${entityId}`),
        entityId,
        currentAiDevelopmentDomain.rows[0]!.id,
        '2026-09-30T00:00:00.000Z',
      ],
    );
  }
}
