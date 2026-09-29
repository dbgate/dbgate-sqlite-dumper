import Database from 'better-sqlite3';
import { Writable } from 'node:stream';
import { fromBetterSqlite3 } from '../src/better-sqlite3.js';
import { dumpSqlite } from '../src/api/dump.js';
import type { DumpResult, DumpSqliteOptions } from '../src/api/types.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import type { RestoreOptions, SqlDumpRestoreResult } from '../src/restore/types.js';
import type { SqliteConnection } from '../src/connection/types.js';

export interface MemoryDatabase {
  readonly database: Database.Database;
  readonly connection: SqliteConnection;
}

/**
 * An in-memory database built from already-delimited statements.
 *
 * Each array element is executed on its own with `better-sqlite3`, which
 * **never touches this package's own parser** — otherwise a statement-
 * splitting bug could corrupt the fixture and mask itself.
 */
export function memoryDatabase(statements: readonly string[] = []): MemoryDatabase {
  const database = new Database(':memory:');
  for (const statement of statements) {
    database.exec(statement);
  }
  return { database, connection: fromBetterSqlite3(database) };
}

/** Collects everything written to it, as bytes. */
export class CollectingStream extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  get buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get text(): string {
    return this.buffer.toString('utf8');
  }
}

export async function dumpToBuffer(
  connection: SqliteConnection,
  options: DumpSqliteOptions = {},
): Promise<{ buffer: Buffer; text: string; result: DumpResult }> {
  const output = new CollectingStream();
  const result = await dumpSqlite(connection, options, output);
  return { buffer: output.buffer, text: output.text, result };
}

export async function restoreInto(
  connection: SqliteConnection,
  source: string | Buffer,
  options?: RestoreOptions,
): Promise<SqlDumpRestoreResult> {
  return restoreSqlDump({ connection, source, ...(options === undefined ? {} : { options }) });
}

/**
 * Every row of every table, rendered by SQLite itself (`quote()` of each
 * column, `hex()` for text so encoding is compared byte for byte), keyed by
 * table name. Two databases with the same contents produce equal snapshots.
 */
export function contentSnapshot(database: Database.Database): Record<string, string[]> {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name <> 'sqlite_stat4' ORDER BY name",
    )
    .pluck()
    .all() as string[];
  const snapshot: Record<string, string[]> = {};
  for (const table of tables) {
    const columns = (
      database.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[]
    ).map(name => `"${name.replace(/"/g, '""')}"`);
    const expression = columns
      .map(
        column =>
          `CASE typeof(${column}) WHEN 'text' THEN 'T' || hex(${column}) ELSE quote(${column}) END`,
      )
      .join(" || ',' || ");
    snapshot[table] = (
      database
        .prepare(`SELECT ${expression} FROM "${table.replace(/"/g, '""')}"`)
        .pluck()
        .all() as string[]
    ).sort();
  }
  return snapshot;
}

/** `sqlite_schema` rows, minus the tables whose presence depends on compile options. */
export function schemaSnapshot(database: Database.Database): string[] {
  return database
    .prepare(
      "SELECT type || ' ' || name || ' ' || tbl_name || ' ' || coalesce(sql, '') FROM sqlite_master WHERE name <> 'sqlite_stat4' ORDER BY rowid",
    )
    .pluck()
    .all() as string[];
}
