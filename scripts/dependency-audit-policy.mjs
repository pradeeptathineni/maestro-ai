import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ADVISORY_URL = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const EXPECTED_PACKAGES = ['braces', 'fast-glob', 'globby', 'micromatch', 'repomix'];

const expectedAuditEntries = {
  braces: {
    name: 'braces',
    severity: 'high',
    isDirect: false,
    via: [
      {
        source: 1240992,
        name: 'braces',
        dependency: 'braces',
        title:
          'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
        url: ADVISORY_URL,
        severity: 'high',
        cwe: ['CWE-674'],
        cvss: {
          score: 7.5,
          vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
        },
        range: '<=3.0.3',
      },
    ],
    effects: ['micromatch'],
    range: '*',
    nodes: ['node_modules/braces'],
    fixAvailable: { name: 'repomix', version: '1.18.0', isSemVerMajor: true },
  },
  'fast-glob': {
    name: 'fast-glob',
    severity: 'high',
    isDirect: false,
    via: ['micromatch'],
    effects: ['globby'],
    range: '*',
    nodes: ['node_modules/fast-glob'],
    fixAvailable: { name: 'repomix', version: '1.18.0', isSemVerMajor: true },
  },
  globby: {
    name: 'globby',
    severity: 'high',
    isDirect: false,
    via: ['fast-glob', 'micromatch'],
    effects: ['repomix'],
    range: '>=8.0.0',
    nodes: ['node_modules/globby'],
    fixAvailable: { name: 'repomix', version: '1.18.0', isSemVerMajor: true },
  },
  micromatch: {
    name: 'micromatch',
    severity: 'high',
    isDirect: false,
    via: ['braces'],
    effects: ['fast-glob', 'globby'],
    range: '>=0.2.0',
    nodes: ['node_modules/micromatch'],
    fixAvailable: { name: 'repomix', version: '1.18.0', isSemVerMajor: true },
  },
  repomix: {
    name: 'repomix',
    severity: 'high',
    isDirect: true,
    via: ['globby'],
    effects: [],
    range: '>=1.18.1',
    nodes: ['node_modules/repomix'],
    fixAvailable: { name: 'repomix', version: '1.18.0', isSemVerMajor: true },
  },
};

const expectedLockPath = {
  'node_modules/repomix': { version: '1.18.1', dev: true },
  'node_modules/globby': { version: '16.2.4', dev: true },
  'node_modules/fast-glob': { version: '3.3.3', dev: true },
  'node_modules/micromatch': { version: '4.0.8', dev: true },
  'node_modules/braces': { version: '3.0.3', dev: true },
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function assessDependencyAudit(report, manifest, lockfile) {
  const errors = [];
  if (
    report?.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities)
  ) {
    return {
      accepted: false,
      waived: false,
      errors: ['npm audit returned an unsupported or malformed report'],
    };
  }

  const vulnerabilities = report.vulnerabilities;
  const blocking = Object.fromEntries(
    Object.entries(vulnerabilities).filter(([, entry]) =>
      ['high', 'critical'].includes(entry?.severity),
    ),
  );

  if (Object.keys(blocking).length === 0) {
    return { accepted: true, waived: false, errors };
  }

  if (!equalJson(Object.keys(blocking).sort(), EXPECTED_PACKAGES)) {
    errors.push(
      `high/critical package set changed: ${Object.keys(blocking).sort().join(', ') || '(none)'}`,
    );
  }

  for (const name of EXPECTED_PACKAGES) {
    if (!equalJson(blocking[name], expectedAuditEntries[name])) {
      errors.push(`${name}: audit evidence drifted from the reviewed advisory chain`);
    }
  }

  if (manifest?.dependencies?.repomix !== undefined) {
    errors.push('repomix must not be a runtime dependency');
  }
  if (manifest?.devDependencies?.repomix !== '1.18.1') {
    errors.push('repomix must remain exact-pinned at the reviewed development-only version 1.18.1');
  }
  if (manifest?.scripts?.['context:pack'] !== 'repomix --config repomix.config.json') {
    errors.push(
      'context:pack must accept patterns only from the reviewed repository configuration',
    );
  }

  for (const [path, expected] of Object.entries(expectedLockPath)) {
    const installed = lockfile?.packages?.[path];
    if (installed?.version !== expected.version || installed?.dev !== expected.dev) {
      errors.push(`${path}: expected development-only ${expected.version}`);
    }
  }

  return { accepted: errors.length === 0, waived: errors.length === 0, errors };
}

function run() {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lockfile = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  );
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['audit', '--json', '--audit-level=high'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  if (![0, 1].includes(result.status)) {
    process.stderr.write(
      result.stderr || `npm audit failed with status ${String(result.status)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    process.stderr.write(`Could not parse npm audit JSON: ${String(error)}\n${result.stderr}`);
    process.exitCode = 1;
    return;
  }

  const assessment = assessDependencyAudit(report, manifest, lockfile);
  if (!assessment.accepted) {
    process.stderr.write(`Dependency audit policy failed:\n${assessment.errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  if (assessment.waived) {
    process.stdout.write(
      `Accepted ${ADVISORY_URL} only for the exact development-only Repomix path; ` +
        'the upstream package has no patched release and every audit or dependency-tree change fails this gate.\n',
    );
  } else {
    process.stdout.write('Dependency audit passed with no high or critical advisories.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
