export interface Phase06EvaluationQuery {
  id: string;
  split: 'development' | 'held_out';
  query: string;
  expectedCoverage: 'maintained' | 'partial' | 'outside_maintained_coverage';
  capabilityGroups: string[];
  acceptableCandidates: string[];
  prohibitedCandidates: string[];
  materialQualifiers: string[];
  evidenceRequirements: string[];
  exactNameCandidate?: string;
  labelProducer: 'agent_proxy_2026-09-29';
}

type QueryOptions = Partial<
  Pick<
    Phase06EvaluationQuery,
    | 'expectedCoverage'
    | 'prohibitedCandidates'
    | 'materialQualifiers'
    | 'evidenceRequirements'
    | 'exactNameCandidate'
  >
>;

function query(
  id: string,
  split: Phase06EvaluationQuery['split'],
  text: string,
  capabilityGroups: string[],
  acceptableCandidates: string[],
  options: QueryOptions = {},
): Phase06EvaluationQuery {
  return {
    id,
    split,
    query: text,
    expectedCoverage: options.expectedCoverage ?? 'maintained',
    capabilityGroups,
    acceptableCandidates,
    prohibitedCandidates: options.prohibitedCandidates ?? [],
    materialQualifiers: options.materialQualifiers ?? [],
    evidenceRequirements: options.evidenceRequirements ?? [
      'Candidate capability and caveats must resolve to source-bound knowledge.',
    ],
    ...(options.exactNameCandidate ? { exactNameCandidate: options.exactNameCandidate } : {}),
    labelProducer: 'agent_proxy_2026-09-29',
  };
}

