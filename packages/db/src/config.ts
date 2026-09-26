export const DEFAULT_DATABASE_URL = 'postgres://maestro:maestro@127.0.0.1:54329/maestro';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
