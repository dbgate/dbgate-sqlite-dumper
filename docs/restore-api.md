# Restore API

```ts
restoreSqlDump({ connection, source, options?, progress?, signal? }): Promise<SqlDumpRestoreResult>
```

Restores a plain-SQL SQLite dump using only the `SqliteConnection` abstraction — no
`sqlite3` shell, no external process. Works on dumps produced by this package **and** on
dumps produced by the native `.dump`, and on any other script the shell would accept.

```ts
import { createReadStream } from 'node:fs';
import { restoreSqlDump } from 'dbgate-sqlite-dumper';

const result = await restoreSqlDump({
  connection,
  source: createReadStream('shop.sql'),
  progress: event => {
    if (event.phase === 'executing' && event.executionState === 'finished') {
      console.log(`${event.statementsProcessed} statements, ${event.rowsRestored} rows`);
    }
  },
});
```

## `source`

```ts
type SqlDumpSource =
  string | Buffer | Uint8Array | Readable | AsyncIterable<string | Buffer | Uint8Array>;
```

Parsed incrementally: only the current statement's text plus a few carried bytes are held
at a time, so a multi-gigabyte dump never lands in memory.

`Buffer` is accepted alongside `string` for a reason that matters: the native `.dump`
writes a `TEXT` value's stored bytes verbatim, so a database holding text that is not valid
UTF-8 produces a dump that is not valid UTF-8 either. Pass the bytes; forcing them through
`.toString()` would replace every invalid sequence with U+FFFD.

## How a script is split

Exactly where the `sqlite3` shell splits it. Two layers, both ported from SQLite's sources:

| Construct                       | Behaviour                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `'…'`                           | String; `''` is a quote. **No** backslash escapes — SQLite has none.              |
| `"…"`, `` `…` ``, `[…]`         | Quoted identifiers; a `;` inside never splits.                                    |
| `-- …`, `/* … */`               | Comments (block comments do not nest). A block comment may run to end of input.   |
| `CREATE TRIGGER … BEGIN … END;` | One statement, inner `;`s included — the `sqlite3_complete()` state machine.      |
| `GO` / `/` alone on a line      | Ends the pending statement, as in the shell.                                      |
| `.command` at column 0          | A shell dot-command; see below.                                                   |
| `# …` at column 0               | A comment line, as in the shell.                                                  |
| `\r\n`                          | The `\r` is dropped — everywhere, literals included — as the shell's reader does. |
| UTF-8 byte-order mark           | Whitespace.                                                                       |
| missing final `;`               | The last statement still runs, as in the shell.                                   |

The dot-command and `#` rules apply only when no SQL is pending — `SELECT 1\n.5;` is one
statement — exactly as the shell decides it.

`tests/statementParser.test.ts` asserts identical output at **every** chunk size and
**every** single split point; `integration/scripts.integration.test.ts` runs a set of
hand-written scripts through both the shell and this package and requires identical
databases afterwards.

### Dot-commands

The shell runs lines beginning with `.` itself. Under the default
`dotCommands: 'skip-presentational'`:

- commands that only affect the shell's own output (`.mode`, `.headers`, `.print`, `.echo`,
  `.timer`, `.output`, …) are skipped and reported as `dot-command-skipped`;
- `.quit` and `.exit` end the input, as in the shell;
- every other command (`.read`, `.import`, `.open`, `.load`, `.shell`, `.parameter`, …) is
  refused with `UnsupportedClientCommandError`. Silently skipping a `.read` would leave the
  referenced file's objects missing — a corrupted restore that looks like a successful one.

`dotCommands: 'error'` refuses every dot-command.

### Text that is not valid UTF-8

A statement whose string literal holds such bytes is executed with that literal rewritten
to `(CAST(X'…' AS TEXT))`, which stores the identical bytes, and a `text-literal-rewritten`
warning says how many. Such bytes anywhere else — in an identifier — cannot be represented
and raise `InvalidTextEncodingError`.

## `RestoreOptions`

| Option                | Default                 | Meaning                                                                      |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `stopOnError`         | `true`                  | Stop at the first failing statement.                                         |
| `restoreSessionState` | `true`                  | Put the connection back as it was; see below.                                |
| `schemaWrites`        | `'allow'`               | Virtual-table dumps write `sqlite_schema`; `'refuse'` fails such statements. |
| `transaction`         | `'script'`              | `'wrap'`: run everything in one transaction of the restore's own.            |
| `disableForeignKeys`  | `false`                 | `PRAGMA foreign_keys=OFF` for the restore (data-only dumps).                 |
| `verifyForeignKeys`   | `false`                 | Run `PRAGMA foreign_key_check` afterwards and report violations.             |
| `maxStatementBytes`   | 256 MiB                 | Bound on one statement's buffered text.                                      |
| `dotCommands`         | `'skip-presentational'` | See above.                                                                   |

### `restoreSessionState`

A native dump is written for a shell that exits when it is done. Run through a long-lived
handle, three things would otherwise leak into the caller's session:

