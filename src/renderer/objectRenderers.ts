import { isCompleteStatement } from '../restore/complete.js';
import { quoteIdentifierIfNeeded, toAsciiLowerCase } from '../security/identifiers.js';
import { quoteStringLiteral } from '../security/literals.js';

/** The native `.dump` preamble: integrity checks off, then one transaction around everything. */
export const SESSION_GUARD_HEADER = 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n';

export const SESSION_GUARD_FOOTER = 'COMMIT;\n';

export const WRITABLE_SCHEMA_ON = 'PRAGMA writable_schema=ON;\n';

export const WRITABLE_SCHEMA_OFF = 'PRAGMA writable_schema=OFF;\n';

/**
 * `printSchemaLine()` from `shell.c`: how the native `.dump` writes a
 * table's stored `CREATE TABLE` text.
 *
 * Two details are reproduced exactly, because both change the bytes:
 *
 * - **A trailing comment.** SQLite stores DDL verbatim, so it can end in a
 *   `--` comment (which would swallow an appended `;`) or even an
 *   unterminated `/*` comment (which SQLite accepts at end of input). When
 *   the text contains either, the shell tries appending nothing, `*\/` and a
 *   newline, in that order, and keeps the first variant that
 *   `sqlite3_complete()` accepts once `;` is added.
 * - **`IF NOT EXISTS` for quoted names.** A `CREATE TABLE` whose name is
 *   written in single or double quotes becomes
 *   `CREATE TABLE IF NOT EXISTS`. Virtual table modules create their shadow
 *   tables with exactly that spelling (`CREATE TABLE 'ft_data'(...)`), and
 *   by the time the dump reaches them on restore, a module may already have
 *   created them.
 */
export function renderSchemaLine(sql: string, tail = ';\n'): string {
  let text = sql;
  if (tail.startsWith(';') && (text.includes('/*') || text.includes('--'))) {
    for (const terminator of ['', '*/', '\n']) {
      if (isCompleteStatement(`${text}${terminator};`)) {
        text = `${text}${terminator}`;
        break;
      }
    }
  }
  if (/^CREATE TABLE ['"]/.test(text)) {
    return `CREATE TABLE IF NOT EXISTS ${text.slice(13)}${tail}`;
  }
  return `${text}${tail}`;
}

/**
 * How `run_table_dump_query()` in `shell.c` writes an index, trigger or view:
 * the stored text, then `;` — on a line of its own if the text contains
 * `--` anywhere, so a trailing line comment cannot swallow it. (The test is
 * a plain substring search, so a `--` inside a string literal triggers it
 * too, and does here.)
 */
export function renderSchemaObject(sql: string): string {
  return sql.includes('--') ? `${sql}\n;\n` : `${sql};\n`;
}

/**
 * A virtual table, recreated the way the native `.dump` does it: by writing
 * its row into `sqlite_schema` directly (under `PRAGMA writable_schema=ON`)
 * instead of running `CREATE VIRTUAL TABLE`.
 *
 * Running the `CREATE` would invoke the module's constructor, which for most
 * modules creates and initializes the shadow tables — and the dump is about
 * to recreate those itself, with the source's exact contents. Writing the
 * schema row leaves the shadow tables to the dump, so an FTS index or R-tree
 * comes back byte-identical rather than rebuilt.
 */
export function renderVirtualTable(name: string, sql: string, schemaTableName: string): string {
  // `'%q'` in the shell's format string: single quotes doubled, nothing else.
  const quotedName = quoteStringLiteral(name);
  return `INSERT INTO ${schemaTableName}(type,name,tbl_name,rootpage,sql)VALUES('table',${quotedName},${quotedName},0,${quoteStringLiteral(sql)});\n`;
}

/**
 * The statement that prepares a system table for its rows.
 *
 * - `sqlite_sequence` is emptied, so the `AUTOINCREMENT` counters that
 *   follow replace — rather than duplicate — the counters the preceding
 *   inserts advanced. A partial dump only resets the counters of the tables
 *   it contains.
 * - `sqlite_stat1`/`sqlite_stat4` are created, if missing, by analyzing the
 *   (trivial) schema table, which is how the native `.dump` guarantees they
 *   exist before inserting into them.
 */
export function renderSystemTablePrelude(
  name: string,
  schemaTableName: string,
  systemRowFilter: readonly string[] | undefined,
): string {
  if (name === 'sqlite_sequence') {
    if (systemRowFilter === undefined) {
      return 'DELETE FROM sqlite_sequence;\n';
    }
    const names = [...new Set(systemRowFilter.map(toAsciiLowerCase))].map(quoteStringLiteral);
    return `DELETE FROM sqlite_sequence WHERE lower(name) IN (${names.join(',')});\n`;
  }
  return `ANALYZE ${schemaTableName};\n`;
}

export type DroppableKind = 'TABLE' | 'INDEX' | 'TRIGGER' | 'VIEW';

/** `DROP <kind> IF EXISTS <name>;`, for `addDropStatements`. */
export function renderDrop(kind: DroppableKind, name: string): string {
  return `DROP ${kind} IF EXISTS ${quoteIdentifierIfNeeded(name)};\n`;
}

/** `PRAGMA user_version=…;` / `PRAGMA application_id=…;`, for `includeDatabaseSettings`. */
export function renderDatabaseSettings(userVersion: number, applicationId: number): string {
  let text = '';
  if (userVersion !== 0) {
    text += `PRAGMA user_version=${userVersion};\n`;
  }
  if (applicationId !== 0) {
    text += `PRAGMA application_id=${applicationId};\n`;
  }
  return text;
}
