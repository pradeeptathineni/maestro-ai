import { createHash, randomUUID } from 'node:crypto';

/**
 * Produces a UUID-shaped stable identifier for deterministic imports and fixtures.
 * It is intentionally namespaced and is not used for user-created runtime records.
 */
export function stableUuid(namespace: string, value: string): string {
  const bytes = createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newOpaqueId(): string {
  return randomUUID();
}
