import type { SqliteRow } from '../connection/types.js';
import type { SqliteColumn, SqliteTable } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import {
  quoteIdentifier,
  quoteIdentifierIfNeeded,
  quoteQualifiedIdentifier,
  toAsciiLowerCase,
} from '../security/identifiers.js';
import { quoteStringLiteral } from '../security/literals.js';
import { isAbortError, throwIfAborted } from '../utils/errors.js';
import { SqlChunkBuilder } from './chunkBuilder.js';
import type { TableDataExportRequest, TableDataExportResult } from './types.js';
import { columnValueSelect, renderColumnLiteral } from './valueQuery.js';

const DEFAULT_MAX_STATEMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ROWS_PER_STATEMENT = 500;

/**
 * Output is handed to the writer in chunks of about this size. A native dump
 * is one short `INSERT` per row, and awaiting the writer once per row would
 * cost more than rendering the row did.
 */
const OUTPUT_CHUNK_BYTES = 64 * 1024;

/** Names the native shell tries, in order, for a rowid that is not a declared column. */
const ROWID_NAMES = ['rowid', '_rowid_', 'oid'] as const;

/**
 * The columns the native `.dump` inserts: those `PRAGMA table_info` lists,
 * which excludes generated columns and the hidden columns of virtual tables.
 * Generated columns cannot be inserted into; SQLite recomputes them.
 */
export function insertableColumns(table: SqliteTable): SqliteColumn[] {
  return [...table.columns].sort((a, b) => a.cid - b.cid).filter(column => column.hidden === 0);
}

/**
 * The name under which `preserveRowids` can address a table's rowid, as
 * `tableColumnList()` in `shell.c` decides it: never for a `WITHOUT ROWID`
 * table or one whose rowid is already a declared `INTEGER PRIMARY KEY`, and
 * otherwise the first of `rowid`, `_rowid_`, `oid` that no column is named.
 */
