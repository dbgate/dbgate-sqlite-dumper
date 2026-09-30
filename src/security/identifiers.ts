/**
 * SQLite's keywords, as `sqlite3_keyword_check()` reports them in a default
 * build (the 147 listed at https://sqlite.org/lang_keywords.html).
 *
 * The native `.dump` quotes a table or column name only when it has to —
 * when it is not a plain `[A-Za-z_][A-Za-z0-9_]*` identifier, or when it is
 * one of these words — and reproducing its output byte for byte means
 * making exactly the same decision.
 */
const SQLITE_KEYWORDS: ReadonlySet<string> = new Set(
  `ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN
  BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS
  CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE
  DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL
  FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE
  IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST
  LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR
  ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE
  REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS
  SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION
  UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`
    .split(/\s+/)
    .filter(word => word !== ''),
);

/** True when `name` is an SQLite keyword, compared case-insensitively as SQLite does. */
export function isSqliteKeyword(name: string): boolean {
  return SQLITE_KEYWORDS.has(toAsciiUpperCase(name));
}

/** The number of keywords known to {@link isSqliteKeyword}; exported for tests. */
export const SQLITE_KEYWORD_COUNT = SQLITE_KEYWORDS.size;

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Upper-cases ASCII letters only, which is how SQLite compares identifiers
 * and keywords: its case folding is ASCII-only (`sqlite3UpperToLower`), so
 * `ß` and `ǅ` are never folded and a locale-aware `toUpperCase()` would
 * disagree with the engine.
 */
export function toAsciiUpperCase(value: string): string {
  return value.replace(/[a-z]+/g, run => run.toUpperCase());
}

/** Lower-cases ASCII letters only; see {@link toAsciiUpperCase}. */
export function toAsciiLowerCase(value: string): string {
  return value.replace(/[A-Z]+/g, run => run.toLowerCase());
}

/**
 * Whether the native shell would quote `name`, and with what — a port of
 * `quoteChar()` from SQLite's `shell.c`:
 *
 * ```c
 * if( !IsAlpha(zName[0]) && zName[0]!='_' ) return '"';
 * for(i=0; zName[i]; i++){
 *   if( !IsAlnum(zName[i]) && zName[i]!='_' ) return '"';
 * }
 * return sqlite3_keyword_check(zName, i) ? '"' : 0;
 * ```
 *
 * `IsAlpha`/`IsAlnum` are the C-locale classifications, so any non-ASCII
 * character forces quoting.
 */
export function needsIdentifierQuoting(name: string): boolean {
  if (name.length === 0) {
    return true;
  }
  const first = name.charCodeAt(0);
  if (!isAsciiAlpha(first) && first !== 0x5f) {
    return true;
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (!isAsciiAlpha(code) && !isAsciiDigit(code) && code !== 0x5f) {
      return true;
    }
  }
  return isSqliteKeyword(name);
}

/**
 * Double-quotes an identifier, doubling any embedded `"`. Always quotes.
 *
 * Used for every query this package *runs*. Quoting unconditionally there
 * removes the whole question of which words are reserved in which SQLite
 * release; the output-shaping decision, where the native layout matters, is
 * {@link quoteIdentifierIfNeeded}.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quotes an identifier exactly when the native `.dump` would
 * ({@link needsIdentifierQuoting}), so `INSERT INTO t` stays unquoted while
 * `INSERT INTO "order"` and `INSERT INTO "a b"` are quoted.
 */
export function quoteIdentifierIfNeeded(name: string): string {
  return needsIdentifierQuoting(name) ? quoteIdentifier(name) : name;
}

/** `"schema"."name"`, for queries against an attached database. */
export function quoteQualifiedIdentifier(schemaName: string, name: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(name)}`;
}
