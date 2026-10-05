import type { Writable } from 'node:stream';
import { inspectDumpArchive } from '../archive/planner.js';
import type { ArchiveEntry } from '../archive/types.js';
import { acquireSqliteConnection } from '../connection/acquire.js';
import { beginSqliteDumpSession } from '../connection/session.js';
import type { SqliteConnectionInput } from '../connection/types.js';
import { exportTableDataAsInserts } from '../data/insertExport.js';
import { introspectSqlite } from '../introspection/introspect.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import { renderPlainSql } from '../renderer/plainSql.js';
import { foldSqliteName, normalizeDumpSelection } from '../selection/normalize.js';
import { SqliteDumperError } from '../utils/errors.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import { StreamDumpWriter } from '../writer/streamWriter.js';
import type { DumpResult, DumpSqliteOptions } from './types.js';

/**
 * Runs a complete SQLite dump: acquire one handle, open a read snapshot,
 * introspect, plan, render, and stream row data — writing plain SQL in the
 * native `.dump` layout to `output`.
 *
 * Everything happens on **one** handle inside **one** read transaction, so
 * every table is read from the same state of the database even while other
 * connections write to it. When a source is passed, one handle is acquired
 * for the whole dump and released afterwards; a bare connection is borrowed
 * and never closed.
 */
export async function dumpSqlite(
  connectionInput: SqliteConnectionInput,
  options: DumpSqliteOptions,
  output: Writable,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult> {
  onProgress?.({ phase: 'connecting' });
  const acquired = await acquireSqliteConnection(connectionInput, signal);

  const session = await (async () => {
    onProgress?.({ phase: 'starting-snapshot' });
    try {
      return await beginSqliteDumpSession(
        acquired.connection,
        options.consistency === undefined ? {} : { consistency: options.consistency },
        signal,
      );
    } catch (error) {
      await acquired.release();
      throw error;
    }
  })();

  try {
    onProgress?.({ phase: 'introspecting' });
    const introspection = await introspectSqlite(
      acquired.connection,
      options.schemaName === undefined ? {} : { schemaName: options.schemaName },
      signal,
    );
    onProgress?.({
      phase: 'detecting-version',
      message: introspection.version.versionString,
      schemaName: introspection.database.schemaName,
    });

    const mode = options.mode ?? 'full';
    const selection = normalizeDumpSelection(options.selection);
    const archive = inspectDumpArchive(introspection.database, {
      mode,
      selection,
      ...(options.objectKinds === undefined ? {} : { objectKinds: options.objectKinds }),
    });
    onProgress?.({ phase: 'planning-archive', objectsTotal: archive.entries.length });

    if (!archive.valid) {
      throw new SqliteDumperError(
        'invalid-archive',
        'Archive planning failed; inspect the diagnostics, cycles and unsatisfiedDependencies returned by inspectDumpArchive for details',
      );
    }

    const writer = new StreamDumpWriter(output);
    const tablesByName = new Map(
      introspection.database.tables.map(table => [foldSqliteName(table.name), table]),
    );

    let rowsExported = 0;
    let statementsWritten = 0;
    const dataWarnings: SqliteDiagnostic[] = [];

    const onTableData = async (entry: ArchiveEntry): Promise<boolean> => {
      const table = tablesByName.get(foldSqliteName(entry.name));
      if (!table) {
        return false;
      }
      const primaryKeyIndex = table.withoutRowid
        ? introspection.database.indexes.find(
            index =>
              index.origin === 'pk' &&
              foldSqliteName(index.tableName) === foldSqliteName(table.name),
          )
        : undefined;
      const result = await exportTableDataAsInserts({
        connection: acquired.connection,
        schemaName: introspection.database.schemaName,
        table,
        writer,
        encoding: introspection.database.encoding,
        ...(entry.systemRowFilter === undefined ? {} : { systemRowFilter: entry.systemRowFilter }),
        ...(primaryKeyIndex === undefined ? {} : { primaryKeyIndex }),
        ...(options.dataExport === undefined ? {} : { options: options.dataExport }),
        ...(signal === undefined ? {} : { signal }),
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      rowsExported += result.rowsExported;
      statementsWritten += result.statementsWritten;
      dataWarnings.push(...result.warnings);
      if (result.cancelled) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return true;
    };

    const renderResult = await renderPlainSql({
      database: introspection.database,
      archive,
      writer,
      mode,
      sourceVersion: introspection.version,
      ...(options.render === undefined ? {} : { options: options.render }),
      ...(signal === undefined ? {} : { signal }),
      ...(onProgress === undefined ? {} : { onProgress }),
      onTableData,
    });

    onProgress?.({ phase: 'finalizing', bytesWritten: renderResult.bytesWritten });

    const sessionWarnings: SqliteDiagnostic[] = [];
    if (session.joinedExistingTransaction) {
      sessionWarnings.push({
        severity: 'info',
        code: 'dump-joined-caller-transaction',
        message:
          "The connection was already inside a transaction, so the dump was read within it and includes that transaction's uncommitted changes.",
      });
    }
    if (session.snapshotUnavailable) {
      sessionWarnings.push({
        severity: 'warning',
        code: 'snapshot-unavailable',
        message:
          'The database does not support transactions, so the dump was not read from one snapshot: changes committed while it ran may be partly included.',
      });
    }

    return {
      bytesWritten: renderResult.bytesWritten,
      renderedDumpIds: renderResult.renderedDumpIds,
      skippedDumpIds: renderResult.skippedDumpIds,
      warnings: [
        ...introspection.diagnostics,
        ...archive.diagnostics,
        ...sessionWarnings,
        ...renderResult.warnings,
        ...dedupeDiagnostics(dataWarnings),
      ],
      cancelled: renderResult.cancelled,
      rowsExported,
      statementsWritten,
    };
  } finally {
    // The read transaction must end before the handle goes back to a
    // source, or the next borrower inherits it (and its lock).
    await session.finish();
    await acquired.release();
  }
}

function dedupeDiagnostics(diagnostics: readonly SqliteDiagnostic[]): SqliteDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter(diagnostic => {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
