import type { ArchiveEntry } from '../archive/types.js';
import type { SqliteIndex, SqliteTrigger, SqliteView } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import { DEFENSIVE_WARNING_COMMENT } from '../restore/preview.js';
import { foldSqliteName } from '../selection/normalize.js';
import { isAbortError, SqliteDumperError, throwIfAborted } from '../utils/errors.js';
import type { DumpProgressSection } from '../utils/progress.js';
import {
  renderDatabaseSettings,
  renderDrop,
  renderSchemaLine,
  renderSchemaObject,
  renderSystemTablePrelude,
  renderVirtualTable,
  SESSION_GUARD_FOOTER,
  SESSION_GUARD_HEADER,
  WRITABLE_SCHEMA_OFF,
  WRITABLE_SCHEMA_ON,
} from './objectRenderers.js';
import { resolvePlainSqlRenderOptions } from './types.js';
import type {
  PlainSqlRenderRequest,
  PlainSqlRenderResult,
  ResolvedPlainSqlRenderOptions,
} from './types.js';

const SECTION_BY_ENTRY: Record<ArchiveEntry['objectType'], DumpProgressSection> = {
  table: 'table-structure',
  tableData: 'table-data',
  virtualTable: 'virtual-table',
  index: 'index',
  trigger: 'trigger',
  view: 'view',
};

/**
 * Renders a validated {@link DumpArchiveInspection} as plain SQL in the
 * native `.dump` layout — the same statements, in the same order, spelled
 * the same way.
 *
 * Purely a function of the static model and the archive plan: it never
 * queries the database, which is why row data has to arrive through the
 * `onTableData` hook (see `exportTableDataAsInserts` for the streaming
 * implementation `dumpSqlite` supplies).
 */
export async function renderPlainSql(
  request: PlainSqlRenderRequest,
): Promise<PlainSqlRenderResult> {
  const options = resolvePlainSqlRenderOptions(request.options);
  const { database, archive, writer, signal, onProgress, onTableData } = request;
  const mode = request.mode ?? 'full';

  if (!archive.valid) {
    throw new SqliteDumperError(
      'invalid-archive',
      'Cannot render an archive inspection that failed validation; see archive.diagnostics, archive.cycles and archive.unsatisfiedDependencies',
    );
  }

  const warnings: SqliteDiagnostic[] = [];
  const renderedDumpIds: string[] = [];
  const skippedDumpIds: string[] = [];
  const schemaTableName = options.legacySchemaTableName ? 'sqlite_master' : 'sqlite_schema';

  const tables = new Map(database.tables.map(table => [foldSqliteName(table.name), table]));
  const indexes = new Map(database.indexes.map(index => [foldSqliteName(index.name), index]));
  const triggers = new Map(
    database.triggers.map(trigger => [foldSqliteName(trigger.name), trigger]),
  );
  const views = new Map(database.views.map(view => [foldSqliteName(view.name), view]));

  const emit = async (text: string): Promise<void> => {
    if (text !== '') {
      await writer.write(text, signal);
    }
  };

  const guards = options.includeSessionGuards && mode !== 'data-only';
  if (!options.includeSessionGuards && mode !== 'data-only') {
    warnings.push({
      severity: 'warning',
      code: 'session-guards-disabled',
      message:
        'render.includeSessionGuards is false, so the dump omits PRAGMA foreign_keys=OFF and its BEGIN TRANSACTION / COMMIT. Tables that reference each other may fail to restore in the emitted order, and every INSERT runs as its own transaction, which makes restoring a large dump dramatically slower.',
    });
  }

  reportUnDumpedSettings(request, options, warnings);

  // The warning appears whenever the dump contains a virtual table, even in
  // a data-only dump — the native `.dump` decides it from the schema alone.
  const containsVirtualTables =
    mode !== 'schema-only' &&
    archive.entries.some(
      entry =>
        entry.objectType === 'virtualTable' ||
        entry.tableKind === 'virtual' ||
        (entry.tableKind === 'shadow' &&
          tables.get(foldSqliteName(entry.name))?.ownerVirtualTable !== undefined),
    );

  let writableSchema = false;

  try {
    if (options.includeHeaderComments && containsVirtualTables) {
      await emit(`${DEFENSIVE_WARNING_COMMENT}\n`);
    }
    if (guards) {
      await emit(SESSION_GUARD_HEADER);
    }

    let processed = 0;
    const total = archive.entries.length;

    for (const entry of archive.entries) {
      throwIfAborted(signal);
      processed++;
      onProgress?.({
        phase: 'rendering-schema',
        section: SECTION_BY_ENTRY[entry.objectType],
        objectsProcessed: processed,
        objectsTotal: total,
        objectName: entry.name,
        schemaName: entry.schemaName,
        bytesWritten: writer.bytesWritten,
      });

      let handled: boolean;
      switch (entry.objectType) {
        case 'table': {
          const table = tables.get(foldSqliteName(entry.name));
          if (!table) {
            handled = missing(entry, 'table', warnings, options);
            break;
          }
          if (table.kind === 'system') {
            await emit(
              renderSystemTablePrelude(table.name, schemaTableName, entry.systemRowFilter),
            );
          } else {
            if (options.addDropStatements) {
              await emit(renderDrop('TABLE', table.name));
            }
            await emit(renderSchemaLine(table.sql));
          }
          handled = true;
          break;
        }

        case 'virtualTable': {
          const table = tables.get(foldSqliteName(entry.name));
          if (!table) {
            handled = missing(entry, 'virtual table', warnings, options);
            break;
          }
          if (options.addDropStatements) {
            await emit(renderDrop('TABLE', table.name));
          }
          if (mode === 'schema-only') {
            // No shadow-table rows follow in a schema-only dump, so the table
            // must be created by its module, which initializes them — as the
            // native `.schema` writes it. The shadow tables' own
            // `CREATE TABLE IF NOT EXISTS` lines then do nothing.
            await emit(renderSchemaLine(table.sql));
          } else {
            if (!writableSchema) {
              await emit(WRITABLE_SCHEMA_ON);
              writableSchema = true;
            }
            await emit(renderVirtualTable(table.name, table.sql, schemaTableName));
          }
          handled = true;
          break;
        }

        case 'tableData': {
          const table = tables.get(foldSqliteName(entry.name));
          if (!table) {
            handled = missing(entry, 'table', warnings, options);
            break;
          }
          if (onTableData) {
            handled = await onTableData(entry);
          } else {
            warnings.push({
              severity: 'warning',
              code: 'data-not-rendered',
              message: `Row data for table "${entry.name}" was selected, but renderPlainSql only renders schema objects; use dumpSqlite (or supply onTableData) with a live connection to stream rows.`,
              objectReference: { kind: 'table', schemaName: entry.schemaName, name: entry.name },
            });
            handled = true;
          }
          break;
        }

        case 'index':
        case 'trigger':
        case 'view': {
          const object = lookupSchemaObject(entry, indexes, triggers, views);
          if (!object || object.sql === null) {
            handled = missing(entry, entry.objectType, warnings, options);
            break;
          }
          if (options.addDropStatements) {
            await emit(
              renderDrop(
                entry.objectType === 'index'
                  ? 'INDEX'
                  : entry.objectType === 'trigger'
                    ? 'TRIGGER'
                    : 'VIEW',
                entry.name,
              ),
            );
          }
          await emit(renderSchemaObject(object.sql));
          handled = true;
          break;
        }

        default: {
          const unreachable: never = entry.objectType;
          throw new SqliteDumperError(
            'unsupported-object',
            `Unhandled archive object type: ${String(unreachable)}`,
          );
        }
      }

      if (handled) {
        renderedDumpIds.push(entry.dumpId);
      } else {
        skippedDumpIds.push(entry.dumpId);
      }
    }

    if (writableSchema) {
      await emit(WRITABLE_SCHEMA_OFF);
    }
    if (options.includeDatabaseSettings) {
      await emit(renderDatabaseSettings(database.userVersion, database.applicationId));
    }
    if (guards) {
      await emit(SESSION_GUARD_FOOTER);
    }

    return {
      bytesWritten: writer.bytesWritten,
      renderedDumpIds,
      skippedDumpIds,
      warnings,
      cancelled: false,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        bytesWritten: writer.bytesWritten,
        renderedDumpIds,
        skippedDumpIds,
        warnings,
        cancelled: true,
      };
    }
    throw error;
  }
}

