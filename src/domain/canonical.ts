import { createHash } from 'node:crypto';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Deterministic JSON serialisation: object keys sorted, no incidental whitespace.
 * Used for idempotency request fingerprints and approval proposal snapshots, where
 * two semantically identical payloads must produce byte-identical output.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
  return `{${parts.join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable fingerprint of a request body / snapshot. */
export function canonicalHash(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}
