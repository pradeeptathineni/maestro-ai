import type { ProblemDetails } from './types.js';

export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
    this.problem = problem;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const mutation = !['GET', 'HEAD'].includes(method);
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(mutation ? { 'content-type': 'application/json', 'x-maestro-request': '1' } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as T | ProblemDetails;
  if (!response.ok) throw new ApiError(body as ProblemDetails);
  return body as T;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function formatFractionPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}
