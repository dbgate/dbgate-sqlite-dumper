import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { D1Error, fromD1Binding, fromD1Http } from '../src/d1.js';
import type { D1DatabaseBinding, D1PreparedStatementBinding } from '../src/d1.js';
import { dumpSqlite } from '../src/api/dump.js';
import {
  CollectingStream,
  contentSnapshot,
  dumpToBuffer,
  memoryDatabase,
  restoreInto,
} from './helpers.js';

/**
 * A database with something of everything a D1 dump has to get right:
 * every storage class (including a 64-bit integer, which JSON cannot carry,
 * and text that is not valid UTF-8), more rows than one page, a `WITHOUT
 * ROWID` table with a composite, descending, NOCASE key, a table whose rowid
 * names are all taken, AUTOINCREMENT, a generated column, a virtual table,
 * and statistics.
 */
const FIXTURE = [
  `CREATE TABLE "values"(id INTEGER PRIMARY KEY AUTOINCREMENT, i INTEGER, r REAL, t TEXT, b BLOB, n)`,
  `INSERT INTO "values"(i, r, t, b, n) VALUES
     (9223372036854775807, 0.1, 'it''s', X'00FF10', NULL),
     (-9223372036854775808, 1e300, 'line' || char(10) || 'break', X'', 1),
     (9007199254740993, -0.0, CAST(X'C328' AS TEXT), NULL, 'x'),
     (0, 9e999, '', X'DEADBEEF', -9e999),
     (NULL, 3.0, 'žluťoučký kůň 🐎', zeroblob(3), 2.5)`,
  'CREATE TABLE plain(a, b)',
  `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50)
     INSERT INTO plain SELECT x, 'row ' || x FROM n`,
  'DELETE FROM plain WHERE a % 7 = 0',
  `CREATE TABLE keyed(region TEXT COLLATE NOCASE, code INTEGER, label TEXT,
     PRIMARY KEY(region, code DESC)) WITHOUT ROWID`,
  `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 30)
     INSERT INTO keyed SELECT char(65 + x % 4) || '''q', x, 'label ' || x FROM n`,
  'CREATE TABLE shadowed(rowid, _rowid_, oid, v)',
  `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20)
     INSERT INTO shadowed SELECT x, x, x, 'v' || x FROM n`,
  'CREATE TABLE gen(a INTEGER, doubled INTEGER GENERATED ALWAYS AS (a * 2) STORED)',
  'INSERT INTO gen(a) VALUES (1), (2)',
  'CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT UNIQUE)',
  'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)',
  "INSERT INTO parent VALUES (1, 'one'), (2, 'two')",
  'INSERT INTO child VALUES (10, 1), (11, 2)',
  'CREATE INDEX child_parent ON child(parent_id)',
  'CREATE VIEW parent_names AS SELECT name FROM parent',
  'CREATE TRIGGER parent_touch AFTER UPDATE ON parent BEGIN SELECT 1; END',
  'CREATE VIRTUAL TABLE docs USING fts5(body)',
  "INSERT INTO docs VALUES ('hello world'), ('dumping d1')",
  'ANALYZE',
];

/** The internal tables a real D1 database carries in `sqlite_schema`. */
const D1_INTERNAL = [
  'CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID',
  "INSERT INTO _cf_KV VALUES ('secret', X'01')",
];

interface FakeD1Options {
  /** Also refuse `table_xinfo`, `index_xinfo` and `table_list`. */
  readonly classicPragmasOnly?: boolean;
}

/**
 * Cloudflare's `/raw` endpoint, emulated over an in-memory database: the
 * same envelope, rows as arrays, BLOBs as arrays of bytes, numbers as JSON
 * numbers — and D1's refusals, so a test fails if the dump ever relies on
 * something real D1 would reject.
 */
