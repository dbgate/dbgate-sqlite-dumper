import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fromBetterSqlite3 } from '../src/better-sqlite3.js';
import { dumpSqlite } from '../src/api/dump.js';
import type { DumpProgressEvent } from '../src/utils/progress.js';
import {
  CollectingStream,
  contentSnapshot,
  dumpToBuffer,
  memoryDatabase,
  restoreInto,
  schemaSnapshot,
} from './helpers.js';

const tempDirectory = mkdtempSync(join(tmpdir(), 'sqlite-dumper-'));
afterAll(() => rmSync(tempDirectory, { recursive: true, force: true }));

async function roundTrip(
  statements: readonly string[],
  options: Parameters<typeof dumpToBuffer>[1] = {},
) {
  const source = memoryDatabase(statements);
  const dump = await dumpToBuffer(source.connection, options);
  const target = memoryDatabase();
  const restore = await restoreInto(target.connection, dump.buffer);
  return { source, target, dump, restore };
}

describe('dumpSqlite: layout', () => {
  it('writes the native .dump frame', async () => {
    const { connection } = memoryDatabase(['CREATE TABLE t(a)', 'INSERT INTO t VALUES(1)']);
    const { text } = await dumpToBuffer(connection);
    expect(text).toBe(
      'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a);\nINSERT INTO t VALUES(1);\nCOMMIT;\n',
    );
  });

  it('writes an empty database as just the frame', async () => {
    const { text } = await dumpToBuffer(memoryDatabase().connection);
    expect(text).toBe('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCOMMIT;\n');
  });

  it('orders tables by creation, then indexes, triggers and views by creation', async () => {
    const { connection } = memoryDatabase([
      'CREATE TABLE zeta(a)',
      'CREATE VIEW v1 AS SELECT * FROM zeta',
      'CREATE TABLE alpha(a)',
      'CREATE INDEX i_alpha ON alpha(a)',
      'CREATE TRIGGER tr AFTER INSERT ON zeta BEGIN SELECT 1; END',
    ]);
    const { text } = await dumpToBuffer(connection);
    expect(text.split('\n').filter(line => line.startsWith('CREATE'))).toEqual([
      'CREATE TABLE zeta(a);',
      'CREATE TABLE alpha(a);',
      'CREATE VIEW v1 AS SELECT * FROM zeta;',
      'CREATE INDEX i_alpha ON alpha(a);',
      'CREATE TRIGGER tr AFTER INSERT ON zeta BEGIN SELECT 1; END;',
    ]);
  });

  it('writes a data-only dump without the frame', async () => {
    const { connection } = memoryDatabase(['CREATE TABLE t(a)', 'INSERT INTO t VALUES(1)']);
    const { text } = await dumpToBuffer(connection, { mode: 'data-only' });
    expect(text).toBe('INSERT INTO t VALUES(1);\n');
  });

  it('writes a schema-only dump without rows, counters or statistics', async () => {
    const { connection } = memoryDatabase([
      'CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, a)',
      'INSERT INTO t(a) VALUES(1)',
      'CREATE INDEX i ON t(a)',
      'ANALYZE',
    ]);
    const { text } = await dumpToBuffer(connection, { mode: 'schema-only' });
    expect(text).toBe(
      'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, a);\nCREATE INDEX i ON t(a);\nCOMMIT;\n',
    );
  });

  it('can batch rows into multi-row INSERTs', async () => {
    const { connection } = memoryDatabase([
      'CREATE TABLE t(a)',
      'INSERT INTO t VALUES(1),(2),(3),(4),(5)',
    ]);
    const { text, result } = await dumpToBuffer(connection, {
      mode: 'data-only',
      dataExport: { extendedInsert: true, maxRowsPerStatement: 2 },
    });
    expect(text).toBe(
      'INSERT INTO t VALUES(1),(2);\nINSERT INTO t VALUES(3),(4);\nINSERT INTO t VALUES(5);\n',
    );
    expect(result.statementsWritten).toBe(3);
    expect(result.rowsExported).toBe(5);
  });

  it('adds DROP statements on request', async () => {
    const { connection } = memoryDatabase([
      'CREATE TABLE "order"(a)',
      'CREATE INDEX i ON "order"(a)',
    ]);
    const { text } = await dumpToBuffer(connection, { render: { addDropStatements: true } });
    expect(text).toContain(
      'DROP TABLE IF EXISTS "order";\nCREATE TABLE IF NOT EXISTS "order"(a);\n',
    );
    expect(text).toContain('DROP INDEX IF EXISTS i;\nCREATE INDEX i ON "order"(a);\n');
  });
});

