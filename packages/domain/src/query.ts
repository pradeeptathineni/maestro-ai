export type QueryFacetOrigin = 'explicit' | 'inferred' | 'missing';

export interface QueryFacet {
  key: string;
  label: string;
  value: string;
  origin: QueryFacetOrigin;
}

export interface QueryInterpretation {
  normalizedText: string;
  terms: string[];
  expandedTerms: string[];
  explicitFacets: QueryFacet[];
  inferredFacets: QueryFacet[];
  missingContext: QueryFacet[];
  capabilityGroups: string[];
  coverageState: 'maintained' | 'partial' | 'outside_maintained_coverage';
  interpretationMethod: 'deterministic-v1';
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'across',
  'are',
  'before',
  'behind',
  'better',
  'build',
  'for',
  'fix',
  'fixes',
  'help',
  'i',
  'improve',
  'in',
  'is',
  'it',
  'make',
  'me',
  'my',
  'no',
  'of',
  'on',
  'or',
  'several',
  'the',
  'to',
  'trying',
  'while',
  'understand',
  'with',
]);

const CONCEPTS: Array<{
  key: string;
  label: string;
  triggers: string[];
  expansions: string[];
}> = [
  {
    key: 'coding',
    label: 'Coding systems',
    triggers: [
      'agent',
      'assistant',
      'assistants',
      'code',
      'codebase',
      'coding',
      'codex',
      'developer',
      'engineering',
      'programming',
      'repo',
      'repository',
      'software',
      'workflow',
      'workflows',
      'agents',
    ],
    expansions: ['agentic', 'repository', 'workflow', 'software'],
  },
  {
    key: 'context',
    label: 'Context efficiency',
    triggers: [
      'compact',
      'compress',
      'compression',
      'context',
      'output',
      'reduction',
      'retrieval',
      'shrink',
      'token',
    ],
    expansions: ['compaction', 'filtering', 'optimization', 'output', 'search'],
  },
  {
    key: 'evaluation',
    label: 'Evaluation and observability',
    triggers: [
      'benchmark',
      'check',
      'checks',
      'eval',
      'evaluation',
      'browser',
      'console',
      'measure',
      'observability',
      'observe',
      'observation',
      'quality',
      'proof',
      'runtime',
      'test',
      'testing',
      'verification',
    ],
    expansions: [
      'assessment',
      'browser',
      'console',
      'evidence',
      'network',
      'runtime',
      'testing',
      'usage',
      'validation',
    ],
  },
  {
    key: 'interoperability',
    label: 'Interoperability and discovery',
    triggers: [
      'hook',
      'hooks',
      'configuration',
      'instruction',
      'instructions',
      'mcp',
      'plugin',
      'protocol',
      'registry',
      'skill',
      'skills',
      'standard',
      'tool',
      'tools',
    ],
    expansions: [
      'capability',
      'connection',
      'integration',
      'interoperability',
      'protocol',
      'server',
      'standard',
      'tool',
      'workflow',
    ],
  },
  {
    key: 'agent-workflow',
    label: 'Agent workflow and orchestration',
    triggers: [
      'delegation',
      'delegate',
      'llm',
      'llms',
      'model',
      'models',
      'multi-agent',
      'multi-model',
      'orchestration',
      'routing',
      'route',
      'subagent',
      'subagents',
    ],
    expansions: ['agent', 'gateway', 'handoff', 'model', 'parallel', 'workflow'],
  },
  {
    key: 'writing-design',
    label: 'Writing and design quality',
    triggers: [
      'copy',
      'design',
      'frontend',
      'generic',
      'interface',
      'language',
      'robot',
      'slop',
      'tone',
      'ui',
      'writing',
    ],
    expansions: ['brevity', 'editing', 'guidance', 'interface', 'prose', 'style', 'tone', 'visual'],
  },
  {
    key: 'local-search',
    label: 'Local and search infrastructure',
    triggers: ['local', 'offline', 'search', 'self-hosted', 'searxng'],
    expansions: ['inference', 'knowledge', 'metasearch', 'retrieval'],
  },
  {
    key: 'software-foundations',
    label: 'Software foundations',
    triggers: ['infrastructure', 'python', 'runtime', 'scripting', 'terraform'],
    expansions: ['language', 'software', 'state', 'tooling'],
  },
];

