import { toNumber, toText } from '../connection/acquire.js';
import type { SqliteConnection, SqliteRow } from '../connection/types.js';
import type {
  SqliteColumn,
  SqliteColumnHidden,
  SqliteDatabase,
  SqliteForeignKey,
  SqliteIndex,
  SqliteIndexColumn,
  SqliteSequence,
  SqliteTable,
  SqliteTableKind,
  SqliteTrigger,
  SqliteView,
} from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import { quoteIdentifier, toAsciiLowerCase, toAsciiUpperCase } from '../security/identifiers.js';
import { quoteStringLiteral } from '../security/literals.js';
import { isAbortError, SqliteDumperError, throwIfAborted } from '../utils/errors.js';
import { detectSqliteCapabilities } from '../version/capabilities.js';
import { detectSqliteVersion } from '../version/detect.js';
import type { SqliteCapabilities, SqliteVersion } from '../version/types.js';
import { declaresAutoincrement, parseTableOptions, parseVirtualTableModule } from './sqlText.js';

export interface IntrospectSqliteOptions {
  /**
   * Schema to introspect: `main` (default), `temp`, or the name of an
   * attached database.
   */
  readonly schemaName?: string;
}

export interface SqliteIntrospectionResult {
  readonly database: SqliteDatabase;
  readonly version: SqliteVersion;
  readonly capabilities: SqliteCapabilities;
  readonly diagnostics: readonly SqliteDiagnostic[];
}

