import type { SqliteConnectionInput, SqliteErrorInfo } from '../connection/types.js';
import type { RestoreProgressCallback } from '../utils/progress.js';
import type { StatementSourceLocation } from './location.js';
import type { SqlDumpSource } from './source.js';
import type { SqlStatementParserOptions } from './statementParser.js';

export interface RestoreOptions extends SqlStatementParserOptions {
  /** Stop at the first statement that fails. Defaults to `true`. */
  readonly stopOnError?: boolean;
  /**
   * Put back the connection state a dump changes, whether or not the
   * restore runs to the end. Defaults to `true`. Specifically:
   *
   * - a transaction the *script* opened (`BEGIN TRANSACTION;`) and never
   *   closed — because a statement failed, the restore was cancelled, or the
   *   file was truncated before its `COMMIT` — is rolled back, exactly as the
   *   `sqlite3` shell's exit would roll it back. Otherwise the caller would
   *   get the handle back mid-transaction, holding a write lock on the file;
   * - `PRAGMA foreign_keys` is returned to its value before the restore. A
   *   native dump turns enforcement off in its first line and never turns it
   *   back on, which is harmless in a shell that then exits, and a silent
   *   integrity hazard on a long-lived handle;
   * - `PRAGMA writable_schema` is turned back off if the script left it on;
   * - defensive mode is re-enabled if this restore disabled it.
   */
  readonly restoreSessionState?: boolean;
  /**
   * What to do when a dump recreates virtual tables by writing
   * `sqlite_schema` directly, as every native `.dump` of such a database
   * does (see `renderVirtualTable`).
   *
   * - `'allow'` (default): when the adapter supports it, lift
   *   `SQLITE_DBCONFIG_DEFENSIVE` for the duration of the restore (the dump's
   *   own header says it requires that), and afterwards reload the schema so
   *   the restored virtual tables are usable on the same handle.
   * - `'refuse'`: fail every statement that writes the schema table.
   */
  readonly schemaWrites?: 'allow' | 'refuse';
  /**
   * Transaction handling.
   *
   * - `'script'` (default): statements run exactly as written, so the
   *   dump's own `BEGIN TRANSACTION` / `COMMIT` decide atomicity — which
   *   for any full dump means the whole restore is one transaction.
   * - `'wrap'`: this package opens its own transaction before the first
   *   statement that is not a `PRAGMA`, skips the script's own
   *   transaction-control statements, and commits at the end — or rolls
   *   everything back on failure. Useful for a data-only dump, which has no
   *   transaction of its own and would otherwise commit (and sync to disk)
   *   once per row.
   */
  readonly transaction?: 'script' | 'wrap';
  /**
   * After a successful restore, run `PRAGMA foreign_key_check` and report
   * every violation as a `foreign-key-violation` warning. Defaults to
   * `false`. A dump is loaded with enforcement off, so a source database
   * that already violated its own foreign keys restores without complaint;
   * this makes that visible.
   */
  readonly verifyForeignKeys?: boolean;
  /**
   * Run `PRAGMA foreign_keys=OFF` before the first statement, and put the
   * previous value back afterwards. Defaults to `false`.
   *
   * A full dump turns enforcement off itself, in its first line. A
   * data-only dump does not (neither does the native `--data-only`), and
   * the `sqlite3` shell never needs it to, because the shell starts with
   * enforcement off — while `better-sqlite3`, like most drivers, turns it on.
   * Loading a data-only dump whose tables reference each other in both
   * directions therefore needs this.
   */
  readonly disableForeignKeys?: boolean;
}

export interface SqlDumpRestoreRequest {
  readonly connection: SqliteConnectionInput;
  readonly source: SqlDumpSource;
  readonly options?: RestoreOptions;
  readonly signal?: AbortSignal;
  readonly progress?: RestoreProgressCallback;
}

/** One statement that parsed successfully but failed when executed. */
export interface RestoreStatementError {
  readonly statementIndex: number;
  readonly location: StatementSourceLocation;
  /** Truncated, secret-redacted preview of the failing statement. */
  readonly sqlPreview: string;
  readonly message: string;
  /** SQLite's own result code, when the adapter can report it. */
  readonly sqliteError?: SqliteErrorInfo;
}

export interface SqlDumpRestoreResult {
  readonly statementsExecuted: number;
  readonly statementsFailed: number;
  /**
   * Sum of the rows changed by every successfully executed statement. In
   * practice this is rows inserted, since DDL changes none — but it is a
   * straightforward sum, so a script's own `UPDATE`/`DELETE` statements
   * contribute too.
   */
  readonly rowsRestored: number;
  /** Bytes of the source consumed. */
  readonly bytesConsumed: number;
  readonly errors: readonly RestoreStatementError[];
  readonly warnings: readonly RestoreWarning[];
  readonly cancelled: boolean;
}

export interface RestoreWarning {
  readonly code: string;
  readonly message: string;
  readonly statementIndex?: number;
}
