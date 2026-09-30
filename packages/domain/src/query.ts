export type QueryFacetOrigin = 'explicit' | 'inferred' | 'missing';

export interface QueryFacet {
  key: string;
  label: string;
  value: string;
  origin: QueryFacetOrigin;
}

export type ConceptRelationType =
  'broader' | 'narrower' | 'related' | 'exact_match' | 'close_match';

export interface QueryConceptRelationKnowledge {
  conceptId: string;
  relationType: ConceptRelationType;
  stableKey: string;
  facetKey: string;
  label: string;
}

export interface QueryConceptKnowledge {
  conceptId: string;
  schemeKey: string;
  schemeVersion: number;
  stableKey: string;
  facetKey: string;
  preferredLabel: string;
  labels: string[];
  relations: QueryConceptRelationKnowledge[];
}

export interface QueryEntityKnowledge {
  entityId: string;
  entityClass: string;
  preferredLabel: string;
  aliases: string[];
}

export interface QueryKnowledge {
  concepts: QueryConceptKnowledge[];
  entities: QueryEntityKnowledge[];
}

export interface ResolvedQueryConcept {
  conceptId: string;
  schemeKey: string;
  schemeVersion: number;
  stableKey: string;
  facetKey: string;
  preferredLabel: string;
  matchedLabel: string;
  matchMethod: 'preferred_label' | 'alternate_label' | 'acronym' | 'token_overlap';
  relations: QueryConceptRelationKnowledge[];
}

export interface ResolvedQueryEntity {
  entityId: string;
  entityClass: string;
  preferredLabel: string;
  matchedLabel: string;
  matchMethod: 'exact' | 'mentioned';
}

export type QueryIntentMode =
  | 'exact_entity'
  | 'broad_landscape'
  | 'typed_discovery'
  | 'problem_discovery'
  | 'task_discovery'
  | 'knowledge_discovery'
  | 'constrained_discovery'
  | 'social_discovery'
  | 'temporal_discovery'
  | 'ambiguous';

export interface QueryInterpretation {
  normalizedText: string;
  terms: string[];
  expandedTerms: string[];
  canonicalConcepts: string[];
  resolvedConcepts: ResolvedQueryConcept[];
  exactEntities: ResolvedQueryEntity[];
  explicitFacets: QueryFacet[];
  inferredFacets: QueryFacet[];
  missingContext: QueryFacet[];
  capabilityGroups: string[];
  landscapeFacets: string[];
  mechanismTerms: string[];
  exclusions: string[];
  temporalTerms: string[];
  intentMode: QueryIntentMode;
  typedTarget: string | null;
  requestedEntityClasses: string[];
  sourceRoutingHints: string[];
  coverageState: 'maintained' | 'partial' | 'outside_maintained_coverage';
  initialCoverageState: 'maintained' | 'partial' | 'outside_maintained_coverage';
  coverageBasis:
    | 'taxonomy_or_identity'
    | 'local_retrieval_evidence'
    | 'interpretation_caveat'
    | 'outside_maintained_coverage';
  interpretationMethod: 'deterministic-v3';
  knowledgeStats: {
    availableConcepts: number;
    availableEntities: number;
    resolvedConcepts: number;
    resolvedEntities: number;
  };
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'several',
  'that',
  'the',
  'these',
  'those',
  'to',
  'with',
]);

const TEMPORAL_WORDS = new Set([
  'current',
  'emerging',
  'hot',
  'latest',
  'new',
  'recent',
  'today',
  'trending',
  'updated',
]);

const COMMUNITY_WORDS = new Set(['community', 'discussion', 'forum', 'people', 'social']);

const PROBLEM_WORDS = new Set([
  'avoid',
  'fix',
  'improve',
  'prevent',
  'reduce',
  'replace',
  'solve',
  'struggle',
]);

const AUTHORITY_WORDS = new Set(['deploy', 'execute', 'install', 'invoke', 'run']);
const EXCLUSION_WORDS = new Set(['except', 'exclude', 'excluding', 'not', 'without']);

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function bounded(value: string, maximum: number): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function normalizedWords(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}+#.-]+/gu)
      ?.map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
      .filter(Boolean) ?? []
  );
}

