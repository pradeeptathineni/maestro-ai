import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessDependencyAudit } from './dependency-audit-policy.mjs';

const advisory = {
  source: 1240992,
  name: 'braces',
  dependency: 'braces',
  title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  severity: 'high',
  cwe: ['CWE-674'],
  cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
  range: '<=3.0.3',
};
const fixAvailable = { name: 'repomix', version: '1.18.0', isSemVerMajor: true };
const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    braces: {
      name: 'braces',
      severity: 'high',
      isDirect: false,
      via: [advisory],
      effects: ['micromatch'],
      range: '*',
      nodes: ['node_modules/braces'],
      fixAvailable,
    },
    'fast-glob': {
      name: 'fast-glob',
      severity: 'high',
      isDirect: false,
      via: ['micromatch'],
      effects: ['globby'],
      range: '*',
      nodes: ['node_modules/fast-glob'],
      fixAvailable,
    },
    globby: {
      name: 'globby',
      severity: 'high',
      isDirect: false,
      via: ['fast-glob', 'micromatch'],
      effects: ['repomix'],
      range: '>=8.0.0',
      nodes: ['node_modules/globby'],
      fixAvailable,
    },
    micromatch: {
      name: 'micromatch',
      severity: 'high',
      isDirect: false,
      via: ['braces'],
      effects: ['fast-glob', 'globby'],
      range: '>=0.2.0',
      nodes: ['node_modules/micromatch'],
      fixAvailable,
    },
    repomix: {
      name: 'repomix',
      severity: 'high',
      isDirect: true,
      via: ['globby'],
      effects: [],
      range: '>=1.18.1',
      nodes: ['node_modules/repomix'],
      fixAvailable,
    },
  },
};
const manifest = {
  dependencies: {},
  devDependencies: { repomix: '1.18.1' },
  scripts: { 'context:pack': 'repomix --config repomix.config.json' },
};
const lockfile = {
  packages: {
    'node_modules/repomix': { version: '1.18.1', dev: true },
    'node_modules/globby': { version: '16.2.4', dev: true },
    'node_modules/fast-glob': { version: '3.3.3', dev: true },
    'node_modules/micromatch': { version: '4.0.8', dev: true },
    'node_modules/braces': { version: '3.0.3', dev: true },
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

test('accepts only the exact reviewed development-only advisory path', () => {
  assert.deepEqual(assessDependencyAudit(report, manifest, lockfile), {
    accepted: true,
    waived: true,
    errors: [],
  });
});

test('passes a clean audit without consulting the exception', () => {
  assert.deepEqual(assessDependencyAudit({ auditReportVersion: 2, vulnerabilities: {} }, {}, {}), {
    accepted: true,
    waived: false,
    errors: [],
  });
});

test('fails closed on malformed audit output', () => {
  assert.equal(assessDependencyAudit({}, manifest, lockfile).accepted, false);
});

test('rejects an additional high advisory', () => {
  const changed = clone(report);
  changed.vulnerabilities.unexpected = {
    severity: 'high',
    isDirect: true,
    via: [],
    effects: [],
    nodes: ['node_modules/unexpected'],
  };
  assert.equal(assessDependencyAudit(changed, manifest, lockfile).accepted, false);
});

test('rejects runtime reachability or dependency-tree drift', () => {
  const runtimeManifest = clone(manifest);
  runtimeManifest.dependencies.repomix = '1.18.1';
  assert.equal(assessDependencyAudit(report, runtimeManifest, lockfile).accepted, false);

  const changedLock = clone(lockfile);
  changedLock.packages['node_modules/braces'].version = '3.0.4';
  assert.equal(assessDependencyAudit(report, manifest, changedLock).accepted, false);
});

test('rejects changed fix metadata so a future patch requires review', () => {
  const changed = clone(report);
  changed.vulnerabilities.braces.fixAvailable = true;
  assert.equal(assessDependencyAudit(changed, manifest, lockfile).accepted, false);
});
