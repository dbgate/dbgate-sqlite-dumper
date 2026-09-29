export type SqliteObjectKind =
  'database' | 'table' | 'virtualTable' | 'column' | 'index' | 'view' | 'trigger' | 'foreignKey';

/** Identifies the object a diagnostic is about. */
export interface SqliteObjectReference {
  readonly kind: SqliteObjectKind;
  /** Schema the object lives in (`main`, or an attached database's name). */
  readonly schemaName: string;
  readonly name: string;
  /** Owning table, for columns, indexes, triggers and foreign keys. */
  readonly parentName?: string;
}

export type SqliteDiagnosticSeverity = 'info' | 'warning' | 'error';

/**
 * A structured diagnostic surfaced by introspection, archive planning,
 * rendering, data export or restore. Diagnostics are never thrown as
 * exceptions for recoverable conditions; callers inspect them explicitly
 * instead of parsing log text.
 */
export interface SqliteDiagnostic {
  readonly severity: SqliteDiagnosticSeverity;
  /** Stable machine-readable identifier, e.g. `"user-version-not-dumped"`. */
  readonly code: string;
  readonly message: string;
  readonly objectReference?: SqliteObjectReference;
}
