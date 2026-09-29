import { executeStatement, toNumber } from '../connection/acquire.js';
import type { SqliteConnection } from '../connection/types.js';
import { isAbortError } from '../utils/errors.js';
import type { StatementInfo } from './statementInfo.js';

const TRUTHY_PRAGMA_VALUES: ReadonlySet<string> = new Set(['1', 'on', 'true', 'yes']);

/** Parses a boolean pragma value the way SQLite does (`sqlite3GetBoolean`). */
export function isTruthyPragmaValue(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_PRAGMA_VALUES.has(value.trim().toLowerCase());
}

/**
 * Follows the connection state a restore script changes, so it can be put
 * back when the script stops before undoing it itself — or, for the
 * settings a native dump never undoes, when it finishes.
 *
 * Only statements the parser has classified (see `describeStatement`) are
 * followed: top-level transaction control and the two session pragmas a
 * dump uses. Text inside row values or trigger bodies is never mistaken for
 * one, because a statement is classified from its leading tokens only.
 */
export class RestoreSessionState {
  private initialForeignKeys: boolean | undefined;
  private foreignKeysChanged = false;
  private writableSchemaOn = false;
  private schemaRowsWritten = false;
  /** Tracked when the adapter cannot report `isInTransaction()`. */
  private trackedTransaction = false;
  private callerTransaction = false;

  /** Records the state to restore to. Call once, before the first statement. */
  async begin(connection: SqliteConnection, signal?: AbortSignal): Promise<void> {
    this.callerTransaction = connection.isInTransaction?.() ?? false;
    try {
      const result = await connection.query({ sql: 'PRAGMA foreign_keys' }, signal);
      const first = result.rows[0];
      if (first !== undefined) {
        this.initialForeignKeys = toNumber(Object.values(first)[0]) !== 0;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }

  /** Whether the handle was already inside a transaction the caller opened. */
  get joinedCallerTransaction(): boolean {
    return this.callerTransaction;
  }

  /** Whether any statement wrote virtual-table rows into the schema table. */
  get wroteSchemaRows(): boolean {
    return this.schemaRowsWritten;
  }

  /** Call after every statement that executed successfully. */
  observe(info: StatementInfo): void {
    if (info.transactionControl === 'begin') {
      this.trackedTransaction = true;
    } else if (info.transactionControl === 'commit' || info.transactionControl === 'rollback') {
      this.trackedTransaction = false;
    } else if (info.transactionControl === 'savepoint' && !this.trackedTransaction) {
      this.trackedTransaction = true;
    }
    if (info.verb === 'PRAGMA' && info.pragmaValue !== undefined) {
      if (info.pragmaName === 'foreign_keys') {
        this.foreignKeysChanged = true;
      } else if (info.pragmaName === 'writable_schema') {
        this.writableSchemaOn = isTruthyPragmaValue(info.pragmaValue);
      }
    }
    if (info.verb === 'INSERT' && isSchemaTableName(info.objectName)) {
      this.schemaRowsWritten = true;
    }
  }

  /** Whether a transaction the script (not the caller) opened is still open. */
  scriptTransactionOpen(connection: SqliteConnection): boolean {
    if (this.callerTransaction) {
      return false;
    }
    return connection.isInTransaction?.() ?? this.trackedTransaction;
  }

  /**
   * Puts back what the script changed. Runs without the caller's signal on
   * purpose: on the cancellation path that signal is already aborted, and
   * the cleanup must still happen. Returns a description of each change it
   * undid, for the `session-state-restored` warning.
   */
  async restore(
    connection: SqliteConnection,
    options: { readonly rollbackOpenTransaction: boolean },
  ): Promise<{ readonly rolledBack: boolean; readonly restored: readonly string[] }> {
    const restored: string[] = [];
    let rolledBack = false;

    if (options.rollbackOpenTransaction && this.scriptTransactionOpen(connection)) {
      await executeStatement(connection, 'ROLLBACK').catch(() => {});
      this.trackedTransaction = false;
      rolledBack = true;
    }
    if (this.writableSchemaOn) {
      await executeStatement(connection, 'PRAGMA writable_schema=OFF').catch(() => {});
      this.writableSchemaOn = false;
      restored.push('writable_schema');
    }
    // `foreign_keys` cannot change inside a transaction, so this has to come
    // after the rollback above. The caller's own open transaction, if any,
    // makes it a no-op — and the value never changed inside it either.
    if (this.foreignKeysChanged && this.initialForeignKeys !== undefined) {
      await executeStatement(
        connection,
        `PRAGMA foreign_keys=${this.initialForeignKeys ? 'ON' : 'OFF'}`,
      ).catch(() => {});
      this.foreignKeysChanged = false;
    }
    return { rolledBack, restored };
  }
}

/** `sqlite_schema`, `sqlite_master`, and their temp-schema forms. */
export function isSchemaTableName(name: string | undefined): boolean {
  if (name === undefined) {
    return false;
  }
  const lower = name.toLowerCase();
  return (
    lower === 'sqlite_schema' ||
    lower === 'sqlite_master' ||
    lower === 'sqlite_temp_schema' ||
    lower === 'sqlite_temp_master'
  );
}
