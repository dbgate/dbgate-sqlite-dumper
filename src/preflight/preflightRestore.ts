import { acquireSqliteConnection, toNumber, toText } from '../connection/acquire.js';
import type { SqliteConnection, SqliteConnectionInput, SqliteRow } from '../connection/types.js';
import { checkTargetCompatibility } from '../compatibility/check.js';
import type { TargetCompatibilityOptions } from '../compatibility/check.js';
import type { SqliteDatabase } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import { toAsciiLowerCase } from '../security/identifiers.js';
import { isAbortError } from '../utils/errors.js';
import { detectSqliteCapabilities } from '../version/capabilities.js';
import { detectSqliteVersion } from '../version/detect.js';
import type { SqliteCapabilities, SqliteVersion } from '../version/types.js';

export interface PreflightRestoreRequest {
  readonly connection: SqliteConnectionInput;
  /**
   * The model of the database the dump was taken from (from
   * `introspectSqlite`). With it, the report answers "what does this dump
   * need that this target cannot do"; without it, only "what can this target
   * do".
   */
  readonly database?: SqliteDatabase;
  readonly options?: TargetCompatibilityOptions & {
    /** The dump was rendered with `addDropStatements`, so existing objects are replaced rather than conflicting. */
    readonly addDropStatements?: boolean;
  };
  readonly signal?: AbortSignal;
}

export interface PreflightRestoreReport {
  readonly version: SqliteVersion;
  readonly capabilities: SqliteCapabilities;
  /** `PRAGMA encoding` of the target. */
  readonly encoding: string;
  /** Whether the target enforces foreign keys (`PRAGMA foreign_keys`). */
  readonly foreignKeysEnabled: boolean;
  /** Whether the handle is already inside a transaction. `undefined` when the adapter cannot tell. */
  readonly inTransaction?: boolean;
  /** Whether the adapter can lift defensive mode for a dump that writes `sqlite_schema`. */
  readonly canDisableDefensiveMode: boolean;
  /** Virtual table modules the target has, when `PRAGMA module_list` is available. */
  readonly modules?: readonly string[];
  /** `PRAGMA compile_options` of the target, when readable. */
  readonly compileOptions?: readonly string[];
  /** Tables, views, indexes and triggers already present in the target's `main` schema. */
  readonly existingObjects: readonly { readonly type: string; readonly name: string }[];
  readonly diagnostics: readonly SqliteDiagnostic[];
}

