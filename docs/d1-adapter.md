# The Cloudflare D1 adapter

```ts
import { fromD1Http, fromD1Binding } from 'dbgate-sqlite-dumper/d1';
```

Dumps a [Cloudflare D1](https://developers.cloudflare.com/d1/) database into the same
plain-SQL file the native `sqlite3 .dump` would write for a local copy of it. The adapter
has no dependencies: it uses the global `fetch` (or the one you pass it).

**Dump only.** Restoring into D1 is not supported: D1 refuses the `BEGIN TRANSACTION` /
`COMMIT` and `PRAGMA writable_schema` statements a dump script relies on. To load a dump
into D1, use `wrangler d1 execute <db> --remote --file=dump.sql`, after removing those
statements as Cloudflare's import guide describes. A D1 dump restores into an ordinary
SQLite database with `restoreSqlDump` or the `sqlite3` shell as usual.

## Over the REST API

```ts
import fs from 'node:fs';
import { dumpSqlite } from 'dbgate-sqlite-dumper';
import { fromD1Http } from 'dbgate-sqlite-dumper/d1';

const connection = fromD1Http({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: 'c8a3...', // the UUID `wrangler d1 list` shows
  apiToken: process.env.CLOUDFLARE_API_TOKEN, // needs D1 Read
});
const result = await dumpSqlite(connection, {}, fs.createWriteStream('backup.sql'));
```

| Option       | Default                                | Meaning                                  |
| ------------ | -------------------------------------- | ---------------------------------------- |
| `accountId`  | required                               | Cloudflare account ID                    |
| `databaseId` | required                               | The database's UUID                      |
| `apiToken`   | required                               | API token with `D1 Read` (or `D1 Edit`)  |
| `apiBaseUrl` | `https://api.cloudflare.com/client/v4` | For a proxy or a test server             |
| `pageSize`   | `1000`                                 | Rows per request when table data is read |
| `fetch`      | `globalThis.fetch`                     | Any `fetch`-compatible function          |

Statements go to the `/raw` query endpoint. The catalog of every table is fetched in
`batch` requests of up to 50 statements, so introspection takes a handful of round trips
whatever the number of tables. The token is sent only in the `Authorization` header and is
never part of an error message. Errors are `D1Error`s carrying the message Cloudflare
returned, the HTTP `status`, and the `SQLITE_*` code when the message names one.

`connection.cancel()` (and the dump's `AbortSignal`) aborts the request in flight.

## Inside a Worker

```ts
import { dumpSqlite, BufferDumpWriter } from 'dbgate-sqlite-dumper';
import { fromD1Binding } from 'dbgate-sqlite-dumper/d1';

const connection = fromD1Binding(env.DB, { pageSize: 1000 });
```

Uses `prepare().bind().raw({ columnNames: true })` and `batch()`. The package uses
`Buffer`, so the Worker needs the `nodejs_compat` compatibility flag.

## How D1's restrictions are handled

The adapter declares what D1 does not allow as `connection.features`
(`d1ConnectionFeatures()`), and the core reads the database with queries D1 does accept.
None of this changes the dump; each is tested against an emulation of D1 that refuses what
D1 refuses, and must produce a dump byte-identical to the one of a local copy.

| D1 restriction                                        | What the dump does instead                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `BEGIN` / `SAVEPOINT`                              | Reads without a snapshot, and reports `snapshot-unavailable` (see below)                                                                             |
| No table-valued `pragma_xxx()` functions              | Uses the `PRAGMA table_info('t')` statement forms                                                                                                    |
| Possibly no `table_xinfo` / `index_xinfo`             | Falls back to `table_info` / `index_info` the first time an extended pragma is refused                                                               |
| One database, `main`                                  | Names no schema in any statement                                                                                                                     |
| JSON results: no bytes, integers as doubles           | Text and blobs are fetched as `hex()`; numbers already arrive as SQLite-rendered text                                                                |
| Whole results, no streaming                           | Table data is read in pages: `WHERE rowid > :last ORDER BY rowid LIMIT n`, or on the primary key of a `WITHOUT ROWID` table — an index seek per page |
| Reserved `_cf_` tables in `sqlite_schema`, unreadable | Left out, with their `sqlite_sequence` and `sqlite_stat*` rows; reported as `reserved-objects-skipped`                                               |

### Consistency

D1 has no read transactions a client can hold across requests, so a D1 dump is not a
snapshot: a write committed while the dump runs may be partly included. The result carries
a `snapshot-unavailable` warning. For a consistent copy, dump while nothing writes, or
create a [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
bookmark first and dump a database restored from it.

### Row order of `WITHOUT ROWID` tables

Pages follow the primary-key index, so rows come out in the order the native `.dump`
writes them. When D1 refuses `index_xinfo`, the key's direction and collation are not
known; pages then follow the declared key, ascending — the same rows, possibly in a
different order for a key declared `DESC` or with its own `COLLATE`.

## Other engines

The features are not specific to D1. Any adapter for an engine that speaks SQLite's SQL
with similar restrictions — over HTTP, or behind an authorizer — can declare the
same `SqliteConnectionFeatures` and get the same treatment. See
[architecture.md](architecture.md) for the `SqliteConnection` contract.
