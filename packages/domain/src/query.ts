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
  canonicalConcepts: string[];
  explicitFacets: QueryFacet[];
  inferredFacets: QueryFacet[];
  missingContext: QueryFacet[];
  capabilityGroups: string[];
  landscapeFacets: string[];
  intentMode:
    | 'broad_landscape'
    | 'typed_discovery'
    | 'task_discovery'
    | 'knowledge_discovery'
    | 'constrained_discovery'
    | 'social_discovery'
    | 'temporal_discovery'
    | 'ambiguous';
  typedTarget: string | null;
  sourceRoutingHints: string[];
  coverageState: 'maintained' | 'partial' | 'outside_maintained_coverage';
  interpretationMethod: 'deterministic-v2';
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
      'connect',
      'connected',
      'connector',
      'connectors',
      'auth',
      'authentication',
      'instruction',
      'instructions',
      'mcp',
      'oauth',
      'plugin',
      'protocol',
      'registry',
      'skill',
      'skills',
      'standard',
      'slack',
      'tool',
      'tools',
    ],
    expansions: [
      'capability',
      'authentication',
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

const LANDSCAPES: Record<
  string,
  {
    aliases: string[];
    label: string;
    expansions: string[];
    facets: string[];
  }
> = {
  ai: {
    aliases: ['ai', 'artificial intelligence'],
    label: 'Artificial intelligence',
    expansions: [
      'artificial intelligence',
      'machine learning',
      'model',
      'inference',
      'agent',
      'neural network',
    ],
    facets: [
      'Models and providers',
      'Machine learning',
      'Agents and tools',
      'Knowledge and context',
      'Evaluation',
      'Infrastructure',
      'Standards',
      'Practices and techniques',
      'Research and learning',
      'Safety and governance',
      'Data',
      'Interfaces',
    ],
  },
  devops: {
    aliases: ['devops', 'development operations'],
    label: 'DevOps',
    expansions: [
      'continuous integration',
      'continuous delivery',
      'containers',
      'orchestration',
      'infrastructure as code',
      'observability',
      'site reliability engineering',
      'gitops',
    ],
    facets: [
      'Containers',
      'Orchestration',
      'Infrastructure as code',
      'CI/CD',
      'Observability',
      'Site reliability',
      'GitOps',
      'Release engineering',
      'Cloud platforms',
      'Configuration',
      'Security',
      'Practices and learning',
    ],
  },
  ml: {
    aliases: ['ml', 'machine learning'],
    label: 'Machine learning',
    expansions: [
      'machine learning',
      'model training',
      'neural network',
      'supervised learning',
      'unsupervised learning',
      'reinforcement learning',
      'feature engineering',
    ],
    facets: [
      'Frameworks',
      'Learning methods',
      'Training',
      'Evaluation',
      'Data and features',
      'Experiment tracking',
      'Serving and deployment',
      'Interpretability',
      'Responsible ML',
      'Research',
      'Learning resources',
      'Standards',
    ],
  },
  cs: {
    aliases: ['cs', 'computer science'],
    label: 'Computer science',
    expansions: [
      'computer science',
      'programming language',
      'algorithm',
      'data structure',
      'distributed systems',
      'operating systems',
      'database systems',
      'computer networks',
    ],
    facets: [
      'Programming languages',
      'Algorithms',
      'Data structures',
      'Systems',
      'Databases',
      'Networks',
      'Security',
      'Compilers',
      'Software engineering',
      'Theory',
      'Human-computer interaction',
      'Learning resources',
    ],
  },
};

const TYPED_TARGETS: Array<{ target: string; terms: string[] }> = [
  { target: 'standard', terms: ['standard', 'standards', 'specification', 'protocol'] },
  { target: 'article', terms: ['article', 'articles', 'paper', 'papers'] },
  { target: 'practice', terms: ['practice', 'practices', 'technique', 'techniques'] },
  { target: 'model', terms: ['model', 'models', 'model family', 'model release'] },
  { target: 'provider', terms: ['provider', 'providers', 'vendor', 'vendors'] },
  {
    target: 'implementation',
    terms: ['tool', 'tools', 'library', 'libraries', 'framework', 'frameworks'],
  },
];

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

function normalizedPhrase(value: string): string {
  return normalizedWords(value.replaceAll('-', ' ')).join(' ');
}

function normalizedPhrasePresent(normalizedValue: string, normalizedPhrase: string): boolean {
  if (!normalizedPhrase) return false;
  if (` ${normalizedValue} `.includes(` ${normalizedPhrase} `)) return true;
  const phraseWords = normalizedPhrase.split(' ');
  if (phraseWords.length !== 1 || phraseWords[0]!.length <= 3) return false;
  const term = phraseWords[0]!;
  const variants = term.endsWith('ies')
    ? [term.slice(0, -3) + 'y']
    : term.endsWith('s')
      ? [term.slice(0, -1)]
      : [term + 's'];
  return variants.some((variant) => ` ${normalizedValue} `.includes(` ${variant} `));
}

function phrasePresent(value: string, phrase: string): boolean {
  return normalizedPhrasePresent(normalizedPhrase(value), normalizedPhrase(phrase));
}

function landscapeFor(normalizedText: string, words: string[]): string | null {
  for (const [key, landscape] of Object.entries(LANDSCAPES)) {
    if (
      landscape.aliases.some(
        (alias) =>
          normalizedText === alias || (words.length <= 3 && phrasePresent(normalizedText, alias)),
      )
    ) {
      return key;
    }
  }
  return null;
}

function typedTargetFor(normalizedText: string): string | null {
  const words = normalizedWords(normalizedText);
  const phraseTarget = TYPED_TARGETS.find((entry) =>
    entry.terms
      .filter((term) => term.includes(' '))
      .some((term) => phrasePresent(normalizedText, term)),
  );
  if (phraseTarget) return phraseTarget.target;
  const matches = TYPED_TARGETS.filter((entry) =>
    entry.terms.some((term) => !term.includes(' ') && words.includes(term)),
  );
  if (!matches.length) return null;
  const knowledgeTarget = matches.find((entry) => ['standard', 'article'].includes(entry.target));
  if (knowledgeTarget) return knowledgeTarget.target;
  const pluralTypedNoun = matches.find((entry) =>
    entry.terms.some((term) => term.endsWith('s') && words.includes(term)),
  );
  if (pluralTypedNoun && words.length <= 5) return pluralTypedNoun.target;
  const leadingTypedNoun = matches.find((entry) => {
    const nounIndex = Math.min(
      ...entry.terms
        .filter((term) => !term.includes(' ') && words.includes(term))
        .map((term) => words.indexOf(term)),
    );
    return nounIndex <= 1 && ['for', 'about', 'of'].some((word) => words.includes(word));
  });
  return leadingTypedNoun?.target ?? null;
}

function intentModeFor(input: {
  normalizedText: string;
  searchable: string[];
  landscapeKey: string | null;
  typedTarget: string | null;
  explicitFacets: QueryFacet[];
}): QueryInterpretation['intentMode'] {
  if (
    input.searchable.some((term) =>
      ['latest', 'new', 'recent', 'updated', 'current'].includes(term),
    )
  ) {
    return 'temporal_discovery';
  }
  if (
    input.searchable.some((term) => ['community', 'discussion', 'people', 'social'].includes(term))
  ) {
    return 'social_discovery';
  }
  if (input.explicitFacets.length > 0) return 'constrained_discovery';
  if (input.typedTarget === 'article' || input.typedTarget === 'standard') {
    return 'knowledge_discovery';
  }
  if (input.typedTarget) return 'typed_discovery';
  if (input.landscapeKey && input.searchable.length <= 2) return 'broad_landscape';
  return input.searchable.length ? 'task_discovery' : 'ambiguous';
}

export function interpretQuery(
  query: string,
  suppliedFacets: Record<string, string> = {},
): QueryInterpretation {
  const normalizedText = normalizedWords(query).join(' ').slice(0, 1000);
  if (!normalizedText) throw new TypeError('A query must contain searchable text.');
  const words = normalizedWords(normalizedText);
  const searchable = words.filter((word) => !STOP_WORDS.has(word));
  const landscapeKey = landscapeFor(normalizedText, searchable);
  const landscape = landscapeKey ? LANDSCAPES[landscapeKey]! : null;
  const typedTarget = typedTargetFor(normalizedText);
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
    : landscape
      ? [landscape.label, ...matchedConcepts.map((concept) => concept.label)]
      : matchedConcepts.map((concept) => concept.label);
  const expandedTerms = [
    ...new Set([
      ...searchable.filter((word) => word !== 'ai'),
      ...(landscape?.expansions ?? []),
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
  const canonicalConcepts = [
    ...(landscape ? [landscape.label] : []),
    ...matchedConcepts.map((concept) => concept.label),
  ];
  const intentMode = intentModeFor({
    normalizedText,
    searchable,
    landscapeKey,
    typedTarget,
    explicitFacets,
  });
  const sourceRoutingHints = [
    'local_index',
    ...(typedTarget === 'article' || intentMode === 'knowledge_discovery' ? ['general_web'] : []),
    ...(searchable.some((term) =>
      ['mcp', 'tool', 'tools', 'assistant', 'assistants'].includes(term),
    )
      ? ['technology_registry']
      : []),
    ...(intentMode === 'social_discovery' || intentMode === 'temporal_discovery'
      ? ['community']
      : []),
    ...(typedTarget !== 'article' && typedTarget !== 'standard' ? ['implementation_forge'] : []),
  ];
  return {
    normalizedText,
    terms: [...new Set([...searchable, ...suppliedTerms])].sort(),
    expandedTerms,
    canonicalConcepts,
    explicitFacets,
    inferredFacets: unresolvedInferredFacets,
    missingContext,
    capabilityGroups,
    landscapeFacets: landscape?.facets ?? [],
    intentMode,
    typedTarget,
    sourceRoutingHints: [...new Set(sourceRoutingHints)],
    coverageState: outsideMaintainedDomain
      ? 'outside_maintained_coverage'
      : circularEndorsement
        ? 'partial'
        : aiRelated
          ? matchedConcepts.length || broadAiOnly
            ? 'maintained'
            : 'partial'
          : landscape || typedTarget
            ? 'maintained'
            : 'outside_maintained_coverage',
    interpretationMethod: 'deterministic-v2',
  };
}

export interface LexicalDocument {
  name: string;
  aliases: string[];
  capabilities: string[];
  searchText: string;
}

export interface LexicalRelevanceResult {
  ordinal: 'no_match' | 'incidental' | 'complementary' | 'partial' | 'direct';
  value: 0 | 25 | 50 | 75 | 100;
  matchedFields: string[];
  matchedTerms: string[];
}

export function compileLexicalRelevance(
  interpretation: QueryInterpretation,
): (document: LexicalDocument) => LexicalRelevanceResult {
  const broadAiQuery = interpretation.terms.length === 1 && interpretation.terms[0] === 'ai';
  const candidateTerms = [...new Set([...interpretation.terms, ...interpretation.expandedTerms])]
    .filter((term) => term !== 'ai' || broadAiQuery)
    .map((term) => ({
      term,
      normalized: normalizedPhrase(term),
    }));
  const explicitOutsideDomainTerms = interpretation.terms.filter((term) =>
    OUTSIDE_MAINTAINED_DOMAINS.has(term),
  );
  const explicitTerms = broadAiQuery
    ? interpretation.terms
    : interpretation.terms.filter((term) => term !== 'ai');
  const normalizedCanonicalConcepts = (interpretation.canonicalConcepts ?? []).map((concept) =>
    normalizedPhrase(concept),
  );

  return (document) => {
    const normalizedFields = [
      { key: 'name', value: normalizedPhrase(document.name) },
      { key: 'alias', value: normalizedPhrase(document.aliases.join(' ')) },
      { key: 'capability', value: normalizedPhrase(document.capabilities.join(' ')) },
      { key: 'knowledge', value: normalizedPhrase(document.searchText) },
    ];
    const termMatches = candidateTerms
      .map(({ term, normalized }) => ({
        term,
        fields: normalizedFields
          .filter((field) => normalizedPhrasePresent(field.value, normalized))
          .map((field) => field.key),
      }))
      .filter((match) => match.fields.length > 0);
    const matchedTerms = termMatches.map((match) => match.term);
    if (
      explicitOutsideDomainTerms.length > 0 &&
      !explicitOutsideDomainTerms.some((term) => matchedTerms.includes(term))
    ) {
      return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
    }
    const matchedFields = normalizedFields
      .filter((field) => termMatches.some((match) => match.fields.includes(field.key)))
      .map((field) => field.key);
    if (!matchedTerms.length) {
      return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
    }
    // `ai` is an umbrella landscape selector rather than a discriminating
    // lexical requirement when qualifiers exist. As the entire broad query it
    // remains a real, boundary-matched term so newly authored AI records are not
    // excluded solely because they do not repeat a longer taxonomy phrase.
    const explicitMatched = explicitTerms.filter((term) => matchedTerms.includes(term));
    const canonicalDirect =
      interpretation.intentMode === 'broad_landscape' &&
      normalizedCanonicalConcepts.some((concept) =>
        normalizedFields.some((field) => normalizedPhrasePresent(field.value, concept)),
      );
    const expandedOnly = matchedTerms.filter((term) => !explicitTerms.includes(term));
    if (
      explicitMatched.length === 0 &&
      !canonicalDirect &&
      (expandedOnly.length < 2 ||
        !matchedFields.some((field) => field === 'capability' || field === 'knowledge'))
    ) {
      return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
    }
    const ratio = explicitTerms.length ? explicitMatched.length / explicitTerms.length : 0;
    if (
      (ratio === 1 || canonicalDirect) &&
      matchedFields.some((field) => field === 'name' || field === 'alias' || field === 'capability')
    ) {
      return { ordinal: 'direct', value: 100, matchedFields, matchedTerms };
    }
    if (ratio >= 0.6) return { ordinal: 'partial', value: 75, matchedFields, matchedTerms };
    if (matchedFields.includes('capability')) {
      return { ordinal: 'complementary', value: 50, matchedFields, matchedTerms };
    }
    return { ordinal: 'incidental', value: 25, matchedFields, matchedTerms };
  };
}

export function lexicalRelevance(
  interpretation: QueryInterpretation,
  document: LexicalDocument,
): LexicalRelevanceResult {
  return compileLexicalRelevance(interpretation)(document);
}
