import type { SqliteTableKind } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';

/**
 * Every kind of entry the archive planner can produce.
 *
 * These map one-to-one onto what the native `.dump` writes:
 *
 * - `table` — a table's structure: its verbatim `CREATE TABLE`, or for the
 *   two system tables the statement that prepares them
 *   (`DELETE FROM sqlite_sequence;`, `ANALYZE sqlite_schema;`).
 * - `tableData` — the table's rows, as `INSERT` statements.
 * - `virtualTable` — a `CREATE VIRTUAL TABLE`, recreated the way the native
 *   `.dump` recreates it: by inserting its row into `sqlite_schema` under
 *   `PRAGMA writable_schema=ON`, *without* running the module's
 *   constructor. Its data lives in its shadow tables, which are ordinary
 *   `table`/`tableData` entries of their own — that is what makes the
 *   restored index byte-identical to the source instead of rebuilt.
 * - `index`, `trigger`, `view` — verbatim DDL, after all table data.
 */
export type ArchiveObjectType =
  'table' | 'tableData' | 'virtualTable' | 'index' | 'trigger' | 'view';

/**
 * Emission sections, in output order. They mirror the two passes the native
 * `.dump` makes over `sqlite_schema`:
 *
 * 1. `tables` — every table, in `sqlite_schema` rowid order (creation
 *    order), each immediately followed by its rows, with `sqlite_sequence`
 *    moved last so the `AUTOINCREMENT` counters are set *after* the inserts
 *    that would otherwise advance them.
 * 2. `schema` — indexes, triggers and views, in `sqlite_schema` rowid order.
 *    After the data on purpose: an index built once over loaded rows is
 *    faster than one maintained row by row, and a trigger created before
 *    the load would fire once per inserted row.
 */
export type DumpSection = 'tables' | 'schema';

/**
 * `hard`: the restore fails, or produces a wrong result, if the order is
 * violated. `preference`: the order is meaningful but a violation is
 * harmless — a foreign key between two tables is the canonical case, since
 * `PRAGMA foreign_keys=OFF` at the top of the dump makes any table order
 * restorable, which is exactly what allows circular foreign keys.
 */
export type ArchiveDependencyStrength = 'hard' | 'preference';

/** One directed edge from an entry to another entry it depends on. */
export interface ArchiveDependency {
  readonly targetDumpId: string;
  readonly strength: ArchiveDependencyStrength;
}

/**
 * One immutable, restore-orderable unit of the archive. Entries carry no SQL
 * text; rendering derives text from the model object identified by `name`
 * at render time.
 */
export interface ArchiveEntry {
  readonly dumpId: string;
  readonly identity: string;
  readonly objectType: ArchiveObjectType;
  readonly section: DumpSection;
  readonly schemaName: string;
  readonly name: string;
  /** Owning table, for `tableData`, `index` and `trigger` entries. */
  readonly parentName?: string;
  /** For `table` and `tableData` entries: which kind of table. */
  readonly tableKind?: SqliteTableKind;
  /**
   * For the rows of `sqlite_sequence` and `sqlite_stat*` in a *partial* dump:
   * the tables whose rows are kept. A dump of a subset of tables must not
   * carry — or, on restore, reset — the counters and statistics of tables
   * it does not contain. Absent when every row is dumped.
   */
  readonly systemRowFilter?: readonly string[];
  readonly dependsOn: readonly ArchiveDependency[];
  /**
   * This entry's 0-based position in {@link DumpArchiveInspection.entries}.
   * Omitted when `valid` is `false`, since no such order exists.
   */
  readonly sequenceNumber?: number;
}

/** A set of entries mutually blocking each other via *hard* dependencies only; no valid order exists. */
export interface ArchiveCycle {
  readonly memberDumpIds: readonly string[];
}

/**
 * A hard dependency the planned order does not satisfy. Always empty for a
 * plan built from a consistent model — it is reported rather than silently
 * reordered, because the emission order is fixed by native compatibility, so
 * a violation means a model or planning bug that reordering would only hide.
 */
export interface UnsatisfiedDependency {
  readonly fromDumpId: string;
  readonly toDumpId: string;
}

export interface DumpArchiveInspection {
  readonly valid: boolean;
  /**
   * In emission order, with `sequenceNumber` set, when `valid` is `true`.
   * When `valid` is `false` the same entries are present in the same
   * deterministic order, but without `sequenceNumber`.
   */
  readonly entries: readonly ArchiveEntry[];
  readonly diagnostics: readonly SqliteDiagnostic[];
  /** Unresolved hard-dependency cycles. Always present; empty when `valid` is `true`. */
  readonly cycles: readonly ArchiveCycle[];
  /** Hard dependencies the emission order violates. Always present; empty when `valid` is `true`. */
  readonly unsatisfiedDependencies: readonly UnsatisfiedDependency[];
}

export type DumpMode = 'full' | 'schema-only' | 'data-only';
