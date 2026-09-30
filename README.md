# dbgate-sqlite-dumper

Standalone, client-agnostic SQLite dump and restore library for Node.js.

Produces the same plain-SQL dump the `sqlite3` shell's `.dump` command writes, and
restores it back — entirely through a database handle. **No `sqlite3` shell, no
external process is ever invoked.** Framework-independent: it does not depend on
DbGate internals and works outside DbGate.

- Node.js >= 20, ESM and CJS builds, full TypeScript types
- `better-sqlite3` is an **optional** peer dependency, reachable only through the
  separate `dbgate-sqlite-dumper/better-sqlite3` entry point — the core never
  imports a driver
- Streaming both ways: a multi-gigabyte database dumps, and a multi-gigabyte `.sql`
  file restores, in constant memory

## Two-way native compatibility

Both directions are **proven by automated tests against the real `sqlite3` shell**,
not assumed:

- **Dumps produced by this library restore with the native shell.**
  ```sh
  sqlite3 copy.db < dump.sql
  ```
- **Dumps produced by the native `.dump` restore with this library.**
  ```ts
  await restoreSqlDump({ connection, source: createReadStream('native-dump.sql') });
  ```

There is no custom format, no archive wrapper, and no metadata sidecar. A `.sql` file
this package writes is **byte-identical** to `sqlite3 database.db .dump` — and to its
`--data-only`, `--preserve-rowids`, `--newlines` and `--nosys` variants — with one
exception that is a property of SQLite itself: the digits past the 17th in a `REAL`
literal come from SQLite's own `printf("%!.20g")`, which changed between releases, so a
driver bundling a different SQLite than the shell may spell the same double differently
(`0.100000000000000005` vs `0.1000000000000000056`). Both parse to the identical value;
the tests compare such lines as doubles and every other byte exactly. See
[docs/native-compatibility.md](docs/native-compatibility.md).

Every path in the matrix ends by reading back the restored database and deep-comparing
its schema _and_ every table's rows — text compared as bytes — against the source.

| Path                                       | Tested |
| ------------------------------------------ | ------ |
| this library → native `sqlite3` restore    | ✅     |
| native `.dump` → this library's restore    | ✅     |
| this library → this library                | ✅     |
| native `.dump` → native restore (baseline) | ✅     |

## Install

```sh
npm install dbgate-sqlite-dumper
# optional, for the bundled better-sqlite3 adapter:
npm install better-sqlite3
```

## Quick start

### Dump

```ts
import { createWriteStream } from 'node:fs';
import { dumpSqlite } from 'dbgate-sqlite-dumper';
import { connectBetterSqlite3 } from 'dbgate-sqlite-dumper/better-sqlite3';

const { connection, close } = await connectBetterSqlite3('shop.db', { readonly: true });

try {
  const result = await dumpSqlite(
    connection,
    { mode: 'full' },
    createWriteStream('shop.sql'),
    event => console.log(event.phase, event.objectName ?? '', event.bytesWritten ?? ''),
  );

  console.log(`${result.rowsExported} rows in ${result.statementsWritten} statements`);
  for (const warning of result.warnings) {
    console.warn(`[${warning.severity}] ${warning.code}: ${warning.message}`);
  }
} finally {
  await close();
}
```

The result is restorable by `sqlite3 shop_copy.db < shop.sql`.

### Restore

```ts
import { createReadStream } from 'node:fs';
import { restoreSqlDump } from 'dbgate-sqlite-dumper';
import { connectBetterSqlite3 } from 'dbgate-sqlite-dumper/better-sqlite3';

const { connection, close } = await connectBetterSqlite3('shop_copy.db');

const result = await restoreSqlDump({
  connection,
  source: createReadStream('shop.sql'),
  progress: event => console.log(event.phase, event.currentObject, event.rowsRestored),
});

console.log(`${result.statementsExecuted} statements, ${result.rowsRestored} rows`);
for (const error of result.errors) {
  console.error(
    `statement ${error.statementIndex} (line ${error.location.startLine}): ${error.message}`,
  );
  console.error(`  ${error.sqlPreview}`); // truncated, key-redacted
  console.error(`  code=${error.sqliteError?.code}`);
}
await close();
```

`source` accepts a `string`, a `Buffer`, a `Readable`, or any `AsyncIterable` of text or
`Buffer` chunks. Input is parsed incrementally, so restoring a multi-gigabyte dump does not
read it into memory.

### Using a database you already have open

```ts
import Database from 'better-sqlite3';
import { fromBetterSqlite3 } from 'dbgate-sqlite-dumper/better-sqlite3';

const connection = fromBetterSqlite3(new Database('shop.db'));
```

A database you supply is **borrowed and never closed**. See
[docs/better-sqlite3-adapter.md](docs/better-sqlite3-adapter.md); any other driver works by
implementing the small `SqliteConnection` interface.

## Public API

