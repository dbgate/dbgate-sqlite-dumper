import { throwIfAborted } from '../utils/errors.js';
import {
  classifyWord,
  CompleteToken,
  completeTransition,
  isIdentifierCharCode,
} from './complete.js';
import {
  MalformedSqlDumpError,
  StatementTooLargeError,
  UnsupportedClientCommandError,
} from './errors.js';
import type { StatementSourceLocation } from './location.js';
import type { SqlDumpSource } from './source.js';
import { describeStatement } from './statementInfo.js';
import type { StatementInfo } from './statementInfo.js';
import { decodeStatementBytes } from './textEncoding.js';

const DEFAULT_MAX_STATEMENT_BYTES = 256 * 1024 * 1024;

/**
 * Longest line examined as a possible `GO` / `/` terminator line. A real one
 * is a few bytes; the cap keeps the cross-chunk lookahead bounded on hostile
 * input (a line that long is simply treated as ordinary SQL).
 */
const MAX_TERMINATOR_LINE_BYTES = 64 * 1024;

/** Longest dot-command line kept; the rest of an absurdly long one is ignored. */
const MAX_DOT_COMMAND_BYTES = 64 * 1024;

/**
 * Shell dot-commands that only affect the `sqlite3` shell's own presentation
 * or diagnostics — never what the script does to the database — and are
 * therefore safe to skip. Anything else is refused.
 */
const PRESENTATIONAL_DOT_COMMANDS: ReadonlySet<string> = new Set([
  'bail',
  'binary',
  'changes',
  'databases',
  'dbinfo',
  'echo',
  'eqp',
  'explain',
  'fullschema',
  'headers',
  'header',
  'help',
  'indexes',
  'indices',
  'log',
  'mode',
  'nullvalue',
  'once',
  'output',
  'print',
  'progress',
  'prompt',
  'scanstats',
  'schema',
  'separator',
  'show',
  'stats',
  'tables',
  'timeout',
  'timer',
  'trace',
  'width',
]);

/** Dot-commands that end the shell's input. */
const EXIT_DOT_COMMANDS: ReadonlySet<string> = new Set(['exit', 'quit']);

/**
 * What to do with a `sqlite3` shell dot-command (`.mode csv`, `.read x.sql`).
 *
 * - `'skip-presentational'` (default) skips commands that only affect the
 *   shell's output (`.mode`, `.headers`, `.print`, ...), reporting each, and
 *   refuses every command that would change what the script does to the
 *   database (`.read`, `.import`, `.open`, `.load`, ...).
 * - `'error'` refuses every dot-command.
 *
 * `.quit` and `.exit` end the input in both modes, exactly as in the shell.
 */
export type DotCommandPolicy = 'skip-presentational' | 'error';

export interface SqlStatementParserOptions {
  /**
   * Upper bound, in bytes, on one statement's accumulated text.
   *
   * Guards against unbounded memory growth from a truncated dump or a
   * `CREATE TRIGGER` whose `END` is missing. Defaults to 256 MiB — far
   * larger than any statement a real dump contains, while still bounded.
   */
  readonly maxStatementBytes?: number;
  readonly dotCommands?: DotCommandPolicy;
}

export interface ParsedStatement {
  readonly statementIndex: number;
  /**
   * Statement text, without its terminating `;` and without the whitespace
   * and comments that preceded it. Never empty.
   */
  readonly sql: string;
  readonly location: StatementSourceLocation;
  /** What the statement is, from its leading tokens. */
  readonly info: StatementInfo;
  /**
   * The object the restore is currently working on: this statement's own
   * object when it names one (`CREATE TABLE t`, `INSERT INTO t`), else the
   * last one seen. Reported through restore progress.
   */
  readonly currentObject?: string;
  /** Bytes of source the parser had consumed when this statement was emitted. */
  readonly bytesConsumed: number;
  /**
   * How many string literals holding bytes that are not valid UTF-8 were
   * rewritten to `CAST(X'...' AS TEXT)` so the statement could be sent as
   * text. See `textEncoding.ts`.
   */
  readonly textLiteralsRewritten: number;
}

