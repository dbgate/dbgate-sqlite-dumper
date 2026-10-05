# Architecture

The package is a stack of layers, each usable on its own. Nothing above the `connection`
layer knows what driver is in use; nothing below the `api` layer knows about a dump as a
whole.

```
                     ┌──────────────────────────────────────────┐
  api/               │ dumpSqlite()  ·  restoreSqlDump()        │  orchestration
                     └──────────────────────────────────────────┘
                            │              │            │
  introspection/  ──────────┘              │            └────── restore/
    sqlite_schema + pragmas → model        │                     sqlite3_complete + shell
                                           │                     line rules → statements
  archive/  ─────── plan: what & in what order
  renderer/  ────── model + plan → plain SQL text        preflight/  compatibility/
  data/  ────────── rows → INSERT statements             selection/  security/
  writer/  ──────── text/bytes → Writable                version/    model/
                            │
                     ┌──────────────────────────────────────────┐
  connection/        │ SqliteConnection (driver-agnostic)       │
                     └──────────────────────────────────────────┘
                            │
  better-sqlite3.ts ─ the only module that knows better-sqlite3 exists
```

This mirrors `dbgate-mysql-dumper`, `dbgate-pg-dumper`, `dbgate-mssql-dumper` and
`dbgate-redis-dumper`; the SQLite-specific differences are called out below.

## `connection/` — the driver boundary

`SqliteConnection` is the whole contract between this package and a driver: `query()`,
`stream()`, and optional `execute()`, `describeError()`, `isInTransaction()` and
`setDefensive()`, plus `cancel()`. The core never imports a driver, and
`tests/packageBoundaries.test.ts` fails if it starts to.

SQLite is embedded, so a "connection" is one open database handle. The contract keeps the
shape of the network drivers' in the sibling packages — including `SqliteConnectionSource`
for pool-like inputs — so an application can drive every dumper the same way.

### Connection features: engines that are not a SQLite handle

An adapter may declare `features` — restrictions of the engine behind it — and an optional
`queryBatch()`. Cloudflare D1 (`src/d1.ts`) is why they exist: SQLite's SQL, reached over
HTTP, behind an authorizer. Each feature makes the core choose an equivalent query rather
than a different dump:

- `transactions: false` — the session reads without a snapshot and says so
  (`snapshot-unavailable`);
- `pragmaFunctions: false` / `extendedPragmas: false` — the catalog is read through the
  classic `PRAGMA` statements (the reader also falls back on its own the first time an
  extended pragma is refused);
- `schemaQualifiedNames: false` — no statement names a schema;
- `binaryTransport: 'hex'` — text and blob bytes are selected as `hex()`;
- `pagedReadSize` — table data is read through `query()` in pages keyed on the rowid or
  the primary key, in natural scan order, instead of through `stream()`;
- `reservedNamePrefixes` — objects the engine keeps for itself are left out, together
  with their counters and statistics.

`queryBatch()` lets introspection fetch every table's catalog in a few requests; a batch
that fails is not fatal, its queries simply run one by one. The tests run every feature
against an ordinary handle as well, where each must leave the dump byte-identical.

### Why one read transaction

A dump runs entirely inside one transaction on one handle (`session.ts`), opened as a
`SAVEPOINT` so that it nests inside a transaction the caller already has, and with one read
issued immediately so the snapshot is taken at the start rather than by whichever catalog
query happens to run first. In WAL mode that is a true snapshot; in rollback-journal mode it
holds a `SHARED` lock. The native shell does the same (`SAVEPOINT dump`). It is released
without the caller's `AbortSignal`, so a cancelled dump still ends it.

## `introspection/` — catalog to model