// These are engineering proxy judgments, not human ground truth. The split is
// frozen for repeatable diagnostics, but it is not an independent user study.
export const phase06QueryEvaluationV1: Phase06EvaluationQuery[] = [
  query(
    'D01',
    'development',
    'ai',
    ['broad'],
    ['OpenHands', 'Model Context Protocol', 'Promptfoo', 'No AI Slop', 'Ollama'],
  ),
  query(
    'D02',
    'development',
    'ai github',
    ['coding', 'interoperability'],
    ['GitHub Agentic Workflows', 'GitNexus', 'Reticle'],
    {
      expectedCoverage: 'partial',
      materialQualifiers: ['GitHub may mean source location or integration target.'],
    },
  ),
  query(
    'D03',
    'development',
    'ai context reduction github',
    ['context', 'coding'],
    [
      'Context Mode',
      'Command Compressor Agent',
      'RTK',
      'tokf',
      'sqz',
      'context-compress',
      'Chisle',
      'Caveman',
    ],
    {
      materialQualifiers: ['Do not generalize a token-reduction claim into end-to-end quality.'],
    },
  ),
  query(
    'D04',
    'development',
    'ai no slop',
    ['writing-design'],
    ['No AI Slop', 'Frontend Design Skill', 'Simple Man', 'Caveman'],
    { exactNameCandidate: 'No AI Slop' },
  ),
  query(
    'D05',
    'development',
    'ai language better tone',
    ['writing-design'],
    ['No AI Slop', 'Simple Man', 'Caveman'],
  ),
  query(
    'D06',
    'development',
    'local ai model runtime',
    ['local-search', 'agent-workflow'],
    ['Ollama', 'AI SDK'],
    { materialQualifiers: ['Local does not establish offline behavior or model availability.'] },
  ),
  query(
    'D07',
    'development',
    'ai prompt evaluation',
    ['evaluation'],
    ['Promptfoo', 'Better Harness'],
  ),
  query(
    'D08',
    'development',
    'discover mcp servers',
    ['interoperability'],
    ['Official MCP Registry', 'Model Context Protocol', 'AAS Core'],
  ),
  query(
    'D09',
    'development',
    'coding agent repository automation',
    ['coding'],
    ['GitHub Agentic Workflows', 'OpenHands', 'Superpowers'],
  ),
  query(
    'D10',
    'development',
    'track coding agent token usage',
    ['coding', 'evaluation'],
    ['CodeBurn'],
  ),
  query(
    'D11',
    'development',
    'scan agent plugins for security',
    ['coding', 'interoperability'],
    ['HOL Guard'],
    { evidenceRequirements: ['A security signal is not a universal safety certification.'] },
  ),
  query(
    'D12',
    'development',
    'compose agent skills',
    ['coding', 'interoperability'],
    ['CAPA', 'AAS Core', 'Codex Skills', 'OpenAI plugins'],
  ),
  query(
    'D13',
    'development',
    'repository context compression',
    ['coding', 'context'],
    [
      'Context Mode',
      'Chisle',
      'Repomix',
      'Aider Repository Map',
      'AgentPack',
      'Context Pack',
      'Tare',
    ],
  ),
  query(
    'D14',
    'development',
    'searxng self-hosted metasearch for ai tools',
    ['local-search'],
    ['SearXNG'],
    {
      exactNameCandidate: 'SearXNG',
      materialQualifiers: ['External-engine query disclosure remains material.'],
    },
  ),
  query(
    'D15',
    'development',
    'structured output typescript model api',
    ['agent-workflow'],
    ['AI SDK', 'OpenAI Agents SDK'],
  ),
  query(
    'D16',
    'development',
    'interface design guidance',
    ['writing-design'],
    ['Frontend Design Skill', 'Awesome Design MD'],
  ),
  query(
    'D17',
    'development',
    'local repository code graph',
    ['coding', 'local-search'],
    ['GitNexus', 'Aider Repository Map', 'Code Context Engine'],
  ),
  query(
    'D18',
    'development',
    'runtime proof for web coding agents',
    ['coding', 'evaluation'],
    ['Reticle'],
  ),
  query(
    'D19',
    'development',
    'lifecycle hooks for coding agent',
    ['coding', 'interoperability'],
    ['Codex Hooks'],
  ),
  query(
    'D20',
    'development',
    'repeatable codex workflows',
    ['coding'],
    ['Codex Skills', 'Superpowers', 'Ponytail', 'Chisle', 'AIBoarding', 'Context Guard'],
  ),
  query(
    'D21',
    'development',
    'parallel specialist coding agents',
    ['coding', 'agent-workflow'],
    ['Codex Subagents', 'Superpowers'],
  ),
  query(
    'D22',
    'development',
    'multi-model routing gateway',
    ['agent-workflow'],
    ['LiteLLM Gateway'],
  ),
  query(
    'D23',
    'development',
    'external app oauth tools for agents',
    ['coding', 'interoperability'],
    ['Composio'],
    { materialQualifiers: ['Authentication and action execution require separate authority.'] },
  ),
  query(
    'D24',
    'development',
    'agent runtime guardrails handoffs',
    ['coding', 'agent-workflow'],
    ['OpenAI Agents SDK'],
  ),
  query(
    'D25',
    'development',
    'minimal change reuse first coding guidance',
    ['coding'],
    ['Ponytail', 'Chisle'],
  ),
  query(
    'D26',
    'development',
    'test driven agent workflow methodology',
    ['coding', 'evaluation'],
    ['Superpowers'],
  ),
  query(
    'D27',
    'development',
    'find design references for ai interface',
    ['writing-design'],
    ['Awesome Design MD', 'Frontend Design Skill'],
  ),
  query('D28', 'development', 'ai capability configuration across agents', ['coding'], ['CAPA']),
  query(
    'D29',
    'development',
    'evidence based coding agent benchmark',
    ['coding', 'evaluation'],
    ['Better Harness', 'Promptfoo'],
  ),
  query('D30', 'development', 'no network local search', ['local-search'], ['SearXNG', 'Ollama'], {
    materialQualifiers: ['No-network is an explicit constraint, not an inferred property.'],
  }),

  query(
    'H01',
    'held_out',
    'shrink tool output before it reaches a coding assistant',
    ['context', 'coding'],
    [
      'Context Mode',
      'Chisle',
      'Command Compressor Agent',
      'RTK',
      'tokf',
      'sqz',
      'context-compress',
    ],
  ),
  query(
    'H02',
    'held_out',
    'make robot writing sound less generic',
    ['writing-design'],
    ['No AI Slop', 'Simple Man', 'Caveman'],
  ),
  query(
    'H03',
    'held_out',
    'graph dependencies and blast radius in this codebase',
    ['coding'],
    ['GitNexus', 'Aider Repository Map', 'Code Context Engine'],
  ),
  query(
    'H04',
    'held_out',
    'observe browser console and network while an agent fixes ui',
    ['coding', 'evaluation', 'writing-design'],
    ['Reticle'],
  ),
  query(
    'H05',
    'held_out',
    'reusable instructions for codex tasks',
    ['coding', 'interoperability'],
    ['Codex Skills', 'Ponytail', 'Chisle', 'AIBoarding', 'Context Guard'],
  ),
  query(
    'H06',
    'held_out',
    'evalution harness for prompt quality',
    ['evaluation'],
    ['Promptfoo', 'Better Harness'],
  ),
  query(
    'H07',
    'held_out',
    'delegate separate coding reviews in parallel',
    ['coding', 'agent-workflow'],
    ['Codex Subagents', 'Superpowers'],
  ),
  query(
    'H08',
    'held_out',
    'route several llms behind one api',
    ['agent-workflow'],
    ['LiteLLM Gateway'],
  ),
  query(
    'H09',
    'held_out',
    'connect an agent to slack and github with managed auth',
    ['coding', 'interoperability'],
    ['Composio'],
  ),
  query(
    'H10',
    'held_out',
    'typed typescript model provider adapter',
    ['agent-workflow'],
    ['AI SDK'],
  ),
  query('H11', 'held_out', 'self-hosted web search json endpoint', ['local-search'], ['SearXNG']),
  query(
    'H12',
    'held_out',
    'open standard connecting tools to assistants',
    ['coding', 'interoperability'],
    ['Model Context Protocol'],
  ),
  query(
    'H13',
    'held_out',
    'registry of mcp server metadata',
    ['interoperability'],
    ['Official MCP Registry'],
  ),
  query('H14', 'held_out', 'infrastructure state planner', ['software-foundations'], ['Terraform']),
  query(
    'H15',
    'held_out',
    'mature general purpose scripting runtime',
    ['software-foundations'],
    ['Python'],
  ),
  query('H16', 'held_out', 'iphone shortcuts', [], [], {
    expectedCoverage: 'outside_maintained_coverage',
  }),
  query('H17', 'held_out', 'medical diagnosis agent', [], [], {
    expectedCoverage: 'outside_maintained_coverage',
    prohibitedCandidates: ['OpenHands', 'OpenAI Agents SDK'],
  }),
  query('H18', 'held_out', 'accounting payroll automation', [], [], {
    expectedCoverage: 'outside_maintained_coverage',
  }),
  query(
    'H19',
    'held_out',
    'install and execute the best plugin automatically',
    ['interoperability'],
    ['OpenAI plugins'],
    {
      materialQualifiers: [
        'Retrieval must not be interpreted as installation or execution authority.',
      ],
      prohibitedCandidates: ['Composio'],
    },
  ),
  query('H20', 'held_out', 'selected by Maestro top ai tool', [], [], {
    expectedCoverage: 'partial',
    materialQualifiers: ['Circular Maestro endorsement is not evidence.'],
  }),
];
