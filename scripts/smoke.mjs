/**
 * Post-build smoke test: loads the built `dist/` as both ESM and CJS and
 * exercises it end to end against an in-memory database.
 *
 * This catches the class of failure a unit test run against `src/` cannot:
 * a broken `exports` map, a missing `.d.ts`, an ESM/CJS interop mistake, or
 * an accidental top-level `better-sqlite3` import that would make the core
 * package unloadable without the optional peer dependency installed.
 *
 * Run with `npm run test:package`.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(description, condition) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    console.error(`  FAIL ${description}`);
    failures++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

section('build output');
for (const file of [
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/better-sqlite3.js',
  'dist/better-sqlite3.cjs',
  'dist/better-sqlite3.d.ts',
]) {
  check(`${file} exists`, existsSync(join(root, file)));
}

section('ESM entry point');
const esm = await import(new URL('../dist/index.js', import.meta.url).href);
for (const name of [
  'dumpSqlite',
  'restoreSqlDump',
  'introspectSqlite',
  'inspectDumpArchive',
  'renderPlainSql',
  'exportTableDataAsInserts',
  'preflightRestore',
  'isSqliteDump',
  'isCompleteStatement',
  'parseSqlStatements',
  'streamSqlStatements',
]) {
  check(`exports ${name}`, typeof esm[name] === 'function');
}

section('CJS entry point');
const cjs = require(join(root, 'dist/index.cjs'));
check('exports dumpSqlite', typeof cjs.dumpSqlite === 'function');
check('exports restoreSqlDump', typeof cjs.restoreSqlDump === 'function');
check('exports isSqliteDump', typeof cjs.isSqliteDump === 'function');

section('better-sqlite3 adapter entry point');
const adapterEsm = await import(new URL('../dist/better-sqlite3.js', import.meta.url).href);
check('exports fromBetterSqlite3', typeof adapterEsm.fromBetterSqlite3 === 'function');
check('exports connectBetterSqlite3', typeof adapterEsm.connectBetterSqlite3 === 'function');
const adapterCjs = require(join(root, 'dist/better-sqlite3.cjs'));
check('CJS exports fromBetterSqlite3', typeof adapterCjs.fromBetterSqlite3 === 'function');

section('behaviour without a database');
const statements = esm.parseSqlStatements(
  'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; SELECT 2; END;\nSELECT 3;',
);
check('a trigger body stays in one statement', statements.length === 2);
check('the following statement is separate', statements[1].sql === 'SELECT 3');
check(
  'isCompleteStatement follows sqlite3_complete',
  esm.isCompleteStatement('SELECT 1;') && !esm.isCompleteStatement('SELECT 1'),
);
check(
  'isSqliteDump recognizes native output',
  esm.isSqliteDump('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n'),
);
check(
  'quoteIdentifierIfNeeded follows the shell',
  esm.quoteIdentifierIfNeeded('order') === '"order"',
);

section('round trip through the built package');
{
  const { connectBetterSqlite3 } = adapterEsm;
  const source = await connectBetterSqlite3(':memory:');
  source.database.exec(
    "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT); INSERT INTO t VALUES(1, 'it''s'), (2, 'x' || char(10) || 'y');",
  );
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const dump = await esm.dumpSqlite(source.connection, {}, output);
  const text = Buffer.concat(chunks).toString('utf8');
  check('dumps two rows', dump.rowsExported === 2);
  check(
    'writes the native layout',
    text ===
      "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT);\nINSERT INTO t VALUES(1,'it''s');\nINSERT INTO t VALUES(2,replace('x\\ny','\\n',char(10)));\nCOMMIT;\n",
  );
  const target = await connectBetterSqlite3(':memory:');
  const restore = await esm.restoreSqlDump({ connection: target.connection, source: text });
  check('restores without errors', restore.errors.length === 0);
  check(
    'restores the same rows',
    JSON.stringify(target.database.prepare('SELECT * FROM t').all()) ===
      JSON.stringify(source.database.prepare('SELECT * FROM t').all()),
  );
  await source.close();
  await target.close();
}

section('core loads without the optional better-sqlite3 peer dependency');
{
  // Resolution of `better-sqlite3` is deliberately broken, then the core entry
  // point is loaded from scratch in a child process. This is the one check
  // that proves the optional peer dependency boundary holds in the *built*
  // artifact rather than only in `src/`.
  const { execFileSync } = await import('node:child_process');
  const probe = `
    const Module = require('module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'better-sqlite3' || request.startsWith('better-sqlite3/')) {
        throw new Error('better-sqlite3 is not installed (simulated)');
      }
      return originalResolve.call(this, request, ...rest);
    };
    const api = require(${JSON.stringify(join(root, 'dist/index.cjs'))});
    const adapter = require(${JSON.stringify(join(root, 'dist/better-sqlite3.cjs'))});
    if (typeof api.dumpSqlite !== 'function' || typeof adapter.fromBetterSqlite3 !== 'function') {
      throw new Error('entry point is incomplete');
    }
    process.stdout.write('ok');
  `;
  let loaded = false;
  try {
    loaded = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim() === 'ok';
  } catch (error) {
    console.error(`  (child failed: ${String(error.message).slice(0, 200)})`);
  }
  check('dist/index.cjs and dist/better-sqlite3.cjs load with better-sqlite3 unresolvable', loaded);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('All smoke checks passed.');
