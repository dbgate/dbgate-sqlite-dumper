import type { SqliteCapabilities, SqliteVersion } from './types.js';

/**
 * Derives {@link SqliteCapabilities} from a detected {@link SqliteVersion}.
 *
 * Gating is by `versionNumber` (`major*1000000 + minor*1000 + patch`), so a
 * capability is gated at the exact release that shipped it. Each gate is the
 * release named in SQLite's own change log for that feature.
 */
export function detectSqliteCapabilities(version: SqliteVersion): SqliteCapabilities {
  const atLeast = (target: number): boolean => version.versionNumber >= target;
  return {
    supportsWithoutRowid: atLeast(3_008_002),
    supportsMultiRowValues: atLeast(3_007_011),
    supportsPragmaFunctions: atLeast(3_016_000),
    supportsTableXinfo: atLeast(3_026_000),
    supportsGeneratedColumns: atLeast(3_031_000),
    supportsSqliteSchemaAlias: atLeast(3_033_000),
    supportsWritableSchemaReset: atLeast(3_035_000),
    supportsStrictTables: atLeast(3_037_000),
    supportsTableList: atLeast(3_037_000),
  };
}
