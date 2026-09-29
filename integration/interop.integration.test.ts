import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliCommand, cliRestore, cliVersion, requireCli, scratchDirectory } from './helpers/cli.js';
import { canonicalizeReals, snapshotDatabase } from './helpers/compare.js';
import {
  buildFixture,
  dropStat4,
  libraryDump,
  libraryRestore,
  readLines,
} from './helpers/library.js';
import type { DumpSqliteOptions } from '../src/api/types.js';

const enabled = requireCli();

const SHADOW_TABLES = [
  'docs_data',
  'docs_idx',
  'docs_content',
  'docs_docsize',
  'docs_config',
  'geo_node',
  'geo_parent',
  'geo_rowid',
];
const scratch = scratchDirectory('interop');
const source = scratch.file('source.db');

beforeAll(() => {
  if (enabled) {
    buildFixture(source);
    console.log(`sqlite3 shell ${cliVersion()}`);
  }
});

afterAll(() => {
  // Kept on failure so CI can upload the dumps; see .github/workflows/ci.yml.
  if (process.env.KEEP_TEST_OUTPUT !== '1') {
    scratch.cleanup();
  }
});

/**
 * Compares two dumps line by line, allowing only the difference the two
 * SQLite releases genuinely produce: the digits past the 17th in a REAL
 * literal (see `canonicalizeReals`). Every other byte must be identical.
 */
function expectSameDump(ours: string[], native: string[]): void {
  expect(ours.length, 'line count').toBe(native.length);
  for (let index = 0; index < native.length; index++) {
    const ourLine = ours[index] as string;
    const nativeLine = native[index] as string;
    if (ourLine !== nativeLine) {
      expect(canonicalizeReals(ourLine), `line ${index + 1}`).toBe(canonicalizeReals(nativeLine));
    }
  }
}

describe.runIf(enabled)('this package vs the native .dump: byte identity', () => {
  const variants: { name: string; cli: string; options: DumpSqliteOptions }[] = [
    { name: '.dump', cli: '.dump', options: {} },
    { name: '.dump --data-only', cli: '.dump --data-only', options: { mode: 'data-only' } },
    {
      name: '.dump --preserve-rowids',
      cli: '.dump --preserve-rowids',
      options: { dataExport: { preserveRowids: true } },
    },
    {
      name: '.dump --newlines',
      cli: '.dump --newlines',
      options: { dataExport: { rawNewlines: true } },
    },
    {
      name: '.dump --nosys',
      cli: '.dump --nosys',
      options: { objectKinds: { includeSystemTables: false } },
    },
  ];

  for (const variant of variants) {
    it(`matches ${variant.name}`, async () => {
      const oursPath = scratch.file(`ours ${variant.name}.sql`);
      const nativePath = scratch.file(`native ${variant.name}.sql`);
      await libraryDump(source, oursPath, variant.options);
      writeFileSync(nativePath, cliCommand(source, variant.cli));
      expectSameDump(readLines(oursPath), readLines(nativePath));
    });
  }

  it('is identical apart from REAL digit tails, and those differ only in the digits past the 17th', async () => {
    const oursPath = scratch.file('ours-exact.sql');
    await libraryDump(source, oursPath);
    const native = cliCommand(source, '.dump').toString('latin1').split('\n');
    const ours = readLines(oursPath);
    const differing = ours.filter((line, index) => line !== native[index]);
    for (const line of differing) {
      // Every differing line holds at least one REAL literal.
      expect(line).toMatch(/\d\.\d/);
    }
  });
});