describe('dumpSqlite: value fidelity', () => {
  const statements = [
    'CREATE TABLE v(x)',
    `INSERT INTO v VALUES
      (9223372036854775807), (-9223372036854775808), (0), (NULL),
      (1.5), (3.0), (-2.0), (0.1), (1e300), (-1e-300), (9e999), (-9e999), (1e20),
      ('plain'), (''), ('it''s'), ('a' || char(10) || 'b' || char(13) || 'c'), ('žluť 😀'),
      ('a' || char(0) || 'b'),
      (X''), (X'00FF10'), (CAST('x' AS BLOB))`,
  ];

  it('round-trips every storage class exactly', async () => {
    const { source, target, restore } = await roundTrip(statements);
    expect(restore.errors).toEqual([]);
    expect(contentSnapshot(target.database)).toEqual(contentSnapshot(source.database));
  });

  it('renders values exactly as the native .dump does', async () => {
    const { connection } = memoryDatabase(statements);
    const { text } = await dumpToBuffer(connection, { mode: 'data-only' });
    const values = text
      .trim()
      .split('\n')
      .map(line => line.slice('INSERT INTO v VALUES('.length, -2));
    expect(values).toEqual([
      '9223372036854775807',
      '-9223372036854775808',
      '0',
      'NULL',
      '1.5',
      '3.0',
      '-2.0',
      expect.stringMatching(/^0\.1000000000000000\d*$/),
      expect.stringMatching(/^1\.0000000000000000\d*e\+300$/),
      expect.stringMatching(/^-1\.0000000000000000\d*e-300$/),
      '9.0e+999',
      '-9.0e+999',
      '1.0e+20',
      "'plain'",
      "''",
      "'it''s'",
      "replace(replace('a\\nb\\rc','\\r',char(13)),'\\n',char(10))",
      "'žluť 😀'",
      "'a'||char(0)||'b'",
      "X''",
      "X'00ff10'",
      "X'78'",
    ]);
  });

  it('writes text that is not valid UTF-8 as its raw bytes, and restores it byte for byte', async () => {
    const source = memoryDatabase(['CREATE TABLE t(x)']);
    source.database
      .prepare('INSERT INTO t VALUES(CAST(? AS TEXT))')
      .run(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const dump = await dumpToBuffer(source.connection, { mode: 'data-only' });
    expect(dump.buffer).toEqual(
      Buffer.concat([
        Buffer.from("INSERT INTO t VALUES('caf"),
        Buffer.from([0xe9]),
        Buffer.from("');\n"),
      ]),
    );

    const target = memoryDatabase(['CREATE TABLE t(x)']);
    const restore = await restoreInto(target.connection, dump.buffer);
    expect(restore.warnings.map(warning => warning.code)).toContain('text-literal-rewritten');
    expect(target.database.prepare('SELECT hex(x), typeof(x) FROM t').raw().get()).toEqual([
      '636166E9',
      'text',
    ]);
  });

  it('keeps a REAL column holding an integral value as REAL', async () => {
    const { source, target } = await roundTrip([
      'CREATE TABLE r(x REAL, y)',
      'INSERT INTO r VALUES(3, 3.0)',
    ]);
    expect(contentSnapshot(target.database)).toEqual(contentSnapshot(source.database));
    expect(target.database.prepare('SELECT typeof(x), typeof(y) FROM r').raw().get()).toEqual([
      'real',
      'real',
    ]);
  });

  it('writes raw newlines with rawNewlines (the native --newlines)', async () => {
    const { connection } = memoryDatabase([
      'CREATE TABLE t(x)',
      "INSERT INTO t VALUES('a' || char(10) || 'b')",
    ]);
    const { text } = await dumpToBuffer(connection, {
      mode: 'data-only',
      dataExport: { rawNewlines: true },
    });
    expect(text).toBe("INSERT INTO t VALUES('a\nb');\n");
  });
});

describe('dumpSqlite: schema objects', () => {
  const schema = [
    // The fixture has circular references; better-sqlite3 enforces foreign
    // keys by default.
    'PRAGMA foreign_keys = OFF',
    'CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, child_id INTEGER REFERENCES child(id))',
    'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE)',
    'CREATE TABLE kv(k TEXT PRIMARY KEY, v) WITHOUT ROWID',
    'CREATE TABLE strict_t(a INTEGER, b TEXT) STRICT',
    "CREATE TABLE gen(a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL, c TEXT AS (a || 'x') STORED)",
    'CREATE TABLE "select"("from" TEXT, "a b" INT)',
    'CREATE TABLE log(msg)',
    'CREATE INDEX i_partial ON parent(name) WHERE name IS NOT NULL',
    'CREATE INDEX i_expr ON child(parent_id * 2 DESC)',
    'CREATE VIEW v_parent AS SELECT id, name FROM parent',
    "CREATE TRIGGER tr_parent AFTER INSERT ON parent BEGIN INSERT INTO log VALUES('parent; ' || new.name); END",
    'CREATE TRIGGER tr_view INSTEAD OF INSERT ON v_parent BEGIN INSERT INTO parent(name) VALUES(new.name); END',
    "INSERT INTO parent(name, child_id) VALUES('a', 1), ('b', 2)",
    'INSERT INTO child VALUES(1, 1), (2, 2)',
    "INSERT INTO kv VALUES('x', 1), ('a', X'00')",
    "INSERT INTO strict_t VALUES(1, 'one')",
    'INSERT INTO gen(a) VALUES(1), (2)',
    `INSERT INTO "select" VALUES('x', 1)`,
    "DELETE FROM parent WHERE name = 'b'",
    "INSERT INTO parent(name) VALUES('c')",
  ];

  it('round-trips schema and data', async () => {
    const { source, target, restore } = await roundTrip(schema);
    expect(restore.errors).toEqual([]);
    expect(schemaSnapshot(target.database)).toEqual(schemaSnapshot(source.database));
    expect(contentSnapshot(target.database)).toEqual(contentSnapshot(source.database));
  });

  it('does not fire triggers during the load', async () => {
    const { target } = await roundTrip(schema);
    // The source log has two rows written by the trigger; a trigger created
    // before the load would have written more.
    expect(target.database.prepare('SELECT count(*) FROM log').pluck().get()).toBe(3);
  });

  it('carries the AUTOINCREMENT counter', async () => {
    const { target } = await roundTrip(schema);
    target.database.exec("INSERT INTO parent(name) VALUES('next')");
    expect(target.database.prepare("SELECT id FROM parent WHERE name = 'next'").pluck().get()).toBe(
      4,
    );
  });

  it('excludes generated columns from INSERT and reports it', async () => {
    const { connection } = memoryDatabase(schema);
    const { text, result } = await dumpToBuffer(connection);
    expect(text).toContain('INSERT INTO gen VALUES(1);\n');
    expect(result.warnings.map(warning => warning.code)).toContain('generated-column-not-exported');
  });

  it('dumps statistics and counters in the native form', async () => {
    const { connection } = memoryDatabase([...schema, 'ANALYZE']);
    const { text } = await dumpToBuffer(connection);
    expect(text).toContain('ANALYZE sqlite_schema;\nINSERT INTO sqlite_stat1 VALUES(');
    expect(text).toMatch(
      /DELETE FROM sqlite_sequence;\nINSERT INTO sqlite_sequence VALUES\('parent',3\);\nCREATE INDEX/,
    );
  });

  it('leaves out system tables with includeSystemTables: false (the native --nosys)', async () => {
    const { connection } = memoryDatabase([...schema, 'ANALYZE']);
    const { text } = await dumpToBuffer(connection, {
      objectKinds: { includeSystemTables: false },
    });
    expect(text).not.toContain('sqlite_sequence');
    expect(text).not.toContain('sqlite_stat');
  });
});

describe('dumpSqlite: rowids', () => {
  const statements = [
    'CREATE TABLE t(a)',
    'INSERT INTO t VALUES(10), (20), (30)',
    'DELETE FROM t WHERE a = 20',
    'CREATE TABLE ipk(id INTEGER PRIMARY KEY, a)',
    'INSERT INTO ipk VALUES(5, 1)',
    'CREATE TABLE rowid_named(rowid, a)',
    'INSERT INTO rowid_named VALUES(1, 2)',
  ];

  it('renumbers hidden rowids by default, as the native .dump does', async () => {
    const { target } = await roundTrip(statements);
    expect(target.database.prepare('SELECT rowid FROM t').pluck().all()).toEqual([1, 2]);
  });

  it('preserves them with preserveRowids (the native --preserve-rowids)', async () => {
    const { connection } = memoryDatabase(statements);
    const { text } = await dumpToBuffer(connection, {
      mode: 'data-only',
      dataExport: { preserveRowids: true },
    });
    expect(text).toBe(
      [
        'INSERT INTO t(rowid,a) VALUES(1,10);',
        'INSERT INTO t(rowid,a) VALUES(3,30);',
        'INSERT INTO ipk VALUES(5,1);',
        'INSERT INTO rowid_named(_rowid_,rowid,a) VALUES(1,1,2);',
        '',
      ].join('\n'),
    );
  });
});

describe('dumpSqlite: virtual tables', () => {
  const statements = [
    'CREATE VIRTUAL TABLE docs USING fts5(title, body)',
    "INSERT INTO docs VALUES('hello', 'world'), ('second', 'row; with -- text')",
    'CREATE TABLE plain(a)',
  ];

  it('writes them the native way, behind the defensive-mode warning', async () => {
    const { connection } = memoryDatabase(statements);
    const { text } = await dumpToBuffer(connection);
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      '/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */',
    );
    expect(text).toContain(
      "PRAGMA writable_schema=ON;\nINSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','docs','docs',0,'CREATE VIRTUAL TABLE docs USING fts5(title, body)');\nCREATE TABLE IF NOT EXISTS 'docs_data'",
    );
    expect(text).toMatch(/PRAGMA writable_schema=OFF;\nCOMMIT;\n$/);
  });

  it('restores them usable on the same handle', async () => {
    const { target, restore } = await roundTrip(statements);
    expect(restore.errors).toEqual([]);
    expect(restore.warnings.map(warning => warning.code)).toContain('defensive-mode-disabled');
    expect(
      target.database.prepare("SELECT title FROM docs WHERE docs MATCH 'world'").pluck().all(),
    ).toEqual(['hello']);
    // Defensive mode is back on: a direct schema write is refused again.
    expect(() =>
      target.database.exec(
        "PRAGMA writable_schema=ON; INSERT INTO sqlite_schema VALUES('table','x','x',0,'CREATE TABLE x(a)')",
      ),
    ).toThrow();
  });

  it('creates them through their module in a schema-only dump, as .schema does', async () => {
    const { connection } = memoryDatabase(statements);
    const { text } = await dumpToBuffer(connection, { mode: 'schema-only' });
    expect(text).toBe(
      'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE VIRTUAL TABLE docs USING fts5(title, body);\nCREATE TABLE plain(a);\nCOMMIT;\n',
    );
    const target = memoryDatabase();
    const restore = await restoreInto(target.connection, text);
    expect(restore.errors).toEqual([]);
    target.database.exec("INSERT INTO docs VALUES('a', 'b')");
    expect(
      target.database.prepare("SELECT count(*) FROM docs WHERE docs MATCH 'b'").pluck().get(),
    ).toBe(1);
  });

  it('reproduces the native data-only quirk of selecting rows through the virtual table, and warns', async () => {
    const { connection } = memoryDatabase(statements);
    const { text, result } = await dumpToBuffer(connection, { mode: 'data-only' });
    expect(text.split('\n')[0]).toBe(
      '/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */',
    );
    expect(text).toContain("INSERT INTO docs VALUES('hello','world');");
    expect(text).toContain('INSERT INTO docs_data VALUES(');
    expect(result.warnings.map(warning => warning.code)).toContain('data-only-virtual-table');
  });

  it('selecting a virtual table brings its shadow tables', async () => {
    const { connection } = memoryDatabase(statements);
    const { text } = await dumpToBuffer(connection, { selection: { tables: ['docs'] } });
    expect(text).toContain("'docs_data'");
    expect(text).not.toContain('plain');
  });
});

