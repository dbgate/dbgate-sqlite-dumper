import { createHash } from 'node:crypto';

/**
 * Builds a collision-resistant identity string from ordered parts.
 *
 * Parts are length-prefixed rather than joined with a separator, because
 * SQLite identifiers may contain any character at all — including
 * whatever separator would otherwise be chosen. Without the prefix,
 * `["a.b", "c"]` and `["a", "b.c"]` would produce the same identity.
 */
export function createCanonicalIdentity(parts: readonly string[]): string {
  return parts.map(part => `${part.length}:${part}`).join('|');
}

/** Stable short hash of a canonical identity, used as an archive entry's `dumpId`. */
export function createDumpId(identity: string): string {
  return createHash('sha1').update(identity, 'utf8').digest('hex').slice(0, 16);
}
