import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { UnsupportedClientCommandError } from '../src/restore/errors.js';
import { isSqliteDump } from '../src/restore/preview.js';
import type { RestoreProgressEvent } from '../src/utils/progress.js';
import { memoryDatabase, restoreInto } from './helpers.js';

const NATIVE_DUMP = [
  'PRAGMA foreign_keys=OFF;',
  'BEGIN TRANSACTION;',
  'CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);',
  "INSERT INTO parent VALUES(1,'a');",
  'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id REFERENCES parent(id));',
  'INSERT INTO child VALUES(1,1);',
  'INSERT INTO child VALUES(2,99);',
  "CREATE TRIGGER tr AFTER INSERT ON child BEGIN UPDATE parent SET name = name || ';' WHERE id = new.parent_id; END;",
  'COMMIT;',
  '',
].join('\n');

describe('restoreSqlDump', () => {
  it('restores a native dump', async () => {
    const { database, connection } = memoryDatabase();
    const result = await restoreInto(connection, NATIVE_DUMP);
    expect(result.errors).toEqual([]);
    expect(result.statementsExecuted).toBe(9);
    expect(result.rowsRestored).toBe(3);
    expect(database.prepare('SELECT count(*) FROM child').pluck().get()).toBe(2);
    expect(result.cancelled).toBe(false);
  });

  it('puts foreign_keys back to its value before the restore', async () => {
    const { database, connection } = memoryDatabase();
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    await restoreInto(connection, NATIVE_DUMP);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('reports foreign-key violations when asked', async () => {
    const { connection } = memoryDatabase();
    const result = await restoreInto(connection, NATIVE_DUMP, { verifyForeignKeys: true });
    expect(
      result.warnings.filter(warning => warning.code === 'foreign-key-violation'),
    ).toHaveLength(1);
  });

  it('stops at the first failing statement and rolls the script transaction back', async () => {
    const { database, connection } = memoryDatabase();
    const broken = NATIVE_DUMP.replace(
      'INSERT INTO child VALUES(2,99);',
      'INSERT INTO nope VALUES(1);',
    );
    const result = await restoreInto(connection, broken);
    expect(result.statementsFailed).toBe(1);
    expect(result.errors[0]).toMatchObject({
      statementIndex: 6,
      location: { startLine: 7, endLine: 7 },
      sqlPreview: 'INSERT INTO nope VALUES(1)',
      sqliteError: { code: 'SQLITE_ERROR' },
    });
    expect(result.errors[0]?.message).toMatch(/no such table/);
    expect(result.warnings.map(warning => warning.code)).toContain('transaction-rolled-back');
    expect(database.inTransaction).toBe(false);
    expect(
      database.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'parent'").pluck().get(),
    ).toBe(0);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('continues past failures with stopOnError: false', async () => {
    const { database, connection } = memoryDatabase();
    const broken = NATIVE_DUMP.replace(
      'INSERT INTO child VALUES(2,99);',
      'INSERT INTO nope VALUES(1);',
    );
    const result = await restoreInto(connection, broken, { stopOnError: false });
    expect(result.statementsFailed).toBe(1);
    expect(result.statementsExecuted).toBe(8);
    expect(database.prepare('SELECT count(*) FROM child').pluck().get()).toBe(1);
  });

  it('rolls back a script that never commits, as the shell would', async () => {
    const { database, connection } = memoryDatabase();
    const truncated = NATIVE_DUMP.replace('COMMIT;\n', '');
    const result = await restoreInto(connection, truncated);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => warning.code)).toContain('transaction-rolled-back');
    expect(database.prepare('SELECT count(*) FROM sqlite_master').pluck().get()).toBe(0);
  });

  it('wraps a data-only dump in one transaction with transaction: "wrap"', async () => {
    const { database, connection } = memoryDatabase(['CREATE TABLE t(a UNIQUE)']);
    const script = 'INSERT INTO t VALUES(1);\nINSERT INTO t VALUES(2);\nINSERT INTO t VALUES(1);\n';
    const result = await restoreInto(connection, script, { transaction: 'wrap' });
    expect(result.statementsFailed).toBe(1);
    expect(database.prepare('SELECT count(*) FROM t').pluck().get()).toBe(0);
    expect(database.inTransaction).toBe(false);

    const ok = await restoreInto(
      connection,
      NATIVE_DUMP.replace(
        /CREATE TABLE parent[^\n]*\n/,
        'CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);\n',
      ),
      { transaction: 'wrap' },
    );
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.map(warning => warning.code)).toContain(
      'script-transaction-control-skipped',
    );
    expect(database.prepare('SELECT count(*) FROM child').pluck().get()).toBe(2);
  });

  it('refuses schema writes with schemaWrites: "refuse"', async () => {
    const { connection } = memoryDatabase();
    const script =
      "PRAGMA writable_schema=ON;\nINSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','x','x',0,'CREATE VIRTUAL TABLE x USING fts5(a)');\n";
    const result = await restoreInto(connection, script, {
      schemaWrites: 'refuse',
      stopOnError: false,
    });
    expect(result.statementsFailed).toBe(2);
  });

  it('skips presentational dot-commands and reports them', async () => {
    const { connection } = memoryDatabase();
    const result = await restoreInto(connection, '.headers on\nCREATE TABLE t(a);\n');
    expect(result.statementsExecuted).toBe(1);
    expect(result.warnings.map(warning => warning.code)).toEqual(['dot-command-skipped']);
  });

  it('throws on a dot-command it cannot honour', async () => {
    const { connection } = memoryDatabase();
    await expect(restoreInto(connection, '.read x.sql\n')).rejects.toThrow(
      UnsupportedClientCommandError,
    );
  });

  it('keeps question marks and colons in literals intact', async () => {
    const { database, connection } = memoryDatabase(['CREATE TABLE t(a)']);
    await restoreInto(connection, "INSERT INTO t VALUES('? :name @x $y');");
    expect(database.prepare('SELECT a FROM t').pluck().get()).toBe('? :name @x $y');
  });

  it('reads from a stream, in chunks, and reports progress', async () => {
    const { connection } = memoryDatabase();
    const events: RestoreProgressEvent[] = [];
    const source = Readable.from(NATIVE_DUMP.match(/[\s\S]{1,7}/g) ?? []);
    const result = await restoreSqlDump({
      connection,
      source,
      progress: event => events.push(event),
    });
    expect(result.errors).toEqual([]);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(NATIVE_DUMP));
    expect(events.some(event => event.currentObject === 'child')).toBe(true);
  });

  it('stops on cancellation and leaves no transaction open', async () => {
    const { database, connection } = memoryDatabase();
    const controller = new AbortController();
    const result = await restoreSqlDump({
      connection,
      source: NATIVE_DUMP,
      signal: controller.signal,
      progress: event => {
        if (event.statementIndex === 3) controller.abort();
      },
    });
    expect(result.cancelled).toBe(true);
    expect(database.inTransaction).toBe(false);
  });
});

describe('isSqliteDump', () => {
  it('recognizes native full dumps and the virtual-table warning', () => {
    expect(isSqliteDump(NATIVE_DUMP)).toBe(true);
    expect(
      isSqliteDump(
        '/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n',
      ),
    ).toBe(true);
    expect(isSqliteDump('PRAGMA foreign_keys=OFF;\r\nBEGIN TRANSACTION;\r\n')).toBe(true);
  });

  it('rejects other scripts', () => {
    expect(isSqliteDump('-- MySQL dump 10.13\n')).toBe(false);
    expect(isSqliteDump('SELECT 1;')).toBe(false);
  });
});
