import type { DumpMode } from '../archive/types.js';
import type { SqliteConsistencyMode } from '../connection/session.js';
import type { TableDataExportOptions } from '../data/types.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import type { PlainSqlRenderOptions } from '../renderer/types.js';
import type { DumpObjectKinds, DumpSelection } from '../selection/types.js';

export interface DumpSqliteOptions {
  /** `'full'` (default): schema and data. `'schema-only'`: definitions only. `'data-only'`: rows only. */
  readonly mode?: DumpMode;
  /**
   * Schema to dump: `main` (default), `temp`, or an attached database's name.
   * The dump itself is schema-less — `CREATE TABLE t`, never
   * `CREATE TABLE aux.t` — so it restores into whatever database it is run
   * against, exactly like a native `.dump`.
   */
  readonly schemaName?: string;
  readonly selection?: DumpSelection;
  /** Which object kinds to include. All default to `true`, which is what the native `.dump` includes. */
  readonly objectKinds?: DumpObjectKinds;
  readonly render?: PlainSqlRenderOptions;
  /** Row rendering and batching options; see `exportTableDataAsInserts`. */
  readonly dataExport?: TableDataExportOptions;
  /**
   * How the dump obtains a consistent view. Defaults to `'snapshot'`; see
   * {@link SqliteConsistencyMode}.
   */
  readonly consistency?: SqliteConsistencyMode;
}

export interface DumpResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly warnings: readonly SqliteDiagnostic[];
  readonly cancelled: boolean;
  /** Total rows written across every exported table. */
  readonly rowsExported: number;
  /** Total `INSERT` statements written. */
  readonly statementsWritten: number;
}