/** A dot-command the parser skipped under `'skip-presentational'`. */
export interface SkippedDotCommand {
  readonly command: string;
  readonly line: number;
}

type LexState =
  | 'normal'
  | 'singleQuote'
  | 'doubleQuote'
  | 'backtick'
  | 'bracket'
  | 'blockComment'
  | 'lineComment'
  | 'dotCommand'
  | 'hashComment'
  | 'stopped';

const OPEN_CONSTRUCT_NAME: Partial<Record<LexState, string>> = {
  singleQuote: "string literal ('...')",
  doubleQuote: 'double-quoted identifier ("...")',
  backtick: 'backtick-quoted identifier (`...`)',
  bracket: 'bracket-quoted identifier ([...])',
};

const CLOSING_CHARACTER: Partial<Record<LexState, string>> = {
  singleQuote: "'",
  doubleQuote: '"',
  backtick: '`',
  bracket: ']',
};

/** Whitespace as `sqlite3_complete()` classifies it. */
function isCompleteWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\n' ||
    character === '\t' ||
    character === '\r' ||
    character === '\f'
  );
}

/** C `isspace()` in the C locale, which the shell's line scanner uses. */
function isCSpace(character: string): boolean {
  return isCompleteWhitespace(character) || character === '\v';
}

/**
 * `quickscan(line) == QSS_Start` from `shell.c`: the rest of a line holds
 * only whitespace and complete comments — no SQL, no `;`, no unterminated
 * comment or quote.
 */
