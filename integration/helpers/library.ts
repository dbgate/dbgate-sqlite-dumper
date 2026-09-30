import Database from 'better-sqlite3';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { dumpSqlite } from '../../src/api/dump.js';
import type { DumpResult, DumpSqliteOptions } from '../../src/api/types.js';
import { fromBetterSqlite3 } from '../../src/better-sqlite3.js';
import { restoreSqlDump } from '../../src/restore/restoreSqlDump.js';
import type { RestoreOptions, SqlDumpRestoreResult } from '../../src/restore/types.js';
import { FIXTURE_SCHEMA, INVALID_UTF8_TEXT } from '../fixture/schema.js';

/** Builds the fixture database file, one statement at a time, never through this package. */
export function buildFixture(path: string, extra: readonly string[] = []): void {
  const database = new Database(path);
  try {
    for (const statement of [...FIXTURE_SCHEMA, ...extra]) {
      database.exec(statement);
    }
    const insert = database.prepare('INSERT INTO later_table VALUES (CAST(? AS TEXT))');
    for (const bytes of INVALID_UTF8_TEXT) {
      insert.run(bytes);
    }
  } finally {
    database.close();
  }
}

/** Dumps a database file with this package, to a file, the way an application would. */
export async function libraryDump(
  databasePath: string,
  outputPath: string,
  options: DumpSqliteOptions = {},
): Promise<DumpResult> {
  const database = new Database(databasePath, { readonly: true });
  const output = createWriteStream(outputPath);
  try {
    return await dumpSqlite(fromBetterSqlite3(database), options, output);
  } finally {
    output.end();
    await finished(output);
    database.close();
  }
}

/** Restores a dump file into a new database file with this package, streaming the input. */
export async function libraryRestore(
  dumpPath: string,
  databasePath: string,
  options?: RestoreOptions,
): Promise<SqlDumpRestoreResult> {
  const database = new Database(databasePath);
  try {
    return await restoreSqlDump({
      connection: fromBetterSqlite3(database),
      source: createReadStream(dumpPath, { highWaterMark: 4096 }),
      ...(options === undefined ? {} : { options }),
    });
  } finally {
    database.close();
  }
}

export function readLines(path: string): string[] {
  return readFileSync(path).toString('latin1').split('\n');
}

export function dropStat4(path: string): void {
  const database = new Database(path);
  try {
    database.exec('DROP TABLE IF EXISTS sqlite_stat4');
  } finally {
    database.close();
  }
}
