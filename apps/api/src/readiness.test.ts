import { describe, expect, it } from 'vitest';
import { assessReadiness, REQUIRED_SCHEMA_MIGRATIONS } from './readiness.js';

describe('Phase 06 readiness', () => {
  it.each([0, 12, 13, 72])('does not use catalog cardinality (%i) as readiness', (providers) => {
    expect(
      assessReadiness({
        migrations: REQUIRED_SCHEMA_MIGRATIONS,
        providers,
        workerSchemaReady: true,
        workerActive: false,
        enabledAdapters: 0,
        unhealthyAdapters: 0,
      }),
    ).toMatchObject({ ready: true, core: 'ready', worker: 'inactive' });
  });

  it('fails for missing core migrations while reporting optional systems separately', () => {
    expect(
      assessReadiness({
        migrations: REQUIRED_SCHEMA_MIGRATIONS - 1,
        providers: 12,
        workerSchemaReady: true,
        workerActive: true,
        enabledAdapters: 1,
        unhealthyAdapters: 0,
      }),
    ).toMatchObject({ ready: false, core: 'not_ready', worker: 'active' });
  });
});
