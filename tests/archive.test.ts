import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import { introspectSqlite } from '../src/introspection/introspect.js';
import { normalizeDumpSelection } from '../src/selection/normalize.js';
import { memoryDatabase } from './helpers.js';

async function modelOf(statements: readonly string[]) {
  const { connection } = memoryDatabase(statements);
  return (await introspectSqlite(connection)).database;
}

const SCHEMA = [
  'CREATE TABLE b(id INTEGER PRIMARY KEY AUTOINCREMENT, a_id REFERENCES a(id))',
  'CREATE TABLE a(id INTEGER PRIMARY KEY, b_id REFERENCES b(id))',
  'CREATE INDEX ib ON b(a_id)',
  'CREATE VIEW v AS SELECT * FROM a',
  'CREATE TRIGGER ta AFTER INSERT ON a BEGIN SELECT 1; END',
  'CREATE TRIGGER tv INSTEAD OF INSERT ON v BEGIN SELECT 1; END',
  'INSERT INTO b(a_id) VALUES(NULL)',
];

describe('inspectDumpArchive', () => {
  it('orders entries the native way, with sqlite_sequence after every table', async () => {
    const archive = inspectDumpArchive(await modelOf(SCHEMA));
    expect(archive.valid).toBe(true);
    expect(archive.entries.map(entry => `${entry.objectType}:${entry.name}`)).toEqual([
      'table:b',
      'tableData:b',
      'table:a',
      'tableData:a',
      'table:sqlite_sequence',
      'tableData:sqlite_sequence',
      'index:ib',
      'view:v',
      'trigger:ta',
      'trigger:tv',
    ]);
    expect(archive.entries.map(entry => entry.sequenceNumber)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('records circular foreign keys as preferences, which keeps the plan valid', async () => {
    const archive = inspectDumpArchive(await modelOf(SCHEMA));
    const tableB = archive.entries.find(
      entry => entry.objectType === 'table' && entry.name === 'b',
    );
    const tableA = archive.entries.find(
      entry => entry.objectType === 'table' && entry.name === 'a',
    );
    expect(tableB?.dependsOn).toContainEqual({
      targetDumpId: tableA?.dumpId,
      strength: 'preference',
    });
    expect(archive.cycles).toEqual([]);
  });

  it('makes a trigger depend hard on its table data', async () => {
    const archive = inspectDumpArchive(await modelOf(SCHEMA));
    const data = archive.entries.find(
      entry => entry.objectType === 'tableData' && entry.name === 'a',
    );
    const trigger = archive.entries.find(entry => entry.name === 'ta');
    expect(trigger?.dependsOn).toContainEqual({ targetDumpId: data?.dumpId, strength: 'hard' });
  });

  it('plans data only, or schema only', async () => {
    const database = await modelOf(SCHEMA);
    expect(
      inspectDumpArchive(database, { mode: 'data-only' }).entries.map(entry => entry.objectType),
    ).toEqual(['tableData', 'tableData', 'tableData']);
    expect(
      inspectDumpArchive(database, { mode: 'schema-only' }).entries.map(
        entry => `${entry.objectType}:${entry.name}`,
      ),
    ).toEqual(['table:b', 'table:a', 'index:ib', 'view:v', 'trigger:ta', 'trigger:tv']);
  });

  it('filters by selection, case-insensitively, and drops orphaned triggers', async () => {
    const archive = inspectDumpArchive(await modelOf(SCHEMA), {
      selection: normalizeDumpSelection({ tables: ['B'], views: [] }),
    });
    expect(archive.entries.map(entry => `${entry.objectType}:${entry.name}`)).toEqual([
      'table:b',
      'tableData:b',
      'table:sqlite_sequence',
      'tableData:sqlite_sequence',
      'index:ib',
    ]);
    expect(
      archive.entries.find(entry => entry.name === 'sqlite_sequence')?.systemRowFilter,
    ).toEqual(['b']);
    expect(archive.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'trigger-table-not-selected',
      'trigger-table-not-selected',
    ]);
  });

  it('honours objectKinds', async () => {
    const archive = inspectDumpArchive(await modelOf(SCHEMA), {
      objectKinds: {
        includeIndexes: false,
        includeTriggers: false,
        includeViews: false,
        includeSystemTables: false,
      },
    });
    expect(archive.entries.map(entry => entry.objectType)).toEqual([
      'table',
      'tableData',
      'table',
      'tableData',
    ]);
  });

  it('groups a virtual table with its shadow tables', async () => {
    const database = await modelOf([
      'CREATE VIRTUAL TABLE ft USING fts5(c)',
      'CREATE TABLE ft_extra(a)',
    ]);
    const shadows = database.tables
      .filter(table => table.kind === 'shadow')
      .map(table => table.name);
    expect(shadows.sort()).toEqual(['ft_config', 'ft_content', 'ft_data', 'ft_docsize', 'ft_idx']);
    expect(database.tables.find(table => table.name === 'ft_extra')?.kind).toBe('table');
    const archive = inspectDumpArchive(database, { objectKinds: { includeVirtualTables: false } });
    expect(archive.entries.map(entry => entry.name)).toEqual(['ft_extra', 'ft_extra']);
  });
});

describe('introspectSqlite', () => {
  it('models tables, columns, indexes and foreign keys', async () => {
    const database = await modelOf([
      'CREATE TABLE p(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE)',
      'CREATE TABLE c(id INT PRIMARY KEY, p_id INTEGER NOT NULL DEFAULT 0 REFERENCES p(id) ON DELETE CASCADE, g AS (id + 1)) WITHOUT ROWID',
      'CREATE TABLE s(a INTEGER, b ANY) STRICT',
      'CREATE TABLE h(a)',
      'CREATE INDEX ic ON c(p_id DESC, id)',
    ]);
    const p = database.tables.find(table => table.name === 'p');
    const c = database.tables.find(table => table.name === 'c');
    const s = database.tables.find(table => table.name === 's');
    const h = database.tables.find(table => table.name === 'h');
    expect(p?.rowidAliasColumn).toBe('id');
    expect(c?.withoutRowid).toBe(true);
    expect(c?.rowidAliasColumn).toBeNull();
    expect(s?.strict).toBe(true);
    expect(h?.rowidAliasColumn).toBeNull();
    expect(
      c?.columns.map(column => [
        column.name,
        column.notNull,
        column.defaultValue,
        column.generated,
      ]),
    ).toEqual([
      ['id', true, null, 'none'],
      ['p_id', true, '0', 'none'],
      ['g', false, null, 'virtual'],
    ]);
    expect(database.foreignKeys).toEqual([
      {
        tableName: 'c',
        id: 0,
        referencedTableName: 'p',
        columns: [{ from: 'p_id', to: 'id' }],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
        match: 'NONE',
      },
    ]);
    const ic = database.indexes.find(index => index.name === 'ic');
    expect(ic?.columns.map(column => [column.name, column.descending])).toEqual([
      ['p_id', true],
      ['id', false],
    ]);
    const unique = database.indexes.find(index => index.tableName === 'p' && index.origin === 'u');
    expect(unique?.sql).toBeNull();
    expect(unique?.columns[0]?.collation).toBe('NOCASE');
  });

  it('reads settings and sequences exactly', async () => {
    const database = await modelOf([
      'PRAGMA user_version = 7',
      'CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT)',
      "INSERT INTO sqlite_sequence VALUES('t', 9007199254740995)",
    ]);
    expect(database.userVersion).toBe(7);
    expect(database.encoding).toBe('UTF-8');
    expect(database.sequences).toEqual([{ tableName: 't', value: '9007199254740995' }]);
    expect(database.tables.find(table => table.name === 't')?.hasAutoincrement).toBe(true);
  });
});