const OUTSIDE_MAINTAINED_DOMAINS = new Set([
  'accounting',
  'diagnosis',
  'healthcare',
  'medical',
  'payroll',
]);

const EXPLICIT_FACETS: Array<{
  key: string;
  label: string;
  value: string;
  terms: string[];
}> = [
  { key: 'distribution', label: 'GitHub distribution', value: 'github', terms: ['github'] },
  { key: 'locality', label: 'Local operation', value: 'local', terms: ['local', 'offline'] },
  {
    key: 'credential',
    label: 'No API key',
    value: 'no_api_key',
    terms: ['no api key', 'without api key'],
  },
  {
    key: 'network_constraint',
    label: 'Network constraint',
    value: 'no_network',
    terms: ['no network', 'without network', 'offline'],
  },
];

function normalizedWords(query: string): string[] {
  return query
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9+#.-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function interpretQuery(
  query: string,
  suppliedFacets: Record<string, string> = {},
): QueryInterpretation {
  const normalizedText = normalizedWords(query).join(' ').slice(0, 1000);
  if (!normalizedText) throw new TypeError('A query must contain searchable text.');
  const words = normalizedWords(normalizedText);
  const searchable = words.filter((word) => !STOP_WORDS.has(word));
  const matchedConcepts = CONCEPTS.filter((concept) =>
    concept.triggers.some((trigger) => searchable.includes(trigger)),
  );
  const outsideMaintainedDomain = searchable.some((term) => OUTSIDE_MAINTAINED_DOMAINS.has(term));
  const circularEndorsement =
    searchable.includes('maestro') &&
    searchable.some((term) => ['best', 'selected', 'top'].includes(term));
  const broadAiOnly = searchable.length === 1 && searchable[0] === 'ai';
  const capabilityGroups = outsideMaintainedDomain
    ? []
    : broadAiOnly
      ? CONCEPTS.map((concept) => concept.label)
      : matchedConcepts.map((concept) => concept.label);
  const expandedTerms = [
    ...new Set([
      ...searchable.filter((word) => word !== 'ai'),
      ...matchedConcepts.flatMap((concept) => concept.expansions),
    ]),
  ].sort();
  const detectedFacets = EXPLICIT_FACETS.filter((facet) =>
    facet.terms.some((term) => normalizedText.includes(term)),
  ).map((facet) => ({ ...facet, origin: 'explicit' as const }));
  if (
    searchable.includes('install') &&
    searchable.some((term) => ['plugin', 'plugins'].includes(term))
  ) {
    detectedFacets.push({
      key: 'candidate_kind',
      label: 'Requested kind',
      value: 'plugin',
      terms: ['plugin'],
      origin: 'explicit',
    });
  }
  const supplied = Object.entries(suppliedFacets)
    .map(([key, value]) => ({
      key: key.normalize('NFKC').trim().slice(0, 80),
      label: key
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase())
        .slice(0, 120),
      value: value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 240),
      origin: 'explicit' as const,
    }))
    .filter((facet) => facet.key && facet.value);
  const suppliedKeys = new Set(supplied.map((facet) => facet.key));
  const explicitFacets = [
    ...detectedFacets.filter((facet) => !suppliedKeys.has(facet.key)),
    ...supplied,
  ];
  const suppliedTerms = supplied.flatMap((facet) => normalizedWords(facet.value));
  const inferredFacets = matchedConcepts.map((concept) => ({
    key: 'capability_group',
    label: 'Suggested interpretation',
    value: concept.key,
    origin: 'inferred' as const,
  }));
  if (searchable.includes('github')) {
    inferredFacets.push({
      key: 'integration_target',
      label: 'Suggested interpretation',
      value: 'github_integration',
      origin: 'inferred',
    });
  }
  const unresolvedInferredFacets = inferredFacets.filter((facet) => !suppliedKeys.has(facet.key));
  const missingContext: QueryFacet[] = [];
  if (searchable.some((term) => ['local', 'offline'].includes(term))) {
    missingContext.push({
      key: 'hardware',
      label: 'Missing context',
      value: 'Hardware capacity is unknown; local does not imply offline search.',
      origin: 'missing',
    });
  }
  if (circularEndorsement) {
    missingContext.push({
      key: 'independent_evidence',
      label: 'Missing context',
      value: 'Selection by Maestro is circular and does not establish independent quality.',
      origin: 'missing',
    });
  }
  if (searchable.some((term) => ['deploy', 'execute', 'install', 'invoke'].includes(term))) {
    missingContext.push({
      key: 'action_authority',
      label: 'Authority boundary',
      value: 'Exploration does not grant installation, execution, deployment, or invocation.',
      origin: 'missing',
    });
  }
  const aiRelated = broadAiOnly || matchedConcepts.length > 0 || searchable.includes('ai');
  return {
    normalizedText,
    terms: [...new Set([...searchable, ...suppliedTerms])].sort(),
    expandedTerms,
    explicitFacets,
    inferredFacets: unresolvedInferredFacets,
    missingContext,
    capabilityGroups,
    coverageState: outsideMaintainedDomain
      ? 'outside_maintained_coverage'
      : circularEndorsement
        ? 'partial'
        : aiRelated
          ? matchedConcepts.length || broadAiOnly
            ? 'maintained'
            : 'partial'
          : 'outside_maintained_coverage',
    interpretationMethod: 'deterministic-v1',
  };
}