function normalizedPhrase(value: string): string {
  return normalizedWords(value.replaceAll('-', ' ')).join(' ');
}

function wordVariants(word: string): Set<string> {
  const variants = new Set([word]);
  if (word.endsWith('ies') && word.length > 4) variants.add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es') && word.length > 4) variants.add(word.slice(0, -2));
  if (word.endsWith('s') && word.length > 3) variants.add(word.slice(0, -1));
  if (word.endsWith('y') && word.length > 3) variants.add(`${word.slice(0, -1)}ies`);
  else {
    variants.add(`${word}s`);
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('ch')) {
      variants.add(`${word}es`);
    }
  }
  return variants;
}

function normalizedPhrasePresent(value: string, phrase: string): boolean {
  const valueWords = normalizedWords(value);
  const phraseWords = normalizedWords(phrase);
  if (!phraseWords.length || phraseWords.length > valueWords.length) return false;
  for (let start = 0; start <= valueWords.length - phraseWords.length; start += 1) {
    const matches = phraseWords.every((word, index) =>
      wordVariants(word).has(valueWords[start + index]!),
    );
    if (matches) return true;
  }
  return false;
}

function acronym(value: string): string | null {
  const words = normalizedWords(value).filter((word) => !STOP_WORDS.has(word));
  if (words.length < 2 || words.length > 6) return null;
  const result = words.map((word) => word[0]).join('');
  return result.length >= 2 && result.length <= 6 ? result : null;
}

function conceptLabels(concept: QueryConceptKnowledge): string[] {
  const stableLabel = concept.stableKey.split(':').at(-1)?.replaceAll('-', ' ') ?? '';
  return unique(
    [concept.preferredLabel, ...concept.labels, stableLabel].map((label) => bounded(label, 160)),
  ).filter(Boolean);
}

function tokenOverlap(left: string[], right: string[]): number {
  return left.filter((leftWord) =>
    right.some(
      (rightWord) => wordVariants(leftWord).has(rightWord) || wordVariants(rightWord).has(leftWord),
    ),
  ).length;
}

function resolveConcepts(
  normalizedText: string,
  meaningfulTerms: string[],
  concepts: QueryConceptKnowledge[],
): ResolvedQueryConcept[] {
  const matches: Array<ResolvedQueryConcept & { specificity: number }> = [];
  for (const concept of concepts) {
    const labels = conceptLabels(concept);
    const labelMatch = labels
      .filter((label) => normalizedPhrasePresent(normalizedText, label))
      .sort((left, right) => normalizedWords(right).length - normalizedWords(left).length)[0];
    const preferredAcronym = acronym(concept.preferredLabel);
    const acronymMatch =
      !labelMatch &&
      preferredAcronym &&
      meaningfulTerms.length <= 4 &&
      meaningfulTerms.includes(preferredAcronym)
        ? preferredAcronym
        : null;
    const overlapMatch =
      !labelMatch && !acronymMatch && !['entity_class', 'document_type'].includes(concept.facetKey)
        ? labels
            .map((label) => {
              const labelWords = normalizedWords(label).filter((word) => !STOP_WORDS.has(word));
              const overlap = tokenOverlap(labelWords, meaningfulTerms);
              return {
                label,
                overlap,
                coverage: labelWords.length ? overlap / labelWords.length : 0,
              };
            })
            .filter((candidate) => candidate.overlap >= 2 && candidate.coverage >= 0.5)
            .sort(
              (left, right) =>
                right.overlap - left.overlap ||
                right.coverage - left.coverage ||
                left.label.length - right.label.length,
            )[0]
        : null;
    if (!labelMatch && !acronymMatch && !overlapMatch) continue;
    const matchedLabel = labelMatch ?? acronymMatch ?? overlapMatch!.label;
    matches.push({
      conceptId: concept.conceptId,
      schemeKey: concept.schemeKey,
      schemeVersion: concept.schemeVersion,
      stableKey: concept.stableKey,
      facetKey: concept.facetKey,
      preferredLabel: concept.preferredLabel,
      matchedLabel,
      matchMethod: acronymMatch
        ? 'acronym'
        : overlapMatch
          ? 'token_overlap'
          : normalizedPhrase(labelMatch!) === normalizedPhrase(concept.preferredLabel)
            ? 'preferred_label'
            : 'alternate_label',
      relations: concept.relations.slice(0, 24),
      specificity: normalizedWords(matchedLabel).length * 100 + matchedLabel.length,
    });
  }
  return matches
    .sort(
      (left, right) =>
        right.specificity - left.specificity ||
        left.preferredLabel.localeCompare(right.preferredLabel) ||
        left.conceptId.localeCompare(right.conceptId),
    )
    .slice(0, 16)
    .map((match) => ({
      conceptId: match.conceptId,
      schemeKey: match.schemeKey,
      schemeVersion: match.schemeVersion,
      stableKey: match.stableKey,
      facetKey: match.facetKey,
      preferredLabel: match.preferredLabel,
      matchedLabel: match.matchedLabel,
      matchMethod: match.matchMethod,
      relations: match.relations,
    }));
}

