import { describe, expect, it } from 'vitest';
import {
  MalformedSqlDumpError,
  StatementTooLargeError,
  UnsupportedClientCommandError,
} from '../src/restore/errors.js';
import { isCompleteStatement } from '../src/restore/complete.js';
import { parseSqlStatements, SqlStatementParser } from '../src/restore/statementParser.js';
import type { SqlStatementParserOptions } from '../src/restore/statementParser.js';

/**
 * The byte-string form `SqlStatementParser.push` consumes: one code unit per
 * byte. Splitting *this* is what a real stream does, so the chunk-boundary
 * tests below exercise genuine byte boundaries — including ones in the middle
 * of a multi-byte character.
 */
function toByteString(sql: string | Buffer): string {
  return (typeof sql === 'string' ? Buffer.from(sql, 'utf8') : sql).toString('latin1');
}

function parseInChunks(
  sql: string | Buffer,
  size: number,
  options?: SqlStatementParserOptions,
): string[] {
  const bytes = toByteString(sql);
  const parser = new SqlStatementParser(options);
  const statements: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    for (const statement of parser.push(bytes.slice(offset, offset + size))) {
      statements.push(statement.sql);
    }
  }
  for (const statement of parser.finish()) {
    statements.push(statement.sql);
  }
  return statements;
}

function parseSplitAt(sql: string, at: number): string[] {
  const bytes = toByteString(sql);
  const parser = new SqlStatementParser();
  return [
    ...parser.push(bytes.slice(0, at)),
    ...parser.push(bytes.slice(at)),
    ...parser.finish(),
  ].map(statement => statement.sql);
}

function texts(sql: string | Buffer, options?: SqlStatementParserOptions): string[] {
  return parseSqlStatements(sql, options).map(statement => statement.sql);
}

describe('isCompleteStatement (sqlite3_complete)', () => {
  it.each([
    ['SELECT 1;', true],
    ['SELECT 1', false],
    ['SELECT 1; -- trailing', true],
    ['SELECT 1; /* open', false],
    ["SELECT 'a;", false],
    ['SELECT "a;"', false],
    ['SELECT [a;]', false],
    ['SELECT `a;`;', true],
    [';', true],
    ['', false],
    ['   ', false],
    ['CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1;', false],
    ['CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;', true],
    ['CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;', true],
    ['CREATE TEMPORARY TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END', false],
    ['EXPLAIN CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;', true],
    ['CREATE TABLE trigger_log(a);', true],
    ['CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; END;', true],
    ['SELECT 1; SELECT 2', false],
  ])('%j -> %s', (sql, expected) => {
    expect(isCompleteStatement(sql)).toBe(expected);
  });
});