function fakeD1(statements: readonly string[], options: FakeD1Options = {}) {
  const database = new Database(':memory:');
  for (const statement of [...D1_INTERNAL, ...statements]) {
    database.exec(statement);
  }
  const requests: unknown[] = [];
  const executed: string[] = [];

  const refusal = (sql: string): string | null => {
    if (/\bpragma_\w+/i.test(sql)) return 'not authorized: table-valued pragma functions';
    if (/^\s*(BEGIN|SAVEPOINT|RELEASE|COMMIT|ROLLBACK)\b/i.test(sql)) {
      return 'not authorized: transactions are not supported';
    }
    // D1's authorizer refuses access to the objects; a string literal naming
    // one (as a filter does) is fine.
    if (/_cf_/i.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) {
      return 'not authorized: _cf_ objects are reserved';
    }
    if (/"main"\s*\./i.test(sql)) return 'qualified names are not expected';
    if (options.classicPragmasOnly && /\b(table_xinfo|index_xinfo|table_list)\b/i.test(sql)) {
      return 'not authorized: pragma';
    }
    if (!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return 'a dump must only read';
    return null;
  };

  const runStatement = (statement: { sql: string; params?: unknown[] }) => {
    executed.push(statement.sql);
    const reason = refusal(statement.sql);
    if (reason) {
      throw new Error(`${reason}: SQLITE_AUTH`);
    }
    const prepared = database.prepare(statement.sql);
    const columns = prepared.columns().map(column => column.name);
    const rows = (prepared.raw(true).all(...(statement.params ?? [])) as unknown[][]).map(row =>
      row.map(value => (Buffer.isBuffer(value) ? [...value] : value)),
    );
    return { results: { columns, rows }, success: true, meta: {} };
  };

  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db-uuid/raw',
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(init?.body)) as
      { sql: string; params?: unknown[] } | { batch: { sql: string; params?: unknown[] }[] };
    requests.push(body);
    const statements = 'batch' in body ? body.batch : [body];
    try {
      const result = statements.map(runStatement);
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }));
    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 7500, message: (error as Error).message }],
          messages: [],
          result: [],
        }),
        { status: 400 },
      );
    }
  }) as typeof globalThis.fetch;

  return { database, requests, executed, fetch };
}

/**
 * The same database without D1's internal tables, as a local SQLite file
 * would hold it: created in the same order (so `sqlite_schema` and the
 * statistics come out in the same order), then the internal table dropped.
 */
function localCopy(statements: readonly string[]) {
  return memoryDatabase([...D1_INTERNAL, ...statements, 'DROP TABLE _cf_KV']);
}

function d1Connection(fake: ReturnType<typeof fakeD1>, pageSize = 7) {
  return fromD1Http({
    accountId: 'acc',
    databaseId: 'db-uuid',
    apiToken: 'secret-token',
    pageSize,
    fetch: fake.fetch,
  });
}

describe('Cloudflare D1 over HTTP', () => {
  it('writes the same dump as a local copy of the database', async () => {
    const local = await dumpToBuffer(localCopy(FIXTURE).connection);
    const fake = fakeD1(FIXTURE);
    const remote = await dumpToBuffer(d1Connection(fake));

    expect(remote.text).toBe(local.text);
    expect(remote.buffer.equals(local.buffer)).toBe(true);
    expect(remote.result.rowsExported).toBe(local.result.rowsExported);
    expect(remote.text).not.toContain('_cf_');
    const codes = remote.result.warnings.map(warning => warning.code);
    expect(codes).toContain('snapshot-unavailable');
    expect(codes).toContain('reserved-objects-skipped');
  });

  it('restores into the same contents', async () => {
    const fake = fakeD1(FIXTURE);
    const remote = await dumpToBuffer(d1Connection(fake));
    const target = memoryDatabase();
    const restore = await restoreInto(target.connection, remote.buffer);
    expect(restore.errors).toEqual([]);
    expect(contentSnapshot(target.database)).toEqual(contentSnapshot(localCopy(FIXTURE).database));
  });

  it('reads table data in keyed pages', async () => {
    const fake = fakeD1(FIXTURE);
    await dumpToBuffer(d1Connection(fake));
    const reads = (table: string) =>
      fake.executed.filter(sql => sql.includes(` FROM ${table}`) && sql.includes('LIMIT 7'));
    // 43 rows, 7 per page: 7 pages, each a seek past the last rowid.
    expect(reads('"plain"')).toHaveLength(7);
    expect(
      reads('"plain"')
        .slice(1)
        .every(sql => /WHERE \(rowid > \d+\)/.test(sql)),
    ).toBe(true);
    // The WITHOUT ROWID table pages on its key, in its own key order.
    expect(reads('"keyed"')[1]).toMatch(/ORDER BY "region" COLLATE "NOCASE", "code" DESC/);
    // No rowid name is free, so this one falls back to offsets.
    expect(reads('"shadowed"')[1]).toMatch(/LIMIT 7 OFFSET 7$/);
  });

  it('batches the catalog queries', async () => {
    const fake = fakeD1(FIXTURE);
    await dumpToBuffer(d1Connection(fake, 1000));
    const batches = fake.requests.filter(request => 'batch' in (request as object));
    expect(batches.length).toBeGreaterThan(0);
    // Without batching the catalog alone would take more than one request per table.
    expect(fake.requests.length).toBeLessThan(40);
  });

  it('falls back to the classic pragmas when the extended ones are refused', async () => {
    const fake = fakeD1(FIXTURE, { classicPragmasOnly: true });
    const remote = await dumpToBuffer(d1Connection(fake));
    expect(fake.executed.some(sql => sql.startsWith('PRAGMA table_info('))).toBe(true);
    const target = memoryDatabase();
    const restore = await restoreInto(target.connection, remote.buffer);
    expect(restore.errors).toEqual([]);
    expect(contentSnapshot(target.database)).toEqual(contentSnapshot(localCopy(FIXTURE).database));
  });

  it('reports what D1 rejected, never the token', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          result: null,
        }),
        { status: 403 },
      )) as typeof globalThis.fetch;
    const connection = fromD1Http({
      accountId: 'acc',
      databaseId: 'db-uuid',
      apiToken: 'secret-token',
      fetch,
    });
    const error = await dumpToBuffer(connection).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(D1Error);
    expect((error as D1Error).message).toBe('Authentication error');
    expect((error as D1Error).status).toBe(403);
    expect(String((error as Error).stack)).not.toContain('secret-token');
  });

  it('cancels a dump through its signal', async () => {
    const fake = fakeD1(FIXTURE);
    const controller = new AbortController();
    controller.abort();
    const output = new CollectingStream();
    await expect(
      dumpSqlite(d1Connection(fake), {}, output, undefined, controller.signal),
    ).rejects.toThrow();
    expect(output.buffer.length).toBe(0);
  });
});