export function preservableRowidName(table: SqliteTable): string | null {
  if (table.withoutRowid || table.rowidAliasColumn !== null || table.kind === 'virtual') {
    return null;
  }
  const names = new Set(insertableColumns(table).map(column => toAsciiLowerCase(column.name)));
  for (const candidate of ROWID_NAMES) {
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Streams one table's rows as `INSERT` statements in the native `.dump`
 * layout.
 *
 * Requires a live connection; this is deliberately separate from
 * `renderPlainSql`, which renders schema objects from the static model and
 * never touches the database.
 *
 * Rows are read in the table's natural order — no `ORDER BY`, exactly like
 * the native `.dump`. For an ordinary table that is rowid order, and for a
 * `WITHOUT ROWID` table primary-key order, so two dumps of an unchanged
 * database are identical.
 *
 * Memory is bounded by one statement plus a small output buffer: rows are
 * consumed from a stream and written as they are rendered, so a table of any
 * size dumps in constant memory.
 */
export async function exportTableDataAsInserts(
  request: TableDataExportRequest,
): Promise<TableDataExportResult> {
  const { connection, schemaName, table, writer, signal, onProgress } = request;
  const options = request.options ?? {};
  const extendedInsert = options.extendedInsert ?? false;
  const maxRowsPerStatement = extendedInsert
    ? Math.max(1, options.maxRowsPerStatement ?? DEFAULT_MAX_ROWS_PER_STATEMENT)
    : 1;
  const maxStatementBytes = Math.max(
    1024,
    options.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES,
  );
  const textStyle = options.rawNewlines ? 'raw-newlines' : 'escaped';
  const utf8Database = (request.encoding ?? 'UTF-8').toUpperCase() === 'UTF-8';

  const warnings: SqliteDiagnostic[] = [];
  const columns = insertableColumns(table);
  const rowidName = options.preserveRowids ? preservableRowidName(table) : null;

  for (const column of table.columns) {
    if (column.generated !== 'none') {
      warnings.push({
        severity: 'info',
        code: 'generated-column-not-exported',
        message: `Column "${table.name}"."${column.name}" is a ${column.generated.toUpperCase()} generated column; SQLite derives its value, so it is excluded from INSERT and recomputed on restore.`,
        objectReference: { kind: 'column', schemaName, name: column.name, parentName: table.name },
      });
    }
  }

  if (columns.length === 0) {
    warnings.push({
      severity: 'warning',
      code: 'table-has-no-insertable-columns',
      message: `Table "${table.name}" has no insertable columns, so no row data is dumped for it.`,
      objectReference: { kind: 'table', schemaName, name: table.name },
    });
    return {
      rowsExported: 0,
      bytesWritten: writer.bytesWritten,
      statementsWritten: 0,
      cancelled: false,
      warnings,
    };
  }

  // `INSERT INTO t` (quoted only when the name needs it) and, only when a
  // rowid is being preserved, the column list — the native shell writes one
  // in no other case, relying on the positional form otherwise.
  const columnList = rowidName
    ? `(${[rowidName, ...columns.map(column => quoteIdentifierIfNeeded(column.name))].join(',')})`
    : '';
  const statementPrefix = `INSERT INTO ${quoteIdentifierIfNeeded(table.name)}${columnList} VALUES`;

  const selectList = [
    ...(rowidName ? [columnValueSelect(rowidName, 0, utf8Database)] : []),
    ...columns.map((column, index) =>
      columnValueSelect(quoteIdentifier(column.name), index + (rowidName ? 1 : 0), utf8Database),
    ),
  ].join(', ');
  const valueCount = columns.length + (rowidName ? 1 : 0);
  const sql = `SELECT ${selectList} FROM ${quoteQualifiedIdentifier(schemaName, table.name)}${systemRowFilterClause(table, request.systemRowFilter)}`;

  let rowsExported = 0;
  let statementsWritten = 0;
  let output = new SqlChunkBuilder();
  let statement: SqlChunkBuilder | null = null;
  let statementRows = 0;

  const flushOutput = async (): Promise<void> => {
    if (output.isEmpty) {
      return;
    }
    const chunk = output.build();
    output = new SqlChunkBuilder();
    await writer.write(chunk, signal);
  };

  const closeStatement = async (): Promise<void> => {
    if (!statement || statementRows === 0) {
      return;
    }
    statement.append(';\n');
    output.appendBuilder(statement);
    statement = null;
    statementRows = 0;
    statementsWritten++;
    if (output.length >= OUTPUT_CHUNK_BYTES) {
      await flushOutput();
    }
  };

  const progress = (
    exportState: 'started' | 'progress' | 'finished' | 'failed' | 'cancelled',
  ): void => {
    onProgress?.({
      phase: 'exporting-data',
      section: 'table-data',
      schemaName,
      tableName: table.name,
      objectName: table.name,
      rowsExported,
      bytesWritten: writer.bytesWritten,
      exportState,
    });
  };

  progress('started');
  try {
    for await (const row of connection.stream<SqliteRow>(
      { sql },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(options.streamBatchSize === undefined ? {} : { batchSize: options.streamBatchSize }),
      },
    )) {
      throwIfAborted(signal);

      const tuple = new SqlChunkBuilder();
      tuple.append('(');
      for (let index = 0; index < valueCount; index++) {
        if (index > 0) {
          tuple.append(',');
        }
        tuple.append(renderColumnLiteral(row, index, textStyle));
      }
      tuple.append(')');

      // Closing *before* appending keeps the byte cap a true upper bound. A
      // statement always holds at least one row, however large that row is.
      if (
        statement &&
        (statementRows >= maxRowsPerStatement ||
          (statement as SqlChunkBuilder).length + tuple.length + 2 > maxStatementBytes)
      ) {
        await closeStatement();
      }
      if (!statement) {
        statement = new SqlChunkBuilder();
        statement.append(statementPrefix);
      } else {
        statement.append(',');
      }
      statement.appendBuilder(tuple);
      statementRows++;
      rowsExported++;

      if (rowsExported % 1000 === 0) {
        progress('progress');
      }
    }

    await closeStatement();
    await flushOutput();
    progress('finished');
    return {
      rowsExported,
      bytesWritten: writer.bytesWritten,
      statementsWritten,
      cancelled: false,
      warnings,
    };
  } catch (error) {
    if (isAbortError(error)) {
      // Buffered output is deliberately *not* flushed: a dump cut off at an
      // arbitrary row boundary should look truncated, not complete.
      progress('cancelled');
      return {
        rowsExported,
        bytesWritten: writer.bytesWritten,
        statementsWritten,
        cancelled: true,
        warnings,
      };
    }
    progress('failed');
    throw error;
  }
}

/**
 * For a partial dump, restricts `sqlite_sequence` to the counters of the
 * dumped tables and `sqlite_stat*` to their statistics. Both key the row by
 * table name in their first column (`name` and `tbl` respectively).
 */
function systemRowFilterClause(table: SqliteTable, filter: readonly string[] | undefined): string {
  if (filter === undefined || table.kind !== 'system') {
    return '';
  }
  const column = table.name === 'sqlite_sequence' ? 'name' : 'tbl';
  const names = [...new Set(filter.map(toAsciiLowerCase))].map(quoteStringLiteral);
  if (names.length === 0) {
    return ' WHERE 0';
  }
  return ` WHERE lower(${column}) IN (${names.join(',')})`;
}