- **`foreign_keys`.** A dump's first line turns enforcement off, and nothing turns it back
  on. It is returned to its value before the restore.
- **An open transaction.** A restore that stops at a failing statement, is cancelled, or
  reads a dump truncated before its `COMMIT` would hand the handle back mid-transaction,
  holding a write lock on the file. The transaction the _script_ opened is rolled back —
  as the shell's exit would roll it back — and reported as `transaction-rolled-back`. A
  transaction the caller opened before the restore is never touched.
- **`writable_schema`.** Turned back off if the script left it on.

### `schemaWrites`

A dump of a database with virtual tables recreates them by inserting into `sqlite_schema`
under `PRAGMA writable_schema=ON` — the native `.dump` does exactly this, and opens with a
comment saying it requires `SQLITE_DBCONFIG_DEFENSIVE` to be off. Under `'allow'`, when the
adapter can (`setDefensive`), defensive mode is lifted at the `writable_schema=ON`
statement, restored afterwards, and reported as `defensive-mode-disabled`. The schema is
then reloaded (`PRAGMA writable_schema=RESET`), so the restored virtual tables work on the
same handle — without it they would only appear on the next connection.

### `transaction: 'wrap'`

The restore opens its own transaction before the first statement that is not a `PRAGMA` —
so the dump's leading `PRAGMA foreign_keys=OFF` still takes effect — skips the script's own
`BEGIN`/`COMMIT`/`ROLLBACK`, and commits at the end, or rolls back everything on failure.
Meant for data-only dumps, which have no transaction of their own and would otherwise sync
to disk once per row.

## `SqlDumpRestoreResult`

```ts
{
  statementsExecuted: number;
  statementsFailed: number;
  rowsRestored: number;      // sum of rows changed
  bytesConsumed: number;
  errors: readonly RestoreStatementError[];
  warnings: readonly RestoreWarning[];
  cancelled: boolean;
}
```

## Errors

### Parse errors — always fatal, thrown

The statement boundaries themselves cannot be trusted past the failure point.

| Error                           | Cause                                                                 |
| ------------------------------- | --------------------------------------------------------------------- |
| `MalformedSqlDumpError`         | Input ends inside a string or quoted identifier — usually truncation. |
| `StatementTooLargeError`        | One statement exceeded `maxStatementBytes`.                           |
| `UnsupportedClientCommandError` | A dot-command that would change the database.                         |
| `InvalidTextEncodingError`      | Bytes that are not valid UTF-8 outside any string literal.            |

All carry `line`, and all extend `SqlParseError` → `RestoreError` → `SqliteDumperError`
(which has a stable `code`).

### Execution errors — scoped to one statement

Recorded in `result.errors`; with `stopOnError: false` the restore continues.

```ts
{
  statementIndex: number;
  location: { startLine: number; endLine: number };
  sqlPreview: string;       // ≤200 chars, whitespace-collapsed, keys redacted
  message: string;
  sqliteError?: { code?: string; errno?: number; message: string };
}
```

`sqliteError.code` is SQLite's extended result code (`SQLITE_CONSTRAINT_UNIQUE`), so a
caller can branch on it instead of matching message text. `location.startLine` points at
the first real SQL character, not at the comments before it.

**No error or preview ever contains an encryption key.** `redactSecrets` covers the syntax
SQLCipher and the SQLite Encryption Extension use — `PRAGMA key`/`rekey`/`hexkey`/`textkey`
and `ATTACH … KEY` — and is applied to driver messages too.

## Progress

```ts
progress: event => {
  // 'connecting' | 'parsing' | 'executing' | 'finalizing'
  console.log(event.phase, event.statementIndex, event.currentObject, event.bytesConsumed);
};
```

`currentObject` is read from the statements themselves (`CREATE TABLE t`, `INSERT INTO t`),
since a native dump carries no section banners.

## Preflight

```ts
import { introspectSqlite, preflightRestore } from 'dbgate-sqlite-dumper';

const { database } = await introspectSqlite(source);
const report = await preflightRestore({ connection: target, database });
if (report.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
  // e.g. object-already-exists, unsupported-target-feature (STRICT tables on 3.31),
  //      virtual-table-module-unavailable, statistics-table-unsupported
}
```

Turns a failure part-way through a restore into an up-front report. Also reports the
target's version, encoding, `foreign_keys`, open transaction, available modules and compile
options, and whether defensive mode can be lifted. Never writes to the target.

## Using the parser on its own

```ts
import {
  parseSqlStatements,
  streamSqlStatements,
  isSqliteDump,
  isCompleteStatement,
} from 'dbgate-sqlite-dumper';

if (!isSqliteDump(head)) throw new Error('not a SQLite dump');

for (const statement of parseSqlStatements(sql)) {
  console.log(statement.statementIndex, statement.info.verb, statement.location.startLine);
}

for await (const statement of streamSqlStatements(createReadStream('big.sql'))) {
  // constant memory
}

isCompleteStatement('CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1;'); // false
```
