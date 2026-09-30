import { describe, expect, it } from 'vitest';
import { checkTargetCompatibility, detectTargetCapabilities } from '../src/compatibility/check.js';
import { unsupportedFeatureDiagnostics } from '../src/compatibility/unsupported.js';
import { introspectSqlite } from '../src/introspection/introspect.js';
import { preflightRestore } from '../src/preflight/preflightRestore.js';
import { detectSqliteCapabilities } from '../src/version/capabilities.js';
import { detectSqliteVersion } from '../src/version/detect.js';
import { parseSqliteVersion } from '../src/version/types.js';
import type { SqliteConnection } from '../src/connection/types.js';
import { memoryDatabase } from './helpers.js';

const OLD = detectTargetCapabilities({ versionString: '3.30.1', ...parseSqliteVersion('3.30.1') });

describe('version', () => {
  it('parses version strings into SQLITE_VERSION_NUMBER form', () => {
    expect(parseSqliteVersion('3.45.1')).toEqual({
      majorVersion: 3,
      minorVersion: 45,
      patchVersion: 1,
      versionNumber: 3045001,
    });
    expect(parseSqliteVersion('3.8')).toMatchObject({ versionNumber: 3008000 });
    expect(() => parseSqliteVersion('garbage')).toThrow();
  });

  it('gates capabilities at the release that shipped them', () => {
    const at = (version: string) =>
      detectSqliteCapabilities({ versionString: version, ...parseSqliteVersion(version) });
    expect(at('3.36.9').supportsStrictTables).toBe(false);
    expect(at('3.37.0').supportsStrictTables).toBe(true);
    expect(at('3.32.3').supportsSqliteSchemaAlias).toBe(false);
    expect(at('3.33.0').supportsSqliteSchemaAlias).toBe(true);
  });

  it('detects the version behind a connection', async () => {
    const version = await detectSqliteVersion(memoryDatabase().connection);
    expect(version.majorVersion).toBe(3);
    expect(version.sourceId).toBeTruthy();
  });
});

describe('checkTargetCompatibility', () => {
  it('names each feature an older target lacks', async () => {
    const { connection } = memoryDatabase([
      'CREATE TABLE s(a INTEGER) STRICT',
      'CREATE TABLE g(a, b AS (a + 1))',
      'CREATE VIRTUAL TABLE ft USING fts5(c)',
    ]);
    const { database } = await introspectSqlite(connection);
    const messages = checkTargetCompatibility(database, OLD, { modules: new Set(['rtree']) }).map(
      diagnostic => `${diagnostic.code}: ${diagnostic.message}`,
    );
    expect(messages).toEqual([
      expect.stringMatching(/unsupported-target-feature: .*STRICT tables.*table "s"/),
      expect.stringMatching(/unsupported-target-feature: .*generated columns.*"g"\."b"/),
      expect.stringMatching(/unsupported-target-feature: .*sqlite_schema table name/),
      expect.stringMatching(/virtual-table-module-unavailable: .*"fts5"/),
    ]);
  });

  it('reports collations the target application must register', async () => {
    // better-sqlite3 cannot register a collation, so the model is edited
    // directly: this is a pure function of the model.
    const { connection } = memoryDatabase([
      'CREATE TABLE t(a)',
      'CREATE INDEX i ON t(a COLLATE NOCASE)',
    ]);
    const { database } = await introspectSqlite(connection);
    expect(checkTargetCompatibility(database, OLD)).toEqual([]);
    const withCustom = {
      ...database,
      indexes: database.indexes.map(index => ({
        ...index,
        columns: index.columns.map(column => ({ ...column, collation: 'UNICODE_CI' })),
      })),
    };
    expect(checkTargetCompatibility(withCustom, OLD).map(diagnostic => diagnostic.code)).toEqual([
      'custom-collation',
    ]);
  });

  it('lists what a dump never contains', () => {
    expect(unsupportedFeatureDiagnostics().map(diagnostic => diagnostic.code)).toContain(
      'file-settings-not-dumped',
    );
  });
});

describe('preflightRestore', () => {
  it('reports target state and conflicting objects', async () => {
    const source = memoryDatabase(['CREATE TABLE t(a)', 'CREATE VIRTUAL TABLE ft USING fts5(c)']);
    const { database } = await introspectSqlite(source.connection);
    const target = memoryDatabase(['CREATE TABLE T(b)']);
    const report = await preflightRestore({ connection: target.connection, database });
    expect(report.foreignKeysEnabled).toBe(true);
    expect(report.inTransaction).toBe(false);
    expect(report.canDisableDefensiveMode).toBe(true);
    expect(report.modules).toContain('fts5');
    expect(report.existingObjects).toEqual([{ type: 'table', name: 'T' }]);
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'object-already-exists',
    ]);
  });

  it('reports a sqlite_stat4 the target cannot recreate', async () => {
    const source = memoryDatabase([
      'CREATE TABLE t(a)',
      'CREATE INDEX i ON t(a)',
      'INSERT INTO t VALUES(1)',
      'ANALYZE',
    ]);
    const { database } = await introspectSqlite(source.connection);
    const target = memoryDatabase();
    const report = await preflightRestore({ connection: target.connection, database });
    // better-sqlite3 has STAT4, so nothing to report against itself...
    expect(report.compileOptions).toContain('ENABLE_STAT4');
    expect(report.diagnostics).toEqual([]);
    // ...but a target without it is refused up front.
    const withoutStat4: SqliteConnection = {
      ...target.connection,
      query: async (query: { sql: string }, signal?: AbortSignal) =>
        query.sql === 'PRAGMA compile_options'
          ? ({ rows: [{ compile_options: 'THREADSAFE=1' }] } as never)
          : target.connection.query(query, signal),
    };
    const refused = await preflightRestore({ connection: withoutStat4, database });
    expect(refused.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'statistics-table-unsupported',
    ]);
  });

  it('accepts existing objects when the dump drops them first', async () => {
    const source = memoryDatabase(['CREATE TABLE t(a)']);
    const { database } = await introspectSqlite(source.connection);
    const target = memoryDatabase(['CREATE TABLE t(b)']);
    const report = await preflightRestore({
      connection: target.connection,
      database,
      options: { addDropStatements: true },
    });
    expect(report.diagnostics).toEqual([]);
  });
});