Everything comes from `sqlite_schema` (read as `sqlite_master`, which every release
accepts), in rowid order, plus the table-valued pragma functions — `table_xinfo`,
`index_list`, `index_xinfo`, `foreign_key_list`, `table_list` — with a fallback to plain
`PRAGMA` statements on libraries too old for them. Tables are classified as ordinary,
virtual, shadow (a virtual table's storage) or system (`sqlite_*`).

### Why the DDL is not reconstructed

SQLite keeps every `CREATE` statement verbatim, and the native `.dump` writes that text.
Reconstructing DDL from the column model would lose comments, spelling, formatting and any
clause the model does not know about, for no gain. The model exists for everything else —
planning, selection, `INSERT` column lists, compatibility checks, diagnostics — which is why
`renderPlainSql` is a pure function of it.

## `archive/` — the plan

`inspectDumpArchive` turns a model into ordered `ArchiveEntry` objects. It is pure: no SQL
text, no streams, no connection.

The order is the native `.dump`'s — creation order — not a topological sort. Creation order
is valid for everything SQLite checks at `CREATE` time (an index after its table, a trigger
after its table or view), SQLite resolves view and trigger bodies lazily, and the dump's
`PRAGMA foreign_keys=OFF` makes table order irrelevant to foreign keys. Dependencies are
still recorded and then _verified_ against that order:

- **`hard`** — a trigger depends on its table's data this way: created before the rows, it
  would fire for each one.
- **`preference`** — every foreign key. Recording them as hard edges would report a false
  cycle for exactly the circular schemas that restore perfectly well.

## `renderer/` — model to text

A port of the parts of `shell.c` that shape `.dump` output — `printSchemaLine()`,
`run_table_dump_query()`, the virtual-table `INSERT INTO sqlite_schema` — driven by the
archive, with row data arriving through an `onTableData` hook so the renderer never needs a
connection. `sqlite3_complete()` itself is ported (in `restore/complete.ts`) because
`printSchemaLine()` calls it to decide how to terminate DDL that ends in a comment.

## `data/` — rows to `INSERT`

`exportTableDataAsInserts` streams one table in constant memory.

### Why SQLite renders the values

The `SELECT` it runs does not fetch column values; it fetches each value's storage class and
a representation computed _by SQLite_: integers as text, reals as the finished literal —
using SQLite's own `printf('%!.20g')`, the formatter the shell uses — and text as its stored
bytes. Three problems disappear at once: 64-bit integers never become JavaScript numbers;
`REAL` digits match the shell's exactly, which no JavaScript formatting could; and text that
is not valid UTF-8 is not "repaired" by the driver's decoder. The core is then exact with
any driver that can return strings and bytes.

`SqlChunkBuilder` keeps `(string | Buffer)[]` parts and only falls back to `Buffer.concat`
once it has been handed bytes, so the all-text case stays on the string fast path.

## `restore/` — text to statements

### The parser

`SqlStatementParser` is an incremental scanner over **bytes**: a dump is not necessarily
valid UTF-8, and `latin1` is a bijection between bytes and code units, so nothing is lost
and every character the scanner reacts to is ASCII.

It has two layers, both ported: `sqlite3_complete()`'s eight-state machine, which decides
when a `;` completes a statement (and keeps trigger bodies whole), and the shell's
`process_input()` line rules — dot-commands and `#` comments at column 0 when nothing is
pending, `GO`/`/` terminator lines checked with the shell's own `line_is_complete()`
condition, and the `\r` its line reader drops before each `\n`.

Anything whose meaning depends on the next chunk — a `-` or `/` that may open a comment, a
`*` that may close one, a `\r` that may precede `\n`, a line start that may be a `GO` line,
a word that may be a keyword — is carried or kept in state, never guessed.
`tests/statementParser.test.ts` checks identical output at every chunk size and every split
point.

### Session cleanup

`RestoreSessionState` follows only classified top-level statements (transaction control,
`PRAGMA foreign_keys`, `PRAGMA writable_schema`, writes to the schema table), never text
inside rows or trigger bodies, and puts back what the script changed: it rolls back a
transaction the script opened and left open, resets `writable_schema`, and returns
`foreign_keys` to its previous value — which a native dump never does, because it is written
for a shell that exits.

## `writer/` — text and bytes out

`DumpWriter.write` accepts `string | Buffer` for the reason above. `StreamDumpWriter` honours
backpressure by gating on `write()`'s return value with the `drain` listener attached in the
same tick, and never calls `end()` on a caller-owned stream.

## `security/` — quoting and escaping

Two quoting functions, for two jobs. `quoteIdentifier` always double-quotes, and is used for
every query this package runs. `quoteIdentifierIfNeeded` reproduces the shell's
`quoteChar()` — quote only non-identifiers and SQLite's 147 keywords — and is used only
where output must match the native layout. Literal rendering ports
`output_quoted_escaped_string()`, including `unused_string()`'s placeholder choice.

## Testing strategy

| Suite          | Needs           | What it proves                                                      |
| -------------- | --------------- | ------------------------------------------------------------------- |
| `tests/`       | nothing         | Every layer, against in-memory `better-sqlite3` databases.          |
| `integration/` | `sqlite3` shell | Byte identity, the four-way matrix, shell-script parity, streaming. |

See [round-trip-testing.md](round-trip-testing.md).