| Function                                                               | Purpose                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `dumpSqlite(connection, options, output, onProgress?, signal?)`        | Full pipeline: snapshot → introspect → plan → render → stream rows |
| `restoreSqlDump({ connection, source, options?, progress?, signal? })` | Streaming parser → statements → database                           |
| `introspectSqlite(connection, options?, signal?)`                      | Normalized `SqliteDatabase` + version/capabilities/diagnostics     |
| `inspectDumpArchive(database, options?)`                               | Pure planning → ordered, verified `ArchiveEntry[]`                 |
| `renderPlainSql(request)`                                              | Pure model → plain SQL text (never touches the database)           |
| `exportTableDataAsInserts(request)`                                    | Stream one table's rows as `INSERT` statements                     |
| `preflightRestore(request)`                                            | Target version, modules, conflicts, and what the dump needs        |
| `isSqliteDump(sample)`                                                 | Recognizes native _and_ this package's dumps                       |
| `parseSqlStatements(sql)` / `streamSqlStatements(source)`              | The shell-compatible statement splitter, usable on its own         |
| `isCompleteStatement(sql)`                                             | A port of `sqlite3_complete()`                                     |
| `beginSqliteDumpSession(connection, options?)`                         | The read snapshot, on its own                                      |
| `checkTargetCompatibility(database, target)`                           | Which features a target cannot accept                              |
| `fromBetterSqlite3(database)`                                          | Adapter (from `dbgate-sqlite-dumper/better-sqlite3`)               |
| `connectBetterSqlite3(filename, options?)`                             | Convenience opener (from `dbgate-sqlite-dumper/better-sqlite3`)    |

Each stage is independently usable: `inspectDumpArchive` and `renderPlainSql` are pure
functions of the model and need no connection at all.

## Why a real parser, not `split(';')`

Splitting a SQLite script on semicolons breaks on the _first_ trigger in any dump:

```sql
CREATE TRIGGER audit_books AFTER INSERT ON books BEGIN
  INSERT INTO audit VALUES ('book ' || new.title || '; END');
  UPDATE authors SET books = books + 1 WHERE id = new.author_id;
END;
```

This package splits a script exactly where the `sqlite3` shell does, by porting the two
pieces of SQLite that decide it: `sqlite3_complete()` — the state machine that keeps a
trigger body's inner statements together — and the shell's own line rules:

- **`GO` and `/` lines end a statement**, as in the shell (SQL Server and Oracle habits).
- **Dot-commands are the shell's, not SQL.** Presentational ones (`.mode`, `.headers`,
  `.print`) are skipped with a warning; ones that change the database (`.read`,
  `.import`, `.open`) are refused with a precise error rather than silently ignored.
- **A `\r` before a newline is dropped**, even inside a string literal — the shell's line
  reader does that, so a CRLF file restores identically.
- **Bytes that are not valid UTF-8 survive.** The native `.dump` writes such text raw; a
  JavaScript driver cannot pass it through a string, so the literal is rewritten to the
  exact-byte `CAST(X'...' AS TEXT)`.

Boundary correctness is not assumed: the parser's output is asserted identical at **every**
chunk size and **every** single split point, and a suite of hand-written scripts is run
through both the shell and this package, which must leave identical databases.

## Documentation

| Document                                                         | Contents                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| [docs/native-compatibility.md](docs/native-compatibility.md)     | The two-way promise, what is reproduced and why, native quirks   |
| [docs/dump-api.md](docs/dump-api.md)                             | `dumpSqlite` options, modes, consistency, progress, batching     |
| [docs/restore-api.md](docs/restore-api.md)                       | `restoreSqlDump`, the parser, session cleanup, errors, preflight |
| [docs/better-sqlite3-adapter.md](docs/better-sqlite3-adapter.md) | Ownership, defensive mode, the `SqliteConnection` contract       |
| [docs/supported-objects.md](docs/supported-objects.md)           | Object matrix: dumped / restored / round-trip tested             |
| [docs/supported-data-types.md](docs/supported-data-types.md)     | Per-storage-class fidelity and how each value is written         |
| [docs/known-limitations.md](docs/known-limitations.md)           | What this package does not do, and why                           |
| [docs/round-trip-testing.md](docs/round-trip-testing.md)         | Running the interop suite; the fixture                           |
| [docs/architecture.md](docs/architecture.md)                     | Layer-by-layer design and the reasoning behind it                |

## Fidelity highlights

- **64-bit integers are exact.** Every value is rendered to text by SQLite itself, so
  `9223372036854775807` never passes through a JavaScript number.
- **`REAL` digits are SQLite's own**, from the same `printf` the shell uses.
- **Virtual tables come back byte-identical**, FTS5 indexes and R-trees included: like the
  native `.dump`, the schema row is written directly and the shadow tables' contents are
  copied, instead of rebuilding the index.
- **Text is bytes.** Invalid UTF-8 and embedded `NUL`s survive a round trip; the native
  shell silently truncates text at the first `NUL`, this package does not.
- **Connections are left as they were found.** A native dump turns `foreign_keys` off and
  never turns it back on; a restore that stops early leaves a transaction open. Both are
  put back before the handle is returned.
- **Consistent under concurrent writes.** A dump reads every table inside one snapshot.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test                   # unit tests; better-sqlite3 in-process, nothing else needed

npm run test:integration   # needs the sqlite3 shell on PATH (apt install sqlite3)
npm run test:package       # builds, then smoke-tests dist/ as ESM and CJS
```

Integration tests skip themselves with a clear message when the `sqlite3` shell is not
installed; set `SQLITE_TEST_REQUIRED=1` (as CI does) to make that a hard error.
`SQLITE3_BIN` selects a specific shell binary.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
