import type {
  AcquiredSqliteConnection,
  SqliteConnection,
  SqliteConnectionFeatures,
  SqliteConnectionInput,
  SqliteExecResult,
} from './types.js';
import { isSqliteConnectionSource } from './types.js';

/**
 * Normalizes a {@link SqliteConnectionInput} into an acquired connection with
 * a release callback. A direct connection resolves immediately with a no-op
 * release and `dedicated: false` (the caller may be sharing it); a source is
 * asked for one handle through its own `acquire()`, which is what snapshot
 * consistency requires.
 */
export async function acquireSqliteConnection(
  input: SqliteConnectionInput,
  signal?: AbortSignal,
): Promise<AcquiredSqliteConnection> {
  if (isSqliteConnectionSource(input)) {
    return input.acquire(signal);
  }
  return {
    connection: input as SqliteConnection,
    dedicated: false,
    release: async () => {},
  };
}

/** Runs one statement through `execute()` when the adapter has it, else through `query()`. */
export async function executeStatement(
  connection: SqliteConnection,
  sql: string,
  signal?: AbortSignal,
): Promise<SqliteExecResult> {
  if (connection.execute) {
    return connection.execute(sql, signal);
  }
  await connection.query({ sql }, signal);
  return { changes: 0 };
}

/**
 * Coerces an integer-valued catalog cell to a JavaScript number.
 *
 * Adapters may return SQLite `INTEGER`s as `number` or `bigint`; catalog
 * values (column positions, flags, `user_version`) always fit in a double,
 * so either shape is accepted here.
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

/** Coerces a text-valued catalog cell to a string, or `null` for SQL `NULL`. */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || Array.isArray(value)) {
    return toBuffer(value as Uint8Array | ArrayBuffer | readonly number[]).toString('utf8');
  }
  return String(value);
}

/**
 * Bytes as a `Buffer`, from any shape a driver returns them in: `Buffer`,
 * `Uint8Array`, `ArrayBuffer` (libSQL), or an array of byte values (the
 * JSON transport of Cloudflare D1).
 */
export function toBuffer(value: Uint8Array | ArrayBuffer | readonly number[]): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return Buffer.from(value as number[]);
}

/** {@link SqliteConnectionFeatures} with every default filled in. */
export interface ResolvedConnectionFeatures {
  readonly transactions: boolean;
  readonly pragmaFunctions: boolean;
  readonly extendedPragmas: boolean;
  readonly schemaQualifiedNames: boolean;
  readonly binaryTransport: 'native' | 'hex';
  readonly pagedReadSize: number | undefined;
  readonly reservedNamePrefixes: readonly string[];
}

export function connectionFeatures(connection: SqliteConnection): ResolvedConnectionFeatures {
  const features: SqliteConnectionFeatures = connection.features ?? {};
  const pageSize = features.pagedReadSize;
  return {
    transactions: features.transactions ?? true,
    pragmaFunctions: features.pragmaFunctions ?? true,
    extendedPragmas: features.extendedPragmas ?? true,
    schemaQualifiedNames: features.schemaQualifiedNames ?? true,
    binaryTransport: features.binaryTransport ?? 'native',
    pagedReadSize:
      pageSize === undefined || !Number.isFinite(pageSize)
        ? undefined
        : Math.max(1, Math.floor(pageSize)),
    reservedNamePrefixes: features.reservedNamePrefixes ?? [],
  };
}
