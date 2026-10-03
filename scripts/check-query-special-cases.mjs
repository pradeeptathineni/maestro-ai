import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = [
  'apps/api/src',
  'apps/web/src',
  'apps/worker/src',
  'packages/adapters/src',
  'packages/db/src',
  'packages/domain/src',
  'packages/scoring/src',
  'packages/seed/src',
];
const runtimeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);

async function filesUnder(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (
      runtimeExtensions.has(extname(entry.name)) &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.') &&
      !entry.name.includes('evaluation.')
    ) {
      files.push(path);
    }
  }
  return files;
}

const forbidden = [
  {
    id: 'development-query-literal',
    pattern: /["'`]AI context reduction["'`]|["'`]ai models["'`]/i,
  },
  {
    id: 'short-query-branch',
    pattern:
      /(?:query|normalizedText|normalized|term|terms\[[^\]]+\])\s*===?\s*["'`](?:ai|devops|ml|cs)["'`]/i,
  },
  {
    id: 'development-landscape-map',
    pattern: /\b(?:LANDSCAPES|broadAiQuery|broadAiOnly)\b/,
  },
  {
    id: 'runtime-qrels-import',
    pattern: /(?:from|import\()["'`][^"'`]*(?:evaluation|qrels|golden-set)[^"'`]*/i,
  },
  {
    id: 'expected-answer-map',
    pattern: /\b(?:expectedCandidates|acceptableCandidates|prohibitedCandidates)\b/,
  },
  {
    id: 'query-derived-scaffold-filter',
    pattern: /\bREQUEST_SCAFFOLD_WORDS\b/,
  },
];

const files = (await Promise.all(sourceRoots.map(filesUnder))).flat();
const violations = [];
for (const file of files) {
  const content = await readFile(join(root, file), 'utf8');
  for (const rule of forbidden) {
    const match = rule.pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split('\n').length;
    violations.push({ rule: rule.id, file: relative(root, join(root, file)), line });
  }
}

const report = {
  policy: 'query-special-case-check-v2',
  scannedFiles: files.length,
  violations,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (violations.length) process.exitCode = 1;
