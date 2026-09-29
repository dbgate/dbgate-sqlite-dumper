# Native compatibility

The promise, in both directions:

1. **A dump written by this package restores with the native shell**:
   `sqlite3 target.db < dump.sql`.
2. **A dump written by the native `.dump` restores with this package**:
   `restoreSqlDump({ connection, source })`.

Both are tested on every run against the real `sqlite3` shell (3.45 on Ubuntu 24.04 in CI),
ending with a deep comparison of the restored database's schema and every row against the
source. See [round-trip-testing.md](round-trip-testing.md).

## Byte identity

With default options, `dumpSqlite` writes the same bytes as `sqlite3 db .dump`, and each
native switch has an equivalent that is tested the same way:

| Native                    | This package                                      |
| ------------------------- | ------------------------------------------------- |
| `.dump`                   | `{}`                                              |
| `.dump --data-only`       | `{ mode: 'data-only' }`                           |
| `.dump --preserve-rowids` | `{ dataExport: { preserveRowids: true } }`        |
| `.dump --newlines`        | `{ dataExport: { rawNewlines: true } }`           |
| `.dump --nosys`           | `{ objectKinds: { includeSystemTables: false } }` |

### The one exception: `REAL` digit tails

The shell writes a non-integral `REAL` with `sqlite3_snprintf("%!.20g")`, and this package
has SQLite evaluate `printf('%!.20g', value)` for it — the same formatter. But the digits
that formatter produces past the 17th significant digit changed between SQLite releases
(3.45 writes `0.100000000000000005`, 3.53 writes `0.1000000000000000056`). A driver that
bundles its own SQLite — as `better-sqlite3` does — therefore writes the digits of _its_
release.

Those digits carry no information: 17 significant digits already identify a double
exactly, and both spellings parse back to the identical value. The interop tests compare
every line byte for byte, and compare a differing line again with each `REAL` literal
parsed as a double; nothing else is allowed to differ. When the driver and the shell embed
the same SQLite release, the output is byte-identical without exception.

## What is reproduced, and why

Every rule below is ported from `shell.c`, because each one changes bytes in the output.

- **The frame.** `PRAGMA foreign_keys=OFF;` and `BEGIN TRANSACTION;` first, `COMMIT;`
  last. A data-only dump has neither, as natively.
- **Creation order.** Tables in `sqlite_schema` rowid order (`sqlite_sequence` moved last),
  each followed by its rows; then indexes, triggers and views in rowid order. Creation order
  is a valid dependency order for everything SQLite checks at `CREATE` time, and
  `foreign_keys=OFF` covers foreign keys, circular ones included.
- **Verbatim DDL.** SQLite stores every object's `CREATE` statement exactly as written; that
  text is what is emitted, never a reconstruction.
- **`printSchemaLine()`.** A table whose name is quoted with `'` or `"` becomes
  `CREATE TABLE IF NOT EXISTS`; DDL ending in a `--` comment or an unterminated `/*` gets a
  newline or `*/` before its `;`, chosen with `sqlite3_complete()` exactly as the shell does.
- **Index, trigger and view terminators.** The statement's `;` goes on a line of its own if
  its text contains `--` anywhere.
- **Identifier quoting.** Table and column names are quoted in `INSERT` only when not a
  plain identifier or when a keyword (`quoteChar()`, with SQLite's 147 keywords).
- **Values.** Integers as decimal; `REAL` as `%lld.0` when integral and in range, else
  `%!.20g`, with infinities as `9.0e+999`; blobs as lower-case `X'...'`; text quoted with
  `'` doubled, and — by default — newlines and carriage returns rewritten as
  `replace('...\n...','\n',char(10))`, with a placeholder guaranteed not to occur in the
  text (`unused_string()`).
- **Virtual tables.** Written as `INSERT INTO sqlite_schema(...)` under
  `PRAGMA writable_schema=ON`, not as `CREATE VIRTUAL TABLE`, so the module's constructor
  does not run and the shadow tables — which the dump then fills with the source's exact
  contents — are not rebuilt. The whole dump is preceded by
  `/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */`.
- **System tables.** `DELETE FROM sqlite_sequence;` before the `AUTOINCREMENT` counters,
  `ANALYZE sqlite_schema;` before each statistics table's rows.

## Native quirks reproduced deliberately

These are faithful to the shell rather than "fixed", because a dump that differs from the
native one for no stated reason is harder to trust than one with a documented quirk. Each is
reported as a warning when it applies.

- **`.dump --data-only` selects virtual tables' rows twice** — through the table itself,
  and again as the shadow tables' rows — because the shell checks for data-only before it
  checks for a virtual table. Restoring such a dump into a database where the virtual table
  exists conflicts with its own shadow rows (`data-only-virtual-table`).
- **`.dump --data-only` inserts into system tables without preparing them**: the
  `sqlite_sequence` rows are not preceded by a `DELETE`, and the statistics rows by no
  `ANALYZE` (`data-only-system-table`).
- **`-0.0` is written as `0.0`**, because the shell's integral test is true for it.

[dump-api.md](dump-api.md#data-only-dumps) gives the option set that avoids the first two
when loading rows into an existing schema.

## Deliberate deviations

Only where the native behaviour loses data, and never for data the shell can represent:

- **`NUL` characters in text are kept.** The shell handles values as C strings and drops
  everything after the first `NUL`; this package writes `'a'||char(0)||'b'`, which the
  shell restores correctly. Text without `NUL` — all text in practice — is unaffected.
- **A schema-only dump** has no native `.dump` equivalent. It creates virtual tables with
  their own `CREATE VIRTUAL TABLE` (as `.schema` shows them) and leaves their shadow tables
  to the module, since no shadow rows follow.
- **Partial dumps** (a `selection`) keep only the selected tables' `sqlite_sequence` and
  statistics rows, and reset only their counters
  (`DELETE FROM sqlite_sequence WHERE lower(name) IN (...)`). The native `.dump PATTERN`
  omits the counters of the selected tables entirely.

## Restoring native dumps

The restore side reproduces how the shell _reads_ a script, which is what makes any
`sqlite3` script restorable, not just `.dump` output:

- statement boundaries from `sqlite3_complete()`, so trigger bodies stay whole;
- `GO` and `/` lines as terminators, `#` lines at column 0 as comments, dot-commands at
  column 0 as shell commands;
- a `\r` immediately before `\n` dropped everywhere, as the shell's line reader does;
- a leading UTF-8 byte-order mark ignored;
- a final statement without `;` still executed.

And it accounts for running inside an application instead of a process that exits:

- the defensive mode a virtual-table dump requires is lifted for the restore and put back;
- the schema is reloaded afterwards, so restored virtual tables work on the same handle;
- `foreign_keys` is put back to its previous value (a native dump never re-enables it);
- a transaction left open by a failing or truncated script is rolled back.
