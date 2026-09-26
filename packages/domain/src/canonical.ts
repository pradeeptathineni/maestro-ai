import { createHash } from 'node:crypto';

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | CanonicalObject;
type CanonicalObject = { [key: string]: CanonicalValue };

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('Canonical JSON cannot encode non-finite numbers.');
  }
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return normalizeNumber(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === 'object') {
    const result: CanonicalObject = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        result[key] = canonicalize(entry);
      }
    }
    return result;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