interface SchemaRow {
  readonly schemaRowid: number;
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

/**
 * Reads the complete schema of one SQLite database into a normalized
 * {@link SqliteDatabase}.
 *
 * Every object comes from `sqlite_schema` (read through its historical name
 * `sqlite_master`, which every release accepts), in rowid order — the order
 * the native `.dump` uses. Column, index and foreign-key detail comes from
 * the table-valued pragma functions where the library has them, falling back
 * to the plain `PRAGMA` statements otherwise.
 *
 * Runs entirely on the one handle it is given, in sequence, and never writes.
 */
export async function introspectSqlite(
  connection: SqliteConnection,
  options?: IntrospectSqliteOptions,
  signal?: AbortSignal,
): Promise<SqliteIntrospectionResult> {
  const schemaName = options?.schemaName ?? 'main';
  const version = await detectSqliteVersion(connection, signal);
  const capabilities = detectSqliteCapabilities(version);
  const diagnostics: SqliteDiagnostic[] = [];
  const catalog = new CatalogReader(connection, schemaName, capabilities, signal);

  const schemaRows = await catalog.schemaRows();
  if (schemaRows === null) {
    throw new SqliteDumperError(
      'schema-not-found',
      `No database named ${JSON.stringify(schemaName)} is attached to this connection`,
    );
  }

  const tableList = await catalog.tableList();
  const virtualTableNames = schemaRows
    .filter(row => row.type === 'table' && isVirtualTableSql(row.sql))
    .map(row => row.name);

  const tables: SqliteTable[] = [];
  const indexes: SqliteIndex[] = [];
  const foreignKeys: SqliteForeignKey[] = [];
  const indexRowsByName = new Map(
    schemaRows.filter(row => row.type === 'index').map(row => [toAsciiLowerCase(row.name), row]),
  );

  for (const row of schemaRows) {
    throwIfAborted(signal);
    if (row.type !== 'table' || row.sql === null) {
      continue;
    }
    const listed = tableList?.get(toAsciiLowerCase(row.name));
    const kind = classifyTable(row, listed?.type, virtualTableNames);

    let columns: SqliteColumn[] = [];
    try {
      columns = await catalog.columns(row.name);
    } catch (error) {
      if (isAbortError(error)) throw error;
      diagnostics.push({
        severity: kind === 'virtual' ? 'warning' : 'error',
        code: kind === 'virtual' ? 'virtual-table-module-unavailable' : 'table-columns-unreadable',
        message:
          kind === 'virtual'
            ? `The columns of virtual table "${row.name}" cannot be read, most likely because its module is not available in this SQLite build (${errorMessage(error)}). Its definition and its shadow tables are still dumped, which is all a restore needs.`
            : `The columns of table "${row.name}" cannot be read: ${errorMessage(error)}`,
        objectReference: {
          kind: kind === 'virtual' ? 'virtualTable' : 'table',
          schemaName,
          name: row.name,
        },
      });
    }

    const parsedOptions = parseTableOptions(row.sql);
    const withoutRowid = listed
      ? listed.withoutRowid
      : kind === 'table' || kind === 'shadow'
        ? parsedOptions.withoutRowid
        : false;
    const strict = listed ? listed.strict : parsedOptions.strict;

    let tableIndexes: SqliteIndex[] = [];
    let tableForeignKeys: SqliteForeignKey[] = [];
    if (kind !== 'virtual') {
      tableIndexes = await catalog.indexes(row.name, indexRowsByName);
      tableForeignKeys = await catalog.foreignKeys(row.name);
    }
    indexes.push(...tableIndexes);
    foreignKeys.push(...tableForeignKeys);

    const virtualModule = kind === 'virtual' ? parseVirtualTableModule(row.sql) : undefined;
    const ownerVirtualTable =
      kind === 'shadow' ? findOwner(row.name, virtualTableNames) : undefined;

    tables.push({
      name: row.name,
      kind,
      schemaRowid: row.schemaRowid,
      sql: row.sql,
      withoutRowid,
      strict,
      hasAutoincrement: kind === 'table' && declaresAutoincrement(row.sql),
      ...(virtualModule === undefined ? {} : { virtualModule }),
      ...(ownerVirtualTable === undefined ? {} : { ownerVirtualTable }),
      rowidAliasColumn:
        kind === 'virtual' || withoutRowid ? null : findRowidAlias(columns, tableIndexes),
      columns,
    });
  }

  // Indexes are attached to their table through the pragmas above; any
  // `CREATE INDEX` row whose table could not be read is still carried, so the
  // dump does not silently lose it.
  const seenIndexes = new Set(indexes.map(index => toAsciiLowerCase(index.name)));
  for (const row of schemaRows) {
    if (row.type === 'index' && row.sql !== null && !seenIndexes.has(toAsciiLowerCase(row.name))) {
      indexes.push({
        name: row.name,
        tableName: row.tableName,
        schemaRowid: row.schemaRowid,
        sql: row.sql,
        isUnique: /^CREATE\s+UNIQUE\b/i.test(row.sql),
        origin: 'c',
        isPartial: false,
        columns: [],
      });
    }
  }
  indexes.sort((a, b) => a.schemaRowid - b.schemaRowid);

  const views: SqliteView[] = schemaRows
    .filter(row => row.type === 'view' && row.sql !== null)
    .map(row => ({ name: row.name, schemaRowid: row.schemaRowid, sql: row.sql as string }));
  const triggers: SqliteTrigger[] = schemaRows
    .filter(row => row.type === 'trigger' && row.sql !== null)
    .map(row => ({
      name: row.name,
      tableName: row.tableName,
      schemaRowid: row.schemaRowid,
      sql: row.sql as string,
    }));

  const sequences = tables.some(table => table.name === 'sqlite_sequence')
    ? await catalog.sequences()
    : [];

  const settings = await catalog.settings();

  return {
    database: {
      schemaName,
      ...settings,
      tables,
      indexes,
      views,
      triggers,
      foreignKeys,
      sequences,
    },
    version,
    capabilities,
    diagnostics,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVirtualTableSql(sql: string | null): boolean {
  // The native shell tests exactly this prefix (`strncmp`, case-sensitive);
  // SQLite normalizes the start of every stored CREATE statement, so it is
  // reliable.
  return sql !== null && sql.startsWith('CREATE VIRTUAL TABLE');
}

function classifyTable(
  row: SchemaRow,
  listedType: string | undefined,
  virtualTableNames: readonly string[],
): SqliteTableKind {
  if (row.name.startsWith('sqlite_')) {
    return 'system';
  }
  if (isVirtualTableSql(row.sql)) {
    return 'virtual';
  }
  if (listedType !== undefined) {
    return listedType === 'shadow' ? 'shadow' : 'table';
  }
  // Without `PRAGMA table_list`, recognize shadow tables the way the native
  // `.dump` does when it expands a table pattern: by the `<vtab>_` prefix.
  return findOwner(row.name, virtualTableNames) === undefined ? 'table' : 'shadow';
}

/** The virtual table whose `<name>_` prefix `tableName` carries — the longest, if several do. */
function findOwner(tableName: string, virtualTableNames: readonly string[]): string | undefined {
  const lower = toAsciiLowerCase(tableName);
  let owner: string | undefined;
  for (const name of virtualTableNames) {
    const prefix = `${toAsciiLowerCase(name)}_`;
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      if (owner === undefined || name.length > owner.length) {
        owner = name;
      }
    }
  }
  return owner;
}

/**
 * The column that *is* the rowid: a lone `INTEGER PRIMARY KEY`. Declared
 * exactly `INTEGER` (not `INT`, not `BIGINT`), and not `PRIMARY KEY DESC` —
 * the one spelling SQLite implements as a separate unique index, which shows
 * up as an index with origin `pk`.
 */
function findRowidAlias(
  columns: readonly SqliteColumn[],
  indexes: readonly SqliteIndex[],
): string | null {
  const primaryKey = columns.filter(column => column.primaryKeyPosition > 0);
  if (primaryKey.length !== 1) {
    return null;
  }
  const column = primaryKey[0] as SqliteColumn;
  if (toAsciiUpperCase(column.declaredType) !== 'INTEGER') {
    return null;
  }
  if (indexes.some(index => index.origin === 'pk')) {
    return null;
  }
  return column.name;
}

interface ListedTable {
  readonly type: string;
  readonly withoutRowid: boolean;
  readonly strict: boolean;
}

/** Catalog queries for one schema, using the pragma functions when available. */
class CatalogReader {
  private readonly qualifier: string;

  constructor(
    private readonly connection: SqliteConnection,
    private readonly schemaName: string,
    private readonly capabilities: SqliteCapabilities,
    private readonly signal?: AbortSignal,
  ) {
    this.qualifier = quoteIdentifier(schemaName);
  }

  private async rows(
    sql: string,
    parameters?: readonly (string | number)[],
  ): Promise<readonly SqliteRow[]> {
    const result = await this.connection.query<SqliteRow>(
      parameters === undefined ? { sql } : { sql, parameters },
      this.signal,
    );
    return result.rows;
  }

  /** Runs `PRAGMA schema.name(argument)`, as a table-valued function when the library has them. */
  private async pragma(
    name: string,
    argument: string,
    columns: string,
  ): Promise<readonly SqliteRow[]> {
    if (this.capabilities.supportsPragmaFunctions) {
      return this.rows(`SELECT ${columns} FROM pragma_${name}(?, ?)`, [argument, this.schemaName]);
    }
    return this.rows(`PRAGMA ${this.qualifier}.${name}(${quoteStringLiteral(argument)})`);
  }

  async schemaRows(): Promise<SchemaRow[] | null> {
    const databases = await this.rows('PRAGMA database_list');
    const known = databases.some(
      row => toAsciiLowerCase(toText(row.name) ?? '') === toAsciiLowerCase(this.schemaName),
    );
    if (!known) {
      return null;
    }
    const master =
      toAsciiLowerCase(this.schemaName) === 'temp' ? 'sqlite_temp_master' : 'sqlite_master';
    const rows = await this.rows(
      `SELECT rowid AS schemaRowid, type, name, tbl_name AS tableName, sql FROM ${this.qualifier}.${master} ORDER BY rowid`,
    );
    return rows.map(row => ({
      schemaRowid: toNumber(row.schemaRowid),
      type: toText(row.type) ?? '',
      name: toText(row.name) ?? '',
      tableName: toText(row.tableName) ?? '',
      sql: toText(row.sql),
    }));
  }

  async tableList(): Promise<Map<string, ListedTable> | undefined> {
    if (!this.capabilities.supportsTableList) {
      return undefined;
    }
    try {
      const rows = await this.rows(
        'SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = ?',
        [this.schemaName],
      );
      return new Map(
        rows.map(row => [
          toAsciiLowerCase(toText(row.name) ?? ''),
          {
            type: toText(row.type) ?? 'table',
            withoutRowid: toNumber(row.wr) !== 0,
            strict: toNumber(row.strict) !== 0,
          },
        ]),
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      // `PRAGMA table_list` prepares every view to count its columns, so one
      // broken view makes it fail as a whole. The DDL-parsing fallback
      // below does not depend on it.
      return undefined;
    }
  }

  async columns(tableName: string): Promise<SqliteColumn[]> {
    const withHidden = this.capabilities.supportsTableXinfo;
    const rows = await this.pragma(
      withHidden ? 'table_xinfo' : 'table_info',
      tableName,
      `cid, name, type, "notnull" AS isNotNull, dflt_value AS defaultValue, pk${withHidden ? ', hidden' : ''}`,
    );
    return rows.map(row => {
      const hidden = (withHidden ? toNumber(row.hidden) : 0) as SqliteColumnHidden;
      return {
        cid: toNumber(row.cid),
        name: toText(row.name) ?? '',
        declaredType: toText(row.type) ?? '',
        notNull: toNumber(row.isNotNull ?? row.notnull) !== 0,
        defaultValue: toText(row.defaultValue ?? row.dflt_value),
        primaryKeyPosition: toNumber(row.pk),
        hidden,
        generated: hidden === 2 ? 'virtual' : hidden === 3 ? 'stored' : 'none',
      };
    });
  }

  async indexes(
    tableName: string,
    schemaRows: ReadonlyMap<string, SchemaRow>,
  ): Promise<SqliteIndex[]> {
    const list = await this.pragma(
      'index_list',
      tableName,
      'seq, name, "unique" AS isUnique, origin, partial',
    );
    const result: SqliteIndex[] = [];
    for (const row of list) {
      const name = toText(row.name) ?? '';
      const schemaRow = schemaRows.get(toAsciiLowerCase(name));
      const origin = (toText(row.origin) ?? 'c') as SqliteIndex['origin'];
      let columns: SqliteIndexColumn[] = [];
      try {
        const keyRows = await this.pragma(
          'index_xinfo',
          name,
          'seqno, cid, name, "desc" AS isDesc, coll, "key" AS isKey',
        );
        columns = keyRows
          .filter(keyRow => toNumber(keyRow.isKey ?? keyRow.key) !== 0)
          .map(keyRow => ({
            name: toText(keyRow.name),
            cid: toNumber(keyRow.cid),
            descending: toNumber(keyRow.isDesc ?? keyRow.desc) !== 0,
            collation: toText(keyRow.coll),
          }));
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
      result.push({
        name,
        tableName,
        // A WITHOUT ROWID table's primary-key index is the table itself and
        // has no sqlite_schema row; it sorts with its table.
        schemaRowid: schemaRow?.schemaRowid ?? 0,
        sql: schemaRow?.sql ?? null,
        isUnique: toNumber(row.isUnique ?? row.unique) !== 0,
        origin: origin === 'u' || origin === 'pk' ? origin : 'c',
        isPartial: toNumber(row.partial) !== 0,
        columns,
      });
    }
    return result;
  }

  async foreignKeys(tableName: string): Promise<SqliteForeignKey[]> {
    const rows = await this.pragma(
      'foreign_key_list',
      tableName,
      'id, seq, "table" AS referencedTable, "from" AS fromColumn, "to" AS toColumn, on_update AS onUpdate, on_delete AS onDelete, "match" AS matchMode',
    );
    const byId = new Map<
      number,
      SqliteForeignKey & { columns: { from: string; to: string | null }[] }
    >();
    const ordered = [...rows].sort(
      (a, b) => toNumber(a.id) - toNumber(b.id) || toNumber(a.seq) - toNumber(b.seq),
    );
    for (const row of ordered) {
      const id = toNumber(row.id);
      let foreignKey = byId.get(id);
      if (!foreignKey) {
        foreignKey = {
          tableName,
          id,
          referencedTableName: toText(row.referencedTable ?? row.table) ?? '',
          columns: [],
          onUpdate: toText(row.onUpdate ?? row.on_update) ?? 'NO ACTION',
          onDelete: toText(row.onDelete ?? row.on_delete) ?? 'NO ACTION',
          match: toText(row.matchMode ?? row.match) ?? 'NONE',
        };
        byId.set(id, foreignKey);
      }
      foreignKey.columns.push({
        from: toText(row.fromColumn ?? row.from) ?? '',
        to: toText(row.toColumn ?? row.to),
      });
    }
    return [...byId.values()];
  }

  async sequences(): Promise<SqliteSequence[]> {
    const rows = await this.rows(
      `SELECT name, CAST(seq AS TEXT) AS value FROM ${this.qualifier}.sqlite_sequence`,
    );
    return rows.map(row => ({
      tableName: toText(row.name) ?? '',
      value: toText(row.value) ?? '0',
    }));
  }

  async settings(): Promise<
    Pick<SqliteDatabase, 'encoding' | 'userVersion' | 'applicationId' | 'pageSize'>
  > {
    const read = async (pragma: string): Promise<unknown> => {
      try {
        const rows = await this.rows(`PRAGMA ${this.qualifier}.${pragma}`);
        const first = rows[0];
        return first === undefined ? undefined : Object.values(first)[0];
      } catch (error) {
        if (isAbortError(error)) throw error;
        return undefined;
      }
    };
    // `encoding` is a property of the main database; an attached database
    // always shares it.
    let encoding: unknown;
    try {
      const rows = await this.rows('PRAGMA encoding');
      encoding = rows[0] === undefined ? undefined : Object.values(rows[0])[0];
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    const pageSize = await read('page_size');
    return {
      encoding: toText(encoding) ?? 'UTF-8',
      userVersion: toNumber(await read('user_version')),
      applicationId: toNumber(await read('application_id')),
      ...(pageSize === undefined ? {} : { pageSize: toNumber(pageSize) }),
    };
  }
}
