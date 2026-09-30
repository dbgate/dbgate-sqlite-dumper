# Dump API

```ts
dumpSqlite(connection, options, output, onProgress?, signal?): Promise<DumpResult>
```

Runs a complete dump — acquire a handle, open a read snapshot, introspect, plan, render,
stream rows — writing plain SQL in the native `.dump` layout to `output`.

```ts
import { createWriteStream } from 'node:fs';
import { dumpSqlite } from 'dbgate-sqlite-dumper';
import { connectBetterSqlite3 } from 'dbgate-sqlite-dumper/better-sqlite3';

const { connection, close } = await connectBetterSqlite3('shop.db', { readonly: true });
try {
  const result = await dumpSqlite(connection, {}, createWriteStream('shop.sql'));
  console.log(`${result.rowsExported} rows in ${result.statementsWritten} statements`);
} finally {
  await close();
}
```

## `output`

Any `Writable`. Never ended or closed by this package — the caller owns its lifecycle.

A dump is written incrementally, honouring backpressure, so a multi-gigabyte database
dumps in constant memory. `output` may receive `Buffer` chunks as well as text: a `TEXT`
value holding bytes that are not valid UTF-8 is written raw, exactly as the native `.dump`
writes it, and cannot be routed through a JavaScript string without corruption.

## `DumpSqliteOptions`

| Option        | Default      | Meaning                                         |
| ------------- | ------------ | ----------------------------------------------- |
| `mode`        | `'full'`     | `'full'`, `'schema-only'`, `'data-only'`.       |
| `schemaName`  | `'main'`     | `main`, `temp`, or an attached database's name. |
| `selection`   | everything   | Per-name object filters; see below.             |
| `objectKinds` | all `true`   | Which kinds participate at all.                 |
| `render`      | see below    | Output shape.                                   |
| `dataExport`  | see below    | Row rendering and batching.                     |
| `consistency` | `'snapshot'` | How a consistent view is obtained.              |

The dump itself never names the schema (`CREATE TABLE t`, not `CREATE TABLE aux.t`), so a
dump of an attached database restores into whatever database it is run against — like a
native `.dump`.

### `mode`

