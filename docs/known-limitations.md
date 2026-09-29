# Known limitations

What this package does not do, and why. The items in the first section are also returned by
`unsupportedFeatureDiagnostics()`, so a UI can list them without hardcoding the text.

## Not dumped

### File-level settings

`page_size`, `auto_vacuum`, `journal_mode`, `encoding` and the like describe how the
database _file_ is laid out, not what it contains, and most can only be chosen before the
first table exists. The native `.dump` does not carry them either. Set them on the target
before restoring if they matter; the dump restores correctly under any of them.

`user_version` and `application_id` are the exception: they are carried with
`render.includeDatabaseSettings`, and reported as a warning when they are non-zero and not
carried.

### The temp schema and attached databases

A dump covers one schema — `main` by default. Temporary objects belong to one connection;
each attached database is a separate file. Dump an attached database on its own with
`schemaName`.

### Application-defined functions, collations and modules

User-defined SQL functions, collating sequences and virtual-table modules are registered by
the application (or loaded as extensions), not stored in the database. Schema that uses
them is dumped verbatim, and the restoring application must register them first.
`checkTargetCompatibility` reports custom collations used by indexes, and — when the
target's module list is known — missing virtual-table modules.

### Encryption

An encrypted database (SQLCipher, SEE) dumps as plain SQL once it is opened with its key.
The dump is not encrypted, and no key is ever written into it or into any diagnostic.

## Behaviours to know about

### `REAL` digits depend on the SQLite release

See [native-compatibility.md](native-compatibility.md#the-one-exception-real-digit-tails).
The value never changes; the spelling past the 17th digit can.

### `sqlite_stat4` across builds

`sqlite_stat4` exists only on SQLite built with `SQLITE_ENABLE_STAT4` (such as
`better-sqlite3`'s). A dump that carries its rows cannot be restored on a build without
it — by the native `.dump` either — because the `ANALYZE sqlite_schema;` that prepares the
table does not create it there. `preflightRestore` reports `statistics-table-unsupported`;
dump with `objectKinds.includeSystemTables: false`, or drop the table first.

Conversely, restoring through a STAT4 build creates an empty `sqlite_stat4` the source did
not have. It is harmless, and `ANALYZE` repopulates it.

### Data-only dumps

A data-only dump reproduces `.dump --data-only`, including two quirks that matter when
loading the rows into an existing schema (virtual-table rows carried twice; system tables
not prepared). [dump-api.md](dump-api.md#data-only-dumps) gives the option set that avoids
both.

### Hidden rowids are renumbered by default

As natively; see [supported-objects.md](supported-objects.md#hidden-rowids).

### Virtual-table dumps need defensive mode off to restore

Inherent to how the native `.dump` recreates virtual tables. The restore lifts
`SQLITE_DBCONFIG_DEFENSIVE` itself through adapters that can (the bundled one can); with an
adapter that cannot, the restore succeeds only on a handle not in defensive mode.

### Cancellation granularity

`better-sqlite3` runs each statement synchronously, so cancellation takes effect between
rows and between statements, never inside one.

### Memory

A dump holds one statement and a 64 KiB output buffer; a restore holds one statement's
text. A single enormous value — a 500 MB blob — is held whole, once, because one row cannot
be split.

### Scripts the parser refuses

Dot-commands that change the database (`.read`, `.import`, `.open`, …), identifiers
containing bytes that are not valid UTF-8, and input ending inside a string or quoted
identifier. See [restore-api.md](restore-api.md#errors).
