import type {
  AcquiredSqliteConnection,
  SqliteConnection,
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
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return String(value);
}