describe('Cloudflare D1 through a Worker binding', () => {
  /** `env.DB`, emulated: `raw({ columnNames: true })` and `batch()`, BLOBs as byte arrays. */
  function fakeBinding(statements: readonly string[]): D1DatabaseBinding {
    const database = new Database(':memory:');
    for (const statement of [...D1_INTERNAL, ...statements]) {
      database.exec(statement);
    }
    const toJson = (value: unknown) => (Buffer.isBuffer(value) ? [...value] : value);
    const prepare = (
      sql: string,
      params: unknown[] = [],
    ): D1PreparedStatementBinding & {
      all(): Promise<{ results: unknown[] }>;
    } => ({
      bind: (...values: unknown[]) => prepare(sql, values),
      raw: async () => {
        if (/\bpragma_\w+|_cf_/i.test(sql.replace(/'(?:[^']|'')*'/g, "''")))
          throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
        const statement = database.prepare(sql);
        const columns = statement.columns().map(column => column.name);
        const rows = (statement.raw(true).all(...params) as unknown[][]).map(row =>
          row.map(toJson),
        );
        return [columns, ...rows];
      },
      all: async () => {
        const statement = database.prepare(sql);
        const rows = (statement.all(...params) as Record<string, unknown>[]).map(row =>
          Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toJson(value)])),
        );
        return { results: rows };
      },
    });
    return {
      prepare: sql => prepare(sql),
      batch: async prepared =>
        Promise.all(prepared.map(statement => (statement as ReturnType<typeof prepare>).all())),
    };
  }

  it('writes the same dump as a local copy of the database', async () => {
    const local = await dumpToBuffer(localCopy(FIXTURE).connection);
    const remote = await dumpToBuffer(fromD1Binding(fakeBinding(FIXTURE), { pageSize: 5 }));
    expect(remote.text).toBe(local.text);
  });
});

describe('connection features on an ordinary handle', () => {
  // The features are not D1-specific: any adapter can declare them, and each
  // must leave the dump unchanged.
  it.each([
    ['paged reads', { pagedReadSize: 4 }],
    ['hex transport', { binaryTransport: 'hex' as const }],
    ['no transactions', { transactions: false }],
    ['statement-form pragmas', { pragmaFunctions: false, extendedPragmas: false }],
    ['unqualified names', { schemaQualifiedNames: false }],
  ])('%s', async (_name, features) => {
    const local = memoryDatabase(FIXTURE);
    const expected = await dumpToBuffer(local.connection);
    const actual = await dumpToBuffer({ ...local.connection, features });
    expect(actual.buffer.equals(expected.buffer)).toBe(true);
  });

  it('keeps UTF-16 text exact with the hex transport', async () => {
    const statements = [
      "PRAGMA encoding = 'UTF-16le'",
      'CREATE TABLE t(a TEXT, b BLOB)',
      "INSERT INTO t VALUES ('žluť' || char(10) || '🐎', X'00FF')",
    ];
    const local = memoryDatabase(statements);
    const expected = await dumpToBuffer(local.connection);
    const actual = await dumpToBuffer({
      ...local.connection,
      features: { binaryTransport: 'hex', pagedReadSize: 1 },
    });
    expect(actual.text).toBe(expected.text);
    expect(actual.text).toContain("X'00ff'");
  });
});
