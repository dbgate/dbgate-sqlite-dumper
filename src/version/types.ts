/** Normalized SQLite library version. */
export interface SqliteVersion {
  /** Raw `sqlite_version()` string, e.g. `"3.45.1"`. */
  readonly versionString: string;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly patchVersion: number;
  /**
   * The numeric form SQLite itself uses for `SQLITE_VERSION_NUMBER`:
   * `major * 1000000 + minor * 1000 + patch`. `3045001` for 3.45.1.
   */
  readonly versionNumber: number;
  /** `sqlite_source_id()`, identifying the exact check-in, when available. */
  readonly sourceId?: string;
}

/**
 * Capabilities derived once from {@link SqliteVersion}. These describe what
 * the SQLite library behind a handle understands; they are used both for the
 * source (which catalog pragmas introspection may use) and, through
 * `compatibility/`, for a restore target (what DDL it can accept).
 */
export interface SqliteCapabilities {
  /** `WITHOUT ROWID` tables; 3.8.2+. */
  readonly supportsWithoutRowid: boolean;
  /** Multi-row `INSERT ... VALUES (...), (...)`; 3.7.11+. */
  readonly supportsMultiRowValues: boolean;
  /** Table-valued pragma functions (`pragma_table_info(...)`); 3.16.0+. */
  readonly supportsPragmaFunctions: boolean;
  /** `PRAGMA table_xinfo`, which reports hidden and generated columns; 3.26.0+. */
  readonly supportsTableXinfo: boolean;
  /** Generated (`GENERATED ALWAYS AS`) columns; 3.31.0+. */
  readonly supportsGeneratedColumns: boolean;
  /** The `sqlite_schema` alias for `sqlite_master`; 3.33.0+. */
  readonly supportsSqliteSchemaAlias: boolean;
  /** `PRAGMA writable_schema=RESET`; 3.35.0+. */
  readonly supportsWritableSchemaReset: boolean;
  /** `STRICT` tables; 3.37.0+. */
  readonly supportsStrictTables: boolean;
  /** `PRAGMA table_list`, which reports `WITHOUT ROWID`, `STRICT` and shadow tables; 3.37.0+. */
  readonly supportsTableList: boolean;
}

/**
 * Parses a `sqlite_version()` string. Only the leading `major.minor.patch`
 * is interpreted; anything after it is kept verbatim for reporting.
 */
export function parseSqliteVersion(versionString: string): {
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
  versionNumber: number;
} {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionString.trim());
  if (!match) {
    throw new Error(`Cannot parse SQLite version string: ${JSON.stringify(versionString)}`);
  }
  const majorVersion = Number(match[1]);
  const minorVersion = Number(match[2]);
  const patchVersion = match[3] === undefined ? 0 : Number(match[3]);
  return {
    majorVersion,
    minorVersion,
    patchVersion,
    versionNumber: majorVersion * 1_000_000 + minorVersion * 1000 + patchVersion,
  };
}