function lookupSchemaObject(
  entry: ArchiveEntry,
  indexes: ReadonlyMap<string, SqliteIndex>,
  triggers: ReadonlyMap<string, SqliteTrigger>,
  views: ReadonlyMap<string, SqliteView>,
): { sql: string | null } | undefined {
  const key = foldSqliteName(entry.name);
  switch (entry.objectType) {
    case 'index':
      return indexes.get(key);
    case 'trigger':
      return triggers.get(key);
    default:
      return views.get(key);
  }
}

/**
 * `user_version` and `application_id` are database settings the native
 * `.dump` does not carry. An application that tracks its schema migrations
 * in `user_version` would restore into a database that looks unmigrated, so
 * a non-zero value that is not being dumped is reported rather than dropped
 * silently.
 */
function reportUnDumpedSettings(
  request: PlainSqlRenderRequest,
  options: ResolvedPlainSqlRenderOptions,
  warnings: SqliteDiagnostic[],
): void {
  if (options.includeDatabaseSettings) {
    return;
  }
  const { database } = request;
  if (database.userVersion !== 0) {
    warnings.push({
      severity: 'warning',
      code: 'user-version-not-dumped',
      message: `The database's PRAGMA user_version is ${database.userVersion}, which the dump does not carry (the native .dump does not either). Set render.includeDatabaseSettings to include it; applications often track schema migrations in it.`,
      objectReference: {
        kind: 'database',
        schemaName: database.schemaName,
        name: database.schemaName,
      },
    });
  }
  if (database.applicationId !== 0) {
    warnings.push({
      severity: 'warning',
      code: 'application-id-not-dumped',
      message: `The database's PRAGMA application_id is ${database.applicationId}, which the dump does not carry (the native .dump does not either). Set render.includeDatabaseSettings to include it.`,
      objectReference: {
        kind: 'database',
        schemaName: database.schemaName,
        name: database.schemaName,
      },
    });
  }
}

function missing(
  entry: ArchiveEntry,
  kind: string,
  warnings: SqliteDiagnostic[],
  options: ResolvedPlainSqlRenderOptions,
): boolean {
  const message = `Archive entry references ${kind} "${entry.name}", which was not found in the introspected model`;
  if (options.unsupportedFeaturePolicy === 'warn-omit') {
    warnings.push({ severity: 'warning', code: 'model-object-missing', message });
    return false;
  }
  throw new SqliteDumperError('model-object-missing', message);
}
