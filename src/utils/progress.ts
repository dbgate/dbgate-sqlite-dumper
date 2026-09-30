export type DumpProgressPhase =
  | 'connecting'
  | 'detecting-version'
  | 'starting-snapshot'
  | 'introspecting'
  | 'planning-archive'
  | 'rendering-schema'
  | 'exporting-data'
  | 'finalizing';

/** The dump section a progress event belongs to, mirroring the native `.dump` output order. */
export type DumpProgressSection =
  | 'header'
  | 'table-structure'
  | 'table-data'
  | 'virtual-table'
  | 'index'
  | 'trigger'
  | 'view'
  | 'footer';

export interface DumpProgressEvent {
  readonly phase: DumpProgressPhase;
  readonly message?: string;
  readonly section?: DumpProgressSection;
  /** Archive entries rendered so far, and the total planned. */
  readonly objectsProcessed?: number;
  readonly objectsTotal?: number;
  /** Name of the object currently being rendered/exported. */
  readonly objectName?: string;
  /** Schema being dumped (`main`, or an attached database's name). */
  readonly schemaName?: string;
  readonly tableName?: string;
  /** Rows exported from the current table. */
  readonly rowsExported?: number;
  /** Bytes written to the output so far. */
  readonly bytesWritten?: number;
  /** Lifecycle of a table data export. */
  readonly exportState?: 'started' | 'progress' | 'finished' | 'failed' | 'cancelled';
}

export type DumpProgressCallback = (event: DumpProgressEvent) => void;

export type RestoreProgressPhase =
  'connecting' | 'preflight' | 'parsing' | 'executing' | 'finalizing';

export interface RestoreProgressEvent {
  readonly phase: RestoreProgressPhase;
  readonly message?: string;
  /** Statements executed plus statements failed so far. */
  readonly statementsProcessed?: number;
  /** The statement currently being parsed/executed, 0-based in source order. */
  readonly statementIndex?: number;
  /**
   * Running total of rows changed across every statement executed so far;
   * see `SqlDumpRestoreResult.rowsRestored`.
   */
  readonly rowsRestored?: number;
  /** Bytes of the source consumed by the parser so far. */
  readonly bytesConsumed?: number;
  /**
   * The object the current statement creates or fills, read from the
   * statement itself (`CREATE TABLE t`, `INSERT INTO t`), when recognizable.
   * A native `.dump` carries no section banners, so this is the only way a
   * long restore can say where it is.
   */
  readonly currentObject?: string;
  /** Lifecycle of the current execution attempt. */
  readonly executionState?: 'started' | 'finished' | 'failed';
  /** Details of the statement failure, emitted immediately with `executionState: 'failed'`. */
  readonly error?: {
    readonly statementIndex: number;
    readonly location: { readonly startLine: number; readonly endLine: number };
    readonly sqlPreview: string;
    readonly message: string;
  };
}

export type RestoreProgressCallback = (event: RestoreProgressEvent) => void;
