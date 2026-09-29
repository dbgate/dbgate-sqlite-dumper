import Database from 'better-sqlite3';

/**
 * Everything a restore must reproduce, read back through SQLite itself:
 *
 * - every `sqlite_schema` row except `rootpage` (a storage detail), sorted,
 *   since a restore creates tables before indexes and views and so assigns
 *   different rowids than the source's interleaved creation order;
 * - every row of every table, each column rendered as `quote()` — or, for
 *   text, as `hex()` so encoding is compared byte for byte — sorted, since a
 *   table without an `INTEGER PRIMARY KEY` gets fresh rowids.
 *
 * `sqlite_stat4` is left out: whether `ANALYZE` creates it is a compile-time
 * option of the SQLite that runs the restore, not a property of the data.
 */
export interface DatabaseSnapshot {
  readonly schema: readonly string[];
  readonly content: Readonly<Record<string, readonly string[]>>;
  readonly userVersion: number;
}

export function snapshotDatabase(path: string): DatabaseSnapshot {
  const database = new Database(path, { readonly: true });
  try {
    const schema = (
      database
        .prepare(
          "SELECT type || '|' || name || '|' || tbl_name || '|' || coalesce(sql, '<null>') FROM sqlite_master WHERE name <> 'sqlite_stat4'",
        )
        .pluck()
        .all() as string[]
    ).sort();

    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name <> 'sqlite_stat4' ORDER BY name",
      )
      .pluck()
      .all() as string[];
    const content: Record<string, string[]> = {};
    for (const table of tables) {
      const quoted = `"${table.replace(/"/g, '""')}"`;
      const columns = (
        database.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[]
      ).map(name => `"${name.replace(/"/g, '""')}"`);
      const expression = columns
        .map(
          column =>
            `CASE typeof(${column}) WHEN 'text' THEN 'T' || hex(${column}) ELSE quote(${column}) END`,
        )
        .join(" || ',' || ");
      content[table] = (
        database.prepare(`SELECT ${expression} FROM ${quoted}`).pluck().all() as string[]
      ).sort();
    }
    const userVersion = database.pragma('user_version', { simple: true }) as number;
    return { schema, content, userVersion };
  } finally {
    database.close();
  }
}

/**
 * Canonicalizes the `REAL` literals on a dump line.
 *
 * A dump's `REAL` digits come from SQLite's own `printf("%!.20g")`, and the
 * digits past the 17th — which carry no information, since 17 significant
 * digits already identify a double exactly — changed between SQLite
 * releases. The shell under test and the SQLite linked into the driver are
 * different releases, so their dumps may spell the same double differently
 * (`0.100000000000000005` vs `0.1000000000000000056`). Replacing each
 * literal with the shortest spelling of the double it denotes compares what
 * actually matters: that both name the same value.
 */
export function canonicalizeReals(line: string): string {
  return line.replace(/(?<![\w.'])-?\d+\.\d+(?:e[+-]\d+)?(?![\w.])/g, literal => {
    const value = Number(literal);
    return Number.isFinite(value) ? `R(${value})` : `R(${literal})`;
  });
}
