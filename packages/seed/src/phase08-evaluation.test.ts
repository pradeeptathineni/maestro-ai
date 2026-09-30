import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  phase08ChallengeQueries,
  phase08DevelopmentQueries,
  phase08ExpertDraftQrels,
  phase08LiveQueries,
} from './phase08-evaluation.js';

const runtimeRoots = [
  'apps/api/src',
  'apps/web/src',
  'apps/worker/src',
  'packages/adapters/src',
  'packages/db/src',
  'packages/domain/src',
  'packages/scoring/src',
];

async function runtimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await runtimeFiles(path)));
    else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

describe('Phase 08 evaluation strata', () => {
  it('keeps declared strata at their frozen sizes and query texts separate', () => {
    expect(phase08DevelopmentQueries).toHaveLength(80);
    expect(phase08ExpertDraftQrels).toHaveLength(50);
    expect(phase08ChallengeQueries).toHaveLength(20);
    expect(phase08LiveQueries).toHaveLength(20);
    const sets = [
      new Set(phase08DevelopmentQueries.map((item) => item.query.toLocaleLowerCase('en-US'))),
      new Set(phase08ExpertDraftQrels.map((item) => item.query.toLocaleLowerCase('en-US'))),
      new Set(phase08ChallengeQueries.map((item) => item.query.toLocaleLowerCase('en-US'))),
      new Set(phase08LiveQueries.map((item) => item.query.toLocaleLowerCase('en-US'))),
    ];
    for (let left = 0; left < sets.length; left += 1) {
      for (let right = left + 1; right < sets.length; right += 1) {
        expect([...sets[left]!].filter((query) => sets[right]!.has(query))).toEqual([]);
      }
    }
  });

  it('labels every AI-authored qrel as an unreviewed expert draft with citations', () => {
    for (const item of phase08ExpertDraftQrels) {
      expect(item.labelProvenance).toMatchObject({
        state: 'expert_draft',
        producer: 'codex_builder_ai',
        reviewer: null,
        humanGold: false,
      });
      for (const qrel of item.qrels.filter((qrel) => qrel.grade > 0)) {
        expect(qrel.citations.length, `${item.id}:${qrel.candidate}`).toBeGreaterThan(0);
        expect(qrel.citations.every((citation) => citation.startsWith('https://'))).toBe(true);
      }
    }
  });

  it('does not embed challenge query strings or evaluation imports in runtime code', async () => {
    const files = (await Promise.all(runtimeRoots.map(runtimeFiles))).flat();
    const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const joined = contents.join('\n').toLocaleLowerCase('en-US');
    for (const item of phase08ChallengeQueries) {
      expect(joined).not.toContain(item.query.toLocaleLowerCase('en-US'));
    }
    expect(joined).not.toContain('phase08expertdraftqrels');
    expect(joined).not.toContain('phase08challengequeries');
  });
});
