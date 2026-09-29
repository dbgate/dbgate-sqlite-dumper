import { createCanonicalIdentity } from '../utils/hash.js';
import type { ArchiveObjectType } from './types.js';

export interface ArchiveIdentityInput {
  readonly objectType: ArchiveObjectType;
  readonly schemaName: string;
  readonly name: string;
  readonly parentName?: string;
}

export function createArchiveIdentity(input: ArchiveIdentityInput): string {
  return createCanonicalIdentity([
    input.objectType,
    input.schemaName,
    input.name,
    input.parentName ?? '',
  ]);
}
