export function uniqueCandidateTerms(groups: readonly (readonly string[])[], limit = 64): string[] {
  return groups
    .flat()
    .map((term) => term.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))
    .filter(Boolean)
    .filter((term, index, terms) => terms.indexOf(term) === index)
    .slice(0, limit);
}

export function postgresPrefixTsQuery(terms: readonly string[], limit = 48): string {
  const lexemes = terms
    .flatMap((term) => term.match(/[a-z0-9]+/g) ?? [])
    .filter((term, index, values) => values.indexOf(term) === index)
    .slice(0, limit);
  return lexemes.map((term) => `${term}:*`).join(' | ');
}
