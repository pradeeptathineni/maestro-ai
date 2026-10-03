import { phase06QueryEvaluationV1 } from './phase06-evaluation.js';

type EvaluationQueryFamily =
  | 'ultra_broad'
  | 'typed_broad'
  | 'problem_statement'
  | 'mechanism'
  | 'standard_protocol'
  | 'exact_entity'
  | 'temporal'
  | 'popularity_adoption'
  | 'emerging_trend'
  | 'constrained'
  | 'ambiguous'
  | 'negative_exclusion'
  | 'community_terminology'
  | 'article_research'
  | 'cross_type'
  | 'obscure_unseen'
  | 'alternate_terminology';

export interface Phase08DevelopmentQuery {
  id: string;
  query: string;
  family: EvaluationQueryFamily;
  provenance: 'phase06_07_regression' | 'phase08_builder_development';
}

export interface GradedQrel {
  candidate: string;
  grade: 0 | 1 | 2 | 3;
  rationale: string;
  citations: string[];
}

export interface Phase08ExpertDraft {
  id: string;
  query: string;
  family: EvaluationQueryFamily;
  interpretation: {
    expectedCoverage: 'maintained' | 'partial' | 'outside_maintained_coverage';
    capabilityGroups: string[];
    materialQualifiers: string[];
  };
  requiredAnchors: string[];
  stronglyRelevantAlternatives: string[];
  acceptableAdjacentResults: string[];
  prohibitedResults: string[];
  importantFacets: string[];
  timeScope: string;
  qrels: GradedQrel[];
  labelProvenance: {
    state: 'expert_draft';
    producer: 'codex_builder_ai';
    sourceReference: string;
    reviewer: null;
    humanGold: false;
  };
  observedAt: '2026-09-30';
  version: 1;
}

const candidateEvidence: Record<string, string> = {
  'AAS Core': 'https://github.com/sickn33/agentic-awesome-skills/blob/main/docs/users/aas-core.md',
  AgentPack: 'https://github.com/vishal2612200/agentpack',
  AIBoarding: 'https://github.com/gustavo-meilus/aiboarding',
  'Aider Repository Map': 'https://aider.chat/docs/repomap.html',
  'AI SDK': 'https://ai-sdk.dev/docs/introduction',
  'Awesome Design MD': 'https://github.com/VoltAgent/awesome-design-md',
  'Better Harness': 'https://github.com/QoderAI/better-harness/blob/main/DESIGN.md',
  CAPA: 'https://capa.infragate.ai/getting-started/how-capa-works/',
  Caveman: 'https://github.com/JuliusBrussee/caveman',
  Chisle: 'https://github.com/JayPokale/Chisle',
  CodeBurn: 'https://codeburn.app/docs/providers',
  'Code Context Engine': 'https://github.com/elara-labs/code-context-engine',
  'Codex Hooks': 'https://learn.chatgpt.com/docs/hooks',
  'Codex Skills': 'https://developers.openai.com/plugins/concepts/skills',
  'Codex Subagents': 'https://learn.chatgpt.com/docs/agent-configuration/subagents',
  'Command Compressor Agent': 'https://github.com/linger-alpha/command-compressor-agent',
  Composio: 'https://github.com/ComposioHQ/composio',
  'Context Guard': 'https://github.com/GreenLv/codex-context-guard',
  'Context Mode': 'https://github.com/mksglu/context-mode/blob/main/BENCHMARK.md',
  'Context Pack': 'https://github.com/Rothschildiuk/context-pack',
  Docker: 'https://docs.docker.com/get-started/docker-overview/',
  'Frontend Design Skill':
    'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
  'GitHub Agentic Workflows':
    'https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows',
  GitNexus: 'https://github.com/abhigyanpatwari/GitNexus',
  'HOL Guard': 'https://github.com/hashgraph-online/hol-guard/blob/main/README.md',
  Kubernetes: 'https://kubernetes.io/docs/concepts/overview/',
  'LiteLLM Gateway': 'https://github.com/BerriAI/litellm',
  'Model Context Protocol': 'https://modelcontextprotocol.io/specification/2025-06-18',
  'No AI Slop': 'https://github.com/petergyang/no-ai-slop',
  'Official MCP Registry': 'https://github.com/modelcontextprotocol/registry',
  Ollama: 'https://docs.ollama.com/',
  'OpenAI Agents SDK': 'https://github.com/openai/openai-agents-js',
  'OpenAI plugins': 'https://developers.openai.com/plugins/concepts/plugins',
  OpenHands:
    'https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx',
  Ponytail: 'https://github.com/DietrichGebert/ponytail',
  Promptfoo: 'https://www.promptfoo.dev/docs/intro/',
  Python: 'https://docs.python.org/3/license.html',
  Repomix: 'https://github.com/yamadashy/repomix',
  Reticle: 'https://github.com/reticlehq/reticle',
  RTK: 'https://github.com/rtk-ai/rtk',
  SearXNG: 'https://docs.searxng.org/dev/search_api.html',
  'Simple Man': 'https://github.com/Maksim-Burtsev/simple-man',
  sqz: 'https://github.com/ojuschugh1/sqz',
  Superpowers: 'https://github.com/obra/superpowers',
  Tare: 'https://github.com/mstuart/tare',
  Terraform: 'https://developer.hashicorp.com/terraform/docs',
  tokf: 'https://github.com/mpecan/tokf',
  'context-compress': 'https://github.com/Open330/context-compress',
};

