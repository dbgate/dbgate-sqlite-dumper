import { toText } from '../connection/acquire.js';
import type { SqliteConnection, SqliteRow } from '../connection/types.js';
import { parseSqliteVersion } from './types.js';
import type { SqliteVersion } from './types.js';

/**
 * Detects the SQLite library version behind a handle.
 *
 * This is the version of the library the *driver* links, which is not
 * necessarily the version of the `sqlite3` command-line shell installed on
 * the same machine — `better-sqlite3`, for instance, bundles its own. The
 * difference matters for one thing in a dump: `REAL` values are rendered by
 * SQLite's own `printf`, whose digit generation changed between releases.
 */
export async function detectSqliteVersion(
  connection: SqliteConnection,
  signal?: AbortSignal,
): Promise<SqliteVersion> {
  const result = await connection.query<SqliteRow>(
    { sql: 'SELECT sqlite_version() AS versionString' },
    signal,
  );
  const versionString = toText(result.rows[0]?.versionString);
  if (!versionString) {
    throw new Error('Unable to detect SQLite version: sqlite_version() returned no data');
  }

  let sourceId: string | undefined;
  try {
    const source = await connection.query<SqliteRow>(
      { sql: 'SELECT sqlite_source_id() AS sourceId' },
      signal,
    );
    sourceId = toText(source.rows[0]?.sourceId) ?? undefined;
  } catch {
    // Optional detail only: a build with the function omitted is still usable.
  }

  return {
    versionString,
    ...parseSqliteVersion(versionString),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}
