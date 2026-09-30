import type { PoolClient } from 'pg';
import { hashCanonical, stableUuid } from '../../domain/src/index.js';
import {
  intrinsicSignalPolicyV3,
  querySignalPolicyV2,
  type QueryValueInput,
} from '../../scoring/src/index.js';

const namespace = 'maestro-ai:discovery-knowledge-v1';
const observedAt = '2026-09-30T12:00:00.000Z';

interface KnowledgeDocumentSeed {
  key: string;
  kind: 'article' | 'research' | 'resource' | 'specification' | 'standard';
  title: string;
  summary: string;
  url: string;
  publisher: string;
  searchText: string;
  aliases: string[];
  mechanismKeys: string[];
  capabilityKey: string;
  relationType: 'about' | 'explains' | 'evaluates' | 'specifies';
}

const documents: KnowledgeDocumentSeed[] = [
  {
    key: 'attention-is-all-you-need',
    kind: 'research',
    title: 'Attention Is All You Need',
    summary:
      'The primary research paper introducing the Transformer architecture based on attention mechanisms.',
    url: 'https://arxiv.org/abs/1706.03762',
    publisher: 'arXiv / paper authors',
    searchText:
      'ai artificial intelligence machine learning transformer attention neural network model research paper',
    aliases: ['Transformer paper'],
    mechanismKeys: ['transformer', 'attention'],
    capabilityKey: 'general-purpose-ai-model-family',
    relationType: 'explains',
  },
  {
    key: 'llmlingua-paper',
    kind: 'research',
    title: 'LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models',
    summary:
      'A primary research paper evaluating a learned coarse-to-fine prompt-compression method.',
    url: 'https://arxiv.org/abs/2310.05736',
    publisher: 'arXiv / paper authors',
    searchText:
      'ai context reduction prompt compression llm token filtering learned compression research paper evaluation',
    aliases: ['LLMLingua paper'],
    mechanismKeys: ['learned-prompt-compression', 'context-compression'],
    capabilityKey: 'learned-prompt-compression',
    relationType: 'evaluates',
  },
  {
    key: 'kubernetes-concepts',
    kind: 'resource',
    title: 'Kubernetes Concepts',
    summary:
      'The project documentation explaining cluster architecture, workloads, services, storage, configuration, and security concepts.',
    url: 'https://kubernetes.io/docs/concepts/',
    publisher: 'Kubernetes project',
    searchText:
      'devops kubernetes container orchestration concepts architecture workloads services configuration learning resource',
    aliases: ['Kubernetes documentation'],
    mechanismKeys: ['container-orchestration'],
    capabilityKey: 'container-orchestration',
    relationType: 'explains',
  },
  {
    key: 'sre-book',
    kind: 'resource',
    title: 'Site Reliability Engineering',
    summary:
      'A publisher-hosted book describing principles and practices for operating reliable production systems.',
    url: 'https://sre.google/sre-book/table-of-contents/',
    publisher: 'Google',
    searchText:
      'devops sre site reliability engineering book service level objectives error budgets operations practice resource',
    aliases: ['Google SRE book'],
    mechanismKeys: ['site-reliability-engineering'],
    capabilityKey: 'site-reliability-engineering',
    relationType: 'explains',
  },
  {
    key: 'mcp-specification',
    kind: 'specification',
    title: 'Model Context Protocol specification',
    summary:
      'The versioned protocol specification for connecting AI applications with tools and contextual data sources.',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18',
    publisher: 'Model Context Protocol',
    searchText:
      'ai standard specification protocol mcp tools assistants context interoperability document',
    aliases: ['MCP specification'],
    mechanismKeys: ['tool-context-interoperability'],
    capabilityKey: 'tool-context-interoperability',
    relationType: 'specifies',
  },
  {
    key: 'scikit-user-guide',
    kind: 'resource',
    title: 'scikit-learn User Guide',
    summary:
      'A maintained guide to supervised and unsupervised learning, model selection, preprocessing, inspection, and common pitfalls.',
    url: 'https://scikit-learn.org/stable/user_guide.html',
    publisher: 'scikit-learn project',
    searchText:
      'ml machine learning guide supervised unsupervised evaluation model selection preprocessing resource',
    aliases: ['sklearn user guide'],
    mechanismKeys: ['supervised-learning', 'unsupervised-learning', 'model-evaluation'],
    capabilityKey: 'classical-machine-learning',
    relationType: 'explains',
  },
  {
    key: 'opentelemetry-specification',
    kind: 'standard',
    title: 'OpenTelemetry Specification',
    summary:
      'The cross-language specification for telemetry APIs, SDKs, data, and semantic conventions.',
    url: 'https://opentelemetry.io/docs/specs/otel/',
    publisher: 'OpenTelemetry project',
    searchText:
      'devops observability telemetry standard specification traces metrics logs semantic conventions',
    aliases: ['OTel specification'],
    mechanismKeys: ['telemetry-instrumentation'],
    capabilityKey: 'telemetry-instrumentation',
    relationType: 'specifies',
  },
  {
    key: 'open-gitops-principles',
    kind: 'standard',
    title: 'OpenGitOps Principles',
    summary:
      'A concise set of vendor-neutral principles for declarative, versioned, automatically pulled and reconciled operations.',
    url: 'https://opengitops.dev/',
    publisher: 'OpenGitOps',
    searchText:
      'devops gitops principles standard declarative versioned pull reconciliation practice',
    aliases: ['GitOps principles'],
    mechanismKeys: ['declarative-operations-practice'],
    capabilityKey: 'declarative-operations-practice',
    relationType: 'specifies',
  },
];

