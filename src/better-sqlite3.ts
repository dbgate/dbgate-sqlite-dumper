/**
 * Optional adapter for the `better-sqlite3` package.
 *
 * Wraps a caller-owned `better-sqlite3` `Database` as a
 * {@link SqliteConnection}. This module is never imported by the core
 * package; `better-sqlite3` is an optional peer dependency and is only
 * resolved when a consumer imports `dbgate-sqlite-dumper/better-sqlite3`
 * themselves.
 *
 * `better-sqlite3` is the driver DbGate's own SQLite plugin uses, which is
 * why it is the bundled adapter. Any other driver works through the same
 * {@link SqliteConnection} interface.
 */
import type BetterSqlite3 from 'better-sqlite3';
import type {
  SqliteConnection,
  SqliteErrorInfo,
  SqliteExecResult,
  SqliteParameterValue,
  SqliteQuery,
  SqliteQueryResult,
  SqliteRow,
  SqliteStreamOptions,
} from './connection/types.js';
import { OperationCancelledError, throwIfAborted } from './utils/errors.js';

type Database = BetterSqlite3.Database;
type Statement = BetterSqlite3.Statement<unknown[], unknown>;

function toDriverParameters(parameters: readonly SqliteParameterValue[] | undefined): unknown[] {
  return (parameters ?? []).map(value =>
    value instanceof Uint8Array && !Buffer.isBuffer(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value,
  );
}

/**
 * Prepares a statement with 64-bit integers returned as `bigint`, so no
 * catalog value is ever rounded. (Row data does not depend on this: the core
 * reads it through SQL that renders numbers as text — see `valueQuery.ts`.)
 */
function prepare(database: Database, sql: string): Statement {
  const statement = database.prepare(sql) as Statement;
  statement.safeIntegers(true);
  return statement;
}

function isMultipleStatementsError(error: unknown): boolean {
  return error instanceof RangeError && /more than one statement/i.test(error.message);
}

/**
 * Wraps an open `better-sqlite3` database. The database is **borrowed**:
 * this package never closes it.
 *
 * `better-sqlite3` is synchronous, which shapes three behaviours:
 *
 * - `stream()` steps the statement one row at a time with `iterate()`,
 *   yielding between rows, so a table of any size streams in constant
 *   memory. While a stream is open the database cannot run another
 *   statement — this package never asks it to.
 * - `cancel()` cannot interrupt a statement mid-step. Cancellation takes
 *   effect between rows and between statements, which for a dump or a
 *   restore (each statement is short) is prompt.
 * - `setDefensive()` is implemented with `unsafeMode()`, which is how
 *   `better-sqlite3` exposes `SQLITE_DBCONFIG_DEFENSIVE`. (Unsafe mode also
 *   relaxes the driver's own guard against writing while iterating; this
 *   package never does that.)
 */
export function fromBetterSqlite3(database: Database): SqliteConnection {
  const connection: SqliteConnection = {
    async query<Row extends SqliteRow = SqliteRow>(
      query: SqliteQuery,
      signal?: AbortSignal,
    ): Promise<SqliteQueryResult<Row>> {
      throwIfAborted(signal);
      const statement = prepare(database, query.sql);
      const parameters = toDriverParameters(query.parameters);
      if (statement.reader) {
        const rows = statement.all(...parameters) as Row[];
        return { rows, columns: statement.columns().map(column => column.name) };
      }
      statement.run(...parameters);
      return { rows: [] };
    },

    stream<Row extends SqliteRow = SqliteRow>(
      query: SqliteQuery,
      options?: SqliteStreamOptions,
    ): AsyncIterable<Row> {
      const signal = options?.signal;
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<Row> {
          throwIfAborted(signal);
          const statement = prepare(database, query.sql);
          if (!statement.reader) {
            statement.run(...toDriverParameters(query.parameters));
            return;
          }
          const iterator = statement.iterate(
            ...toDriverParameters(query.parameters),
          ) as IterableIterator<Row>;
          try {
            for (const row of iterator) {
              if (signal?.aborted) {
                throw new OperationCancelledError();
              }
              yield row;
            }
          } finally {
            // Finalizes the statement even when the consumer stops early,
            // which is what frees the database for the next statement.
            iterator.return?.();
          }
        },
      };
    },

    async execute(sql: string, signal?: AbortSignal): Promise<SqliteExecResult> {
      throwIfAborted(signal);
      let statement: Statement;
      try {
        statement = prepare(database, sql);
      } catch (error) {
        if (!isMultipleStatementsError(error)) {
          throw error;
        }
        // Text the shell would run as several statements at once. Rare in a
        // restore (the parser splits statements), but valid input.
        const before = totalChanges(database);
        database.exec(sql);
        return { changes: totalChanges(database) - before };
      }
      if (statement.reader) {
        // A script's own SELECT or PRAGMA query: step it to completion, as
        // the shell would, without keeping the rows.
        for (const _row of statement.iterate()) {
          // discard
        }
        return { changes: 0 };
      }
      const info = statement.run();
      return { changes: Number(info.changes) };
    },

    describeError(error: unknown): SqliteErrorInfo | undefined {
      if (!(error instanceof Error)) {
        return undefined;
      }
      const code = (error as { code?: unknown }).code;
      return {
        ...(typeof code === 'string' ? { code } : {}),
        message: error.message,
      };
    },

    isInTransaction(): boolean {
      return database.inTransaction;
    },

    async setDefensive(enabled: boolean): Promise<void> {
      database.unsafeMode(!enabled);
    },

    async cancel(): Promise<void> {
      // better-sqlite3 runs each statement synchronously to completion;
      // there is nothing in flight to interrupt.
    },
  };
  return connection;
}

function totalChanges(database: Database): number {
  return Number(database.prepare('SELECT total_changes()').pluck().get());
}

export interface ConnectedBetterSqlite3 {
  readonly connection: SqliteConnection;
  /** The underlying `better-sqlite3` database, for anything the adapter does not cover. */
  readonly database: Database;
  /** Closes the database. Idempotent. */
  close(): Promise<void>;
}

/**
 * Opens a database file with `better-sqlite3` and wraps it. Unlike
 * {@link fromBetterSqlite3}, the returned `close()` owns the handle.
 *
 * `better-sqlite3` is loaded lazily, so importing this module does not
 * require the optional peer dependency to be installed until this function
 * is actually called.
 */
export async function connectBetterSqlite3(
  filename: string,
  options?: BetterSqlite3.Options,
): Promise<ConnectedBetterSqlite3> {
  const module = await import('better-sqlite3');
  const DatabaseConstructor = (module.default ?? module) as unknown as new (
    filename: string,
    options?: BetterSqlite3.Options,
  ) => Database;
  const database = new DatabaseConstructor(filename, options);
  let closed = false;
  return {
    connection: fromBetterSqlite3(database),
    database,
    close: async () => {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