- **`'full'`** — schema and rows: the native `.dump`.
- **`'data-only'`** — `INSERT` statements only, no frame: the native `.dump --data-only`.
  See [data-only dumps](#data-only-dumps).
- **`'schema-only'`** — every `CREATE`, no rows, no `AUTOINCREMENT` counters, no statistics.
  Virtual tables are created with their own `CREATE VIRTUAL TABLE`, so their module sets up
  its shadow tables, which are therefore left out.

### `selection`

Names are exact identifiers, never patterns, compared the way SQLite compares them (ASCII
letters case-insensitively, nothing else folded).

```ts
selection: {
  tables: ['orders', 'order_lines'],   // omit for all
  excludeTables: ['orders_archive'],   // applied after `tables`
  views: [...], excludeViews: [...],
  triggers: [...], excludeTriggers: [...],
  excludeIndexes: [...],               // indexes otherwise follow their table

  // Structure dumped, rows skipped — for a large log or cache table you still
  // want recreated.
  dataExcludedTables: ['request_log'],
}
```

Selecting a virtual table selects its shadow tables (`docs` brings `docs_data`,
`docs_idx`, ...). A trigger whose table is not selected is dropped rather than orphaned,
and reported as `trigger-table-not-selected`. In a partial dump, the `sqlite_sequence` and
statistics rows are restricted to the selected tables, and only their counters are reset.

### `objectKinds`

```ts
objectKinds: {
  includeTables: true,
  includeViews: true,
  includeIndexes: true,
  includeTriggers: true,
  includeVirtualTables: true,   // and their shadow tables
  includeSystemTables: true,    // sqlite_sequence, sqlite_stat*; false = native --nosys
}
```

### `render` — output shape

| Option                     | Default   | Meaning                                                            |
| -------------------------- | --------- | ------------------------------------------------------------------ |
| `includeSessionGuards`     | `true`    | `PRAGMA foreign_keys=OFF;` / `BEGIN TRANSACTION;` … `COMMIT;`      |
| `includeHeaderComments`    | `true`    | The defensive-mode warning line, when there are virtual tables.    |
| `addDropStatements`        | `false`   | `DROP … IF EXISTS` before each `CREATE`.                           |
| `includeDatabaseSettings`  | `false`   | `PRAGMA user_version` / `application_id` before `COMMIT`.          |
| `legacySchemaTableName`    | `false`   | Write `sqlite_master` instead of `sqlite_schema` (targets < 3.33). |
| `unsupportedFeaturePolicy` | `'error'` | `'warn-omit'` skips an entry that cannot be rendered instead.      |

Notes on the ones that carry weight:

- **`includeSessionGuards: false`** produces a `session-guards-disabled` warning. Without
  `foreign_keys=OFF`, tables that reference each other may not restore in creation order;
  without the transaction, every `INSERT` is its own transaction and its own disk sync.
- **`includeDatabaseSettings`** is off to match the native `.dump`, which does not carry
  `user_version`. Applications often track their schema migrations there, so a non-zero
  value that is not being dumped is reported as `user-version-not-dumped`.

### `dataExport` — row rendering

| Option                | Default | Meaning                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------- |
| `preserveRowids`      | `false` | `INSERT INTO t(rowid,…)` for hidden rowids; native `--preserve-rowids`. |
| `rawNewlines`         | `false` | Raw newlines in literals instead of `replace()`; native `--newlines`.   |
| `extendedInsert`      | `false` | Multi-row `INSERT … VALUES (…),(…)`.                                    |
| `maxRowsPerStatement` | `500`   | With `extendedInsert`.                                                  |
| `maxStatementBytes`   | 1 MiB   | With `extendedInsert`; a single larger row is still emitted alone.      |
| `streamBatchSize`     | —       | Hint passed to `connection.stream()`.                                   |

- **`preserveRowids`**: a table without an `INTEGER PRIMARY KEY` has a hidden rowid, and
  without this option a restore renumbers its rows from 1. That matters when anything
  refers to rowids — an external-content FTS index, an application storing them.
- **`extendedInsert`** makes the file smaller and the restore faster, at the cost of native
  byte identity. One row per statement is not slow in SQLite — the whole restore is one
  transaction — so the default follows the native layout.

Rows are read in the table's natural order, with no `ORDER BY`, exactly like the native
`.dump`: rowid order for an ordinary table, primary-key order for a `WITHOUT ROWID` one. Two
dumps of an unchanged database are identical.

### `consistency`

- **`'snapshot'`** (default) — the whole dump runs inside one read transaction (a
  `SAVEPOINT`, so it nests inside a transaction the caller already has open, and reads
  what that transaction sees). In WAL mode that is a true snapshot and writers carry on; in
  rollback-journal mode it holds a `SHARED` lock that keeps writers out until the dump
  ends. It is the same mechanism the native `.dump` uses.
- **`'none'`** — no transaction; only safe when nothing else writes to the database.

## Data-only dumps

`.dump --data-only` — and `mode: 'data-only'`, which reproduces it — has two quirks that
matter when loading the rows into an existing schema:

- it carries each virtual table's rows twice: through the table, and as its shadow tables'
  rows, which collide with the target table's own shadow rows;
- it inserts into `sqlite_sequence` and `sqlite_stat*` without preparing them, leaving
  duplicate counters, or failing where the target was never analyzed.

For loading rows into an existing schema, this option set avoids both:

```ts
await dumpSqlite(
  connection,
  {
    mode: 'data-only',
    objectKinds: { includeSystemTables: false },
    selection: {
      dataExcludedTables: ['docs_data', 'docs_idx', 'docs_content', 'docs_docsize', 'docs_config'],
    },
  },
  output,
);

// …and restore with
await restoreSqlDump({
  connection: target,
  source,
  options: { transaction: 'wrap', disableForeignKeys: true },
});
```

Create triggers after the load, or they fire for every restored row.

## `DumpResult`

```ts
{
  bytesWritten: number;
  rowsExported: number;
  statementsWritten: number;
  renderedDumpIds: readonly string[];
  skippedDumpIds: readonly string[];
  warnings: readonly SqliteDiagnostic[];
  cancelled: boolean;
}
```

`cancelled` is `true` when the `AbortSignal` fired; the dump is truncated but nothing
throws, and the read transaction is ended cleanly.

## Progress

Phases, in order: `connecting`, `starting-snapshot`, `introspecting`, `detecting-version`,
`planning-archive`, `rendering-schema`, `exporting-data`, `finalizing`. Rendering events
carry `section`, `objectsProcessed`/`objectsTotal` and `objectName`; data events carry
`exportState` (`started`/`progress`/`finished`/`failed`/`cancelled`), `tableName`,
`rowsExported` and `bytesWritten`, every 1000 rows.

## Cancellation

```ts
const controller = new AbortController();
const result = await dumpSqlite(connection, {}, output, undefined, controller.signal);
if (result.cancelled) console.warn('dump truncated');
```

Cancellation takes effect between rows. Buffered output is deliberately **not** flushed: a
dump cut off at an arbitrary row should look truncated, not complete.

## Composing the stages

```ts
import {
  introspectSqlite,
  inspectDumpArchive,
  renderPlainSql,
  BufferDumpWriter,
} from 'dbgate-sqlite-dumper';

const { database, version } = await introspectSqlite(connection);

// Inspect the plan without rendering anything.
const archive = inspectDumpArchive(database, { mode: 'schema-only' });
for (const entry of archive.entries) {
  console.log(entry.sequenceNumber, entry.section, entry.objectType, entry.name);
}

// Render schema only, into memory, with no database access.
const writer = new BufferDumpWriter();
await renderPlainSql({ database, archive, writer, mode: 'schema-only', sourceVersion: version });
console.log(writer.toString());
```

`exportTableDataAsInserts` streams one table's rows on its own:

```ts
import { exportTableDataAsInserts } from 'dbgate-sqlite-dumper';

await exportTableDataAsInserts({
  connection,
  schemaName: 'main',
  table: database.tables.find(table => table.name === 'orders')!,
  writer,
  options: { extendedInsert: true },
});
```
