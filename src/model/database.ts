/**
 * The normalized SQLite schema model.
 *
 * SQLite stores every schema object's DDL verbatim in `sqlite_schema.sql`,
 * and that text — not a reconstruction from the column model — is what a
 * dump emits, exactly as the native `.dump` does. The structured fields
 * exist for everything else: archive planning, selection, data export
 * column lists, compatibility checks and diagnostics.
 */

/** What kind of table a `type = 'table'` row of `sqlite_schema` is. */
export type SqliteTableKind =
  /** An ordinary table. */
  | 'table'
  /** `CREATE VIRTUAL TABLE ... USING module(...)`. */
  | 'virtual'
  /** A table a virtual table module created to store its own data (`ft_data`, `rt_node`, ...). */
  | 'shadow'
  /** `sqlite_sequence`, `sqlite_stat1`, `sqlite_stat4`, and any other `sqlite_` table. */
  | 'system';

/**
 * `hidden` as `PRAGMA table_xinfo` reports it: `0` an ordinary column,
 * `1` a hidden column of a virtual table, `2` a `VIRTUAL` generated column,
 * `3` a `STORED` generated column.
 */
export type SqliteColumnHidden = 0 | 1 | 2 | 3;

export interface SqliteColumn {
  /** 0-based position, as `PRAGMA table_xinfo` numbers it (`cid`). */
  readonly cid: number;
  readonly name: string;
  /** The declared type exactly as written (`VARCHAR(20)`, `INTEGER`, or `''` for none). */
  readonly declaredType: string;
  readonly notNull: boolean;
  /** Default value expression text as written, or `null` for none. */
  readonly defaultValue: string | null;
  /** 1-based position within the primary key, `0` when not part of it. */
  readonly primaryKeyPosition: number;
  readonly hidden: SqliteColumnHidden;
  readonly generated: 'none' | 'virtual' | 'stored';
}

export interface SqliteTable {
  readonly name: string;
  readonly kind: SqliteTableKind;
  /** `rowid` of this table's row in `sqlite_schema`; native dump order is by it. */
  readonly schemaRowid: number;
  /** Verbatim `sqlite_schema.sql`. */
  readonly sql: string;
  readonly withoutRowid: boolean;
  readonly strict: boolean;
  readonly hasAutoincrement: boolean;
  /** For a virtual table, the module named in `USING` (`fts5`, `rtree`, ...). */
  readonly virtualModule?: string;
  /** For a shadow table, the virtual table that owns it. */
  readonly ownerVirtualTable?: string;
  /**
   * The column that aliases the rowid (`INTEGER PRIMARY KEY`), or `null`
   * when the table has a separate, hidden rowid — the case in which a plain
   * dump renumbers rows, and `preserveRowids` exists to prevent that. Always
   * `null` for a `WITHOUT ROWID` table.
   */
  readonly rowidAliasColumn: string | null;
  /** Columns in `cid` order, including hidden and generated ones. */
  readonly columns: readonly SqliteColumn[];
}

export interface SqliteIndexColumn {
  /** Column name, or `null` for an expression key part. */
  readonly name: string | null;
  readonly cid: number;
  readonly descending: boolean;
  readonly collation: string | null;
}

export interface SqliteIndex {
  readonly name: string;
  readonly tableName: string;
  readonly schemaRowid: number;
  /**
   * Verbatim `CREATE INDEX` text, or `null` for an automatic index SQLite
   * built for a `UNIQUE`/`PRIMARY KEY` constraint. Those carry no DDL of
   * their own: they are recreated by the table's `CREATE TABLE`.
   */
  readonly sql: string | null;
  readonly isUnique: boolean;
  /** `'c'` created by `CREATE INDEX`, `'u'` a `UNIQUE` constraint, `'pk'` a `PRIMARY KEY`. */
  readonly origin: 'c' | 'u' | 'pk';
  readonly isPartial: boolean;
  /** Key columns only, in index order. */
  readonly columns: readonly SqliteIndexColumn[];
}

export interface SqliteView {
  readonly name: string;
  readonly schemaRowid: number;
  readonly sql: string;
}

export interface SqliteTrigger {
  readonly name: string;
  /** The table (or, for `INSTEAD OF`, view) the trigger is attached to. */
  readonly tableName: string;
  readonly schemaRowid: number;
  readonly sql: string;
}

export interface SqliteForeignKeyColumn {
  readonly from: string;
  /** Referenced column, or `null` when the constraint names only the table (its primary key). */
  readonly to: string | null;
}

export interface SqliteForeignKey {
  readonly tableName: string;
  /** `PRAGMA foreign_key_list` id; unique per table. */
  readonly id: number;
  readonly referencedTableName: string;
  readonly columns: readonly SqliteForeignKeyColumn[];
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

/** One row of `sqlite_sequence`: an `AUTOINCREMENT` table's high-water mark. */
export interface SqliteSequence {
  readonly tableName: string;
  /** Read as text so a value past 2^53 is carried exactly. */
  readonly value: string;
}

export interface SqliteDatabase {
  /** The schema that was introspected: `main`, or an attached database's name. */
  readonly schemaName: string;
  /** `PRAGMA encoding`: `UTF-8`, `UTF-16le` or `UTF-16be`. */
  readonly encoding: string;
  /** `PRAGMA user_version`, which applications use for their own migrations. */
  readonly userVersion: number;
  /** `PRAGMA application_id`. */
  readonly applicationId: number;
  readonly pageSize?: number;
  readonly tables: readonly SqliteTable[];
  readonly indexes: readonly SqliteIndex[];
  readonly views: readonly SqliteView[];
  readonly triggers: readonly SqliteTrigger[];
  readonly foreignKeys: readonly SqliteForeignKey[];
  readonly sequences: readonly SqliteSequence[];
}