describe('dumpSqlite: selection', () => {
  const statements = [
    'CREATE TABLE a(id INTEGER PRIMARY KEY AUTOINCREMENT, x)',
    'CREATE TABLE b(id INTEGER PRIMARY KEY AUTOINCREMENT, x)',
    'INSERT INTO a(x) VALUES(1)',
    'INSERT INTO b(x) VALUES(1), (2)',
    'CREATE INDEX ia ON a(x)',
    'CREATE TRIGGER tb AFTER INSERT ON b BEGIN SELECT 1; END',
  ];

  it('dumps only the selected tables, their indexes, and their counters', async () => {
    const { connection } = memoryDatabase(statements);
    const { text, result } = await dumpToBuffer(connection, { selection: { tables: ['A'] } });
    expect(text).toContain('CREATE TABLE a(');
    expect(text).not.toContain('CREATE TABLE b(');
    expect(text).toContain('CREATE INDEX ia');
    expect(text).toContain(
      "DELETE FROM sqlite_sequence WHERE lower(name) IN ('a');\nINSERT INTO sqlite_sequence VALUES('a',1);\n",
    );
    expect(text).not.toContain("'b',2");
    expect(result.warnings.map(warning => warning.code)).toContain('trigger-table-not-selected');
  });

  it('keeps structure but skips rows for dataExcludedTables', async () => {
    const { connection } = memoryDatabase(statements);
    const { text } = await dumpToBuffer(connection, { selection: { dataExcludedTables: ['b'] } });
    expect(text).toContain('CREATE TABLE b(');
    expect(text).not.toContain('INSERT INTO b');
  });
});