function familyFor(query: (typeof phase06QueryEvaluationV1)[number]): EvaluationQueryFamily {
  if (query.exactNameCandidate) return 'exact_entity';
  if (query.expectedCoverage === 'outside_maintained_coverage') return 'obscure_unseen';
  if (query.query.split(/\s+/).length <= 2) return 'ultra_broad';
  if (/without|no network|automatically/i.test(query.query)) return 'constrained';
  if (/standard|protocol|registry/i.test(query.query)) return 'standard_protocol';
  if (/runtime|gateway|graph|compress|hooks|structured/i.test(query.query)) return 'mechanism';
  return 'problem_statement';
}

const phase08DevelopmentAdditions: Array<Pick<Phase08DevelopmentQuery, 'query' | 'family'>> = [
  { query: 'model serving observability landscape', family: 'typed_broad' },
  { query: 'open source evaluation datasets for retrieval systems', family: 'article_research' },
  { query: 'new local inference runtimes this month', family: 'temporal' },
  { query: 'widely adopted infrastructure as code tools', family: 'popularity_adoption' },
  { query: 'emerging agent interoperability conventions', family: 'emerging_trend' },
  { query: 'self hosted search excluding cloud services', family: 'negative_exclusion' },
  { query: 'MCP', family: 'ambiguous' },
  { query: 'tools practitioners call repo maps', family: 'community_terminology' },
  { query: 'research about prompt compression quality loss', family: 'article_research' },
  { query: 'standards libraries and explanatory guides for telemetry', family: 'cross_type' },
  { query: 'Docker', family: 'exact_entity' },
  { query: 'OpenTelemetry specification', family: 'standard_protocol' },
  { query: 'learn distributed systems from primary course material', family: 'problem_statement' },
  { query: 'python type checker for large monorepos', family: 'problem_statement' },
  { query: 'local model runtime with no network fallback', family: 'constrained' },
  { query: 'continuous delivery systems', family: 'typed_broad' },
  { query: 'open source machine learning experiment tracking', family: 'problem_statement' },
  { query: 'protocol for tool calling between assistants', family: 'standard_protocol' },
  { query: 'repository indexing with dependency relationships', family: 'mechanism' },
  { query: 'agent evaluation harness that records evidence', family: 'problem_statement' },
  { query: 'most discussed code context tools', family: 'popularity_adoption' },
  { query: 'recent repository context compression research', family: 'temporal' },
  { query: 'IaC', family: 'ambiguous' },
  { query: 'container orchestration without Kubernetes', family: 'negative_exclusion' },
  { query: 'Spanish resources for aprendizaje supervisado', family: 'alternate_terminology' },
  { query: 'compare standards implementations and research documents', family: 'cross_type' },
  { query: 'security review for agent extension ecosystems', family: 'problem_statement' },
  { query: 'mature low churn programming language foundations', family: 'typed_broad' },
  { query: 'rising open source browser agent tools', family: 'emerging_trend' },
  { query: 'what can summarize command output before an LLM sees it', family: 'problem_statement' },
];

export const phase08DevelopmentQueries: Phase08DevelopmentQuery[] = [
  ...phase06QueryEvaluationV1.map((item) => ({
    id: `DEV-${item.id}`,
    query: item.query,
    family: familyFor(item),
    provenance: 'phase06_07_regression' as const,
  })),
  ...phase08DevelopmentAdditions.map((item, index) => ({
    id: `DEV-P08-${String(index + 1).padStart(2, '0')}`,
    ...item,
    provenance: 'phase08_builder_development' as const,
  })),
];

