import { acquireSqliteConnection, executeStatement, toText } from '../connection/acquire.js';
import type { SqliteConnection, SqliteErrorInfo, SqliteRow } from '../connection/types.js';
import { redactSecrets } from '../security/redact.js';
import { isAbortError, throwIfAborted } from '../utils/errors.js';
import { RestoreExecutionError } from './errors.js';
import { safeSqlPreview } from './preview.js';
import { isSchemaTableName, isTruthyPragmaValue, RestoreSessionState } from './sessionState.js';
import { SqlStatementParser, streamWithParser } from './statementParser.js';
import type { ParsedStatement } from './statementParser.js';
import type {
  RestoreStatementError,
  RestoreWarning,
  SqlDumpRestoreRequest,
  SqlDumpRestoreResult,
} from './types.js';

const WRAP_SAVEPOINT = 'dbgate_sqlite_restore';

/** Most foreign-key violations listed individually before the rest are summarized. */
const MAX_REPORTED_FOREIGN_KEY_VIOLATIONS = 20;

/**
 * Restores a plain-SQL dump using only the {@link SqliteConnection}
 * abstraction — no `sqlite3` shell, no external process.
 *
 * The input is split into statements by a streaming parser that reproduces
 * the `sqlite3` shell's own rules (see `statementParser.ts`), so a script is
 * executed as the same statements, in the same order, that
 * `sqlite3 database.db < dump.sql` would execute. Statements run
 * sequentially on one handle.
 *
 * A structural problem with the input — an unterminated string, an
 * unsupported dot-command, bytes that cannot be represented — throws,
 * because the statement boundaries past that point cannot be trusted. A
 * statement that parses but fails in SQLite is recorded in `result.errors`
 * instead, and unless `stopOnError` (the default) is set, the restore
 * continues.
 */
