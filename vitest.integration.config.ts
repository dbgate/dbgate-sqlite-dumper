import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against the native `sqlite3` shell and live in a
 * separate Vitest project on purpose: `npm test` must stay fast and depend on
 * nothing outside `node_modules`, while `npm run test:integration` opts in to
 * the shell binary, which is how native interoperability is proven. See
 * `docs/round-trip-testing.md`.
 *
 * When the shell is not installed the suites skip themselves with a clear
 * message rather than failing — set `SQLITE_TEST_REQUIRED=1` (as CI does) to
 * turn "not installed" into a hard error, so the tests can never silently
 * no-op in an environment that was supposed to run them.
 */
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
