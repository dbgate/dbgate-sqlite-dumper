/**
 * Caller-facing object selection.
 *
 * Names are exact SQLite identifiers: they are matched against the names in
 * `sqlite_schema` and are never treated as wildcard patterns (unlike the
 * native `.dump ?PATTERN?`, which takes a `LIKE` pattern).
 *
 * **Case sensitivity** follows SQLite's own rule for identifiers: ASCII
 * letters compare case-insensitively (`Orders` and `orders` are the same
 * table), and nothing else is folded.
 */
export interface DumpSelection {
  /** Exact table names to include. When omitted, all non-excluded tables are included. */
  readonly tables?: readonly string[];
  /** Exact table names to exclude, applied after {@link tables}. */
  readonly excludeTables?: readonly string[];
  /** Exact view names to include. When omitted, all non-excluded views are included. */
  readonly views?: readonly string[];
  readonly excludeViews?: readonly string[];
  /**
   * Exact trigger names to include. A trigger is dumped only when the table
   * (or view) it is attached to is dumped too.
   */
  readonly triggers?: readonly string[];
  readonly excludeTriggers?: readonly string[];
  /**
   * Exact index names to exclude. Indexes otherwise follow their table: a
   * selected table brings every index defined on it.
   */
  readonly excludeIndexes?: readonly string[];
  /**
   * Tables whose *structure* is dumped but whose rows are not. Useful for
   * large log or cache tables. A table excluded through
   * {@link excludeTables} is omitted entirely instead.
   */
  readonly dataExcludedTables?: readonly string[];
}

/**
 * Which object kinds participate in the dump at all, independent of the
 * per-name filters in {@link DumpSelection}. All default to `true`, which is
 * what the native `.dump` includes.
 */
export interface DumpObjectKinds {
  readonly includeTables?: boolean;
  readonly includeViews?: boolean;
  readonly includeIndexes?: boolean;
  readonly includeTriggers?: boolean;
  /**
   * Virtual tables (`CREATE VIRTUAL TABLE ... USING fts5(...)`) and the
   * shadow tables that hold their data.
   */
  readonly includeVirtualTables?: boolean;
  /**
   * `sqlite_sequence` (the `AUTOINCREMENT` counters) and the `sqlite_stat*`
   * tables `ANALYZE` maintains. The native `.dump --nosys` turns this off.
   */
  readonly includeSystemTables?: boolean;
}

export interface NormalizedDumpSelection {
  readonly tables?: ReadonlySet<string>;
  readonly excludeTables: ReadonlySet<string>;
  readonly views?: ReadonlySet<string>;
  readonly excludeViews: ReadonlySet<string>;
  readonly triggers?: ReadonlySet<string>;
  readonly excludeTriggers: ReadonlySet<string>;
  readonly excludeIndexes: ReadonlySet<string>;
  readonly dataExcludedTables: ReadonlySet<string>;
  /** `true` when any filter at all was given, i.e. the dump may be a subset of the database. */
  readonly isPartial: boolean;
}