export async function restoreSqlDump(
  request: SqlDumpRestoreRequest,
): Promise<SqlDumpRestoreResult> {
  const options = request.options ?? {};
  const stopOnError = options.stopOnError ?? true;
  const restoreSessionStateOnExit = options.restoreSessionState ?? true;
  const schemaWrites = options.schemaWrites ?? 'allow';
  const wrap = options.transaction === 'wrap';
  const signal = request.signal;

  request.progress?.({ phase: 'connecting' });
  const acquired = await acquireSqliteConnection(request.connection, signal);
  const connection = acquired.connection;

  let statementsExecuted = 0;
  let statementsFailed = 0;
  let rowsRestored = 0;
  let bytesConsumed = 0;
  const errors: RestoreStatementError[] = [];
  const warnings: RestoreWarning[] = [];
  const sessionState = new RestoreSessionState();
  const parser = new SqlStatementParser(options);

  let defensiveDisabled = false;
  let wrapOpen = false;
  let skippedTransactionControl = 0;
  let textLiteralsRewritten = 0;

  const result = (cancelled: boolean): SqlDumpRestoreResult => ({
    statementsExecuted,
    statementsFailed,
    rowsRestored,
    bytesConsumed,
    errors,
    warnings,
    cancelled,
  });

  const report = (
    phase: 'parsing' | 'executing' | 'finalizing',
    statement?: ParsedStatement,
    executionState?: 'started' | 'finished' | 'failed',
    error?: RestoreStatementError,
  ): void => {
    request.progress?.({
      phase,
      statementsProcessed: statementsExecuted + statementsFailed,
      rowsRestored,
      bytesConsumed,
      ...(statement === undefined
        ? {}
        : {
            statementIndex: statement.statementIndex,
            ...(statement.currentObject === undefined
              ? {}
              : { currentObject: statement.currentObject }),
          }),
      ...(executionState === undefined ? {} : { executionState }),
      ...(error === undefined
        ? {}
        : {
            error: {
              statementIndex: error.statementIndex,
              location: error.location,
              sqlPreview: error.sqlPreview,
              message: error.message,
            },
          }),
    });
  };

  /** Ends the restore's own transaction (`transaction: 'wrap'`), committing only on success. */
  const closeWrap = async (commit: boolean): Promise<void> => {
    if (!wrapOpen) {
      return;
    }
    wrapOpen = false;
    if (!commit) {
      await executeStatement(connection, `ROLLBACK TO ${WRAP_SAVEPOINT}`).catch(() => {});
      warnings.push({
        code: 'transaction-rolled-back',
        message:
          'The restore did not complete, so its transaction (transaction: "wrap") was rolled back and the database is unchanged.',
      });
    }
    await executeStatement(connection, `RELEASE ${WRAP_SAVEPOINT}`).catch(() => {});
  };

  const finalize = async (completed: boolean): Promise<void> => {
    await closeWrap(completed);
    if (restoreSessionStateOnExit) {
      const { rolledBack, restored } = await sessionState.restore(connection, {
        rollbackOpenTransaction: true,
      });
      if (rolledBack) {
        warnings.push({
          code: 'transaction-rolled-back',
          message: completed
            ? "The script opened a transaction and never committed it (a truncated dump ends this way), so it was rolled back — as the sqlite3 shell's exit would roll it back."
            : 'The restore stopped inside the transaction the script opened, so that transaction was rolled back: nothing it had written so far was kept.',
        });
      }
      if (restored.length > 0) {
        warnings.push({
          code: 'session-state-restored',
          message: `The script left ${restored.join(', ')} changed when the restore ended, so it was reset before the connection was released.`,
        });
      }
    }
    if (sessionState.wroteSchemaRows) {
      // Rows written straight into sqlite_schema only take effect once the
      // schema is re-read. A fresh connection re-reads it anyway; this makes
      // the restored virtual tables usable on the *same* handle too.
      await executeStatement(connection, 'PRAGMA writable_schema=RESET').catch(() => {});
    }
    if (defensiveDisabled && connection.setDefensive) {
      await connection.setDefensive(true).catch(() => {});
      defensiveDisabled = false;
    }
    await acquired.release();
  };

  try {
    await sessionState.begin(connection, signal);
    if (options.disableForeignKeys) {
      await executeStatement(connection, 'PRAGMA foreign_keys=OFF', signal);
      sessionState.observe({ verb: 'PRAGMA', pragmaName: 'foreign_keys', pragmaValue: 'OFF' });
    }
    if (sessionState.joinedCallerTransaction && !wrap) {
      warnings.push({
        code: 'caller-transaction-open',
        message:
          'The connection was already inside a transaction when the restore started. A full dump\'s own BEGIN TRANSACTION will fail in that state; commit first, or restore with transaction: "wrap", which nests.',
      });
    }

    for await (const statement of streamWithParser(parser, request.source, signal)) {
      throwIfAborted(signal);
      bytesConsumed = statement.bytesConsumed;
      textLiteralsRewritten += statement.textLiteralsRewritten;
      report('parsing', statement);
      const info = statement.info;

      if (wrap) {
        if (
          info.transactionControl === 'begin' ||
          info.transactionControl === 'commit' ||
          info.transactionControl === 'rollback'
        ) {
          skippedTransactionControl++;
          continue;
        }
        // `PRAGMA foreign_keys` is a no-op inside a transaction, so the
        // dump's leading pragmas run before the wrapping transaction opens.
        if (!wrapOpen && info.verb !== 'PRAGMA') {
          await executeStatement(connection, `SAVEPOINT ${WRAP_SAVEPOINT}`, signal);
          wrapOpen = true;
        }
      }

      const schemaWriteRefused =
        schemaWrites === 'refuse' &&
        ((info.verb === 'INSERT' && isSchemaTableName(info.objectName)) ||
          (info.pragmaName === 'writable_schema' && isTruthyPragmaValue(info.pragmaValue)));

      if (
        !schemaWriteRefused &&
        schemaWrites === 'allow' &&
        !defensiveDisabled &&
        connection.setDefensive &&
        info.pragmaName === 'writable_schema' &&
        isTruthyPragmaValue(info.pragmaValue)
      ) {
        await connection.setDefensive(false);
        defensiveDisabled = true;
        warnings.push({
          code: 'defensive-mode-disabled',
          message:
            'The dump recreates virtual tables by writing sqlite_schema directly (as every native .dump of such a database does), so SQLITE_DBCONFIG_DEFENSIVE was disabled for the rest of the restore and re-enabled afterwards.',
          statementIndex: statement.statementIndex,
        });
      }

      report('executing', statement, 'started');
      try {
        if (schemaWriteRefused) {
          throw new Error(
            'Statement writes the schema table directly, which schemaWrites: "refuse" does not allow',
          );
        }
        const executed = await executeStatement(connection, statement.sql, signal);
        rowsRestored += executed.changes;
        statementsExecuted++;
        sessionState.observe(info);
        report('executing', statement, 'finished');
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        statementsFailed++;
        const statementError = toStatementError(connection, statement, error);
        errors.push(statementError);
        report('executing', statement, 'failed', statementError);
        if (stopOnError) {
          collectParserWarnings(parser, warnings, textLiteralsRewritten, skippedTransactionControl);
          await finalize(false);
          return result(false);
        }
      }
    }

    report('finalizing');
    if (options.verifyForeignKeys) {
      await closeWrap(true);
      warnings.push(...(await checkForeignKeys(connection, signal)));
    }
    collectParserWarnings(parser, warnings, textLiteralsRewritten, skippedTransactionControl);
    await finalize(true);
    return result(false);
  } catch (error) {
    collectParserWarnings(parser, warnings, textLiteralsRewritten, skippedTransactionControl);
    await finalize(false);
    if (isAbortError(error)) {
      return result(true);
    }
    throw error;
  }
}

