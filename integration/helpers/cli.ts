import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The native `sqlite3` shell, used only here — to prove interoperability.
 * `SQLITE3_BIN` points at a specific binary; otherwise `sqlite3` on `PATH`.
 */
export const SQLITE3_BIN = process.env.SQLITE3_BIN ?? 'sqlite3';

export function cliVersion(): string | undefined {
  const result = spawnSync(SQLITE3_BIN, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return undefined;
  }
  return result.stdout.trim().split(/\s+/)[0];
}

/**
 * Whether the integration suites can run. When the shell is missing they
 * skip with a clear message — unless `SQLITE_TEST_REQUIRED=1` (as CI sets),
 * which turns "not installed" into a hard failure so the suites can never
 * silently no-op where they were supposed to run.
 */
export function requireCli(): boolean {
  const version = cliVersion();
  if (version) {
    return true;
  }
  if (process.env.SQLITE_TEST_REQUIRED === '1') {
    throw new Error(
      `SQLITE_TEST_REQUIRED=1 but the sqlite3 shell (${SQLITE3_BIN}) could not be run`,
    );
  }
  console.warn(`Skipping integration tests: the sqlite3 shell (${SQLITE3_BIN}) is not installed.`);
  return false;
}

/** `sqlite3 <db> <command>` — returns stdout as bytes, so non-UTF-8 output survives. */
export function cliCommand(databasePath: string, ...commands: string[]): Buffer {
  return execFileSync(SQLITE3_BIN, [databasePath, ...commands], { maxBuffer: 1 << 30 });
}

/** `sqlite3 <db> < script` — the native restore. Throws if the shell reports an error. */
export function cliRestore(databasePath: string, script: Buffer | string): void {
  const result = spawnSync(SQLITE3_BIN, ['-bail', databasePath], {
    input: script,
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0) {
    throw new Error(`sqlite3 restore failed (${result.status}): ${result.stderr.toString()}`);
  }
}

/** A scratch directory under `test-output/`, where failed runs' dumps are left for inspection. */
export function scratchDirectory(name: string): {
  path: string;
  file(name: string): string;
  cleanup(): void;
} {
  const root = join(process.cwd(), 'test-output');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, `${name}-`));
  return {
    path,
    file: (fileName: string) => join(path, fileName),
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export { tmpdir };
