import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { cliCommand, cliRestore, requireCli, scratchDirectory } from './helpers/cli.js';
import { canonicalizeReals, snapshotDatabase } from './helpers/compare.js';
import { libraryDump, libraryRestore } from './helpers/library.js';

const enabled = requireCli();
const scratch = scratchDirectory('streaming');
afterAll(() => {
  if (process.env.KEEP_TEST_OUTPUT !== '1') {
    scratch.cleanup();
  }
});

const ROWS = 200_000;

describe.runIf(enabled)('large tables', () => {
  it('dump and restore a large table, streaming both ways, matching the native shell', async () => {
    const source = scratch.file('large.db');
    const database = new Database(source);
    database.exec(
      'CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT, amount REAL, payload BLOB)',
    );
    const insert = database.prepare('INSERT INTO big VALUES (?, ?, ?, randomblob(64))');
    database.transaction(() => {
      for (let index = 1; index <= ROWS; index++) {
        insert.run(
          index,
          `row ${index} ${index % 7 === 0 ? "with 'quotes'\nand a newline" : ''}`,
          index / 3,
        );
      }
    })();
    database.close();

    const dump = scratch.file('large.sql');
    const heapBefore = process.memoryUsage().heapUsed;
    const result = await libraryDump(source, dump);
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(result.rowsExported).toBe(ROWS);
    const size = statSync(dump).size;
    expect(size).toBeGreaterThan(30_000_000);
    // Constant memory: the heap does not grow with the size of the dump.
    expect(heapGrowth).toBeLessThan(size / 2);

    const native = cliCommand(source, '.dump').toString('latin1').split('\n');
    const ours = readFileSync(dump).toString('latin1').split('\n');
    expect(ours.length).toBe(native.length);
    for (let index = 0; index < ours.length; index++) {
      if (ours[index] !== native[index]) {
        expect(canonicalizeReals(ours[index] as string)).toBe(
          canonicalizeReals(native[index] as string),
        );
      }
    }

    const viaLibrary = scratch.file('large-library.db');
    const restore = await libraryRestore(dump, viaLibrary);
    expect(restore.errors).toEqual([]);
    expect(restore.rowsRestored).toBe(ROWS);
    const viaShell = scratch.file('large-shell.db');
    cliRestore(viaShell, readFileSync(dump));
    const expected = snapshotDatabase(source);
    expect(snapshotDatabase(viaLibrary)).toEqual(expected);
    expect(snapshotDatabase(viaShell)).toEqual(expected);
  });
});
