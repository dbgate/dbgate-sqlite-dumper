/**
 * Small, deliberately conservative helpers for reading facts out of the
 * verbatim DDL SQLite keeps in `sqlite_schema.sql`, for the few facts no
 * catalog pragma reports on every supported version.
 */

/**
 * Blanks out string literals, quoted identifiers and comments (keeping
 * their length), so a keyword search cannot match text *inside* them —
 * `DEFAULT 'AUTOINCREMENT'` is not an autoincrement column.
 */
export function maskSqlLiterals(sql: string): string {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] as string;
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character;
      let end = sql.indexOf(close, index + 1);
      end = end === -1 ? sql.length : end + 1;
      output += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      let end = sql.indexOf('\n', index);
      end = end === -1 ? sql.length : end;
      output += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      let end = sql.indexOf('*/', index + 2);
      end = end === -1 ? sql.length : end + 2;
      output += ' '.repeat(end - index);
      index = end;
      continue;
    }
    output += character;
    index++;
  }
  return output;
}

/** `true` when the `CREATE TABLE` text declares an `AUTOINCREMENT` column. */
export function declaresAutoincrement(sql: string): boolean {
  return /\bAUTOINCREMENT\b/i.test(maskSqlLiterals(sql));
}

/**
 * Table options after the closing parenthesis of a `CREATE TABLE`
 * (`WITHOUT ROWID`, `STRICT`, in any combination). Used only when the
 * library is too old for `PRAGMA table_list`, which reports both directly.
 */
export function parseTableOptions(sql: string): { withoutRowid: boolean; strict: boolean } {
  const masked = maskSqlLiterals(sql);
  const close = masked.lastIndexOf(')');
  const tail = close === -1 ? '' : masked.slice(close + 1);
  return {
    withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(tail),
    strict: /\bSTRICT\b/i.test(tail),
  };
}

/** The module named in `CREATE VIRTUAL TABLE name USING module(...)`. */
export function parseVirtualTableModule(sql: string): string | undefined {
  const masked = maskSqlLiterals(sql);
  const match = /\bUSING\s+([A-Za-z0-9_$\u0080-\uffff]+)/i.exec(masked);
  return match
    ? sql.slice(match.index, match.index + match[0].length).replace(/^USING\s+/i, '')
    : undefined;
}
