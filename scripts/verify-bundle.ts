import { readFile } from 'node:fs/promises';
import { verifyVerificationBundle } from '../packages/domain/src/index.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('Usage: npm run bundle:verify -- /absolute/path/to/bundle.json\n');
  process.exitCode = 2;
} else {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const result = verifyVerificationBundle(value);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
