# Supported objects

"Round-trip tested" means the object survives dump → restore and the restored database's
schema and rows deep-compare equal to the source, across all four paths of the
interoperability matrix (this package and the native `sqlite3` shell, each dumping and each
restoring).

## Object matrix

| Object                                 | Dumped | Restored | Round-trip tested | Notes                                                                  |
| -------------------------------------- | :----: | :------: | :---------------: | ---------------------------------------------------------------------- |
| Tables                                 |   ✅   |    ✅    |        ✅         | Verbatim stored DDL, so every clause survives.                         |
| Columns, defaults, collations, `CHECK` |   ✅   |    ✅    |        ✅         | Inline in the table DDL.                                               |
| Primary keys, `UNIQUE` constraints     |   ✅   |    ✅    |        ✅         | Their automatic indexes are recreated by the table DDL.                |
| Foreign keys                           |   ✅   |    ✅    |        ✅         | Circular and self-referencing both covered.                            |
| `INTEGER PRIMARY KEY` (rowid alias)    |   ✅   |    ✅    |        ✅         | The rowid _is_ the column, so it is always kept.                       |
| Hidden rowids                          |   ✅   |    ⚠️    |        ✅         | Renumbered unless `preserveRowids`; see below.                         |
| `AUTOINCREMENT` counters               |   ✅   |    ✅    |        ✅         | `sqlite_sequence`, set after the rows.                                 |
| `WITHOUT ROWID` tables                 |   ✅   |    ✅    |        ✅         |                                                                        |
| `STRICT` tables                        |   ✅   |    ✅    |        ✅         | SQLite 3.37+ on the restoring side.                                    |
| Generated columns (`VIRTUAL`/`STORED`) |   ✅   |    ✅    |        ✅         | Not inserted; SQLite recomputes them.                                  |
| Quoted and keyword names               |   ✅   |    ✅    |        ✅         | `"…"`, `'…'`, `[…]`, keywords, non-ASCII.                              |
| Indexes                                |   ✅   |    ✅    |        ✅         | Partial, expression, `DESC`, `COLLATE`.                                |
| Views                                  |   ✅   |    ✅    |        ✅         | Including one created before the table it reads.                       |
| Triggers                               |   ✅   |    ✅    |        ✅         | Multi-statement bodies; `INSTEAD OF` on views; created after the data. |
| Virtual tables (FTS5, R-tree, …)       |   ✅   |    ✅    |        ✅         | Shadow tables copied exactly; queryable after restore.                 |
| Statistics (`sqlite_stat1`/`stat4`)    |   ✅   |    ✅    |        ✅         | `ANALYZE sqlite_schema;` then the rows.                                |
| `user_version`, `application_id`       |   ⚙️   |    ✅    |        ✅         | With `render.includeDatabaseSettings`; otherwise reported.             |
| Attached databases                     |   ⚙️   |    ✅    |         —         | One schema per dump: pass `schemaName`.                                |
| File settings (page size, WAL, …)      |   ❌   |    —     |         —         | See [known-limitations.md](known-limitations.md).                      |
| Application functions and collations   |   ❌   |    —     |         —         | Registered by the application, not stored in the database.             |

⚙️ = opt-in.

## Model coverage

`introspectSqlite` returns a normalized `SqliteDatabase`:

```ts
{
  schemaName, encoding, userVersion, applicationId, pageSize,
  tables:      SqliteTable[],       // kind (table | virtual | shadow | system), sql, withoutRowid, strict,
                                    // hasAutoincrement, virtualModule, ownerVirtualTable, rowidAliasColumn, columns
  indexes:     SqliteIndex[],       // tableName, sql (null for automatic), isUnique, origin, isPartial, columns
  views:       SqliteView[],
  triggers:    SqliteTrigger[],     // tableName
  foreignKeys: SqliteForeignKey[],  // referencedTableName, column pairs, onUpdate, onDelete, match
  sequences:   SqliteSequence[],    // AUTOINCREMENT counters, as exact text
}
```

Per column: `declaredType` as written, `notNull`, `defaultValue` as written,
`primaryKeyPosition`, and `hidden`/`generated` from `PRAGMA table_xinfo`.

Every object also carries its `sqlite_schema` rowid (`schemaRowid`), which is the order the
dump uses.

## Notable behaviours

### Hidden rowids

A table without an `INTEGER PRIMARY KEY` still has a rowid, just not a declared column. The
native `.dump` does not write it, so a restore numbers the rows 1, 2, 3… in dump order —
closing any gaps deletions left. With `dataExport.preserveRowids` (the native
`--preserve-rowids`), the rowid is named in each `INSERT` and kept, under the first of
`rowid`, `_rowid_`, `oid` that is not a real column.

### Triggers

Created after all table data. A trigger created before the load would fire once per
restored row — an `AFTER INSERT` trigger writing an audit table would fabricate rows the
source never had. The archive records that as a _hard_ dependency. A trigger whose table is
not selected is dropped and reported.

### Virtual tables

Recreated the way the native `.dump` does it — by inserting the table's `sqlite_schema` row
directly, under `PRAGMA writable_schema=ON` — then filling the shadow tables with the
source's exact rows. The module's constructor never runs, so an FTS5 index or an R-tree
comes back byte-identical rather than rebuilt. This needs defensive mode off on the
restoring handle, which the restore arranges and undoes (see
[restore-api.md](restore-api.md#schemawrites)).

A schema-only dump instead creates each virtual table with its own `CREATE VIRTUAL TABLE`,
since no shadow rows follow and the module must set up its storage itself.
