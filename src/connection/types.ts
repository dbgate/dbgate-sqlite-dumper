/**
 * Client-agnostic SQLite connection abstraction.
 *
 * The core package never imports a Node.js driver directly. Callers provide
 * a {@link SqliteConnection} (or a {@link SqliteConnectionSource} that can
 * acquire one) implemented by an adapter such as
 * `dbgate-sqlite-dumper/better-sqlite3`.
 *
 * SQLite is an embedded engine, so a "connection" here is one open database
 * handle. The contract is deliberately the same shape the sibling dumper
 * packages use for their network drivers, so an application can treat every
 * dumper the same way.
 */

/** Scalar values accepted as bound query parameters (`?` placeholders). */
export type SqliteParameterValue = string | number | bigint | Buffer | Uint8Array | null;

/** A single SQL statement plus its positional (`?`) parameters. */
export interface SqliteQuery {
  readonly sql: string;
  /** Bound in order for each `?` placeholder. Adapters must never string-interpolate these. */
  readonly parameters?: readonly SqliteParameterValue[];
}

/**
 * Scalar values that can appear in a returned row: SQLite's five storage
 * classes as JavaScript sees them.
 *
 * `INTEGER` may arrive as `number` or `bigint` depending on the adapter; the
 * core never relies on either for exactness. Row data is read through SQL
 * that has SQLite itself render every numeric value as text (see
 * `data/valueQuery.ts`), so a 64-bit integer or a `REAL`'s exact digits
 * never pass through a JavaScript number on the way into the dump.
 */
export type SqliteColumnValue = string | number | bigint | Buffer | Uint8Array | null;

/** A single result row, keyed by column name. */
export interface SqliteRow {
  readonly [column: string]: SqliteColumnValue;
}

/** Buffered result of a non-streaming query. */
export interface SqliteQueryResult<Row extends SqliteRow = SqliteRow> {
  readonly rows: readonly Row[];
  /** Result column names, in order, when the adapter can report them. */
  readonly columns?: readonly string[];
}

export interface SqliteStreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Hint for adapters that fetch rows in batches. SQLite steps one row at a
   * time in-process, so most adapters simply ignore it.
   */
  readonly batchSize?: number;
}

/** Result of executing one statement through {@link SqliteConnection.execute}. */
export interface SqliteExecResult {
  /**
   * Rows inserted, updated or deleted by *this* statement — `0` for DDL and
   * for statements that return rows. Adapters must not report SQLite's
   * `sqlite3_changes()` for a statement that is not DML, because it still
   * holds the count from the previous DML statement.
   */
  readonly changes: number;
}

/** Structured information about a SQLite error, extracted by an adapter. */
export interface SqliteErrorInfo {
  /** Symbolic (extended) result code, e.g. `SQLITE_CONSTRAINT_UNIQUE`. */
  readonly code?: string;
  /** Numeric (extended) result code, e.g. `2067`, when the adapter can report it. */
  readonly errno?: number;
  readonly message: string;
}

/**
 * One open SQLite database handle.
 *
 * Implementations must serialize statements sent through the same handle.
 * In particular, while a {@link stream} is being consumed no other statement
 * is sent on it — this package never interleaves them, because most
 * synchronous drivers refuse to run a second statement while one is still
 * stepping.
 */
export interface SqliteConnection {
  query<Row extends SqliteRow = SqliteRow>(
    query: SqliteQuery,
    signal?: AbortSignal,
  ): Promise<SqliteQueryResult<Row>>;

  /** Streams rows without buffering the full result set in memory. */
  stream<Row extends SqliteRow = SqliteRow>(
    query: SqliteQuery,
    options?: SqliteStreamOptions,
  ): AsyncIterable<Row>;

  /**
   * Executes one already-complete statement's SQL text with no parameter
   * binding and no client-side rewriting.
   *
   * Restore routes every statement through this rather than `query()`
   * because a dump's statement text must reach SQLite byte for byte: a driver
   * that treats `?` or `:name` as a placeholder would corrupt any `INSERT`
   * carrying one inside a string literal. Adapters that cannot make this
   * guarantee may omit it; callers then fall back to `query()` with no
   * parameters.
   */
  execute?(sql: string, signal?: AbortSignal): Promise<SqliteExecResult>;

  /** Extracts structured error fields from a driver error, for diagnostics. */
  describeError?(error: unknown): SqliteErrorInfo | undefined;

  /**
   * Whether a transaction is open on this handle (`!sqlite3_get_autocommit`).
   *
   * SQLite has no SQL-level way to ask this, and it matters: a restore that
   * stops part-way through a dump's own `BEGIN TRANSACTION` must roll it back
   * before handing the handle back, or the caller inherits an open
   * transaction holding a write lock on the file. Adapters that cannot answer
   * may omit it; restore then tracks the script's own transaction statements
   * instead.
   */
  isInTransaction?(): boolean;

  /**
   * Turns `SQLITE_DBCONFIG_DEFENSIVE` on or off.
   *
   * A dump of a database containing virtual tables recreates them by
   * inserting into `sqlite_schema` under `PRAGMA writable_schema=ON` — exactly
   * as the native `.dump` does — and defensive mode forbids that. Restore
   * uses this, when the adapter provides it, to lift the restriction for the
   * duration of such a restore and put it back afterwards.
   */
  setDefensive?(enabled: boolean): Promise<void>;

  /**
   * Requests cancellation of the currently executing statement, if any.
   * Synchronous drivers cannot interrupt a statement mid-step; they
   * implement this as a no-op, and cancellation then takes effect between
   * rows and between statements.
   */
  cancel(): Promise<void>;
}

/** A connection acquired from a pool-like source, plus its release callback. */
export interface AcquiredSqliteConnection {
  readonly connection: SqliteConnection;
  /**
   * Whether this handle is exclusively held for the duration of the
   * operation. `false` for a bare {@link SqliteConnection} the caller handed
   * over directly — it may be shared, so any state this package changes on
   * it must be restored rather than assumed discarded.
   */
  readonly dedicated: boolean;
  /** Idempotent; safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Represents a resource that must be acquired to obtain one database
 * handle, such as a pool of handles onto the same file. Direct
 * {@link SqliteConnection} instances are borrowed by the library and are
 * never closed by it.
 */
export interface SqliteConnectionSource {
  acquire(signal?: AbortSignal): Promise<AcquiredSqliteConnection>;
}

/** Anything the public API accepts in place of a database handle. */
export type SqliteConnectionInput = SqliteConnection | SqliteConnectionSource;

export function isSqliteConnectionSource(
  input: SqliteConnectionInput,
): input is SqliteConnectionSource {
  return typeof (input as SqliteConnectionSource).acquire === 'function';
}
