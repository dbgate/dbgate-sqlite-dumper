import { describe, expect, it } from 'vitest';
import {
  isSqliteKeyword,
  needsIdentifierQuoting,
  quoteIdentifier,
  quoteIdentifierIfNeeded,
  SQLITE_KEYWORD_COUNT,
  toAsciiLowerCase,
} from '../src/security/identifiers.js';
import {
  renderBlobLiteral,
  renderEscapedStringLiteral,
  renderQuotedStringLiteral,
  renderTextLiteral,
} from '../src/security/literals.js';
import { redactSecrets } from '../src/security/redact.js';
import {
  renderDatabaseSettings,
  renderSchemaLine,
  renderSchemaObject,
  renderSystemTablePrelude,
  renderVirtualTable,
} from '../src/renderer/objectRenderers.js';

describe('string literals (output_quoted_escaped_string)', () => {
  it('writes plain text as a quoted literal with doubled quotes', () => {
    expect(renderEscapedStringLiteral("it's")).toBe("'it''s'");
    expect(renderEscapedStringLiteral('')).toBe("''");
    expect(renderEscapedStringLiteral('back\\slash')).toBe("'back\\slash'");
  });

  it('wraps newlines in replace(..., char(10))', () => {
    expect(renderEscapedStringLiteral('a\nb')).toBe("replace('a\\nb','\\n',char(10))");
  });

  it('wraps carriage returns in replace(..., char(13))', () => {
    expect(renderEscapedStringLiteral('a\rb')).toBe("replace('a\\rb','\\r',char(13))");
  });

  it('nests both exactly as the shell does', () => {
    expect(renderEscapedStringLiteral("x'\r\ny")).toBe(
      "replace(replace('x''\\r\\ny','\\r',char(13)),'\\n',char(10))",
    );
  });

  it('picks a placeholder that does not occur in the text', () => {
    expect(renderEscapedStringLiteral('\\n\n')).toBe("replace('\\n\\012','\\012',char(10))");
    expect(renderEscapedStringLiteral('\\n\\012\n')).toBe(
      "replace('\\n\\012(\\n0)','(\\n0)',char(10))",
    );
  });

  it('writes newlines raw in the --newlines form', () => {
    expect(renderQuotedStringLiteral("a\n'b")).toBe("'a\n''b'");
    expect(renderTextLiteral('a\nb', 'raw-newlines')).toBe("'a\nb'");
  });

  it('keeps NUL characters, which the native shell truncates at', () => {
    expect(renderTextLiteral('a\u0000b')).toBe("'a'||char(0)||'b'");
    expect(renderTextLiteral('\u0000')).toBe("''||char(0)||''");
  });
});

describe('blob literals (output_hex_blob)', () => {
  it('writes lower-case hex', () => {
    expect(renderBlobLiteral(Buffer.from([0x00, 0xff, 0x0a]))).toBe("X'00ff0a'");
    expect(renderBlobLiteral(new Uint8Array())).toBe("X''");
  });
});

describe('identifier quoting (quoteChar)', () => {
  it('knows all 147 SQLite keywords', () => {
    expect(SQLITE_KEYWORD_COUNT).toBe(147);
    expect(isSqliteKeyword('select')).toBe(true);
    expect(isSqliteKeyword('Returning')).toBe(true);
    expect(isSqliteKeyword('rowid')).toBe(false);
  });

  it('quotes only when the native shell would', () => {
    expect(quoteIdentifierIfNeeded('orders')).toBe('orders');
    expect(quoteIdentifierIfNeeded('_x1')).toBe('_x1');
    expect(quoteIdentifierIfNeeded('rowid')).toBe('rowid');
    expect(quoteIdentifierIfNeeded('order')).toBe('"order"');
    expect(quoteIdentifierIfNeeded('a b')).toBe('"a b"');
    expect(quoteIdentifierIfNeeded('1x')).toBe('"1x"');
    expect(quoteIdentifierIfNeeded('žluť')).toBe('"žluť"');
    expect(quoteIdentifierIfNeeded('say "hi"')).toBe('"say ""hi"""');
    expect(needsIdentifierQuoting('')).toBe(true);
  });

  it('always quotes for queries this package runs', () => {
    expect(quoteIdentifier('orders')).toBe('"orders"');
  });

  it('folds only ASCII letters, as SQLite does', () => {
    expect(toAsciiLowerCase('ORDERS_Ž')).toBe('orders_Ž');
  });
});

