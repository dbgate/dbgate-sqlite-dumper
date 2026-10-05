import { connectionFeatures, toBuffer } from '../connection/acquire.js';
import type { SqliteConnection, SqliteRow } from '../connection/types.js';
import type { SqliteColumn, SqliteIndex, SqliteTable } from '../model/database.js';
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
import { columnValueSelect, renderColumnLiteral, valueTransport } from './valueQuery.js';
import type { SqliteValueTransport } from './valueQuery.js';

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
  const features = connectionFeatures(connection);
  const transport = valueTransport(utf8Database, features.binaryTransport);

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
    ...(rowidName ? [columnValueSelect(rowidName, 0, utf8Database, transport)] : []),
    ...columns.map((column, index) =>
      columnValueSelect(
        quoteIdentifier(column.name),
        index + (rowidName ? 1 : 0),
        utf8Database,
        transport,
      ),
    ),
  ].join(', ');
  const valueCount = columns.length + (rowidName ? 1 : 0);
  const from = features.schemaQualifiedNames
    ? quoteQualifiedIdentifier(schemaName, table.name)
    : quoteIdentifier(table.name);
  const filter = systemRowFilterCondition(
    table,
    request.systemRowFilter,
    features.reservedNamePrefixes,
  );
  const rows =
    features.pagedReadSize === undefined
      ? connection.stream<SqliteRow>(
          { sql: `SELECT ${selectList} FROM ${from}${filter === null ? '' : ` WHERE ${filter}`}` },
          {
            ...(signal === undefined ? {} : { signal }),
            ...(options.streamBatchSize === undefined
              ? {}
              : { batchSize: options.streamBatchSize }),
          },
        )
      : readPages({
          connection,
          selectList,
          from,
          filter,
          pageSize: features.pagedReadSize,
          key: pageKey(table, columns, rowidName ? 1 : 0, request.primaryKeyIndex),
          transport,
          signal,
        });

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
    for await (const row of rows) {
      throwIfAborted(signal);

      const tuple = new SqlChunkBuilder();
      tuple.append('(');
      for (let index = 0; index < valueCount; index++) {
        if (index > 0) {
          tuple.append(',');
        }
        tuple.append(renderColumnLiteral(row, index, textStyle, transport));
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
 *
 * The rows of tables with a reserved name (see
 * `SqliteConnectionFeatures.reservedNamePrefixes`) are always left out:
 * those tables are not in the dump, so neither are their counters and
 * statistics.
 */
function systemRowFilterCondition(
  table: SqliteTable,
  filter: readonly string[] | undefined,
  reservedPrefixes: readonly string[],
): string | null {
  if (table.kind !== 'system' || (filter === undefined && reservedPrefixes.length === 0)) {
    return null;
  }
  const column = table.name === 'sqlite_sequence' ? 'name' : 'tbl';
  const conditions: string[] = [];
  if (filter !== undefined) {
    const names = [...new Set(filter.map(toAsciiLowerCase))].map(quoteStringLiteral);
    if (names.length === 0) {
      return '0';
    }
    conditions.push(`lower(${column}) IN (${names.join(',')})`);
  }
  for (const prefix of reservedPrefixes) {
    const lower = toAsciiLowerCase(prefix);
    conditions.push(
      `coalesce(substr(lower(${column}), 1, ${lower.length}) <> ${quoteStringLiteral(lower)}, 1)`,
    );
  }
  return conditions.join(' AND ');
}

/**
 * How consecutive pages of a table are delimited:
 *
 * - `rowid` — by the rowid (or the column that aliases it), which every
 *   ordinary table has: `WHERE rowid > :last ORDER BY rowid`, an index seek
 *   per page in exactly the order an unordered scan returns.
 * - `primaryKey` — by the primary key of a `WITHOUT ROWID` table, in the
 *   order of its key index, which is again the natural scan order. The key of
 *   the last row is written back as the literals this package renders for it.
 * - `offset` — `LIMIT … OFFSET …` with no order, for what has neither: a
 *   virtual table, or a table whose `rowid`, `_rowid_` and `oid` are all
 *   shadowed by columns.
 */
type PageKey =
  | { readonly kind: 'rowid'; readonly expression: string }
  | {
      readonly kind: 'primaryKey';
      readonly columns: readonly {
        readonly expression: string;
        readonly valueIndex: number;
        readonly descending: boolean;
      }[];
    }
  | { readonly kind: 'offset' };

function pageKey(
  table: SqliteTable,
  columns: readonly SqliteColumn[],
  valueOffset: number,
  primaryKeyIndex: SqliteIndex | undefined,
): PageKey {
  if (table.kind === 'virtual') {
    return { kind: 'offset' };
  }
  if (!table.withoutRowid) {
    if (table.rowidAliasColumn !== null) {
      return { kind: 'rowid', expression: quoteIdentifier(table.rowidAliasColumn) };
    }
    const names = new Set(table.columns.map(column => toAsciiLowerCase(column.name)));
    const name = ROWID_NAMES.find(candidate => !names.has(candidate));
    return name === undefined ? { kind: 'offset' } : { kind: 'rowid', expression: name };
  }
  const valueIndexes = new Map(
    columns.map((column, index) => [toAsciiLowerCase(column.name), index + valueOffset]),
  );
  // The key index lists the key in its own order, with direction and
  // collation; without it (an engine that has no `index_xinfo`), the
  // declared primary-key order, ascending, in each column's own collation.
  const keyColumns =
    primaryKeyIndex && primaryKeyIndex.columns.length > 0
      ? primaryKeyIndex.columns.map(column => ({
          name: column.name,
          descending: column.descending,
          collation: column.collation,
        }))
      : [...table.columns]
          .filter(column => column.primaryKeyPosition > 0)
          .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
          .map(column => ({ name: column.name, descending: false, collation: null }));
  const result: { expression: string; valueIndex: number; descending: boolean }[] = [];
  for (const column of keyColumns) {
    const valueIndex =
      column.name === null ? undefined : valueIndexes.get(toAsciiLowerCase(column.name));
    if (column.name === null || valueIndex === undefined) {
      return { kind: 'offset' };
    }
    const collation =
      column.collation === null || toAsciiLowerCase(column.collation) === 'binary'
        ? ''
        : ` COLLATE ${quoteIdentifier(column.collation)}`;
    result.push({
      expression: `${quoteIdentifier(column.name)}${collation}`,
      valueIndex,
      descending: column.descending,
    });
  }
  return result.length === 0 ? { kind: 'offset' } : { kind: 'primaryKey', columns: result };
}

/** Alias of the extra rowid column a `rowid`-keyed page selects. */
const PAGE_KEY_ALIAS = 'dbgate_page_key';

/** Reads a table page by page through `query()`; see {@link PageKey}. */
async function* readPages(request: {
  readonly connection: SqliteConnection;
  readonly selectList: string;
  readonly from: string;
  readonly filter: string | null;
  readonly pageSize: number;
  readonly key: PageKey;
  readonly transport: SqliteValueTransport;
  readonly signal: AbortSignal | undefined;
}): AsyncGenerator<SqliteRow> {
  const { connection, selectList, from, filter, pageSize, key, transport, signal } = request;
  let after: string | null = null;
  let offset = 0;
  for (;;) {
    throwIfAborted(signal);
    const conditions = [filter, after].filter(condition => condition !== null);
    const where =
      conditions.length === 0 ? '' : ` WHERE ${conditions.map(c => `(${c})`).join(' AND ')}`;
    let sql: string;
    if (key.kind === 'rowid') {
      sql = `SELECT ${selectList}, CAST(${key.expression} AS TEXT) AS "${PAGE_KEY_ALIAS}" FROM ${from}${where} ORDER BY ${key.expression} LIMIT ${pageSize}`;
    } else if (key.kind === 'primaryKey') {
      const order = key.columns
        .map(column => `${column.expression}${column.descending ? ' DESC' : ''}`)
        .join(', ');
      sql = `SELECT ${selectList} FROM ${from}${where} ORDER BY ${order} LIMIT ${pageSize}`;
    } else {
      sql = `SELECT ${selectList} FROM ${from}${where} LIMIT ${pageSize} OFFSET ${offset}`;
    }
    const { rows } = await connection.query<SqliteRow>({ sql }, signal);
    for (const row of rows) {
      yield row;
    }
    if (rows.length < pageSize) {
      return;
    }
    const last = rows[rows.length - 1] as SqliteRow;
    if (key.kind === 'rowid') {
      after = `${key.expression} > ${String(last[PAGE_KEY_ALIAS])}`;
    } else if (key.kind === 'primaryKey') {
      after = keyAfterCondition(key.columns, last, transport);
    } else {
      offset += rows.length;
    }
  }
}

/**
 * `key > last` in key-index order, expanded column by column
 * (`a > x OR (a = x AND b > y) …`) so that each column compares in its own
 * direction and collation.
 */
function keyAfterCondition(
  columns: readonly {
    readonly expression: string;
    readonly valueIndex: number;
    readonly descending: boolean;
  }[],
  row: SqliteRow,
  transport: SqliteValueTransport,
): string {
  const literals = columns.map(column => keyLiteral(row, column.valueIndex, transport));
  const alternatives: string[] = [];
  for (let position = 0; position < columns.length; position++) {
    const terms: string[] = [];
    for (let previous = 0; previous < position; previous++) {
      terms.push(
        `${(columns[previous] as { expression: string }).expression} = ${literals[previous]}`,
      );
    }
    const column = columns[position] as { expression: string; descending: boolean };
    terms.push(`${column.expression} ${column.descending ? '<' : '>'} ${literals[position]}`);
    alternatives.push(terms.length === 1 ? (terms[0] as string) : `(${terms.join(' AND ')})`);
  }
  return alternatives.join(' OR ');
}

/** A key value of the last row of a page, as a literal for the next page's condition. */
function keyLiteral(row: SqliteRow, index: number, transport: SqliteValueTransport): string {
  const literal = renderColumnLiteral(row, index, 'escaped', transport);
  if (typeof literal === 'string') {
    return literal;
  }
  // Text that is not valid UTF-8 is rendered as raw bytes; as a condition it
  // is written as those bytes, cast back to text.
  const value = row[`v${index}`] ?? null;
  const bytes =
    typeof value === 'string'
      ? Buffer.from(value, transport.hexText ? 'hex' : 'utf8')
      : toBuffer(value as Uint8Array | ArrayBuffer | readonly number[]);
  return `CAST(X'${bytes.toString('hex').toUpperCase()}' AS TEXT)`;
}