function resolveEntities(
  normalizedText: string,
  entities: QueryEntityKnowledge[],
): ResolvedQueryEntity[] {
  const resolved: Array<ResolvedQueryEntity & { specificity: number }> = [];
  for (const entity of entities) {
    const labels = unique([entity.preferredLabel, ...entity.aliases]).filter(Boolean);
    const exact = labels.find((label) => normalizedPhrase(label) === normalizedText);
    const mentioned = exact
      ? null
      : labels
          .filter(
            (label) =>
              normalizedWords(label).join('').length >= 4 &&
              normalizedPhrasePresent(normalizedText, label),
          )
          .sort((left, right) => right.length - left.length)[0];
    if (!exact && !mentioned) continue;
    const matchedLabel = exact ?? mentioned!;
    resolved.push({
      entityId: entity.entityId,
      entityClass: entity.entityClass,
      preferredLabel: entity.preferredLabel,
      matchedLabel,
      matchMethod: exact ? 'exact' : 'mentioned',
      specificity: normalizedWords(matchedLabel).length * 100 + matchedLabel.length,
    });
  }
  return resolved
    .sort(
      (left, right) =>
        Number(right.matchMethod === 'exact') - Number(left.matchMethod === 'exact') ||
        right.specificity - left.specificity ||
        left.preferredLabel.localeCompare(right.preferredLabel),
    )
    .slice(0, 8)
    .map((match) => ({
      entityId: match.entityId,
      entityClass: match.entityClass,
      preferredLabel: match.preferredLabel,
      matchedLabel: match.matchedLabel,
      matchMethod: match.matchMethod,
    }));
}

function suppliedFacets(values: Record<string, string>): QueryFacet[] {
  return Object.entries(values)
    .map(([key, value]) => ({
      key: bounded(key, 80),
      label: bounded(
        key.replaceAll('_', ' ').replace(/\b\p{L}/gu, (character) => character.toUpperCase()),
        120,
      ),
      value: bounded(value, 240),
      origin: 'explicit' as const,
    }))
    .filter((facet) => facet.key && facet.value);
}

function extractExclusions(words: string[]): string[] {
  const exclusions: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (!EXCLUSION_WORDS.has(words[index]!)) continue;
    const captured: string[] = [];
    for (const candidate of words.slice(index + 1, index + 4)) {
      if (STOP_WORDS.has(candidate) || EXCLUSION_WORDS.has(candidate)) break;
      captured.push(candidate);
    }
    if (captured.length) exclusions.push(captured.join(' '));
  }
  return unique(exclusions);
}