describe('dumpSqlite: database settings', () => {
  it('warns about a user_version it does not dump', async () => {
    const { connection } = memoryDatabase(['PRAGMA user_version = 12', 'CREATE TABLE t(a)']);
    const { text, result } = await dumpToBuffer(connection);
    expect(text).not.toContain('user_version');
    expect(result.warnings.map(warning => warning.code)).toContain('user-version-not-dumped');
  });

  it('dumps user_version and application_id on request', async () => {
    const { connection } = memoryDatabase([
      'PRAGMA user_version = 12',
      'PRAGMA application_id = 99',
      'CREATE TABLE t(a)',
    ]);
    const { text } = await dumpToBuffer(connection, { render: { includeDatabaseSettings: true } });
    expect(text).toMatch(/PRAGMA user_version=12;\nPRAGMA application_id=99;\nCOMMIT;\n$/);
    const target = memoryDatabase();
    await restoreInto(target.connection, text);
    expect(target.database.pragma('user_version', { simple: true })).toBe(12);
  });
});

describe('dumpSqlite: attached schemas', () => {
  it('dumps an attached database, without schema qualifiers', async () => {
    const { database, connection } = memoryDatabase(['CREATE TABLE main_only(a)']);
    database.exec(
      "ATTACH ':memory:' AS aux; CREATE TABLE aux.other(b); INSERT INTO aux.other VALUES(1)",
    );
    const { text } = await dumpToBuffer(connection, { schemaName: 'aux' });
    expect(text).toBe(
      'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE other(b);\nINSERT INTO other VALUES(1);\nCOMMIT;\n',
    );
  });

  it('refuses an unknown schema', async () => {
    const { connection } = memoryDatabase();
    await expect(dumpToBuffer(connection, { schemaName: 'nope' })).rejects.toThrow(
      /No database named/,
    );
  });
});

