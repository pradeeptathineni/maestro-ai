export interface ReadinessState {
  migrations: number;
  providers: number;
  workerSchemaReady: boolean;
  workerActive: boolean;
  enabledAdapters: number;
  unhealthyAdapters: number;
}

export const REQUIRED_SCHEMA_MIGRATIONS = 14;

export function assessReadiness(state: ReadinessState): {
  ready: boolean;
  status: 'ready' | 'not_ready';
  core: 'ready' | 'not_ready';
  worker: 'active' | 'inactive' | 'schema_missing';
  integrations: 'disabled' | 'healthy' | 'degraded';
  warnings: string[];
} {
  const coreReady = state.migrations >= REQUIRED_SCHEMA_MIGRATIONS;
  const worker = !state.workerSchemaReady
    ? 'schema_missing'
    : state.workerActive
      ? 'active'
      : 'inactive';
  const integrations =
    state.enabledAdapters === 0 ? 'disabled' : state.unhealthyAdapters > 0 ? 'degraded' : 'healthy';
  const warnings = [
    ...(worker !== 'active'
      ? ['Background refresh/intake work is unavailable; cached exploration remains usable.']
      : []),
    ...(integrations === 'disabled'
      ? ['External discovery and local semantic adapters are disabled.']
      : integrations === 'degraded'
        ? ['One or more optional integrations report a failure.']
        : []),
  ];
  return {
    ready: coreReady,
    status: coreReady ? 'ready' : 'not_ready',
    core: coreReady ? 'ready' : 'not_ready',
    worker,
    integrations,
    warnings,
  };
}