describe('SqlStatementParser: basic splitting', () => {
  it('splits on semicolons and drops them', () => {
    expect(texts('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('emits a final statement with no semicolon, as the shell does', () => {
    expect(texts('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('ignores empty statements', () => {
    expect(texts(';;;\n\n;  ;')).toEqual([]);
  });

  it('does not split inside strings or quoted identifiers', () => {
    expect(texts(`INSERT INTO t VALUES('a;b'); SELECT "c;d", [e;f], \`g;h\`;`)).toEqual([
      `INSERT INTO t VALUES('a;b')`,
      'SELECT "c;d", [e;f], `g;h`',
    ]);
  });

  it('handles doubled quotes', () => {
    expect(texts(`SELECT 'it''s; fine'; SELECT "a""b;c";`)).toEqual([
      `SELECT 'it''s; fine'`,
      `SELECT "a""b;c"`,
    ]);
  });

  it('treats a backslash as an ordinary character (SQLite has no backslash escapes)', () => {
    expect(texts(`SELECT 'a\\'; SELECT 2;`)).toEqual([`SELECT 'a\\'`, 'SELECT 2']);
  });

  it('does not split inside comments, and drops leading ones', () => {
    expect(texts('-- a; b\nSELECT 1 /* c; d */ + 2; /* x */ SELECT 3;')).toEqual([
      'SELECT 1 /* c; d */ + 2',
      'SELECT 3',
    ]);
  });

  it('keeps a trailing line comment inside the statement, ahead of its `;` line', () => {
    expect(texts('CREATE TABLE t(a) -- note\n;\n')).toEqual(['CREATE TABLE t(a) -- note']);
  });

  it('accepts a block comment that runs to the end of the input', () => {
    expect(texts('SELECT 1 /* open to the end')).toEqual(['SELECT 1 /* open to the end']);
  });

  it('keeps a whole trigger body, with its inner semicolons, in one statement', () => {
    const trigger =
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  INSERT INTO log VALUES('x; END');\n  UPDATE t SET a = CASE WHEN 1 THEN 2 END;\nEND";
    expect(texts(`${trigger};\nSELECT 1;`)).toEqual([trigger, 'SELECT 1']);
  });

  it('recognizes CREATE TEMP TRIGGER and EXPLAIN CREATE TRIGGER', () => {
    const temp = 'CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END';
    expect(texts(`${temp}; SELECT 3;`)).toEqual([temp, 'SELECT 3']);
  });

  it('is case-insensitive for the trigger keywords', () => {
    const trigger = 'create trigger tr after insert on t begin select 1; end';
    expect(texts(`${trigger};select 2;`)).toEqual([trigger, 'select 2']);
  });

  it('reports 1-based line numbers of the first real SQL character', () => {
    const statements = parseSqlStatements('-- header\n\nSELECT\n1;\n\nSELECT 2;');
    expect(statements.map(statement => statement.location)).toEqual([
      { startLine: 3, endLine: 4 },
      { startLine: 6, endLine: 6 },
    ]);
  });

  it('classifies statements and tracks the current object', () => {
    const statements = parseSqlStatements(
      'CREATE TABLE IF NOT EXISTS "a b"(x);\nINSERT INTO "a b" VALUES(1);\nCOMMIT;',
    );
    expect(statements.map(statement => [statement.info.verb, statement.currentObject])).toEqual([
      ['CREATE', 'a b'],
      ['INSERT', 'a b'],
      ['COMMIT', 'a b'],
    ]);
  });
});

describe('SqlStatementParser: the sqlite3 shell line rules', () => {
  it('drops a carriage return that precedes a newline, even inside a literal', () => {
    expect(texts("INSERT INTO t VALUES('x\r\ny');\r\nSELECT 1;\r\n")).toEqual([
      "INSERT INTO t VALUES('x\ny')",
      'SELECT 1',
    ]);
  });

  it('keeps a carriage return that does not precede a newline', () => {
    expect(texts("SELECT 'a\rb';")).toEqual(["SELECT 'a\rb'"]);
    expect(texts("SELECT 'a\r\r\n';")).toEqual(["SELECT 'a\r\n'"]);
  });

  it('treats a line holding only GO or / as the end of the statement', () => {
    expect(texts('INSERT INTO t VALUES(1)\nGO\nINSERT INTO t VALUES(2)\n  /  \nSELECT 3;')).toEqual(
      ['INSERT INTO t VALUES(1)', 'INSERT INTO t VALUES(2)', 'SELECT 3'],
    );
    expect(texts('SELECT 1\ngo -- comment\n')).toEqual(['SELECT 1']);
  });

  it('does not treat GO or / as a terminator inside a trigger body', () => {
    // Inside the body the shell's `line_is_complete()` check fails, so the
    // line stays ordinary SQL text.
    const trigger = 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n/\nSELECT 1; END';
    expect(texts(`${trigger};`)).toEqual([trigger]);
  });

  it('does not mistake words that merely start with "go" for a terminator', () => {
    expect(texts('SELECT 1\ngoal;')).toEqual(['SELECT 1\ngoal']);
  });

  it('skips # comment lines and presentational dot-commands at column 0', () => {
    const parser = new SqlStatementParser();
    const statements = [
      ...parser.push(toByteString('# a comment\n.mode csv\n.headers on\nSELECT 1;\n.print done\n')),
      ...parser.finish(),
    ];
    expect(statements.map(statement => statement.sql)).toEqual(['SELECT 1']);
    expect(parser.skippedDotCommands.map(command => command.command)).toEqual([
      'mode',
      'headers',
      'print',
    ]);
  });

  it('treats # and . as SQL when they are not at column 0, or when SQL is pending', () => {
    expect(texts('SELECT 1\n.5;')).toEqual(['SELECT 1\n.5']);
    expect(texts('  # not a comment;')).toEqual(['# not a comment']);
  });

  it('refuses dot-commands that would change the database', () => {
    expect(() => texts('.read other.sql\n')).toThrow(UnsupportedClientCommandError);
    expect(() => texts('SELECT 1;\n.import data.csv t\n')).toThrow(UnsupportedClientCommandError);
  });

  it('refuses every dot-command under dotCommands: "error"', () => {
    expect(() => texts('.mode csv\n', { dotCommands: 'error' })).toThrow(
      UnsupportedClientCommandError,
    );
  });

  it('stops at .quit, as the shell does', () => {
    expect(texts('SELECT 1;\n.quit\nSELECT 2;')).toEqual(['SELECT 1']);
  });

  it('treats a UTF-8 byte-order mark as whitespace', () => {
    expect(texts('\uFEFFSELECT 1;\n\uFEFFSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('SqlStatementParser: bytes that are not valid UTF-8', () => {
  it('rewrites such a string literal into CAST(X... AS TEXT), keeping every byte', () => {
    const script = Buffer.concat([
      Buffer.from("INSERT INTO t VALUES('caf"),
      Buffer.from([0xe9]),
      Buffer.from("', 'ok');"),
    ]);
    const [statement] = parseSqlStatements(script);
    expect(statement?.sql).toBe("INSERT INTO t VALUES((CAST(X'636166e9' AS TEXT)), 'ok')");
    expect(statement?.textLiteralsRewritten).toBe(1);
  });

  it('keeps valid multi-byte text untouched', () => {
    expect(texts("SELECT 'žluťoučký 😀';")).toEqual(["SELECT 'žluťoučký 😀'"]);
  });
});

describe('SqlStatementParser: errors', () => {
  it('rejects an unterminated string', () => {
    expect(() => texts("SELECT 'open")).toThrow(MalformedSqlDumpError);
  });

  it('rejects an unterminated quoted identifier', () => {
    expect(() => texts('SELECT "open')).toThrow(MalformedSqlDumpError);
    expect(() => texts('SELECT [open')).toThrow(MalformedSqlDumpError);
  });

  it('bounds the size of one statement', () => {
    expect(() => texts(`SELECT '${'x'.repeat(5000)}';`, { maxStatementBytes: 1000 })).toThrow(
      StatementTooLargeError,
    );
  });
});

const BOUNDARY_SCRIPT = [
  '\uFEFF-- leading comment\r\n',
  'PRAGMA foreign_keys=OFF;\n',
  'BEGIN TRANSACTION;\n',
  'CREATE TABLE IF NOT EXISTS "a b"(id INTEGER PRIMARY KEY, t TEXT DEFAULT \'x;y\');\n',
  "INSERT INTO \"a b\" VALUES(1,replace('line\\nbreak','\\n',char(10)));\n",
  "INSERT INTO \"a b\" VALUES(2,'žluť ''quoted'' -- not a comment /* nor this */');\r\n",
  'CREATE TRIGGER tr AFTER INSERT ON "a b" BEGIN\n  UPDATE "a b" SET t = t || \';\' WHERE id = new.id;\nEND;\n',
  '# hash line\n',
  '.mode insert\n',
  'SELECT 1\nGO\n',
  'SELECT [br;acket], `back;tick` FROM x /* block\n comment */;\n',
  'SELECT 5-3, 6/2 -- trailing\n;\n',
  'COMMIT;\n',
].join('');

describe('SqlStatementParser: chunk-boundary invariance', () => {
  const expected = texts(BOUNDARY_SCRIPT);

  it('parses the reference script as expected', () => {
    expect(expected).toEqual([
      'PRAGMA foreign_keys=OFF',
      'BEGIN TRANSACTION',
      'CREATE TABLE IF NOT EXISTS "a b"(id INTEGER PRIMARY KEY, t TEXT DEFAULT \'x;y\')',
      "INSERT INTO \"a b\" VALUES(1,replace('line\\nbreak','\\n',char(10)))",
      "INSERT INTO \"a b\" VALUES(2,'žluť ''quoted'' -- not a comment /* nor this */')",
      'CREATE TRIGGER tr AFTER INSERT ON "a b" BEGIN\n  UPDATE "a b" SET t = t || \';\' WHERE id = new.id;\nEND',
      'SELECT 1',
      'SELECT [br;acket], `back;tick` FROM x /* block\n comment */',
      'SELECT 5-3, 6/2 -- trailing',
      'COMMIT',
    ]);
  });

  it('produces identical output at every chunk size', () => {
    const length = Buffer.byteLength(BOUNDARY_SCRIPT, 'utf8');
    for (let size = 1; size <= length; size++) {
      expect(parseInChunks(BOUNDARY_SCRIPT, size), `chunk size ${size}`).toEqual(expected);
    }
  });

  it('produces identical output at every single split point', () => {
    const length = Buffer.byteLength(BOUNDARY_SCRIPT, 'utf8');
    for (let at = 0; at <= length; at++) {
      expect(parseSplitAt(BOUNDARY_SCRIPT, at), `split at ${at}`).toEqual(expected);
    }
  });
});
