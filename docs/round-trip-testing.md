# Round-trip testing

Two suites, kept apart on purpose.

| Suite          | Command                    | Needs                      | What it proves                                  |
| -------------- | -------------------------- | -------------------------- | ----------------------------------------------- |
| `tests/`       | `npm test`                 | nothing but `node_modules` | Every layer, against in-memory databases.       |
| `integration/` | `npm run test:integration` | the `sqlite3` shell        | Two-way interoperability with the native shell. |

The unit suite uses `better-sqlite3` in-process, so it needs no server, no network and no
binary beyond `node_modules`. The integration suite runs the real shell.

## Running the integration suite

```sh
sudo apt-get install sqlite3        # or brew install sqlite
npm run test:integration
```

- When the shell is not installed the suites skip themselves with a message.
  `SQLITE_TEST_REQUIRED=1` (set in CI) turns that into a hard failure, so the suite can
  never silently no-op where it was supposed to run.
- `SQLITE3_BIN=/path/to/sqlite3` tests a specific shell.
- `KEEP_TEST_OUTPUT=1` keeps every dump and database under `test-output/` for inspection;
  CI uploads that directory when a run fails.

## What is tested

### Byte identity (`interop.integration.test.ts`)

The fixture is dumped by this package and by the shell, with each native switch and its
equivalent option (`.dump`, `--data-only`, `--preserve-rowids`, `--newlines`, `--nosys`).
Every line must be identical; a line may differ only in the digits of a `REAL` literal, and
is then compared again with each literal parsed as a double.

### The interoperability matrix

| Path                                       |
| ------------------------------------------ |
| this package → native `sqlite3` restore    |
| native `.dump` → this package's restore    |
| this package → this package                |
| native `.dump` → native restore (baseline) |

Each ends by snapshotting the restored database — every `sqlite_schema` row except
`rootpage`, and every row of every table with text compared as bytes — and deep-comparing
it with the source. The baseline proves the fixture itself round-trips natively, so a
failure elsewhere is this package's.

On top of the matrix: dumping the restored database reproduces the first dump byte for byte,
restored virtual tables answer FTS5 and R-tree queries, `NUL` characters survive through
both restores, `user_version` is carried on request, and a data-only dump loads into an
existing schema with `transaction: 'wrap'`.

### Scripts beyond `.dump` (`scripts.integration.test.ts`)

Hand-written scripts in shapes the shell accepts — trigger bodies with `;`, `END` and
`CASE`; comments everywhere; `GO` and `/` terminator lines; CRLF files and carriage returns
inside literals; `#` comments and dot-commands; every kind of quoted identifier; several
statements on a line. Each runs through the shell and through this package, and the two
databases must be identical — including where both stop on the same error.

### Streaming (`streaming.integration.test.ts`)

A 200 000-row table (over 30 MB of SQL) is dumped with bounded heap growth, compared with
the shell's `.dump`, and restored both ways.

## The fixture

`integration/fixture/schema.ts`: one statement per array element, executed one at a time
with `better-sqlite3` — **never through this package's parser**, so a statement-splitting
bug cannot corrupt the fixture and hide itself.

It is deliberately unfriendly: a view created before the table it reads; two tables
referencing each other; deleted rows leaving gaps in hidden rowids; names that are
keywords, contain spaces and quotes, or are quoted with `'`, `"` and `[…]`; `WITHOUT ROWID`,
`STRICT` and generated columns; partial, expression and `DESC` indexes; triggers whose
bodies contain `; END`; an FTS5 and an R-tree table; statistics from `ANALYZE`; 64-bit
extremes, infinities, `REAL`s without short representations, empty blobs, text with CRLF,
emoji, and bytes that are not valid UTF-8.

`sqlite_stat4` is dropped after `ANALYZE`: `better-sqlite3` builds with STAT4 and the
Ubuntu shell does not, and a dump carrying it cannot restore there — natively either (see
[known-limitations.md](known-limitations.md#sqlite_stat4-across-builds)).