function collectParserWarnings(
  parser: SqlStatementParser,
  warnings: RestoreWarning[],
  textLiteralsRewritten: number,
  skippedTransactionControl: number,
): void {
  for (const skipped of parser.skippedDotCommands) {
    warnings.push({
      code: 'dot-command-skipped',
      message: `The sqlite3 shell command ".${skipped.command}" on line ${skipped.line} only affects the shell's own output, so it was skipped.`,
    });
  }
  if (textLiteralsRewritten > 0) {
    warnings.push({
      code: 'text-literal-rewritten',
      message: `${textLiteralsRewritten} string literal(s) held bytes that are not valid UTF-8 and were executed as CAST(X'...' AS TEXT), which stores the identical bytes.`,
    });
  }
  if (skippedTransactionControl > 0) {
    warnings.push({
      code: 'script-transaction-control-skipped',
      message: `${skippedTransactionControl} BEGIN/COMMIT/ROLLBACK statement(s) in the script were skipped, because transaction: "wrap" runs the whole restore in its own transaction.`,
    });
  }
}

/** Runs `PRAGMA foreign_key_check` over the restored database. */
async function checkForeignKeys(
  connection: SqliteConnection,
  signal?: AbortSignal,
): Promise<RestoreWarning[]> {
  const found: RestoreWarning[] = [];
  let total = 0;
  const byTable = new Map<string, number>();
  for await (const row of connection.stream<SqliteRow>(
    { sql: 'PRAGMA foreign_key_check' },
    signal === undefined ? {} : { signal },
  )) {
    total++;
    const table = toText(row.table) ?? '?';
    byTable.set(table, (byTable.get(table) ?? 0) + 1);
    if (found.length < MAX_REPORTED_FOREIGN_KEY_VIOLATIONS) {
      found.push({
        code: 'foreign-key-violation',
        message: `Row ${toText(row.rowid) ?? '(no rowid)'} of table "${table}" references a missing row in "${toText(row.parent) ?? '?'}" (foreign key #${toText(row.fkid) ?? '?'}).`,
      });
    }
  }
  if (total > found.length) {
    found.push({
      code: 'foreign-key-violation',
      message: `${total} foreign-key violations in total: ${[...byTable].map(([table, count]) => `${table} (${count})`).join(', ')}.`,
    });
  }
  return found;
}

function toStatementError(
  connection: SqliteConnection,
  statement: ParsedStatement,
  error: unknown,
): RestoreStatementError {
  const described = connection.describeError?.(error);
  const message = redactSecrets(
    described?.message ?? (error instanceof Error ? error.message : String(error)),
  );
  const sqliteError: SqliteErrorInfo | undefined = described
    ? { ...described, message: redactSecrets(described.message) }
    : undefined;
  const executionError = new RestoreExecutionError(
    statement.statementIndex,
    statement.location,
    safeSqlPreview(statement.sql),
    message,
    sqliteError,
    { cause: error },
  );
  return {
    statementIndex: executionError.statementIndex,
    location: executionError.location,
    sqlPreview: executionError.sqlPreview,
    message: executionError.message,
    ...(executionError.sqliteError === undefined
      ? {}
      : { sqliteError: executionError.sqliteError }),
  };
}