export function lexicalRelevance(
  interpretation: QueryInterpretation,
  document: { name: string; aliases: string[]; capabilities: string[]; searchText: string },
): {
  ordinal: 'no_match' | 'incidental' | 'complementary' | 'partial' | 'direct';
  value: 0 | 25 | 50 | 75 | 100;
  matchedFields: string[];
  matchedTerms: string[];
} {
  const fields = {
    name: document.name.toLocaleLowerCase('en-US'),
    alias: document.aliases.join(' ').toLocaleLowerCase('en-US'),
    capability: document.capabilities.join(' ').toLocaleLowerCase('en-US'),
    knowledge: document.searchText.toLocaleLowerCase('en-US'),
  };
  const candidateTerms = [
    ...new Set([...interpretation.terms, ...interpretation.expandedTerms]),
  ].filter((term) => term !== 'ai');
  const matchedTerms = candidateTerms.filter((term) =>
    Object.values(fields).some((field) => field.includes(term)),
  );
  const explicitOutsideDomainTerms = interpretation.terms.filter((term) =>
    OUTSIDE_MAINTAINED_DOMAINS.has(term),
  );
  if (
    explicitOutsideDomainTerms.length > 0 &&
    !explicitOutsideDomainTerms.some((term) => matchedTerms.includes(term))
  ) {
    return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
  }
  const matchedFields = Object.entries(fields)
    .filter(([, field]) => matchedTerms.some((term) => field.includes(term)))
    .map(([key]) => key);
  if (interpretation.terms.length === 1 && interpretation.terms[0] === 'ai') {
    return {
      ordinal: 'complementary',
      value: 50,
      matchedFields: ['knowledge'],
      matchedTerms: ['ai'],
    };
  }
  if (!matchedTerms.length) {
    return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
  }
  const explicitTerms = interpretation.terms.filter((term) => term !== 'ai');
  const explicitMatched = explicitTerms.filter((term) => matchedTerms.includes(term));
  const expandedOnly = matchedTerms.filter((term) => !explicitTerms.includes(term));
  if (
    explicitMatched.length === 0 &&
    (expandedOnly.length < 2 ||
      !matchedFields.some((field) => field === 'capability' || field === 'knowledge'))
  ) {
    return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
  }
  const ratio = explicitTerms.length ? explicitMatched.length / explicitTerms.length : 0;
  if (ratio === 1 && matchedFields.some((field) => field === 'name' || field === 'capability')) {
    return { ordinal: 'direct', value: 100, matchedFields, matchedTerms };
  }
  if (ratio >= 0.6) return { ordinal: 'partial', value: 75, matchedFields, matchedTerms };
  if (matchedFields.includes('capability')) {
    return { ordinal: 'complementary', value: 50, matchedFields, matchedTerms };
  }
  return { ordinal: 'incidental', value: 25, matchedFields, matchedTerms };
}
