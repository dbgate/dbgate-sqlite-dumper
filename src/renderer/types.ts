import type { ArchiveEntry, DumpArchiveInspection, DumpMode } from '../archive/types.js';
import type { SqliteDatabase } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import type { SqliteVersion } from '../version/types.js';
import type { DumpWriter } from '../writer/types.js';

export interface PlainSqlRenderOptions {
  /**
   * Wrap the dump in `PRAGMA foreign_keys=OFF;` / `BEGIN TRANSACTION;` …
   * `COMMIT;`, exactly as the native `.dump` does. Defaults to `true`, and
   * turning it off produces a `session-guards-disabled` warning.
   *
   * These are not decoration. `foreign_keys=OFF` is what lets tables be
   * created and filled in creation order whatever references what —
   * circular foreign keys included — and the transaction is what makes the
   * restore both atomic and fast: without it every `INSERT` is its own
   * transaction, and its own disk sync. A data-only dump never carries them,
   * matching `.dump --data-only`.
   */
  readonly includeSessionGuards?: boolean;
  /**
   * Emit the `/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be
   * disabled *\/` line the native `.dump` writes first when the dump
   * contains virtual tables. Defaults to `true`.
   */
  readonly includeHeaderComments?: boolean;
  /**
   * Emit `DROP ... IF EXISTS` before each object's `CREATE`, so the dump can
   * be restored over an existing copy. Defaults to `false`: the native
   * `.dump` has no such option, and a dump restored into a fresh database
   * does not need it.
   */
  readonly addDropStatements?: boolean;
  /**
   * Emit `PRAGMA user_version=…;` and `PRAGMA application_id=…;` before the
   * final `COMMIT`, when either is non-zero. Defaults to `false`, matching
   * the native `.dump` — which does not carry them, so an application that
   * versions its schema through `user_version` loses that version in a
   * native round trip. When they are not dumped, a non-zero value is
   * reported as a `user-version-not-dumped` / `application-id-not-dumped`
   * warning.
   */
  readonly includeDatabaseSettings?: boolean;
  /**
   * Write `sqlite_master` instead of `sqlite_schema` in the two places the
   * dump names the schema table (`ANALYZE sqlite_schema;` and the virtual
   * table `INSERT INTO sqlite_schema ...`). Defaults to `false`. The
   * `sqlite_schema` spelling needs SQLite 3.33.0 or later on the restoring
   * side; set this for a dump that must restore on something older.
   */
  readonly legacySchemaTableName?: boolean;
  /**
   * How to react to an archive entry that cannot be rendered. `'error'`
   * (default) fails the render; `'warn-omit'` skips the entry and records a
   * warning diagnostic.
   */
  readonly unsupportedFeaturePolicy?: 'error' | 'warn-omit';
}

export interface ResolvedPlainSqlRenderOptions {
  readonly includeSessionGuards: boolean;
  readonly includeHeaderComments: boolean;
  readonly addDropStatements: boolean;
  readonly includeDatabaseSettings: boolean;
  readonly legacySchemaTableName: boolean;
  readonly unsupportedFeaturePolicy: 'error' | 'warn-omit';
}

export function resolvePlainSqlRenderOptions(
  options?: PlainSqlRenderOptions,
): ResolvedPlainSqlRenderOptions {
  return {
    includeSessionGuards: options?.includeSessionGuards ?? true,
    includeHeaderComments: options?.includeHeaderComments ?? true,
    addDropStatements: options?.addDropStatements ?? false,
    includeDatabaseSettings: options?.includeDatabaseSettings ?? false,
    legacySchemaTableName: options?.legacySchemaTableName ?? false,
    unsupportedFeaturePolicy: options?.unsupportedFeaturePolicy ?? 'error',
  };
}

export interface PlainSqlRenderRequest {
  readonly database: SqliteDatabase;
  readonly archive: DumpArchiveInspection;
  readonly writer: DumpWriter;
  readonly options?: PlainSqlRenderOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: DumpProgressCallback;
  /** Source library version; informational. */
  readonly sourceVersion?: SqliteVersion;
  /** Which dump mode produced `archive`. Defaults to `'full'`. */
  readonly mode?: DumpMode;
  /**
   * Called for each `tableData` entry, for callers that can actually stream
   * the rows (see `dumpSqlite`, which supplies this backed by a live
   * connection). Resolve `true` once the rows have been written to
   * `writer`; resolve `false` to fall back to the default "not rendered"
   * warning for that entry.
   */
  readonly onTableData?: (entry: ArchiveEntry) => Promise<boolean>;
}

export interface PlainSqlRenderResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly warnings: readonly SqliteDiagnostic[];
  readonly cancelled: boolean;
}