function extractMechanisms(words: string[], resolvedConcepts: ResolvedQueryConcept[]): string[] {
  const conceptWords = new Set(
    resolvedConcepts.flatMap((concept) => normalizedWords(concept.matchedLabel)),
  );
  const candidates = words.filter(
    (word) =>
      !STOP_WORDS.has(word) &&
      !TEMPORAL_WORDS.has(word) &&
      !COMMUNITY_WORDS.has(word) &&
      !EXCLUSION_WORDS.has(word) &&
      !conceptWords.has(word),
  );
  const phrases: string[] = [];
  for (const size of [3, 2]) {
    for (let index = 0; index <= candidates.length - size; index += 1) {
      phrases.push(candidates.slice(index, index + size).join(' '));
    }
  }
  phrases.push(...candidates.filter((word) => word.length >= 4));
  return unique(phrases).slice(0, 12);
}

function typedTargetFor(
  resolvedConcepts: ResolvedQueryConcept[],
  explicitFacets: QueryFacet[],
  meaningfulTerms: string[],
): { typedTarget: string | null; requestedEntityClasses: string[] } {
  const suppliedEntityClass = explicitFacets
    .filter((facet) => facet.key === 'entity_class' || facet.key === 'entityClass')
    .map((facet) => normalizedPhrase(facet.value).replaceAll(' ', '-'));
  const entityClasses = resolvedConcepts
    .filter((concept) => concept.facetKey === 'entity_class')
    .filter((concept) => {
      const key = concept.stableKey.replace(/^entity-class:/, '');
      const matchedClassWords = new Set(normalizedWords(concept.matchedLabel));
      const classMentionIsPartOfAnotherConcept = resolvedConcepts
        .filter((candidate) => candidate.facetKey !== 'entity_class')
        .some((candidate) => {
          const candidateWords = new Set([
            ...normalizedWords(candidate.matchedLabel),
            ...normalizedWords(candidate.preferredLabel),
          ]);
          return (
            matchedClassWords.size > 0 &&
            [...matchedClassWords].every((word) =>
              [...candidateWords].some(
                (candidateWord) =>
                  wordVariants(word).has(candidateWord) || wordVariants(candidateWord).has(word),
              ),
            )
          );
        });
      const pluralMention = meaningfulTerms.some(
        (term) => term.endsWith('s') && normalizedPhrasePresent(term, concept.matchedLabel),
      );
      const leadingMention = meaningfulTerms
        .slice(0, 1)
        .some((term) => normalizedPhrasePresent(term, concept.matchedLabel));
      return (
        meaningfulTerms.length <= 5 &&
        !classMentionIsPartOfAnotherConcept &&
        (pluralMention || leadingMention || ['document', 'standard'].includes(key))
      );
    })
    .sort((left, right) => {
      const priority = (concept: ResolvedQueryConcept) =>
        ['document', 'standard'].includes(concept.stableKey.replace(/^entity-class:/, '')) ? 0 : 1;
      return priority(left) - priority(right);
    })
    .map((concept) => concept.stableKey.replace(/^entity-class:/, ''));
  const requestedEntityClasses = unique([...suppliedEntityClass, ...entityClasses]);
  if (requestedEntityClasses.length) {
    const first = requestedEntityClasses[0]!;
    return { typedTarget: first === 'document' ? 'article' : first, requestedEntityClasses };
  }
  const documentType = resolvedConcepts.find((concept) => concept.facetKey === 'document_type');
  if (!documentType) return { typedTarget: null, requestedEntityClasses };
  const key = documentType.stableKey.replace(/^document-type:/, '');
  return {
    typedTarget: ['standard', 'specification'].includes(key) ? 'standard' : 'article',
    requestedEntityClasses: ['document'],
  };
}

