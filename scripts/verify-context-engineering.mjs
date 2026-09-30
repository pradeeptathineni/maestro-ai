import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const require = createRequire(import.meta.url);
const { compressObservation } = require('@linger-alpha/cca/src/compression/compressor.js');

const repositoryRoot = new URL('../', import.meta.url);
const hookConfig = JSON.parse(await readFile(new URL('.codex/hooks.json', repositoryRoot), 'utf8'));
const packConfig = JSON.parse(
  await readFile(new URL('repomix.config.json', repositoryRoot), 'utf8'),
);
const hook = hookConfig.hooks?.PostToolUse?.[0];
const hookCommand = hook?.hooks?.[0]?.command ?? '';

assert.equal(hook?.matcher, '^Bash$', 'compression must only observe shell results');
assert.match(
  hookCommand,
  /git rev-parse --show-toplevel/,
  'hook must resolve the active repository',
);
assert.match(hookCommand, /CCA_CONFIG_PATH/, 'hook must isolate state inside the repository');
assert.doesNotMatch(hookCommand, /\/Users\//, 'hook must not contain a developer-specific path');
assert.equal(
  packConfig.security?.enableSecurityCheck,
  true,
  'context packs require secret scanning',
);
assert.equal(packConfig.output?.compress, true, 'code context should be structural by default');
assert.ok(packConfig.output?.tokenBudget <= 30_000, 'context packs require a bounded token budget');

const rawDirectory = await mkdtemp(join(tmpdir(), 'maestro-context-fidelity-'));
try {
  const repeatedLine = 'progress: compiling deterministic workspace fixture';
  const completion = 'Build completed successfully in 8.2s';
  const stdout = `${Array.from({ length: 400 }, () => repeatedLine).join('\n')}\n${completion}`;
  const compressed = compressObservation(
    { command: 'npm run build', stdout, stderr: '', exitCode: 0 },
    { rawDir: rawDirectory },
  );

  assert.equal(compressed.changed, true, 'representative repetitive output should compress');
  assert.match(compressed.text, /raw_ref:/, 'changed output must include a recovery reference');
  assert.match(compressed.text, new RegExp(completion), 'completion evidence must remain visible');
  assert.ok(
    compressed.compressedTokensEst < compressed.rawTokensEst,
    'compression must reduce the deterministic fixture',
  );
  const recovered = await readFile(compressed.rawRef, 'utf8');
  assert.match(recovered, new RegExp(repeatedLine), 'raw output must remain locally recoverable');
  assert.match(recovered, new RegExp(completion), 'raw recovery must preserve the final result');

  const failure = 'AssertionError: revision hash mismatch at packages/domain/src/bundle.ts:88';
  const critical = compressObservation(
    {
      command: 'npm run test:integration',
      stdout: 'running integration suite',
      stderr: failure,
      exitCode: 1,
    },
    { rawDir: rawDirectory },
  );
  assert.match(critical.text, new RegExp(failure), 'critical failure evidence must remain visible');

  const inspection = compressObservation(
    { command: 'git diff --stat', stdout: 'package.json | 4 ++++', stderr: '', exitCode: 0 },
    { rawDir: rawDirectory },
  );
  assert.equal(inspection.changed, false, 'read-only inspection commands must pass through');

  const ratio = (compressed.compressedTokensEst / compressed.rawTokensEst).toFixed(3);
  process.stdout.write(
    `Context fidelity verified: fixture ${compressed.rawTokensEst} -> ${compressed.compressedTokensEst} estimated tokens (ratio ${ratio}); raw recovery, critical output, inspection passthrough, hook portability, and pack budget passed.\n`,
  );
} finally {
  await rm(rawDirectory, { recursive: true, force: true });
}