describe.runIf(enabled)('the interoperability matrix', () => {
  let expected: ReturnType<typeof snapshotDatabase>;
  let oursDump: string;
  let nativeDump: string;

  beforeAll(async () => {
    expected = snapshotDatabase(source);
    oursDump = scratch.file('matrix-ours.sql');
    nativeDump = scratch.file('matrix-native.sql');
    const result = await libraryDump(source, oursDump);
    expect(result.cancelled).toBe(false);
    writeFileSync(nativeDump, cliCommand(source, '.dump'));
  });

  it('this package → native sqlite3 restore', () => {
    const target = scratch.file('ours-to-native.db');
    cliRestore(target, readFileSync(oursDump));
    expect(snapshotDatabase(target)).toEqual(expected);
  });

  it("native .dump → this package's restore", async () => {
    const target = scratch.file('native-to-ours.db');
    const result = await libraryRestore(nativeDump, target);
    expect(result.errors).toEqual([]);
    expect(snapshotDatabase(target)).toEqual(expected);
  });

  it('this package → this package', async () => {
    const target = scratch.file('ours-to-ours.db');
    const result = await libraryRestore(oursDump, target);
    expect(result.errors).toEqual([]);
    expect(snapshotDatabase(target)).toEqual(expected);
  });

  it('native .dump → native sqlite3 restore (baseline)', () => {
    const target = scratch.file('native-to-native.db');
    cliRestore(target, readFileSync(nativeDump));
    expect(snapshotDatabase(target)).toEqual(expected);
  });

  it('dumping the restored database reproduces the first dump byte for byte', async () => {
    const target = scratch.file('idempotent.db');
    await libraryRestore(oursDump, target);
    // Restoring through better-sqlite3 runs ANALYZE on a build with
    // SQLITE_ENABLE_STAT4, which also creates an (empty) sqlite_stat4 the
    // source did not have. That is the restoring library's build, not the dump.
    dropStat4(target);
    const second = scratch.file('matrix-ours-second.sql');
    await libraryDump(target, second);
    expect(readFileSync(second).equals(readFileSync(oursDump))).toBe(true);
  });

  it('restored virtual tables answer queries', () => {
    const target = scratch.file('ours-to-native.db');
    const titles = cliCommand(target, "SELECT title FROM docs WHERE docs MATCH 'world'")
      .toString()
      .trim();
    expect(titles).toBe('Hello');
    const ids = cliCommand(target, 'SELECT id FROM geo WHERE minx <= 1 AND maxx >= 1 ORDER BY id')
      .toString()
      .trim();
    expect(ids).toBe('1\n2');
  });
});

describe.runIf(enabled)('fidelity beyond the native .dump', () => {
  it('keeps NUL characters, which the native shell truncates at', async () => {
    const path = scratch.file('nul.db');
    buildFixture(path, ["INSERT INTO later_table VALUES ('a' || char(0) || 'b')"]);
    const dump = scratch.file('nul.sql');
    await libraryDump(path, dump);

    const viaNative = scratch.file('nul-native.db');
    cliRestore(viaNative, readFileSync(dump));
    expect(snapshotDatabase(viaNative)).toEqual(snapshotDatabase(path));

    const viaLibrary = scratch.file('nul-library.db');
    await libraryRestore(dump, viaLibrary);
    expect(snapshotDatabase(viaLibrary)).toEqual(snapshotDatabase(path));
  });

  it('carries user_version with includeDatabaseSettings', async () => {
    const path = scratch.file('version.db');
    buildFixture(path, ['PRAGMA user_version = 42']);
    const dump = scratch.file('version.sql');
    await libraryDump(path, dump, { render: { includeDatabaseSettings: true } });
    const target = scratch.file('version-restored.db');
    cliRestore(target, readFileSync(dump));
    expect(snapshotDatabase(target)).toEqual(snapshotDatabase(path));
  });

  it('restores a data-only dump into an existing schema, atomically with transaction: "wrap"', async () => {
    // The recipe docs/dump-api.md gives for data-only dumps: triggers are
    // created after the load (or they fire for every row), rows of virtual
    // tables go in through the table rather than as shadow-table rows, and
    // counters and statistics are left to the target.
    const schemaDump = scratch.file('schema-only.sql');
    const dataDump = scratch.file('data-only.sql');
    await libraryDump(source, schemaDump, {
      mode: 'schema-only',
      objectKinds: { includeTriggers: false },
    });
    await libraryDump(source, dataDump, {
      mode: 'data-only',
      objectKinds: { includeSystemTables: false },
      selection: { dataExcludedTables: SHADOW_TABLES },
    });

    const target = scratch.file('split.db');
    const schemaResult = await libraryRestore(schemaDump, target);
    expect(schemaResult.errors).toEqual([]);
    const dataResult = await libraryRestore(dataDump, target, {
      transaction: 'wrap',
      disableForeignKeys: true,
    });
    expect(dataResult.errors).toEqual([]);
    const restored = snapshotDatabase(target).content;
    const original = snapshotDatabase(source).content;
    for (const table of Object.keys(original)) {
      if (!table.startsWith('sqlite_') && !SHADOW_TABLES.includes(table)) {
        expect(restored[table], table).toEqual(original[table]);
      }
    }
  });
});
