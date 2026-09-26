export interface ApiConfig {
  host: string;
  port: number;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}

export function apiConfig(): ApiConfig {
  const host = process.env.MAESTRO_HOST ?? '127.0.0.1';
  const port = Number(process.env.MAESTRO_PORT ?? '4310');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('MAESTRO_HOST must be a loopback host in v0.');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('MAESTRO_PORT must be an integer from 1024 through 65535.');
  }
  const apiOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    process.env.MAESTRO_WEB_ORIGIN ?? 'http://127.0.0.1:5173',
  ];
  const hosts = apiOrigins.map((origin) => new URL(origin).host.toLowerCase());
  return {
    host,
    port,
    allowedHosts: new Set(hosts),
    allowedOrigins: new Set(apiOrigins),
  };
}
