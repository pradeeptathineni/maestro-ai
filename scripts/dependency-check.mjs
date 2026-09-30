import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf8'));
const direct = { ...manifest.dependencies, ...manifest.devDependencies };
const allowedLicenses = new Set(['Apache-2.0', 'ISC', 'MIT', 'MPL-2.0']);
const errors = [];

for (const [name, declaredVersion] of Object.entries(direct)) {
  const installed = JSON.parse(
    await readFile(join(rootPath, 'node_modules', name, 'package.json'), 'utf8'),
  );
  if (installed.version !== declaredVersion) {
    errors.push(`${name}: declared ${declaredVersion}, installed ${installed.version}`);
  }
  if (typeof installed.license !== 'string' || !allowedLicenses.has(installed.license)) {
    errors.push(`${name}: unreviewed direct license ${JSON.stringify(installed.license)}`);
  }
}

if (errors.length) {
  process.stderr.write(`Direct dependency review failed:\n${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Verified ${Object.keys(direct).length} exact direct versions and reviewed licenses.\n`,
  );
}