const expertDraftParaphrases = [
  'map the reusable systems in the AI developer-tool landscape',
  'find AI tooling designed around GitHub repositories and workflows',
  'reduce coding-assistant context before tool output enters the model',
  'tools explicitly aimed at avoiding generic AI-produced prose',
  'make machine-assisted writing more direct and natural',
  'run model inference locally through a documented developer interface',
  'evaluate prompts and model behavior with repeatable assertions',
  'locate published servers that implement the Model Context Protocol',
  'automate repository work with a coding agent',
  'measure token consumption by coding assistants',
  'inspect agent extensions for security concerns',
  'compose reusable capabilities for coding assistants',
  'compress or map repository context for code-focused models',
  'operate a self-hosted metasearch API for tool research',
  'produce schema-checked model output from TypeScript',
  'find source-backed guidance for interface design',
  'build a local graph of code and dependency relationships',
  'capture browser runtime evidence while a coding agent works',
  'run deterministic lifecycle callbacks around coding-agent actions',
  'package repeatable instructions for Codex work',
  'delegate independent coding tasks to specialist workers',
  'route multiple model providers behind one compatible gateway',
  'connect an assistant to external services through managed authorization',
  'use typed guardrails and handoffs in an agent SDK',
  'guide a coding assistant toward minimal reuse-first changes',
  'apply test-driven workflow discipline to agentic coding',
  'collect design references before implementing an AI interface',
  'share capability configuration across multiple assistants',
  'benchmark coding assistants with inspectable evidence',
  'search locally without silently sending queries to a hosted service',
  'shrink verbose command output before a code assistant reads it',
  'remove formulaic machine-written tone from prose',
  'understand dependency blast radius inside an unfamiliar repository',
  'observe console and network behavior during an automated UI repair',
  'reuse task instructions across Codex sessions',
  'test prompt quality despite a misspelled evaluation request',
  'send separate code-review concerns to parallel specialists',
  'present several LLM providers through one API surface',
  'use managed OAuth when connecting an agent to collaboration services',
  'implement a typed TypeScript adapter for a model provider',
  'serve web-search results through a self-managed JSON endpoint',
  'use an open protocol to connect assistants with tools',
  'find registry metadata for MCP server implementations',
  'plan infrastructure from declarative desired state',
  'choose a mature general-purpose scripting language runtime',
  'automate a workflow from an iPhone shortcut',
  'use an agent to produce a medical diagnosis',
  'automate accounting payroll operations',
  'install and execute whichever plugin ranks first',
  'find a tool endorsed as best by the product doing the ranking',
] as const;

if (expertDraftParaphrases.length !== phase06QueryEvaluationV1.length) {
  throw new Error('Phase 08 expert-draft paraphrases must stay aligned with source proxy labels.');
}

export const phase08ExpertDraftQrels: Phase08ExpertDraft[] = phase06QueryEvaluationV1.map(
  (source, index) => {
    const relevant = source.acceptableCandidates.map((candidate, candidateIndex): GradedQrel => ({
      candidate,
      grade: candidateIndex === 0 ? 3 : 2,
      rationale:
        candidateIndex === 0
          ? 'Source-backed candidate selected as the strongest required anchor in this AI-authored draft.'
          : 'Source-backed candidate judged strongly relevant in this AI-authored draft.',
      citations: candidateEvidence[candidate] ? [candidateEvidence[candidate]] : [],
    }));
    const prohibited = source.prohibitedCandidates.map((candidate): GradedQrel => ({
      candidate,
      grade: 0,
      rationale: 'Explicit negative judgment inherited from the frozen Phase 06/07 proxy set.',
      citations: candidateEvidence[candidate] ? [candidateEvidence[candidate]] : [],
    }));
    return {
      id: `GOLD-DRAFT-${String(index + 1).padStart(2, '0')}`,
      query: expertDraftParaphrases[index]!,
      family: familyFor(source),
      interpretation: {
        expectedCoverage: source.expectedCoverage,
        capabilityGroups: source.capabilityGroups,
        materialQualifiers: source.materialQualifiers,
      },
      requiredAnchors: source.acceptableCandidates.slice(0, 1),
      stronglyRelevantAlternatives: source.acceptableCandidates.slice(1),
      acceptableAdjacentResults: [],
      prohibitedResults: source.prohibitedCandidates,
      importantFacets: source.capabilityGroups,
      timeScope: 'Current public evidence as observed on 2026-09-30; revalidation required.',
      qrels: [...relevant, ...prohibited],
      labelProvenance: {
        state: 'expert_draft',
        producer: 'codex_builder_ai',
        sourceReference: `phase06-evaluation-v1:${source.id}`,
        reviewer: null,
        humanGold: false,
      },
      observedAt: '2026-09-30',
      version: 1,
    };
  },
);

