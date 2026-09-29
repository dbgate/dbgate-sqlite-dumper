import { executeStatement } from './acquire.js';
import type { SqliteConnection } from './types.js';

/**
 * How a dump obtains a consistent view of the database.
 *
 * - `'snapshot'` (default) — opens a read transaction (as a `SAVEPOINT`, see
 *   below) and performs one read inside it before anything else, so every
 *   table is read from the same state of the file. In WAL mode that is a
 *   true snapshot and writers carry on unblocked; in rollback-journal mode
 *   the transaction holds a `SHARED` lock, which keeps writers out until the
 *   dump finishes. Either way the result is consistent — it is the same
 *   mechanism the native `.dump` uses (`SAVEPOINT dump`).
 * - `'none'` — no transaction; each statement reads whatever is committed
 *   when it runs. Only safe when nothing else writes to the database.
 */
export type SqliteConsistencyMode = 'snapshot' | 'none';

export interface SqliteDumpSessionOptions {
  readonly consistency?: SqliteConsistencyMode;
}

export interface SqliteDumpSession {
  readonly consistency: SqliteConsistencyMode;
  /**
   * `true` when the handle was already inside a transaction the caller
   * opened, so the dump reads within *their* transaction and sees their
   * uncommitted changes. Reported so a caller can tell.
   */
  readonly joinedExistingTransaction: boolean;
  /**
   * Ends the read transaction. Idempotent. Never throws for a handle that is
   * already closed — cleanup must not mask the error that caused it.
   */
  finish(): Promise<void>;
}

/**
 * Savepoint name used for the dump's read transaction. Distinct from the
 * native shell's `dump` so a dump taken from inside a caller's own savepoint
 * named `dump` cannot release theirs by accident.
 */
const DUMP_SAVEPOINT = 'dbgate_sqlite_dump';

/**
 * Opens the dump's read session.
 *
 * A `SAVEPOINT` rather than `BEGIN`: outside a transaction the two are the
 * same (a savepoint then starts a deferred transaction), but inside one a
 * `BEGIN` fails while a savepoint nests. A caller who is already in a
 * transaction therefore gets a dump of what *they* see instead of an error.
 *
 * A deferred transaction does not take its read lock until the first read,
 * so the session performs one immediately — otherwise the snapshot would be
 * taken lazily by whichever catalog query happened to come first, which is
 * the same thing but leaves the guarantee to an accident of ordering.
 */
export async function beginSqliteDumpSession(
  connection: SqliteConnection,
  options?: SqliteDumpSessionOptions,
  signal?: AbortSignal,
): Promise<SqliteDumpSession> {
  const consistency = options?.consistency ?? 'snapshot';
  const joinedExistingTransaction = connection.isInTransaction?.() ?? false;

  if (consistency === 'none') {
    return { consistency, joinedExistingTransaction, finish: async () => {} };
  }

  await executeStatement(connection, `SAVEPOINT ${DUMP_SAVEPOINT}`, signal);
  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) {
      return;
    }
    finished = true;
    // Deliberately *without* the caller's signal: if the dump was cancelled
    // that signal is already aborted, and reusing it would skip the release
    // and leave a read transaction (and on rollback-journal databases, a
    // SHARED lock) open on a handle the caller may keep using.
    await executeStatement(connection, `RELEASE ${DUMP_SAVEPOINT}`).catch(() => {});
  };

  try {
    await connection.query({ sql: 'SELECT count(*) AS n FROM sqlite_master' }, signal);
  } catch (error) {
    await finish();
    throw error;
  }

  return { consistency, joinedExistingTransaction, finish };
}
