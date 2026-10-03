import { describe, expect, it } from 'vitest';
import { postgresPrefixTsQuery, uniqueCandidateTerms } from './candidate-search.js';

describe('large-corpus candidate selection', () => {
  it('normalizes and deduplicates generic query vocabulary', () => {
    expect(
      uniqueCandidateTerms([
        [' Distributed  tracing ', 'TRACE'],
        ['distributed tracing', 'trace'],
      ]),
    ).toEqual(['distributed tracing', 'trace']);
  });

  it('builds a bounded prefix query from data rather than named evaluation cases', () => {
    expect(postgresPrefixTsQuery(['lichen spectroscopy', 'field-notebook'])).toBe(
      'lichen:* | spectroscopy:* | field:* | notebook:*',
    );
  });

  it('drops query syntax and enforces the lexeme budget', () => {
    const query = postgresPrefixTsQuery(
      Array.from({ length: 80 }, (_, index) => `term${index} & !unsafe`),
      12,
    );
    expect(query.split(' | ')).toHaveLength(12);
    expect(query).not.toContain('&');
    expect(query).not.toContain('!');
  });
});