function inferIntent(input: {
  meaningfulTerms: string[];
  resolvedConcepts: ResolvedQueryConcept[];
  exactEntities: ResolvedQueryEntity[];
  typedTarget: string | null;
  explicitFacets: QueryFacet[];
  exclusions: string[];
  temporalTerms: string[];
}): QueryIntentMode {
  if (input.exactEntities.some((entity) => entity.matchMethod === 'exact')) return 'exact_entity';
  if (input.temporalTerms.length) return 'temporal_discovery';
  if (input.meaningfulTerms.some((term) => COMMUNITY_WORDS.has(term))) return 'social_discovery';
  if (input.explicitFacets.length || input.exclusions.length) return 'constrained_discovery';
  if (input.typedTarget === 'article' || input.typedTarget === 'standard') {
    return 'knowledge_discovery';
  }
  if (input.typedTarget) return 'typed_discovery';
  if (
    input.resolvedConcepts.some((concept) => concept.facetKey === 'domain') &&
    !input.resolvedConcepts.some((concept) =>
      ['capability', 'interface', 'service_model', 'document_type'].includes(concept.facetKey),
    ) &&
    input.meaningfulTerms.length <= 3
  ) {
    return 'broad_landscape';
  }
  if (input.meaningfulTerms.some((term) => PROBLEM_WORDS.has(term))) {
    return 'problem_discovery';
  }
  if (
    input.meaningfulTerms.length === 1 &&
    input.meaningfulTerms[0]!.length <= 4 &&
    !input.resolvedConcepts.length
  ) {
    return 'ambiguous';
  }
  return 'task_discovery';
}