describe('redactSecrets', () => {
  it('redacts SQLCipher and SEE keys', () => {
    expect(redactSecrets("PRAGMA key = 'hunter2'")).toBe("PRAGMA key = '***REDACTED***'");
    expect(redactSecrets("PRAGMA main.rekey='new'")).toBe("PRAGMA main.rekey='***REDACTED***'");
    expect(redactSecrets('PRAGMA hexkey("00ff")')).toBe("PRAGMA hexkey('***REDACTED***')");
    expect(redactSecrets("ATTACH DATABASE 'x.db' AS x KEY 'secret'")).toBe(
      "ATTACH DATABASE 'x.db' AS x KEY '***REDACTED***'",
    );
  });

  it('leaves ordinary statements alone', () => {
    expect(redactSecrets("INSERT INTO t VALUES('key = 1')")).toBe(
      "INSERT INTO t VALUES('key = 1')",
    );
  });
});

describe('schema line rendering (printSchemaLine)', () => {
  it('appends ;\\n to ordinary DDL', () => {
    expect(renderSchemaLine('CREATE TABLE t(a)')).toBe('CREATE TABLE t(a);\n');
  });

  it('adds IF NOT EXISTS for a quoted table name', () => {
    expect(renderSchemaLine('CREATE TABLE "a b"(x)')).toBe(
      'CREATE TABLE IF NOT EXISTS "a b"(x);\n',
    );
    expect(renderSchemaLine("CREATE TABLE 'ft_data'(x)")).toBe(
      "CREATE TABLE IF NOT EXISTS 'ft_data'(x);\n",
    );
    expect(renderSchemaLine('CREATE TABLE [a b](x)')).toBe('CREATE TABLE [a b](x);\n');
  });

  it('moves the semicolon past a trailing line comment', () => {
    expect(renderSchemaLine('CREATE TABLE t(a) -- note')).toBe('CREATE TABLE t(a) -- note\n;\n');
  });

  it('closes an unterminated block comment', () => {
    expect(renderSchemaLine('CREATE TABLE t(a) /* open')).toBe('CREATE TABLE t(a) /* open*/;\n');
  });

  it('leaves complete comments alone', () => {
    expect(renderSchemaLine('CREATE TABLE t(a /* ok */)')).toBe('CREATE TABLE t(a /* ok */);\n');
  });

  it('puts the semicolon on its own line when an index, trigger or view contains --', () => {
    expect(renderSchemaObject('CREATE VIEW v AS SELECT 1')).toBe('CREATE VIEW v AS SELECT 1;\n');
    expect(renderSchemaObject("CREATE VIEW v AS SELECT '--'")).toBe(
      "CREATE VIEW v AS SELECT '--'\n;\n",
    );
  });
});

describe('other renderers', () => {
  it('recreates a virtual table through sqlite_schema', () => {
    expect(
      renderVirtualTable("f't", 'CREATE VIRTUAL TABLE "f\'t" USING fts5(c)', 'sqlite_schema'),
    ).toBe(
      "INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','f''t','f''t',0,'CREATE VIRTUAL TABLE \"f''t\" USING fts5(c)');\n",
    );
  });

  it('prepares the system tables', () => {
    expect(renderSystemTablePrelude('sqlite_sequence', 'sqlite_schema', undefined)).toBe(
      'DELETE FROM sqlite_sequence;\n',
    );
    expect(renderSystemTablePrelude('sqlite_sequence', 'sqlite_schema', ['A', 'b'])).toBe(
      "DELETE FROM sqlite_sequence WHERE lower(name) IN ('a','b');\n",
    );
    expect(renderSystemTablePrelude('sqlite_stat1', 'sqlite_master', undefined)).toBe(
      'ANALYZE sqlite_master;\n',
    );
  });

  it('renders database settings only when non-zero', () => {
    expect(renderDatabaseSettings(0, 0)).toBe('');
    expect(renderDatabaseSettings(7, -3)).toBe(
      'PRAGMA user_version=7;\nPRAGMA application_id=-3;\n',
    );
  });
});