function isPlainWhiteLine(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (isCSpace(character)) {
      index++;
      continue;
    }
    if (character === '-' && text[index + 1] === '-') {
      return true;
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) {
        return false;
      }
      index = end + 2;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * `line_is_command_terminator()` from `shell.c`: a line holding only `/`
 * (Oracle's convention) or `GO` (SQL Server's), optionally surrounded by
 * whitespace and comments, ends the pending statement.
 */
function isTerminatorLine(line: string): boolean {
  let index = 0;
  while (index < line.length && isCSpace(line[index] as string)) {
    index++;
  }
  if (line[index] === '/') {
    return isPlainWhiteLine(line.slice(index + 1));
  }
  if ((line[index] ?? '').toLowerCase() === 'g' && (line[index + 1] ?? '').toLowerCase() === 'o') {
    return isPlainWhiteLine(line.slice(index + 2));
  }
  return false;
}

/** Whether the start of a (possibly incomplete) line could still turn out to be a terminator line. */
function couldBeTerminatorLine(partial: string): boolean {
  let index = 0;
  while (index < partial.length && isCSpace(partial[index] as string)) {
    index++;
  }
  if (index >= partial.length) {
    return true;
  }
  const first = (partial[index] as string).toLowerCase();
  if (first === '/') {
    return true;
  }
  return (
    first === 'g' &&
    (index + 1 >= partial.length || (partial[index + 1] as string).toLowerCase() === 'o')
  );
}

/**
 * An incremental splitter for `sqlite3` scripts that decides statement
 * boundaries exactly where the `sqlite3` shell does.
 *
 * Two layers, both ported from SQLite's own sources:
 *
 * - **Tokens and completeness** follow `sqlite3_complete()`
 *   (see `complete.ts`): `'...'` strings, `"..."`, `` `...` `` and `[...]`
 *   identifiers, `--` and (non-nesting) `/* *\/` comments, and the state
 *   machine that keeps the `;`-terminated statements inside a
 *   `CREATE TRIGGER ... BEGIN ... END;` body in one statement.
 * - **Lines** follow the shell's `process_input()`: a line starting with `.`
 *   at column 0, when no SQL is pending, is a dot-command; a line starting
 *   with `#` there is a comment; a line holding only `GO` or `/` ends the
 *   pending statement; and a carriage return immediately before a newline is
 *   dropped, exactly as the shell's line reader drops it.
 *
 * The parser runs on **bytes** — chunks are byte strings, one code unit per
 * byte, as `latin1` decodes them — because a dump is not necessarily valid
 * UTF-8, and decoding up front would replace invalid bytes with U+FFFD
 * before the parser ever saw them. Every character it reacts to is ASCII,
 * and no byte of a multi-byte UTF-8 sequence can be mistaken for one.
 *
 * Correctness across chunk boundaries is not assumed: anything whose
 * meaning depends on what follows — a `-` or `/` that may open a comment, a
 * `*` that may close one, a `\r` that may precede `\n`, the start of a line
 * that may be a `GO` line — is carried to the next chunk.
 *
 * Memory is bounded by one statement: only the current statement's text and
 * a few carried bytes are held, and `maxStatementBytes` fails fast on a
 * pathological input rather than growing without limit.
 */
export class SqlStatementParser {
  private readonly maxStatementBytes: number;
  private readonly dotCommandPolicy: DotCommandPolicy;

  private lex: LexState = 'normal';
  private completeState = 0;
  /** Length and (lower-cased, capped) prefix of the identifier being scanned. */
  private wordLength = 0;
  private wordPrefix = '';
  /** In a block comment: whether the previous byte was `*`. */
  private blockStar = false;
  private openLine = 1;

  private carry = '';
  private parts: string[] = [];
  private partsBytes = 0;
  /** True once the pending statement has content other than whitespace and comments. */
  private hasContent = false;
  private statementStartLine = 1;

  private line = 1;
  private atLineStart = true;
  private firstChunk = true;
  private dotText = '';
  private dotLine = 1;

  private nextStatementIndex = 0;
  private finished = false;
  private bytesConsumedTotal = 0;
  private lastObject: string | undefined;
  private readonly skipped: SkippedDotCommand[] = [];

  constructor(options?: SqlStatementParserOptions) {
    this.maxStatementBytes = options?.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES;
    this.dotCommandPolicy = options?.dotCommands ?? 'skip-presentational';
  }

  /** Bytes of source consumed so far. */
  get bytesConsumed(): number {
    return this.bytesConsumedTotal;
  }

  /** Dot-commands skipped so far under the `'skip-presentational'` policy. */
  get skippedDotCommands(): readonly SkippedDotCommand[] {
    return this.skipped;
  }

  /** `true` once a `.quit`/`.exit` command ended the input. */
  get stopped(): boolean {
    return this.lex === 'stopped';
  }

  /**
   * Feeds one chunk of the source, as a **byte string** — one code unit per
   * byte, as produced by `buffer.toString('latin1')`. Callers holding text
   * should use {@link parseSqlStatements} or {@link streamSqlStatements},
   * which convert for them.
   */
  push(chunk: string): ParsedStatement[] {
    if (this.finished) {
      throw new Error('SqlStatementParser.push() called after finish()');
    }
    this.bytesConsumedTotal += chunk.length;
    if (chunk.length === 0) {
      return [];
    }
    return this.scan(this.carry + chunk, false);
  }

  finish(): ParsedStatement[] {
    if (this.finished) {
      throw new Error('SqlStatementParser.finish() called more than once');
    }
    this.finished = true;
    const out = this.scan(this.carry, true);
    this.carry = '';

    const open = OPEN_CONSTRUCT_NAME[this.lex];
    if (open !== undefined) {
      throw new MalformedSqlDumpError(open, this.openLine);
    }
    if (this.lex === 'dotCommand') {
      this.handleDotCommand();
    }
    if (this.lex !== 'stopped') {
      this.endWord();
      // The shell runs whatever is left at end of input ("this may be
      // incomplete; let the SQL parser deal with that"), so a final statement
      // without a `;` is still executed.
      const statement = this.emit();
      if (statement) {
        out.push(statement);
      }
    }
    return out;
  }

  private scan(text: string, final: boolean): ParsedStatement[] {
    const out: ParsedStatement[] = [];
    const length = text.length;
    let index = 0;
    /** Start of the run of `text` currently being kept as statement text, or `-1`. */
    let keepFrom = this.hasContent && this.lex !== 'stopped' ? 0 : -1;

    const flush = (end: number): void => {
      if (keepFrom >= 0 && end > keepFrom) {
        const part = text.slice(keepFrom, end);
        this.parts.push(part);
        this.partsBytes += part.length;
        if (this.partsBytes > this.maxStatementBytes) {
          throw new StatementTooLargeError(this.maxStatementBytes, this.statementStartLine);
        }
      }
      keepFrom = -1;
    };
    const markContent = (at: number): void => {
      if (!this.hasContent) {
        this.hasContent = true;
        this.statementStartLine = this.line;
        keepFrom = at;
      } else if (keepFrom < 0) {
        keepFrom = at;
      }
    };
    const resume = (at: number): void => {
      if (this.hasContent && keepFrom < 0) {
        keepFrom = at;
      }
    };
    const carryFrom = (at: number): void => {
      flush(at);
      this.carry = text.slice(at);
    };

    if (this.firstChunk && length > 0) {
      // A UTF-8 byte-order mark at the very start of the input. SQLite's
      // tokenizer treats one as whitespace anywhere, so the shell never sees
      // it as SQL; it is skipped here so it cannot start a "statement".
      if (text.startsWith('\u00ef\u00bb\u00bf')) {
        index = 3;
        this.firstChunk = false;
      } else if (!final && '\u00ef\u00bb\u00bf'.startsWith(text)) {
        this.carry = text;
        return out;
      } else {
        this.firstChunk = false;
      }
    }

    while (index < length) {
      const character = text[index] as string;

      // The shell's line reader drops a `\r` that immediately precedes `\n`,
      // wherever it is — including inside a string literal.
      if (character === '\r' && this.lex !== 'stopped') {
        if (index + 1 >= length && !final) {
          carryFrom(index);
          return out;
        }
        if (text[index + 1] === '\n') {
          flush(index);
          index++;
          resume(index);
          continue;
        }
      }

      switch (this.lex) {
        case 'stopped':
          index = length;
          continue;

        case 'hashComment':
        case 'dotCommand': {
          const newline = text.indexOf('\n', index);
          const end = newline === -1 ? length : newline;
          if (this.lex === 'dotCommand' && this.dotText.length < MAX_DOT_COMMAND_BYTES) {
            this.dotText += text.slice(index, end);
          }
          if (newline === -1) {
            index = length;
            continue;
          }
          if (this.lex === 'dotCommand') {
            this.handleDotCommand();
            if (this.stopped) {
              index = length;
              continue;
            }
          }
          this.lex = 'normal';
          index = newline;
          continue;
        }

        case 'singleQuote':
        case 'doubleQuote':
        case 'backtick':
        case 'bracket': {
          const close = CLOSING_CHARACTER[this.lex] as string;
          if (character === close) {
            // Doubled quotes need no lookahead: `'it''s'` is two adjacent
            // strings to `sqlite3_complete()` as well, which changes nothing.
            this.lex = 'normal';
            this.atLineStart = false;
            index++;
            continue;
          }
          if (character === '\r') {
            // A lone `\r`; one followed by `\n` was already dropped above.
            index++;
            continue;
          }
          // Jump to the next byte that matters: the closing quote, or a `\r`
          // that may need dropping. Newlines in between are only counted.
          let end = text.indexOf(close, index);
          if (end === -1) end = length;
          const crAt = text.indexOf('\r', index);
          if (crAt !== -1 && crAt < end) end = crAt;
          this.countNewlines(text, index, end);
          index = end;
          continue;
        }

        case 'blockComment': {
          if (this.blockStar && character === '/') {
            this.blockStar = false;
            this.lex = 'normal';
            this.completeState = completeTransition(this.completeState, CompleteToken.Whitespace);
            this.atLineStart = false;
            index++;
            continue;
          }
          const starAt = text.indexOf('*', index);
          const crAt = text.indexOf('\r', index);
          let end = starAt === -1 ? length : starAt;
          if (crAt !== -1 && crAt < end) {
            end = crAt;
          }
          if (end > index) {
            this.countNewlines(text, index, end);
            this.blockStar = false;
            index = end;
            continue;
          }
          if (character === '*') {
            this.blockStar = true;
            this.atLineStart = false;
            if (index + 1 >= length && !final) {
              // Keep the `*` pending, so a `/` at the start of the next chunk
              // closes the comment.
              index++;
              continue;
            }
            index++;
            continue;
          }
          // A lone `\r` not followed by `\n`: ordinary comment text.
          this.blockStar = false;
          index++;
          continue;
        }

        case 'lineComment': {
          if (character === '\n') {
            // The newline itself is whitespace in the normal state.
            this.lex = 'normal';
            continue;
          }
          if (character === '\r') {
            index++;
            continue;
          }
          let end = text.indexOf('\n', index);
          if (end === -1) end = length;
          const crAt = text.indexOf('\r', index);
          if (crAt !== -1 && crAt < end) end = crAt;
          index = end;
          continue;
        }

        case 'normal':
          break;
      }

      // --- normal state -------------------------------------------------

      const code = text.charCodeAt(index);

      if (this.wordLength > 0) {
        if (isIdentifierCharCode(code)) {
          const start = index;
          while (index < length && isIdentifierCharCode(text.charCodeAt(index))) {
            index++;
          }
          this.extendWord(text.slice(start, index));
          continue;
        }
        this.endWord();
      }

      if (this.atLineStart) {
        this.atLineStart = false;
        if (!this.hasContent && (character === '.' || character === '#')) {
          this.lex = character === '.' ? 'dotCommand' : 'hashComment';
          this.dotText = '';
          this.dotLine = this.line;
          index++;
          continue;
        }
        if (
          this.completeState !== 5 &&
          this.completeState !== 6 &&
          this.mayStartTerminatorLine(text, index, final)
        ) {
          const newline = text.indexOf('\n', index);
          const lineEnd = newline === -1 ? length : newline;
          const lineText = text.slice(index, lineEnd);
          if (newline === -1 && !final) {
            if (lineText.length < MAX_TERMINATOR_LINE_BYTES && couldBeTerminatorLine(lineText)) {
              this.atLineStart = true;
              carryFrom(index);
              return out;
            }
          } else if (isTerminatorLine(lineText)) {
            // The shell replaces the whole line with `;`.
            flush(index);
            const statement = this.completeWithSemicolon();
            if (statement) {
              out.push(statement);
            }
            index = lineEnd;
            continue;
          }
        }
      }

      if (character === ';') {
        const next = completeTransition(this.completeState, CompleteToken.Semi);
        if (next === 1) {
          flush(index);
          this.completeState = next;
          const statement = this.emit();
          if (statement) {
            out.push(statement);
          }
          index++;
          continue;
        }
        // A `;` inside a trigger body is part of the statement.
        this.completeState = next;
        markContent(index);
        index++;
        continue;
      }

      if (isCompleteWhitespace(character)) {
        this.completeState = completeTransition(this.completeState, CompleteToken.Whitespace);
        if (character === '\n') {
          this.line++;
          this.atLineStart = true;
        }
        index++;
        continue;
      }

      if (character === '-' || character === '/') {
        if (index + 1 >= length && !final) {
          carryFrom(index);
          return out;
        }
        const next = text[index + 1];
        if ((character === '-' && next === '-') || (character === '/' && next === '*')) {
          this.lex = character === '-' ? 'lineComment' : 'blockComment';
          this.blockStar = false;
          if (character === '-') {
            // `--` behaves as whitespace for `sqlite3_complete()`.
            this.completeState = completeTransition(this.completeState, CompleteToken.Whitespace);
          }
          index += 2;
          continue;
        }
        this.completeState = completeTransition(this.completeState, CompleteToken.Other);
        markContent(index);
        index++;
        continue;
      }

      if (character === "'" || character === '"' || character === '`' || character === '[') {
        this.lex =
          character === "'"
            ? 'singleQuote'
            : character === '"'
              ? 'doubleQuote'
              : character === '`'
                ? 'backtick'
                : 'bracket';
        this.openLine = this.line;
        this.completeState = completeTransition(this.completeState, CompleteToken.Other);
        markContent(index);
        index++;
        continue;
      }

      if (code === 0xef) {
        // A UTF-8 byte-order mark at the start of a token is whitespace to
        // SQLite's tokenizer (its `CC_BOM` class).
        if (index + 2 >= length && !final) {
          carryFrom(index);
          return out;
        }
        if (text.charCodeAt(index + 1) === 0xbb && text.charCodeAt(index + 2) === 0xbf) {
          flush(index);
          index += 3;
          resume(index);
          continue;
        }
      }

      if (isIdentifierCharCode(code)) {
        markContent(index);
        const start = index;
        while (index < length && isIdentifierCharCode(text.charCodeAt(index))) {
          index++;
        }
        this.extendWord(text.slice(start, index));
        continue;
      }

      this.completeState = completeTransition(this.completeState, CompleteToken.Other);
      markContent(index);
      index++;
    }

    flush(length);
    this.carry = '';
    return out;
  }

  /**
   * Cheap pre-check before the terminator-line lookahead: only a line whose
   * first non-blank character is `/` or `g` can be one. Keeps the lookahead —
   * which has to look at the whole line — off the ordinary `INSERT` lines
   * that make up almost all of a dump.
   */
  private mayStartTerminatorLine(text: string, index: number, final: boolean): boolean {
    let probe = index;
    while (probe < text.length && text[probe] !== '\n' && isCSpace(text[probe] as string)) {
      probe++;
    }
    if (probe >= text.length) {
      return !final;
    }
    const first = text[probe];
    return first === '/' || first === 'g' || first === 'G';
  }

  private countNewlines(text: string, start: number, end: number): void {
    let position = text.indexOf('\n', start);
    while (position !== -1 && position < end) {
      this.line++;
      position = text.indexOf('\n', position + 1);
    }
    if (end > start) {
      this.atLineStart = text[end - 1] === '\n';
    }
  }

  private extendWord(segment: string): void {
    if (this.wordPrefix.length < 10) {
      this.wordPrefix += segment.slice(0, 10 - this.wordPrefix.length);
    }
    this.wordLength += segment.length;
  }

  private endWord(): void {
    if (this.wordLength === 0) {
      return;
    }
    const token = this.wordLength > 9 ? CompleteToken.Other : classifyWord(this.wordPrefix);
    this.completeState = completeTransition(this.completeState, token);
    this.wordLength = 0;
    this.wordPrefix = '';
  }

  /** A terminator line: behave as if the line were `;`. */
  private completeWithSemicolon(): ParsedStatement | null {
    this.completeState = completeTransition(this.completeState, CompleteToken.Semi);
    return this.emit();
  }

  private emit(): ParsedStatement | null {
    const hadContent = this.hasContent;
    const byteText = this.parts.join('');
    this.parts = [];
    this.partsBytes = 0;
    this.hasContent = false;
    if (!hadContent) {
      return null;
    }
    // Only ASCII whitespace: `\s` would also match byte 0xA0, which can be the
    // last byte of a multi-byte UTF-8 character.
    const trimmed = byteText.replace(/[ \t\n\r\f\v]+$/, '');
    if (trimmed === '') {
      return null;
    }
    const { sql, literalsRewritten } = decodeStatementBytes(trimmed, this.statementStartLine);
    const info = describeStatement(sql);
    if (info.objectName !== undefined) {
      this.lastObject = info.objectName;
    }
    return {
      statementIndex: this.nextStatementIndex++,
      sql,
      location: { startLine: this.statementStartLine, endLine: this.line },
      info,
      ...(this.lastObject === undefined ? {} : { currentObject: this.lastObject }),
      bytesConsumed: this.bytesConsumedTotal,
      textLiteralsRewritten: literalsRewritten,
    };
  }

  private handleDotCommand(): void {
    const text = this.dotText;
    this.dotText = '';
    this.lex = 'normal';
    const command = (/^\S*/.exec(text)?.[0] ?? '').toLowerCase();
    if (EXIT_DOT_COMMANDS.has(command)) {
      this.lex = 'stopped';
      return;
    }
    if (
      this.dotCommandPolicy === 'skip-presentational' &&
      PRESENTATIONAL_DOT_COMMANDS.has(command)
    ) {
      this.skipped.push({ command, line: this.dotLine });
      return;
    }
    throw new UnsupportedClientCommandError(command, this.dotLine);
  }
}

/** Parses a complete, already-in-memory script. A convenience wrapper over {@link SqlStatementParser}. */
export function parseSqlStatements(
  sql: string | Buffer,
  options?: SqlStatementParserOptions,
): ParsedStatement[] {
  const parser = new SqlStatementParser(options);
  const byteString = (typeof sql === 'string' ? Buffer.from(sql, 'utf8') : sql).toString('latin1');
  return [...parser.push(byteString), ...parser.finish()];
}

/**
 * Normalizes any {@link SqlDumpSource} into *byte strings*: one JavaScript
 * code unit per input byte, via `latin1`. See {@link SqlStatementParser} for
 * why the parser runs on bytes; a `latin1` decode can also never split a
 * character across chunks, so no `StringDecoder` is needed.
 */
export async function* toByteStringChunks(source: SqlDumpSource): AsyncGenerator<string> {
  if (typeof source === 'string') {
    yield Buffer.from(source, 'utf8').toString('latin1');
    return;
  }
  if (source instanceof Uint8Array) {
    // Covers `Buffer` too, which extends `Uint8Array`.
    yield (Buffer.isBuffer(source) ? source : Buffer.from(source)).toString('latin1');
    return;
  }
  for await (const chunk of source as AsyncIterable<string | Buffer | Uint8Array>) {
    if (typeof chunk === 'string') {
      yield Buffer.from(chunk, 'utf8').toString('latin1');
    } else {
      yield (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('latin1');
    }
  }
}

/**
 * Streams `source` into {@link ParsedStatement}s without ever buffering the
 * whole input: at most the current statement's text, plus a few carried
 * bytes, is held at a time.
 */
export async function* streamSqlStatements(
  source: SqlDumpSource,
  options?: SqlStatementParserOptions,
  signal?: AbortSignal,
): AsyncGenerator<ParsedStatement> {
  const parser = new SqlStatementParser(options);
  yield* streamWithParser(parser, source, signal);
}

/** Drives an existing parser over `source`, so a caller can inspect it afterwards. */
export async function* streamWithParser(
  parser: SqlStatementParser,
  source: SqlDumpSource,
  signal?: AbortSignal,
): AsyncGenerator<ParsedStatement> {
  for await (const chunk of toByteStringChunks(source)) {
    throwIfAborted(signal);
    for (const statement of parser.push(chunk)) {
      yield statement;
    }
    if (parser.stopped) {
      break;
    }
  }
  throwIfAborted(signal);
  for (const statement of parser.finish()) {
    yield statement;
  }
}