async function queryRows(
  connection: SqliteConnection,
  sql: string,
  signal?: AbortSignal,
): Promise<readonly SqliteRow[] | undefined> {
  try {
    return (await connection.query<SqliteRow>({ sql }, signal)).rows;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function firstValue(rows: readonly SqliteRow[] | undefined): unknown {
  const first = rows?.[0];
  return first === undefined ? undefined : Object.values(first)[0];
}

/**
 * Inspects a restore target before anything is written to it.
 *
 * Turns a failure part-way through a restore — `table t already exists`,
 * `no such module: fts5`, a syntax error on a `STRICT` table — into an
 * up-front, actionable report. Never writes to the target.
 */
export async function preflightRestore(
  request: PreflightRestoreRequest,
): Promise<PreflightRestoreReport> {
  const acquired = await acquireSqliteConnection(request.connection, request.signal);
  const connection = acquired.connection;
  const { signal } = request;
  try {
    const version = await detectSqliteVersion(connection, signal);
    const capabilities = detectSqliteCapabilities(version);
    const encoding =
      toText(firstValue(await queryRows(connection, 'PRAGMA encoding', signal))) ?? 'UTF-8';
    const foreignKeysEnabled =
      toNumber(firstValue(await queryRows(connection, 'PRAGMA foreign_keys', signal))) !== 0;
    const moduleRows = await queryRows(connection, 'SELECT name FROM pragma_module_list', signal);
    const optionRows = await queryRows(connection, 'PRAGMA compile_options', signal);
    const compileOptions = optionRows?.map(row => toText(Object.values(row)[0]) ?? '');
    const modules = moduleRows?.map(row => toText(row.name) ?? '').filter(name => name !== '');
    const existingRows =
      (await queryRows(
        connection,
        "SELECT type, name FROM main.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
        signal,
      )) ?? [];
    const existingObjects = existingRows.map(row => ({
      type: toText(row.type) ?? '',
      name: toText(row.name) ?? '',
    }));
    const inTransaction = connection.isInTransaction?.();

    const diagnostics: SqliteDiagnostic[] = [];
    if (inTransaction) {
      diagnostics.push({
        severity: 'warning',
        code: 'target-in-transaction',
        message:
          'The target handle is already inside a transaction. A full dump\'s own BEGIN TRANSACTION will fail; commit first, or restore with transaction: "wrap".',
      });
    }

    const database = request.database;
    if (database) {
      diagnostics.push(
        ...checkTargetCompatibility(database, capabilities, {
          ...request.options,
          ...(modules === undefined ? {} : { modules: new Set(modules.map(toAsciiLowerCase)) }),
        }),
      );

      const hasVirtualTables = database.tables.some(table => table.kind === 'virtual');
      if (hasVirtualTables && !connection.setDefensive) {
        diagnostics.push({
          severity: 'warning',
          code: 'defensive-mode-not-controllable',
          message:
            'This dump recreates virtual tables by writing sqlite_schema directly, which SQLITE_DBCONFIG_DEFENSIVE forbids, and this adapter cannot turn defensive mode off. The restore succeeds only if the connection is not in defensive mode.',
        });
      }

      const hasStat4 = database.tables.some(table => table.name === 'sqlite_stat4');
      if (hasStat4 && compileOptions && !compileOptions.includes('ENABLE_STAT4')) {
        diagnostics.push({
          severity: 'error',
          code: 'statistics-table-unsupported',
          message:
            "The source database has a sqlite_stat4 table, and the target SQLite is not built with SQLITE_ENABLE_STAT4, so ANALYZE there does not create it and the dump's INSERT INTO sqlite_stat4 fails. The native .dump of such a database fails the same way. Dump with objectKinds.includeSystemTables: false, or drop sqlite_stat4 from the source copy first.",
        });
      }

      if (database.encoding.toUpperCase() !== encoding.toUpperCase()) {
        diagnostics.push({
          severity: 'info',
          code: 'encoding-differs',
          message: `The source database is ${database.encoding} and the target is ${encoding}. Text is converted between the two on restore, which is lossless for valid text.`,
        });
      }

      if (!request.options?.addDropStatements) {
        const existing = new Map(
          existingObjects.map(object => [toAsciiLowerCase(object.name), object]),
        );
        const created = [
          ...database.tables.filter(table => table.kind !== 'system').map(table => table.name),
          ...database.views.map(view => view.name),
          ...database.indexes.filter(index => index.sql !== null).map(index => index.name),
          ...database.triggers.map(trigger => trigger.name),
        ];
        for (const name of created) {
          const conflict = existing.get(toAsciiLowerCase(name));
          if (conflict) {
            diagnostics.push({
              severity: 'error',
              code: 'object-already-exists',
              message: `The target already has a ${conflict.type} named "${conflict.name}", so the dump's CREATE for it will fail. Restore into an empty database, drop it first, or render the dump with addDropStatements.`,
              objectReference: { kind: 'table', schemaName: 'main', name: conflict.name },
            });
          }
        }
      }
    }

    return {
      version,
      capabilities,
      encoding,
      foreignKeysEnabled,
      ...(inTransaction === undefined ? {} : { inTransaction }),
      canDisableDefensiveMode: typeof connection.setDefensive === 'function',
      ...(modules === undefined ? {} : { modules }),
      ...(compileOptions === undefined ? {} : { compileOptions }),
      existingObjects,
      diagnostics,
    };
  } finally {
    await acquired.release();
  }
}