export interface Phase08ChallengeQuery {
  id: string;
  query: string;
  family: EvaluationQueryFamily;
  expectedPlan: {
    minimumPasses: 1 | 2;
    requiresExternalLeadRoute: true;
    expectedCoverage: 'outside_maintained_coverage';
  };
  freeze: {
    createdAfterPolicyCommit: '93e22a2f6421f74071163b7c60581eb8501b836e';
    productionChangesPermittedBeforeRecording: false;
  };
}

const challengeQueries: Array<Pick<Phase08ChallengeQuery, 'query' | 'family'>> = [
  { query: 'marine eDNA metabarcoding classifier', family: 'obscure_unseen' },
  { query: 'satellite wildfire smoke plume inversion', family: 'obscure_unseen' },
  { query: 'multispectral restoration of ancient manuscripts', family: 'problem_statement' },
  { query: 'TEI critical apparatus collation software', family: 'standard_protocol' },
  { query: 'low resource language morphological analyzer', family: 'obscure_unseen' },
  { query: 'protein crystallography molecular replacement phasing', family: 'mechanism' },
  { query: 'seismic full waveform inversion toolkit', family: 'mechanism' },
  { query: 'whole slide pathology image registration', family: 'problem_statement' },
  { query: 'formal theorem prover tactic synthesis', family: 'problem_statement' },
  { query: 'quantum error correction decoder benchmark', family: 'article_research' },
  { query: 'neutrino detector event reconstruction framework', family: 'obscure_unseen' },
  { query: 'battery impedance spectroscopy diagnostics library', family: 'problem_statement' },
  { query: 'cuneiform transliteration OCR pipeline', family: 'problem_statement' },
  { query: 'urban heat island statistical downscaling', family: 'mechanism' },
  { query: 'bioacoustic species occupancy modeling', family: 'obscure_unseen' },
  { query: 'underwater sonar SLAM loop closure', family: 'mechanism' },
  { query: 'power grid state estimation from PMU streams', family: 'problem_statement' },
  { query: 'metabolomics mass spectral annotation', family: 'obscure_unseen' },
  { query: 'historical census genealogical record linkage', family: 'problem_statement' },
  { query: 'radio astronomy fast transient detection', family: 'obscure_unseen' },
];

export const phase08ChallengeQueries: Phase08ChallengeQuery[] = challengeQueries.map(
  (item, index) => ({
    id: `CHALLENGE-${String(index + 1).padStart(2, '0')}`,
    ...item,
    expectedPlan: {
      minimumPasses: 2,
      requiresExternalLeadRoute: true,
      expectedCoverage: 'outside_maintained_coverage',
    },
    freeze: {
      createdAfterPolicyCommit: '93e22a2f6421f74071163b7c60581eb8501b836e',
      productionChangesPermittedBeforeRecording: false,
    },
  }),
);

export interface Phase08LiveQuery {
  id: string;
  query: string;
  family: EvaluationQueryFamily;
  adapter: 'github' | 'mcp_registry' | 'hacker_news';
  observedOn: '2026-09-30';
}

export const phase08LiveQueries: Phase08LiveQuery[] = [
  ['WASM component model runtime', 'mechanism', 'github'],
  ['Rust embedded async executor', 'problem_statement', 'github'],
  ['geospatial cloud optimized raster toolkit', 'problem_statement', 'github'],
  ['theorem prover tactic synthesis', 'problem_statement', 'github'],
  ['bioacoustic annotation software', 'obscure_unseen', 'github'],
  ['mass spectrometry annotation library', 'obscure_unseen', 'github'],
  ['multispectral manuscript restoration', 'obscure_unseen', 'github'],
  ['geospatial data', 'typed_broad', 'mcp_registry'],
  ['scientific literature', 'article_research', 'mcp_registry'],
  ['knowledge graph', 'mechanism', 'mcp_registry'],
  ['browser automation', 'mechanism', 'mcp_registry'],
  ['database schema', 'mechanism', 'mcp_registry'],
  ['observability', 'typed_broad', 'mcp_registry'],
  ['developer context windows', 'community_terminology', 'hacker_news'],
  ['WebAssembly component model', 'emerging_trend', 'hacker_news'],
  ['local first database', 'emerging_trend', 'hacker_news'],
  ['formal verification tools', 'community_terminology', 'hacker_news'],
  ['open source geospatial', 'community_terminology', 'hacker_news'],
  ['small language model inference', 'emerging_trend', 'hacker_news'],
  ['software supply chain attestations', 'standard_protocol', 'hacker_news'],
].map(([query, family, adapter], index) => ({
  id: `LIVE-${String(index + 1).padStart(2, '0')}`,
  query,
  family,
  adapter,
  observedOn: '2026-09-30',
})) as Phase08LiveQuery[];