export function interpretQuery(
  query: string,
  suppliedFacetValues: Record<string, string> = {},
  knowledge: QueryKnowledge = { concepts: [], entities: [] },
): QueryInterpretation {
  const normalizedText = normalizedPhrase(query).slice(0, 1000);
  if (!normalizedText) throw new TypeError('A query must contain searchable text.');
  const words = normalizedWords(normalizedText);
  const meaningfulTerms = words.filter((word) => !STOP_WORDS.has(word));
  const supplied = suppliedFacets(suppliedFacetValues);
  const suppliedTerms = supplied.flatMap((facet) => normalizedWords(facet.value));
  const terms = unique([...meaningfulTerms, ...suppliedTerms]);
  const resolvedConcepts = resolveConcepts(normalizedText, meaningfulTerms, knowledge.concepts);
  const exactEntities = resolveEntities(normalizedText, knowledge.entities);
  const exclusions = extractExclusions(words);
  const temporalTerms = unique(words.filter((word) => TEMPORAL_WORDS.has(word)));

  const detectedFacets: QueryFacet[] = [];
  if (words.includes('github')) {
    detectedFacets.push({
      key: 'distribution',
      label: 'Distribution',
      value: 'github',
      origin: 'explicit',
    });
  }
  if (words.some((word) => word === 'local' || word === 'offline')) {
    detectedFacets.push({
      key: 'locality',
      label: 'Locality',
      value: words.includes('offline') ? 'offline' : 'local',
      origin: 'explicit',
    });
  }
  if (normalizedPhrasePresent(normalizedText, 'no api key')) {
    detectedFacets.push({
      key: 'credential',
      label: 'Credential',
      value: 'no_api_key',
      origin: 'explicit',
    });
  }
  if (normalizedPhrasePresent(normalizedText, 'no network') || words.includes('offline')) {
    detectedFacets.push({
      key: 'network_constraint',
      label: 'Network constraint',
      value: 'no_network',
      origin: 'explicit',
    });
  }
  for (const exclusion of exclusions) {
    detectedFacets.push({
      key: 'exclusion',
      label: 'Exclusion',
      value: exclusion,
      origin: 'explicit',
    });
  }
  for (const temporal of temporalTerms) {
    detectedFacets.push({
      key: 'temporal',
      label: 'Temporal qualifier',
      value: temporal,
      origin: 'explicit',
    });
  }
  const suppliedKeys = new Set(supplied.map((facet) => `${facet.key}:${facet.value}`));
  const explicitFacets = [
    ...detectedFacets.filter((facet) => !suppliedKeys.has(`${facet.key}:${facet.value}`)),
    ...supplied,
  ];
  const { typedTarget, requestedEntityClasses } = typedTargetFor(
    resolvedConcepts,
    explicitFacets,
    meaningfulTerms,
  );
  const intentMode = inferIntent({
    meaningfulTerms,
    resolvedConcepts,
    exactEntities,
    typedTarget,
    explicitFacets,
    exclusions,
    temporalTerms,
  });
  const mechanismTerms = extractMechanisms(words, resolvedConcepts);
  const related = unique(
    resolvedConcepts.flatMap((concept) =>
      concept.relations
        .filter((relation) =>
          ['narrower', 'related', 'close_match', 'exact_match'].includes(relation.relationType),
        )
        .map((relation) => relation.label),
    ),
  ).slice(0, 16);
  const expandedTerms = unique([
    ...resolvedConcepts.flatMap((concept) => [
      concept.preferredLabel,
      ...concept.relations.slice(0, 12).map((relation) => relation.label),
    ]),
    ...mechanismTerms,
  ])
    .filter((term) => !terms.includes(normalizedPhrase(term)))
    .slice(0, 32);
  const inferredFacets: QueryFacet[] = resolvedConcepts.map((concept) => ({
    key: concept.facetKey,
    label: 'Resolved concept',
    value: concept.stableKey,
    origin: 'inferred' as const,
  }));
  if (
    words.includes('github') &&
    !explicitFacets.some((facet) => facet.key === 'integration_target')
  ) {
    inferredFacets.push({
      key: 'integration_target',
      label: 'Suggested interpretation',
      value: 'github_integration',
      origin: 'inferred',
    });
  }
  const missingContext: QueryFacet[] = [];
  if (words.some((word) => word === 'local' || word === 'offline')) {
    missingContext.push({
      key: 'hardware',
      label: 'Missing context',
      value: 'Hardware capacity is unknown; local and offline are distinct constraints.',
      origin: 'missing',
    });
  }
  if (words.some((word) => AUTHORITY_WORDS.has(word))) {
    missingContext.push({
      key: 'action_authority',
      label: 'Authority boundary',
      value:
        'Research does not grant installation, execution, deployment, or invocation authority.',
      origin: 'missing',
    });
  }
  if (
    words.some((word) => word === 'best' || word === 'top') &&
    normalizedPhrasePresent(normalizedText, 'selected by')
  ) {
    missingContext.push({
      key: 'independent_evidence',
      label: 'Evidence caveat',
      value:
        'Selection by the subject itself is circular and does not establish independent quality.',
      origin: 'missing',
    });
  }
  if (intentMode === 'ambiguous') {
    missingContext.push({
      key: 'ambiguity',
      label: 'Ambiguous term',
      value:
        'The short term did not resolve to a known concept or entity; alternate interpretations remain open.',
      origin: 'missing',
    });
  }

  const sourceRoutingHints = unique([
    'local_index',
    ...(resolvedConcepts.length ? ['concept_neighborhood'] : []),
    ...(exactEntities.length ? ['exact_identity'] : []),
    'general_web',
    ...(['article', 'standard'].includes(typedTarget ?? '') ||
    words.some((word) => ['paper', 'research', 'study'].includes(word))
      ? ['research_index']
      : []),
    ...(typedTarget === 'standard' ? ['standards_registry'] : []),
    ...(!['article', 'standard', 'document'].includes(typedTarget ?? '')
      ? ['implementation_forge', 'package_registry']
      : []),
    ...(resolvedConcepts.some(
      (concept) => concept.facetKey === 'interface' && concept.stableKey.endsWith('mcp-server'),
    )
      ? ['technology_registry']
      : []),
    ...(['broad_landscape', 'social_discovery', 'temporal_discovery'].includes(intentMode)
      ? ['community']
      : []),
  ]);
  const canonicalConcepts = resolvedConcepts.map((concept) => concept.preferredLabel);
  const subjectCoverageConcepts = resolvedConcepts.filter((concept) => {
    if (['domain', 'capability'].includes(concept.facetKey)) return true;
    if (!['interface', 'service_model'].includes(concept.facetKey)) return false;
    return (
      concept.matchMethod === 'acronym' ||
      normalizedWords(concept.matchedLabel).filter((word) => !STOP_WORDS.has(word)).length >= 2
    );
  });
  const capabilityGroups = unique(
    resolvedConcepts
      .filter((concept) => concept.facetKey === 'domain' || concept.facetKey === 'capability')
      .map((concept) => concept.preferredLabel),
  );
  const initialCoverageState =
    subjectCoverageConcepts.length || exactEntities.length
      ? 'maintained'
      : intentMode === 'ambiguous'
        ? 'partial'
        : 'outside_maintained_coverage';
  return {
    normalizedText,
    terms,
    expandedTerms,
    canonicalConcepts,
    resolvedConcepts,
    exactEntities,
    explicitFacets,
    inferredFacets,
    missingContext,
    capabilityGroups,
    landscapeFacets: related,
    mechanismTerms,
    exclusions,
    temporalTerms,
    intentMode,
    typedTarget,
    requestedEntityClasses,
    sourceRoutingHints,
    coverageState: initialCoverageState,
    initialCoverageState,
    coverageBasis:
      initialCoverageState === 'maintained'
        ? 'taxonomy_or_identity'
        : initialCoverageState === 'partial'
          ? 'interpretation_caveat'
          : 'outside_maintained_coverage',
    interpretationMethod: 'deterministic-v3',
    knowledgeStats: {
      availableConcepts: knowledge.concepts.length,
      availableEntities: knowledge.entities.length,
      resolvedConcepts: resolvedConcepts.length,
      resolvedEntities: exactEntities.length,
    },
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
  const explicitTerms = unique(interpretation.terms.map(normalizedPhrase)).filter(Boolean);
  const expandedTerms = unique(
    [...interpretation.expandedTerms, ...interpretation.canonicalConcepts]
      .map(normalizedPhrase)
      .filter(Boolean),
  );
  const candidateTerms = unique([...explicitTerms, ...expandedTerms]);

  return (document) => {
    const fields = [
      { key: 'name', value: normalizedPhrase(document.name) },
      { key: 'alias', value: normalizedPhrase(document.aliases.join(' ')) },
      { key: 'capability', value: normalizedPhrase(document.capabilities.join(' ')) },
      { key: 'knowledge', value: normalizedPhrase(document.searchText) },
    ];
    const termMatches = candidateTerms
      .map((term) => ({
        term,
        fields: fields
          .filter((field) => normalizedPhrasePresent(field.value, term))
          .map((field) => field.key),
      }))
      .filter((match) => match.fields.length);
    const matchedTerms = termMatches.map((match) => match.term);
    const matchedFields = fields
      .filter((field) => termMatches.some((match) => match.fields.includes(field.key)))
      .map((field) => field.key);
    const explicitMatched = explicitTerms.filter((term) => matchedTerms.includes(term));
    const conceptDirect = interpretation.canonicalConcepts.some((label) =>
      fields.some((field) => normalizedPhrasePresent(field.value, label)),
    );
    const exactEntity = interpretation.exactEntities.some((entity) =>
      [document.name, ...document.aliases].some(
        (label) => normalizedPhrase(label) === normalizedPhrase(entity.preferredLabel),
      ),
    );

    if (!termMatches.length || (!explicitMatched.length && !conceptDirect && !exactEntity)) {
      return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
    }
    const explicitRatio = explicitTerms.length
      ? explicitMatched.length / explicitTerms.length
      : conceptDirect || exactEntity
        ? 1
        : 0;
    if (!interpretation.resolvedConcepts.length && !exactEntity && explicitRatio < 0.5) {
      return { ordinal: 'no_match', value: 0, matchedFields: [], matchedTerms: [] };
    }
    const strongField = matchedFields.some((field) =>
      ['name', 'alias', 'capability'].includes(field),
    );
    if (exactEntity || (explicitRatio === 1 && strongField) || (conceptDirect && strongField)) {
      return { ordinal: 'direct', value: 100, matchedFields, matchedTerms };
    }
    if (explicitRatio >= 0.6 || (conceptDirect && explicitMatched.length > 0)) {
      return { ordinal: 'partial', value: 75, matchedFields, matchedTerms };
    }
    if (matchedFields.some((field) => field === 'capability' || field === 'knowledge')) {
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
