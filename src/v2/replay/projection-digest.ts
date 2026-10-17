import { createHash } from 'node:crypto';
import { ProjectionDigest } from './projection-rebuild.types';

/** Stable JSON for hashing — sorted keys, no undefined. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export async function digestProjector(
  projector: string,
  rows: unknown[],
): Promise<ProjectionDigest> {
  const ordered = [...rows].map((r) => JSON.parse(stableStringify(r)));
  ordered.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  return {
    projector,
    rowCount: ordered.length,
    digest: sha256Hex(stableStringify(ordered)),
  };
             }