function id(kind: string, key: string): string {
  return stableUuid(namespace, `${kind}:${key}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function documentValueProfile(evidenceId: string): QueryValueInput[] {
  return [
    {
      key: 'reuse_leverage',
      raw: 65,
      confidence: 0.55,
      coverage: 0.7,
      applicability: 'applicable',
      state: 'present',
      reasons: ['The document directly explains or specifies a scoped mechanism.'],
      missing: ['Usefulness for a particular reader or project is not measured.'],
      evidenceIds: [evidenceId],
    },
    {
      key: 'adoption_ease',
      raw: null,
      confidence: 0,
      coverage: 0,
      applicability: 'not_applicable',
      state: 'not_applicable',
      reasons: ['Installability is not a criterion for a knowledge document.'],
      missing: [],
      evidenceIds: [],
    },
    {
      key: 'maturity',
      raw: 55,
      confidence: 0.45,
      coverage: 0.5,
      applicability: 'applicable',
      state: 'present',
      reasons: ['A stable canonical publisher location was observed.'],
      missing: ['Citation, revision, or long-term continuity is not fully assessed.'],
      evidenceIds: [evidenceId],
    },
    {
      key: 'provenance_clarity',
      raw: 80,
      confidence: 0.75,
      coverage: 1,
      applicability: 'applicable',
      state: 'present',
      reasons: ['Canonical document identity and publisher are recorded.'],
      missing: [],
      evidenceIds: [evidenceId],
    },
  ];
}

export async function importKnowledgeDocuments(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO catalog.score_policies
       (id, policy_key, version, policy_document, code_revision, created_at)
     VALUES ($1, 'query-signal', $2, $3, 'discovery-knowledge-v1', $4)
     ON CONFLICT (policy_key, version) DO NOTHING`,
    [
      id('policy', querySignalPolicyV2.version),
      querySignalPolicyV2.version,
      json(querySignalPolicyV2),
      observedAt,
    ],
  );
  await client.query(
    `INSERT INTO catalog.score_policies
       (id, policy_key, version, policy_document, code_revision, created_at)
     VALUES ($1, 'intrinsic-signal', $2, $3, 'signals-phase-08', $4)
     ON CONFLICT (policy_key, version) DO NOTHING`,
    [
      id('policy', intrinsicSignalPolicyV3.version),
      intrinsicSignalPolicyV3.version,
      json(intrinsicSignalPolicyV3),
      observedAt,
    ],
  );
  for (const document of documents) {
    const sourceId = id('source', document.url);
    await client.query(
      `INSERT INTO catalog.sources
         (id, canonical_uri, title, owner, source_type, authority_scope, redistribution_notes)
       VALUES ($1, $2, $3, $4, 'primary_knowledge_document',
               'Publisher identity and bounded document scope',
               'Metadata and a bounded paraphrase only; document content is not mirrored.')
       ON CONFLICT (canonical_uri) DO NOTHING`,
      [sourceId, document.url, document.title, document.publisher],
    );
    const resolvedSource = await client.query<{ id: string }>(
      'SELECT id FROM catalog.sources WHERE canonical_uri = $1',
      [document.url],
    );
    const actualSourceId = resolvedSource.rows[0]!.id;
    const contentDigest = hashCanonical({
      url: document.url,
      title: document.title,
      summary: document.summary,
      observedAt,
    });
    const observationId = id('observation', `${document.key}:${contentDigest}`);
    await client.query(
      `INSERT INTO catalog.source_observations
         (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
          adapter_version, content_digest, excerpt, media_type, trust_boundary, handling_status)
       VALUES ($1, $2, $3, $3, $4, 'discovery_primary_source_review', 'discovery-knowledge-v1',
               $5, $6, 'text/metadata', 'curated', 'normalized')
       ON CONFLICT DO NOTHING`,
      [observationId, actualSourceId, document.url, observedAt, contentDigest, document.summary],
    );
    const evidenceId = id('evidence', document.key);
    await client.query(
      `INSERT INTO catalog.evidence_items
         (id, source_observation_id, evidence_type, producer, method_version, result,
          independence, applicability_scope, limitations, quality_flags, observed_at,
          review_after, visibility)
       VALUES ($1, $2, 'documentation_inspection', 'Maestro discovery knowledge curation',
               'discovery-primary-source-review-v1', $3, 'publisher_only',
               'document identity and stated subject only',
               ARRAY['No independent usefulness judgment.'], ARRAY['proposed_mapping'], $4,
               $4::timestamptz + interval '90 days', 'global')
       ON CONFLICT DO NOTHING`,
      [
        evidenceId,
        observationId,
        json({ title: document.title, summary: document.summary }),
        observedAt,
      ],
    );
    const documentId = id('document', document.key);
    const profile = documentValueProfile(evidenceId);
    await client.query(
      `INSERT INTO catalog.knowledge_documents
         (id, document_kind, title, summary, canonical_uri, publisher, publication_state,
          source_observation_id, search_text, aliases, mechanism_keys, value_profile,
          content_digest, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (canonical_uri) DO NOTHING`,
      [
        documentId,
        document.kind,
        document.title,
        document.summary,
        document.url,
        document.publisher,
        observationId,
        document.searchText,
        document.aliases,
        document.mechanismKeys,
        json(profile),
        contentDigest,
        observedAt,
      ],
    );
    const capability = await client.query<{ id: string }>(
      `SELECT id FROM catalog.capability_definitions
       WHERE stable_key = $1 ORDER BY schema_version DESC LIMIT 1`,
      [document.capabilityKey],
    );
    if (capability.rowCount) {
      await client.query(
        `INSERT INTO catalog.knowledge_document_subjects
           (document_id, capability_definition_id, relation_type, source_observation_id, rationale)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          documentId,
          capability.rows[0]!.id,
          document.relationType,
          observationId,
          'The document publisher presents this as the stated subject; efficacy is not inferred.',
        ],
      );
    }
  }
}
