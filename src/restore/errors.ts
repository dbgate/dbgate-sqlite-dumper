import type { SqliteErrorInfo } from '../connection/types.js';
import { SqliteDumperError } from '../utils/errors.js';
import type { StatementSourceLocation } from './location.js';

/** Common base for every error {@link restoreSqlDump} (or its parser) throws intentionally. */
export class RestoreError extends SqliteDumperError {}

/**
 * The input could not be split into statements correctly.
 *
 * Always fatal: unlike a statement that fails when executed, a parse failure
 * means the statement boundaries themselves are not trustworthy, so nothing
 * after the failure point can be safely executed either.
 */
export class SqlParseError extends RestoreError {
  readonly line: number;

  constructor(code: string, message: string, line: number, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'SqlParseError';
    this.line = line;
  }
}

/**
 * The input ended while a quoted token — a string, a `"`/`` ` ``/`[...]`
 * identifier — was still open. The script is structurally incomplete (most
 * often a truncated file) and cannot be split into valid statements.
 *
 * An unterminated `/*` comment is *not* reported: SQLite itself accepts a
 * block comment that runs to the end of the input.
 */
export class MalformedSqlDumpError extends SqlParseError {
  readonly openConstruct: string;

  constructor(openConstruct: string, line: number) {
    super(
      'malformed-sql-dump',
      `Unterminated ${openConstruct} starting at line ${line}: the input ends before it is closed`,
      line,
    );
    this.name = 'MalformedSqlDumpError';
    this.openConstruct = openConstruct;
  }
}

/**
 * One statement's accumulated text exceeded
 * {@link SqlStatementParserOptions.maxStatementBytes} before it was
 * complete.
 *
 * A statement must be sent to SQLite whole, so this bounds how much of a
 * pathological input — a truncated dump, or an unterminated `CREATE TRIGGER`
 * that swallows the rest of the file — the parser will buffer before giving
 * up, instead of growing without limit.
 */
export class StatementTooLargeError extends SqlParseError {
  readonly maxStatementBytes: number;

  constructor(maxStatementBytes: number, line: number) {
    super(
      'statement-too-large',
      `Statement starting near line ${line} exceeds the configured limit of ${maxStatementBytes} bytes without being complete; increase options.maxStatementBytes if this statement is genuinely intended to be this large, or check for a CREATE TRIGGER missing its END`,
      line,
    );
    this.name = 'StatementTooLargeError';
    this.maxStatementBytes = maxStatementBytes;
  }
}

/**
 * A `sqlite3` shell dot-command was found that would change what the script
 * does to the database.
 *
 * The shell executes lines beginning with `.` itself (`.read`, `.import`,
 * `.open`, `.load`, `.shell`, ...) before anything reaches SQLite. Commands
 * that only affect the shell's own presentation (`.mode`, `.headers`,
 * `.print`, ...) are skipped with a warning; the rest are refused with a
 * precise diagnostic rather than being silently ignored, which would corrupt
 * the restore — a `.read` that never runs leaves the referenced file's
 * objects missing, and an `.import` that never runs leaves a table empty.
 */
export class UnsupportedClientCommandError extends SqlParseError {
  readonly command: string;

  constructor(command: string, line: number) {
    super(
      'unsupported-client-command',
      `Unsupported sqlite3 shell command ".${command}" on line ${line}: dbgate-sqlite-dumper executes SQL statements and does not implement shell dot-commands that change the database. Run this script through the sqlite3 shell, or remove the command.`,
      line,
    );
    this.name = 'UnsupportedClientCommandError';
    this.command = command;
  }
}

/**
 * A statement holds bytes that are not valid UTF-8 outside any string
 * literal, so it cannot be handed to SQLite as text without corrupting them.
 *
 * Invalid UTF-8 *inside* a string literal — which the native `.dump` writes
 * whenever a `TEXT` value holds such bytes — is handled transparently, by
 * rewriting the literal into the equivalent `CAST(X'...' AS TEXT)`. Reaching
 * this error means the bytes are in an identifier or keyword position.
 */
export class InvalidTextEncodingError extends SqlParseError {
  constructor(message: string, line: number) {
    super('invalid-text-encoding', `${message} (near line ${line})`, line);
    this.name = 'InvalidTextEncodingError';
  }
}

/**
 * A statement parsed successfully but failed when executed.
 *
 * Unlike a parse error this is scoped to one statement: with
 * `stopOnError: false`, restoration continues with the next one, and this
 * error's data — never the raw driver error, which can echo back parts of
 * the failing statement — is what is recorded in
 * {@link SqlDumpRestoreResult.errors}.
 */
export class RestoreExecutionError extends RestoreError {
  readonly statementIndex: number;
  readonly location: StatementSourceLocation;
  readonly sqlPreview: string;
  readonly sqliteError?: SqliteErrorInfo;

  constructor(
    statementIndex: number,
    location: StatementSourceLocation,
    sqlPreview: string,
    message: string,
    sqliteError?: SqliteErrorInfo,
    options?: { cause?: unknown },
  ) {
    super('restore-execution-failed', message, options);
    this.name = 'RestoreExecutionError';
    this.statementIndex = statementIndex;
    this.location = location;
    this.sqlPreview = sqlPreview;
    if (sqliteError) {
      this.sqliteError = sqliteError;
    }
  }
}