describe('dumpSqlite: consistency, progress and cancellation', () => {
  it('reads every table from one snapshot while another connection writes', async () => {
    const file = join(tempDirectory, 'snapshot.db');
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.exec(
      'CREATE TABLE a(x); CREATE TABLE b(x); INSERT INTO a VALUES(1); INSERT INTO b VALUES(1);',
    );
    const reader = new Database(file);
    const output = new CollectingStream();
    let wrote = false;
    await dumpSqlite(fromBetterSqlite3(reader), {}, output, event => {
      if (event.phase === 'exporting-data' && event.exportState === 'finished' && !wrote) {
        wrote = true;
        writer.exec('INSERT INTO b VALUES(2)');
      }
    });
    expect(output.text).not.toContain('INSERT INTO b VALUES(2)');
    expect(reader.inTransaction).toBe(false);
    reader.close();
    writer.close();
  });

  it('reports progress through every phase', async () => {
    const { connection } = memoryDatabase(['CREATE TABLE t(a)', 'INSERT INTO t VALUES(1)']);
    const phases: string[] = [];
    await dumpSqlite(connection, {}, new CollectingStream(), (event: DumpProgressEvent) => {
      if (phases[phases.length - 1] !== event.phase) phases.push(event.phase);
    });
    expect(phases).toEqual([
      'connecting',
      'starting-snapshot',
      'introspecting',
      'detecting-version',
      'planning-archive',
      'rendering-schema',
      'exporting-data',
      'finalizing',
    ]);
  });

  it('stops on cancellation, leaving no transaction open', async () => {
    const { database, connection } = memoryDatabase(['CREATE TABLE t(a)']);
    const insert = database.prepare('INSERT INTO t VALUES(?)');
    database.transaction(() => {
      for (let index = 0; index < 5000; index++) insert.run(index);
    })();
    const controller = new AbortController();
    const result = await dumpSqlite(
      connection,
      {},
      new CollectingStream(),
      event => {
        if (event.phase === 'exporting-data' && (event.rowsExported ?? 0) >= 1000)
          controller.abort();
      },
      controller.signal,
    );
    expect(result.cancelled).toBe(true);
    expect(database.inTransaction).toBe(false);
  });

  it("borrows the caller's transaction instead of failing", async () => {
    const { database, connection } = memoryDatabase(['CREATE TABLE t(a)']);
    database.exec('BEGIN; INSERT INTO t VALUES(1);');
    const { text, result } = await dumpToBuffer(connection);
    expect(text).toContain('INSERT INTO t VALUES(1);');
    expect(result.warnings.map(warning => warning.code)).toContain(
      'dump-joined-caller-transaction',
    );
    expect(database.inTransaction).toBe(true);
    database.exec('ROLLBACK');
  });
});
