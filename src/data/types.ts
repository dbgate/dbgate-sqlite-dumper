import type { SqliteConnection } from '../connection/types.js';
import type { SqliteTable } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import type { DumpWriter } from '../writer/types.js';

export interface TableDataExportOptions {
  /** Row-fetch hint passed through to `connection.stream()`. */
  readonly streamBatchSize?: number;
  /**
   * Emit multi-row `INSERT INTO t VALUES(...),(...)` statements rather than
   * one statement per row. Defaults to `false`, matching the native `.dump`.
   *
   * One row per statement is not slow in SQLite: the whole dump runs inside
   * one transaction, so each `INSERT` is an in-memory b-tree update rather
   * than a disk sync. Multi-row statements make the file smaller and the
   * restore somewhat faster, at the cost of native byte-identity.
   */
  readonly extendedInsert?: boolean;
  /** With {@link extendedInsert}: maximum rows per statement. Defaults to 500. */
  readonly maxRowsPerStatement?: number;
  /**
   * With {@link extendedInsert}: approximate maximum size, in bytes, of one
   * statement. Defaults to 1 MiB — far below SQLite's own 1 GB
   * `SQLITE_MAX_SQL_LENGTH`, so a statement never approaches the limit, and
   * small enough to keep restore memory modest. A statement is closed once
   * the next row would exceed it; a single larger row is still emitted
   * alone, since one row cannot be split.
   */
  readonly maxStatementBytes?: number;
  /**
   * Keep each row's `rowid` by naming it in the `INSERT`
   * (`INSERT INTO t(rowid,a,b) VALUES(...)`), for tables whose rowid is not
   * already a declared column. The native `.dump --preserve-rowids`.
   *
   * Defaults to `false`, as natively. Without it such a table's rows get
   * fresh rowids on restore, numbered from 1 in dump order — which matters
   * when anything refers to them: an external-content FTS index, an
   * application storing rowids, or a `VACUUM`-sensitive process.
   */
  readonly preserveRowids?: boolean;
  /**
   * Write newlines and carriage returns inside string literals raw, instead
   * of the native default `replace('...\n...','\n',char(10))` form. The
   * native `.dump --newlines`. Defaults to `false`.
   */
  readonly rawNewlines?: boolean;
}

export interface TableDataExportRequest {
  readonly connection: SqliteConnection;
  /** Schema the table lives in: `main`, `temp`, or an attached database's name. */
  readonly schemaName: string;
  readonly table: SqliteTable;
  readonly writer: DumpWriter;
  /**
   * `PRAGMA encoding` of the database. Text values are read as their stored
   * bytes in a UTF-8 database; see `columnValueSelect`. Defaults to `UTF-8`.
   */
  readonly encoding?: string;
  /**
   * For `sqlite_sequence` and the `sqlite_stat*` tables only: keep just the
   * rows that belong to these tables. Used by partial dumps; see
   * `ArchiveEntry.systemRowFilter`.
   */
  readonly systemRowFilter?: readonly string[];
  readonly options?: TableDataExportOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: DumpProgressCallback;
}

export interface TableDataExportResult {
  readonly rowsExported: number;
  readonly bytesWritten: number;
  readonly statementsWritten: number;
  readonly cancelled: boolean;
  readonly warnings: readonly SqliteDiagnostic[];
}
