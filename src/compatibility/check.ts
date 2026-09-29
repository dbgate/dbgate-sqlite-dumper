import type { SqliteDatabase } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import { toAsciiLowerCase, toAsciiUpperCase } from '../security/identifiers.js';
import { detectSqliteCapabilities } from '../version/capabilities.js';
import type { SqliteCapabilities } from '../version/types.js';

/**
 * A restore target's capabilities have the same shape as a source's, but the
 * two stay distinct concepts: a source's describe what introspection may
 * use, a target's what DDL it can accept.
 */
export type TargetCapabilities = SqliteCapabilities;

export { detectSqliteCapabilities as detectTargetCapabilities };

export interface TargetCompatibilityOptions {
  /**
   * Virtual table modules the target has (`PRAGMA module_list`), when known.
   * Without it, module availability is not checked.
   */
  readonly modules?: ReadonlySet<string>;
  /** The dump names `sqlite_master` rather than `sqlite_schema`; see `PlainSqlRenderOptions`. */
  readonly legacySchemaTableName?: boolean;
  /** The dump uses multi-row `INSERT ... VALUES (...), (...)`. */
  readonly extendedInsert?: boolean;
}

const FEATURE_LABELS: Record<keyof TargetCapabilities, string> = {
  supportsWithoutRowid: 'WITHOUT ROWID tables (SQLite 3.8.2+)',
  supportsMultiRowValues: 'multi-row VALUES (SQLite 3.7.11+)',
  supportsPragmaFunctions: 'table-valued pragma functions (SQLite 3.16.0+)',
  supportsTableXinfo: 'PRAGMA table_xinfo (SQLite 3.26.0+)',
  supportsGeneratedColumns: 'generated columns (SQLite 3.31.0+)',
  supportsSqliteSchemaAlias: 'the sqlite_schema table name (SQLite 3.33.0+)',
  supportsWritableSchemaReset: 'PRAGMA writable_schema=RESET (SQLite 3.35.0+)',
  supportsStrictTables: 'STRICT tables (SQLite 3.37.0+)',
  supportsTableList: 'PRAGMA table_list (SQLite 3.37.0+)',
};

/** Collations every SQLite build has. Any other must be registered by the restoring application. */
const BUILT_IN_COLLATIONS: ReadonlySet<string> = new Set(['BINARY', 'NOCASE', 'RTRIM']);

/**
 * Reports what a dump of `database` needs that `target` cannot provide.
 *
 * Feature-level rather than statement-level: the dump carries SQLite's own
 * stored DDL, so what can be checked is which features the source model
 * actually uses — which turns "restore failed with a syntax error at line
 * 4713" into "the target is SQLite 3.31 and this dump contains STRICT
 * tables".
 *
 * Never throws: callers decide whether an unsupported feature blocks the
 * restore or is merely reported.
 */
export function checkTargetCompatibility(
  database: SqliteDatabase,
  target: TargetCapabilities,
  options: TargetCompatibilityOptions = {},
): SqliteDiagnostic[] {
  const diagnostics: SqliteDiagnostic[] = [];
  const { schemaName } = database;
  const reported = new Set<keyof TargetCapabilities>();

  const require = (
    feature: keyof TargetCapabilities,
    detail: string,
    objectReference?: SqliteDiagnostic['objectReference'],
  ): void => {
    if (target[feature] || reported.has(feature)) {
      return;
    }
    reported.add(feature);
    diagnostics.push({
      severity: 'error',
      code: 'unsupported-target-feature',
      message: `Restore target does not support ${FEATURE_LABELS[feature]}, which this dump uses: ${detail}`,
      ...(objectReference === undefined ? {} : { objectReference }),
    });
  };

  const missingModules = new Set<string>();
  for (const table of database.tables) {
    const reference = { kind: 'table' as const, schemaName, name: table.name };
    if (table.strict) {
      require('supportsStrictTables', `table "${table.name}"`, reference);
    }
    if (table.withoutRowid) {
      require('supportsWithoutRowid', `table "${table.name}"`, reference);
    }
    for (const column of table.columns) {
      if (column.generated !== 'none') {
        require('supportsGeneratedColumns', `column "${table.name}"."${column.name}"`, {
          kind: 'column',
          schemaName,
          name: column.name,
          parentName: table.name,
        });
      }
    }
    if (table.kind === 'virtual') {
      if (!options.legacySchemaTableName) {
        require('supportsSqliteSchemaAlias', `virtual table "${table.name}" is recreated through INSERT INTO sqlite_schema`, reference);
      }
      const module =
        table.virtualModule === undefined ? undefined : toAsciiLowerCase(table.virtualModule);
      if (
        options.modules &&
        module !== undefined &&
        !options.modules.has(module) &&
        !missingModules.has(module)
      ) {
        missingModules.add(module);
        diagnostics.push({
          severity: 'error',
          code: 'virtual-table-module-unavailable',
          message: `Restore target has no "${table.virtualModule}" module, which virtual table "${table.name}" needs. The dump still restores — its schema row and shadow tables are plain SQL — but the table cannot be queried there until the module is loaded.`,
          objectReference: { kind: 'virtualTable', schemaName, name: table.name },
        });
      }
    }
    if (
      table.kind === 'system' &&
      /^sqlite_stat/.test(table.name) &&
      !options.legacySchemaTableName
    ) {
      require('supportsSqliteSchemaAlias', 'the statistics tables are recreated by ANALYZE sqlite_schema', reference);
    }
  }

  if (options.extendedInsert) {
    require('supportsMultiRowValues', 'dataExport.extendedInsert is enabled');
  }

  const customCollations = new Map<string, string>();
  for (const index of database.indexes) {
    for (const column of index.columns) {
      if (
        column.collation !== null &&
        !BUILT_IN_COLLATIONS.has(toAsciiUpperCase(column.collation))
      ) {
        customCollations.set(toAsciiUpperCase(column.collation), index.name);
      }
    }
  }
  for (const [collation, indexName] of customCollations) {
    diagnostics.push({
      severity: 'warning',
      code: 'custom-collation',
      message: `Index "${indexName}" uses the collation ${collation}, which is not built into SQLite. The restoring application must register it (sqlite3_create_collation) before the restore, or the index cannot be created.`,
      objectReference: { kind: 'index', schemaName, name: indexName },
    });
  }

  return diagnostics;
}
