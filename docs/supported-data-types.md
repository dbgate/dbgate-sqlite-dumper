# Supported data types

SQLite stores every value in one of five storage classes, whatever a column is declared
as. A dump writes each value according to its storage class, exactly as the native `.dump`
writes it — and restoring it yields the same storage class and the same value.

| Storage class | Written as                                    | Example                                  |
| ------------- | --------------------------------------------- | ---------------------------------------- |
| `NULL`        | `NULL`                                        | `NULL`                                   |
| `INTEGER`     | decimal                                       | `9223372036854775807`                    |
| `REAL`        | `%lld.0` when integral, else `%!.20g`         | `3.0`, `0.100000000000000005`, `1.0e+20` |
|               | infinities                                    | `9.0e+999`, `-9.0e+999`                  |
| `TEXT`        | quoted, `'` doubled, newlines via `replace()` | `replace('a\nb','\n',char(10))`          |
| `BLOB`        | lower-case hex                                | `X'00ff'`, `X''`                         |

## How values are read

Row data never passes through a JavaScript number, and text never passes through the
driver's decoder. The `SELECT` that reads a table has SQLite itself produce, per column:

- `INTEGER` → `CAST(x AS TEXT)`: exact at 64 bits, whatever the driver would have done;
- `REAL` → the literal, computed in SQL with the shell's own rule — including SQLite's
  `printf('%!.20g')`, so the digits are the ones SQLite writes, which no JavaScript number
  formatting reproduces;
- `TEXT` → `CAST(x AS BLOB)`: the stored bytes (in a UTF-16 database, the text itself);
- `BLOB` → the bytes.

## Notes per class

### `INTEGER`

Exact across the full 64-bit range. `AUTOINCREMENT` counters are read as text too, so a
counter past 2^53 resumes at exactly the right value.

### `REAL`

The literal round-trips to the identical double: `%!.20g` carries more than the 17
significant digits that identify one. The digits beyond the 17th vary between SQLite
releases (see [native-compatibility.md](native-compatibility.md#the-one-exception-real-digit-tails)),
never the value.

A `REAL` holding an integral value is written with `.0` (`3.0`), so it is restored as a
`REAL`, not an `INTEGER`. `-0.0` is written as `0.0`, as natively.

### `TEXT`

- **Quoting:** the only escape SQLite has is a doubled `'`. There are no backslash escapes.
- **Newlines and carriage returns** are written as `replace('…\n…','\n',char(10))` (and
  `char(13)`), with a placeholder that does not otherwise occur in the text — so each
  `INSERT` stays on one line and survives tools that rewrite line endings. With
  `dataExport.rawNewlines` (native `--newlines`) they are written raw instead.
- **Bytes that are not valid UTF-8** — SQLite does not validate what it stores — are
  written raw, as natively, so the dump reproduces the stored value exactly. Such a dump is
  not valid UTF-8, which is why the writer and the restore handle bytes. On restore through
  a JavaScript driver, such a literal is executed as `CAST(X'…' AS TEXT)`, the identical
  bytes.
- **`NUL` characters** are kept, written as `'a'||char(0)||'b'`. The native shell truncates
  text at the first `NUL`; this is the one place this package writes something the shell
  would not, and only for text the shell cannot represent.

### `BLOB`

Always hex. An empty blob is `X''`, distinct from `NULL` and from the empty string `''`.

## Declared types

A column's declared type — `VARCHAR(20)`, `DATETIME`, `BOOLEAN`, `JSON`, or none at all —
is part of the table's DDL and is reproduced verbatim. It only determines the column's
_affinity_, which SQLite applies on insert; since every value is written in the storage
class it already has, affinity cannot change it on restore. `STRICT` tables are restored as
`STRICT`, with their type checks.

Dates and times have no storage class of their own in SQLite; they are whatever text,
number or blob the application stored, and are dumped as such.
