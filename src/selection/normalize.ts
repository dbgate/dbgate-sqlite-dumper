import { toAsciiLowerCase } from '../security/identifiers.js';
import type { DumpSelection, NormalizedDumpSelection } from './types.js';

/** Folds a name the way SQLite compares identifiers: ASCII letters only. */
export function foldSqliteName(name: string): string {
  return toAsciiLowerCase(name);
}

function toSet(names: readonly string[] | undefined): ReadonlySet<string> | undefined {
  return names ? new Set(names.map(foldSqliteName)) : undefined;
}

export function normalizeDumpSelection(selection?: DumpSelection): NormalizedDumpSelection {
  const normalized = {
    tables: toSet(selection?.tables),
    excludeTables: new Set((selection?.excludeTables ?? []).map(foldSqliteName)),
    views: toSet(selection?.views),
    excludeViews: new Set((selection?.excludeViews ?? []).map(foldSqliteName)),
    triggers: toSet(selection?.triggers),
    excludeTriggers: new Set((selection?.excludeTriggers ?? []).map(foldSqliteName)),
    excludeIndexes: new Set((selection?.excludeIndexes ?? []).map(foldSqliteName)),
    dataExcludedTables: new Set((selection?.dataExcludedTables ?? []).map(foldSqliteName)),
  };
  const isPartial =
    normalized.tables !== undefined ||
    normalized.views !== undefined ||
    normalized.triggers !== undefined ||
    normalized.excludeTables.size > 0 ||
    normalized.excludeViews.size > 0 ||
    normalized.excludeTriggers.size > 0 ||
    normalized.excludeIndexes.size > 0;
  return { ...normalized, isPartial };
}

function isSelected(
  name: string,
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string>,
): boolean {
  const key = foldSqliteName(name);
  if (exclude.has(key)) {
    return false;
  }
  return include ? include.has(key) : true;
}

export function isTableSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return isSelected(name, selection.tables, selection.excludeTables);
}

export function isViewSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return isSelected(name, selection.views, selection.excludeViews);
}

export function isTriggerSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return isSelected(name, selection.triggers, selection.excludeTriggers);
}

export function isIndexSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return !selection.excludeIndexes.has(foldSqliteName(name));
}

/** True when the table's *rows* should be skipped while its structure is still dumped. */
export function isTableDataExcluded(name: string, selection: NormalizedDumpSelection): boolean {
  return selection.dataExcludedTables.has(foldSqliteName(name));
}
