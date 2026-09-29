import { afterAll, describe, expect, it } from 'vitest';
import { cliRestore, requireCli, scratchDirectory } from './helpers/cli.js';
import { snapshotDatabase } from './helpers/compare.js';
import { libraryRestore } from './helpers/library.js';
import { writeFileSync } from 'node:fs';

const enabled = requireCli();
const scratch = scratchDirectory('scripts');
afterAll(() => {
  if (process.env.KEEP_TEST_OUTPUT !== '1') {
    scratch.cleanup();
  }
});

/**
 * Hand-written scripts in the shapes the `sqlite3` shell accepts beyond what
 * `.dump` writes. Each is run through the shell and through this package, and
 * the two resulting databases must be identical — which proves the parser
 * splits them where the shell does, rather than where it seems reasonable.
 */
const SCRIPTS: Record<string, string> = {
  'triggers with semicolons, END and CASE in their bodies': [
    'CREATE TABLE t(a, b);',
    'CREATE TABLE log(m);',
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN',
    "  INSERT INTO log VALUES ('end; END; begin');",
    "  INSERT INTO log VALUES (CASE WHEN new.a > 1 THEN 'big' ELSE 'small' END);",
    'END;',
    'create temp trigger tt after insert on t begin select 1; end;',
    'INSERT INTO t VALUES (1, 2); INSERT INTO t VALUES (5, 6);',
  ].join('\n'),
  'comments everywhere': [
    '-- leading; comment',
    '/* block; comment',
    '   spanning lines */',
    'CREATE TABLE t(a /* inline; */, b -- line; comment',
    ');',
    "INSERT INTO t VALUES ('--not a comment', '/* nor this */'); -- trailing",
    'INSERT INTO t VALUES (5-3, 6/2);',
  ].join('\n'),
  'GO and / terminator lines': [
    'CREATE TABLE t(a)',
    'GO',
    'INSERT INTO t VALUES (1)',
    '   go   ',
    'INSERT INTO t VALUES (2)',
    '/',
    'INSERT INTO t VALUES (3);',
  ].join('\n'),
  'CRLF line endings and carriage returns in literals': [
    'CREATE TABLE t(a);',
    "INSERT INTO t VALUES ('one\r\ntwo');",
    "INSERT INTO t VALUES ('lone\rcr');",
    "INSERT INTO t VALUES ('double\r\r\nend');",
    '',
  ].join('\r\n'),
  'hash comments and presentational dot-commands': [
    '# a comment line',
    '.headers on',
    '.mode list',
    'CREATE TABLE t(a);',
    '  # not a comment here, so this is an error in both',
    'INSERT INTO t VALUES (1);',
  ].join('\n'),
  'quoted identifiers of every kind': [
    'CREATE TABLE "a;b" ([c;d], `e;f`, "g""h");',
    "INSERT INTO \"a;b\" VALUES ('1', '2', '3');",
    "CREATE TABLE 'quoted' (x);",
    "INSERT INTO 'quoted' VALUES ('it''s');",
  ].join('\n'),
  'several statements on one line, and none at the end': [
    'CREATE TABLE t(a); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);',
    'INSERT INTO t VALUES (3)',
  ].join('\n'),
};

describe.runIf(enabled)(
  'scripts beyond .dump: this package splits them where the shell does',
  () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      it(name, async () => {
        const slug = name.replace(/\W+/g, '-');
        const scriptPath = scratch.file(`${slug}.sql`);
        writeFileSync(scriptPath, script);

        const viaShell = scratch.file(`${slug}-shell.db`);
        let shellError: Error | undefined;
        try {
          cliRestore(viaShell, script);
        } catch (error) {
          shellError = error as Error;
        }

        const viaLibrary = scratch.file(`${slug}-library.db`);
        const result = await libraryRestore(scriptPath, viaLibrary, { stopOnError: true });

        // Both stop at the same failing statement, or neither fails.
        expect(result.errors.length > 0, `library errors: ${JSON.stringify(result.errors)}`).toBe(
          shellError !== undefined,
        );
        expect(snapshotDatabase(viaLibrary)).toEqual(snapshotDatabase(viaShell));
      });
    }
  },
);
