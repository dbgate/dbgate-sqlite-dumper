# The `better-sqlite3` adapter

```ts
import { fromBetterSqlite3, connectBetterSqlite3 } from 'dbgate-sqlite-dumper/better-sqlite3';
```

The only module that knows `better-sqlite3` exists, reachable only through this separate
entry point. `better-sqlite3` is an optional peer dependency: the type import costs nothing
at runtime and the value import is dynamic, so the core package — and this module — load
without it installed. `better-sqlite3` is the driver DbGate's own SQLite plugin uses.

## Ownership

| Function                                | Who closes the database                   |
| --------------------------------------- | ----------------------------------------- |
| `fromBetterSqlite3(database)`           | The caller. The database is **borrowed**. |
| `connectBetterSqlite3(filename, opts?)` | The returned `close()`. Idempotent.       |

`connectBetterSqlite3` passes `opts` straight to the `Database` constructor, so
`{ readonly: true }` for a dump source, `{ fileMustExist: true }` and the rest all work.

## Behaviour

- **Integers are read as `bigint`** (`safeIntegers(true)`) for every catalog query, so no
  value is ever rounded. Row data does not depend on this: it is read through SQL that has
  SQLite render every value as text or bytes (see
  [supported-data-types.md](supported-data-types.md)).
- **`stream()` steps the statement with `iterate()`**, one row at a time, yielding between
  rows — constant memory for a table of any size. While a stream is open, the database
  cannot run another statement; this package never asks it to.
- **`execute()` reports a statement's own row count** (`changes`), 0 for DDL — not the
  count left over from the previous `INSERT`. Text holding several statements, which the
  parser does not produce but other callers might, falls back to `exec()`.
- **`isInTransaction()`** is `database.inTransaction`, which is what lets a restore roll
  back exactly the transaction the script opened.
- **`setDefensive()`** is `unsafeMode()`, which is how `better-sqlite3` exposes
  `SQLITE_DBCONFIG_DEFENSIVE` — on by default in `better-sqlite3`. A restore lifts it only
  for a dump that writes `sqlite_schema` (a virtual-table dump), and puts it back. Unsafe
  mode also relaxes the driver's own guard against writing while iterating; this package
  never does that.
- **`cancel()` is a no-op.** `better-sqlite3` runs each statement synchronously to
  completion, so cancellation takes effect between rows and between statements — prompt,
  since every statement a dump or a restore runs is short.

## Foreign keys

`better-sqlite3` turns `foreign_keys` **on** for every database it opens; the `sqlite3`
shell leaves it off. A full dump turns enforcement off itself, but a data-only dump does
not, so loading one whose tables reference each other needs `disableForeignKeys: true`
(see [restore-api.md](restore-api.md)).

## Statistics tables

`better-sqlite3` is built with `SQLITE_ENABLE_STAT4`, so `ANALYZE` — including the
`ANALYZE sqlite_schema;` a dump runs — creates a `sqlite_stat4` table. A dump of a database
that has one does not restore on a build without STAT4 (the native `.dump` of it fails the
same way); `preflightRestore` reports it as `statistics-table-unsupported`.

## Other drivers

Anything that can run SQL can be adapted by implementing `SqliteConnection`:

```ts
interface SqliteConnection {
  query(
    query: { sql: string; parameters?: readonly unknown[] },
    signal?,
  ): Promise<{ rows: readonly Row[] }>;
  stream(query, options?): AsyncIterable<Row>;
  execute?(sql: string, signal?): Promise<{ changes: number }>; // run text verbatim, no parameter parsing
  describeError?(error): { code?: string; errno?: number; message: string } | undefined;
  isInTransaction?(): boolean;
  setDefensive?(enabled: boolean): Promise<void>;
  cancel(): Promise<void>;
}
```

`query` and `stream` return rows as objects keyed by column name. Values may be any of
SQLite's storage classes as the driver represents them; the core only relies on text,
bytes and `null`, which every driver delivers exactly. The optional members degrade
gracefully: without `execute`, statements go through `query`; without `isInTransaction`,
restore tracks the script's own `BEGIN`/`COMMIT`; without `setDefensive`, a virtual-table
dump restores only onto a handle that is not in defensive mode, and preflight says so.
