import type { SqliteDatabase, SqliteTable } from '../model/database.js';
import type { SqliteDiagnostic } from '../model/diagnostics.js';
import {
  foldSqliteName,
  isIndexSelected,
  isTableDataExcluded,
  isTableSelected,
  isTriggerSelected,
  isViewSelected,
  normalizeDumpSelection,
} from '../selection/normalize.js';
import type { DumpObjectKinds, NormalizedDumpSelection } from '../selection/types.js';
import { createDumpId } from '../utils/hash.js';
import { createArchiveIdentity } from './identity.js';
import { assignDumpSection } from './sectionRules.js';
import type {
  ArchiveCycle,
  ArchiveDependency,
  ArchiveEntry,
  ArchiveObjectType,
  DumpArchiveInspection,
  DumpMode,
  UnsatisfiedDependency,
} from './types.js';

export interface InspectDumpArchiveOptions {
  readonly mode?: DumpMode;
  readonly selection?: NormalizedDumpSelection;
  readonly objectKinds?: DumpObjectKinds;
}

interface MutableEntry {
  dumpId: string;
  identity: string;
  objectType: ArchiveObjectType;
  name: string;
  parentName?: string;
  tableKind?: SqliteTable['kind'];
  systemRowFilter?: readonly string[];
  dependsOn: ArchiveDependency[];
}

/** `sqlite3_strglob("sqlite_stat?", name)` — the tables `ANALYZE` maintains. */
export function isStatisticsTableName(name: string): boolean {
  return /^sqlite_stat[\s\S]$/.test(name);
}

/** The native shell compares this name with `strcmp`, so case-sensitively. */
export const SEQUENCE_TABLE_NAME = 'sqlite_sequence';

/**
 * Converts a normalized {@link SqliteDatabase} into an ordered,
 * dependency-validated set of {@link ArchiveEntry} objects.
 *
 * Independent of SQL text, output streams and connections: it decides only
 * *what* is dumped and in *what order*. The order is the native `.dump`'s —
 * see {@link DumpSection} — which is creation order (`sqlite_schema` rowid)
 * rather than a topological sort. Creation order is itself a valid
 * dependency order for everything SQLite checks at `CREATE` time, and the
 * dump's `PRAGMA foreign_keys=OFF` covers the rest. Dependencies are still
 * recorded and then *verified* against that order, so a model or planning
 * bug surfaces as `valid: false` rather than as an unrestorable dump.
 */
export function inspectDumpArchive(
  database: SqliteDatabase,
  options: InspectDumpArchiveOptions = {},
): DumpArchiveInspection {
  const mode = options.mode ?? 'full';
  const selection = options.selection ?? normalizeDumpSelection();
  const kinds = options.objectKinds ?? {};
  const includeTables = kinds.includeTables ?? true;
  const includeViews = kinds.includeViews ?? true;
  const includeIndexes = kinds.includeIndexes ?? true;
  const includeTriggers = kinds.includeTriggers ?? true;
  const includeVirtualTables = kinds.includeVirtualTables ?? true;
  const includeSystemTables = kinds.includeSystemTables ?? true;

  const wantsSchema = mode !== 'data-only';
  const wantsData = mode !== 'schema-only';
  const schemaName = database.schemaName;

  const diagnostics: SqliteDiagnostic[] = [];
  const entries: MutableEntry[] = [];
  const byDumpId = new Map<string, MutableEntry>();

  function addEntry(
    objectType: ArchiveObjectType,
    name: string,
    extra: Partial<Pick<MutableEntry, 'parentName' | 'tableKind' | 'systemRowFilter'>> = {},
  ): string {
    const identity = createArchiveIdentity({
      objectType,
      schemaName,
      name,
      ...(extra.parentName === undefined ? {} : { parentName: extra.parentName }),
    });
    const dumpId = createDumpId(identity);
    if (byDumpId.has(dumpId)) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-archive-identity',
        message: `Duplicate archive identity for ${objectType} "${name}" in schema "${schemaName}"`,
        objectReference: { kind: 'table', schemaName, name },
      });
      return dumpId;
    }
    const entry: MutableEntry = { dumpId, identity, objectType, name, ...extra, dependsOn: [] };
    entries.push(entry);
    byDumpId.set(dumpId, entry);
    return dumpId;
  }

  function addDependency(
    fromDumpId: string,
    toDumpId: string | undefined,
    strength: ArchiveDependency['strength'],
  ): void {
    if (!toDumpId || fromDumpId === toDumpId) {
      return;
    }
    const entry = byDumpId.get(fromDumpId);
    if (!entry) {
      return;
    }
    const existing = entry.dependsOn.find(dependency => dependency.targetDumpId === toDumpId);
    if (existing) {
      if (strength === 'hard' && existing.strength === 'preference') {
        entry.dependsOn = entry.dependsOn.filter(
          dependency => dependency.targetDumpId !== toDumpId,
        );
        entry.dependsOn.push({ targetDumpId: toDumpId, strength: 'hard' });
      }
      return;
    }
    entry.dependsOn.push({ targetDumpId: toDumpId, strength });
  }

  const tablesByName = new Map(database.tables.map(table => [foldSqliteName(table.name), table]));

  const isUserTableSelected = (table: SqliteTable): boolean => {
    switch (table.kind) {
      case 'table':
        return includeTables && isTableSelected(table.name, selection);
      case 'virtual':
        return includeVirtualTables && isTableSelected(table.name, selection);
      case 'shadow': {
        // A shadow table belongs to its virtual table and follows it: it is
        // the virtual table's data. Selecting `ft` selects `ft_data`,
        // `ft_idx`, ... too, just as the native `.dump ft` does.
        const owner =
          table.ownerVirtualTable === undefined
            ? undefined
            : tablesByName.get(foldSqliteName(table.ownerVirtualTable));
        if (!owner) {
          return includeTables && isTableSelected(table.name, selection);
        }
        return includeVirtualTables && isTableSelected(owner.name, selection);
      }
      case 'system':
        return false;
    }
  };

  const selectedUserTables = database.tables.filter(isUserTableSelected);
  const selectedTableNames = selectedUserTables.map(table => table.name);

  const tableDumpId = new Map<string, string>();
  const tableDataDumpId = new Map<string, string>();

  // Pass 1 — tables, in creation order, with sqlite_sequence last. This is
  // `ORDER BY tbl_name='sqlite_sequence', rowid`, the native query.
  const orderedTables = [...database.tables].sort((a, b) => {
    const aLast = a.name === SEQUENCE_TABLE_NAME ? 1 : 0;
    const bLast = b.name === SEQUENCE_TABLE_NAME ? 1 : 0;
    return aLast - bLast || a.schemaRowid - b.schemaRowid;
  });

  for (const table of orderedTables) {
    const key = foldSqliteName(table.name);

    if (table.kind === 'system') {
      const isSequence = table.name === SEQUENCE_TABLE_NAME;
      if (!includeSystemTables || (!isSequence && !isStatisticsTableName(table.name))) {
        // Any other `sqlite_` table is internal and never dumped natively either.
        continue;
      }
      const systemRowFilter = selection.isPartial ? selectedTableNames : undefined;
      if (systemRowFilter && systemRowFilter.length === 0) {
        continue;
      }
      const extra = {
        tableKind: table.kind,
        ...(systemRowFilter === undefined ? {} : { systemRowFilter }),
      };
      let structureId: string | undefined;
      if (wantsSchema && wantsData) {
        // `DELETE FROM sqlite_sequence;` / `ANALYZE sqlite_schema;` only make
        // sense together with the rows that follow them; a schema-only dump
        // carries neither counters nor statistics.
        structureId = addEntry('table', table.name, extra);
        tableDumpId.set(key, structureId);
      }
      if (wantsData) {
        const dataId = addEntry('tableData', table.name, { ...extra, parentName: table.name });
        tableDataDumpId.set(key, dataId);
        addDependency(dataId, structureId, 'hard');
        if (!wantsSchema) {
          diagnostics.push({
            severity: 'warning',
            code: 'data-only-system-table',
            message: isSequence
              ? 'A data-only dump inserts the sqlite_sequence rows without first clearing the table, exactly as the native .dump --data-only does; restoring it into a database whose tables already advanced their AUTOINCREMENT counters leaves duplicate counter rows. Set objectKinds.includeSystemTables to false to leave the counters to the inserts themselves.'
              : `A data-only dump inserts into ${table.name} without creating it first, exactly as the native .dump --data-only does; restoring it into a database that has never been analyzed fails with "no such table". Set objectKinds.includeSystemTables to false to leave statistics out.`,
            objectReference: { kind: 'table', schemaName, name: table.name },
          });
        }
      }
      continue;
    }

    if (!isUserTableSelected(table)) {
      continue;
    }

    if (table.kind === 'virtual') {
      if (wantsSchema) {
        tableDumpId.set(key, addEntry('virtualTable', table.name, { tableKind: table.kind }));
      } else if (!isTableDataExcluded(table.name, selection)) {
        // A native quirk reproduced on purpose: `.dump --data-only` checks
        // for data-only *before* it checks for a virtual table, so it selects
        // the virtual table's rows through the module — in addition to the
        // shadow tables' rows, which hold the same data.
        tableDataDumpId.set(
          key,
          addEntry('tableData', table.name, { tableKind: table.kind, parentName: table.name }),
        );
        diagnostics.push({
          severity: 'warning',
          code: 'data-only-virtual-table',
          message: `A data-only dump carries the rows of virtual table "${table.name}" twice — through the table itself and in its shadow tables — exactly as the native .dump --data-only does. Restoring it into a database where "${table.name}" already exists conflicts with that table's own shadow rows; exclude the shadow tables through selection.dataExcludedTables to load the rows through the virtual table only.`,
          objectReference: { kind: 'virtualTable', schemaName, name: table.name },
        });
      }
      continue;
    }

    if (table.kind === 'shadow' && !wantsData && table.ownerVirtualTable !== undefined) {
      // A schema-only dump creates each virtual table through its module,
      // whose constructor creates the shadow tables itself (see the
      // renderer); defensive mode would refuse them as statements anyway.
      continue;
    }

    let structureId: string | undefined;
    if (wantsSchema) {
      structureId = addEntry('table', table.name, { tableKind: table.kind });
      tableDumpId.set(key, structureId);
      if (table.kind === 'shadow' && table.ownerVirtualTable !== undefined) {
        addDependency(
          structureId,
          tableDumpId.get(foldSqliteName(table.ownerVirtualTable)),
          'preference',
        );
      }
    }
    if (wantsData && !isTableDataExcluded(table.name, selection)) {
      const dataId = addEntry('tableData', table.name, {
        tableKind: table.kind,
        parentName: table.name,
      });
      tableDataDumpId.set(key, dataId);
      addDependency(dataId, structureId, 'hard');
    }
  }

  // Foreign keys are recorded as *preferences* only: the dump's
  // `PRAGMA foreign_keys=OFF` makes any table order restorable, which is
  // precisely what makes circular foreign keys work.
  for (const foreignKey of database.foreignKeys) {
    const from = tableDumpId.get(foldSqliteName(foreignKey.tableName));
    const to = tableDumpId.get(foldSqliteName(foreignKey.referencedTableName));
    if (from && to) {
      addDependency(from, to, 'preference');
    }
  }

  // Pass 2 — indexes, triggers and views, in creation order.
  if (wantsSchema) {
    const selectedViewNames = new Set(
      includeViews
        ? database.views
            .filter(view => isViewSelected(view.name, selection))
            .map(view => foldSqliteName(view.name))
        : [],
    );
    const viewDumpId = new Map<string, string>();

    type SchemaObject =
      | { kind: 'index'; schemaRowid: number; index: SqliteDatabase['indexes'][number] }
      | { kind: 'trigger'; schemaRowid: number; trigger: SqliteDatabase['triggers'][number] }
      | { kind: 'view'; schemaRowid: number; view: SqliteDatabase['views'][number] };

    const objects: SchemaObject[] = [
      ...database.indexes.map(index => ({
        kind: 'index' as const,
        schemaRowid: index.schemaRowid,
        index,
      })),
      ...database.triggers.map(trigger => ({
        kind: 'trigger' as const,
        schemaRowid: trigger.schemaRowid,
        trigger,
      })),
      ...database.views.map(view => ({
        kind: 'view' as const,
        schemaRowid: view.schemaRowid,
        view,
      })),
    ].sort((a, b) => a.schemaRowid - b.schemaRowid);

    for (const object of objects) {
      switch (object.kind) {
        case 'index': {
          const { index } = object;
          // An automatic index (UNIQUE / PRIMARY KEY) has no DDL of its own;
          // the table's CREATE TABLE recreates it.
          if (index.sql === null || !includeIndexes || !isIndexSelected(index.name, selection)) {
            continue;
          }
          const tableId = tableDumpId.get(foldSqliteName(index.tableName));
          if (!tableId) {
            continue;
          }
          const dumpId = addEntry('index', index.name, { parentName: index.tableName });
          addDependency(dumpId, tableId, 'hard');
          // Building an index after the rows are loaded is faster, but not required.
          addDependency(dumpId, tableDataDumpId.get(foldSqliteName(index.tableName)), 'preference');
          break;
        }
        case 'trigger': {
          const { trigger } = object;
          if (!includeTriggers || !isTriggerSelected(trigger.name, selection)) {
            continue;
          }
          const parentKey = foldSqliteName(trigger.tableName);
          const parentId = tableDumpId.get(parentKey) ?? viewDumpId.get(parentKey);
          if (!parentId) {
            // Dropped rather than orphaned: a trigger cannot be created on a
            // table the dump will not create.
            diagnostics.push({
              severity: 'info',
              code: 'trigger-table-not-selected',
              message: `Trigger "${trigger.name}" is not dumped because its table "${trigger.tableName}" is not part of the dump`,
              objectReference: {
                kind: 'trigger',
                schemaName,
                name: trigger.name,
                parentName: trigger.tableName,
              },
            });
            continue;
          }
          const dumpId = addEntry('trigger', trigger.name, { parentName: trigger.tableName });
          addDependency(dumpId, parentId, 'hard');
          // Hard, not cosmetic: a trigger created before its table's rows are
          // loaded fires once per inserted row, fabricating side effects the
          // source database never had.
          addDependency(dumpId, tableDataDumpId.get(parentKey), 'hard');
          break;
        }
        case 'view': {
          const { view } = object;
          const key = foldSqliteName(view.name);
          if (!selectedViewNames.has(key)) {
            continue;
          }
          const dumpId = addEntry('view', view.name);
          viewDumpId.set(key, dumpId);
          // SQLite resolves a view's body when the view is used, not when it
          // is created, so tables and other views are only a preference.
          for (const tableId of tableDumpId.values()) {
            addDependency(dumpId, tableId, 'preference');
          }
          break;
        }
      }
    }
  }

  const { cycles, unsatisfiedDependencies } = validateOrder(entries);
  const valid =
    cycles.length === 0 &&
    unsatisfiedDependencies.length === 0 &&
    !diagnostics.some(diagnostic => diagnostic.severity === 'error');

  for (const cycle of cycles) {
    diagnostics.push({
      severity: 'error',
      code: 'archive-dependency-cycle',
      message: `Hard dependency cycle between archive entries: ${cycle.memberDumpIds.join(', ')}`,
    });
  }
  for (const violation of unsatisfiedDependencies) {
    diagnostics.push({
      severity: 'error',
      code: 'archive-order-violation',
      message: `Archive entry ${violation.fromDumpId} is emitted before its hard dependency ${violation.toDumpId}`,
    });
  }

  return {
    valid,
    entries: entries.map((entry, index) =>
      toArchiveEntry(entry, schemaName, valid ? index : undefined),
    ),
    diagnostics,
    cycles,
    unsatisfiedDependencies,
  };
}

function toArchiveEntry(
  entry: MutableEntry,
  schemaName: string,
  sequenceNumber: number | undefined,
): ArchiveEntry {
  return {
    dumpId: entry.dumpId,
    identity: entry.identity,
    objectType: entry.objectType,
    section: assignDumpSection(entry.objectType),
    schemaName,
    name: entry.name,
    ...(entry.parentName === undefined ? {} : { parentName: entry.parentName }),
    ...(entry.tableKind === undefined ? {} : { tableKind: entry.tableKind }),
    ...(entry.systemRowFilter === undefined ? {} : { systemRowFilter: entry.systemRowFilter }),
    dependsOn: entry.dependsOn,
    ...(sequenceNumber === undefined ? {} : { sequenceNumber }),
  };
}

/**
 * Verifies the fixed emission order against the recorded hard dependencies,
 * and separately reports any hard cycle.
 *
 * This is a *check*, not a sort. The order is dictated by native
 * compatibility, so if a hard dependency points backwards the right answer
 * is to surface it rather than to reorder and hide the cause.
 */
function validateOrder(ordered: readonly MutableEntry[]): {
  cycles: ArchiveCycle[];
  unsatisfiedDependencies: UnsatisfiedDependency[];
} {
  const positionByDumpId = new Map(ordered.map((entry, index) => [entry.dumpId, index]));
  const unsatisfiedDependencies: UnsatisfiedDependency[] = [];

  for (const entry of ordered) {
    const fromPosition = positionByDumpId.get(entry.dumpId) as number;
    for (const dependency of entry.dependsOn) {
      if (dependency.strength !== 'hard') {
        continue;
      }
      const toPosition = positionByDumpId.get(dependency.targetDumpId);
      if (toPosition !== undefined && toPosition > fromPosition) {
        unsatisfiedDependencies.push({
          fromDumpId: entry.dumpId,
          toDumpId: dependency.targetDumpId,
        });
      }
    }
  }

  return { cycles: findHardCycles(ordered), unsatisfiedDependencies };
}

function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tarjan's strongly-connected components over hard edges only; any component of size > 1 is a cycle. */
function findHardCycles(entries: readonly MutableEntry[]): ArchiveCycle[] {
  const indexByDumpId = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const byDumpId = new Map(entries.map(entry => [entry.dumpId, entry]));
  const cycles: ArchiveCycle[] = [];
  let nextIndex = 0;

  const strongConnect = (dumpId: string): void => {
    indexByDumpId.set(dumpId, nextIndex);
    lowLink.set(dumpId, nextIndex);
    nextIndex++;
    stack.push(dumpId);
    onStack.add(dumpId);

    for (const dependency of byDumpId.get(dumpId)?.dependsOn ?? []) {
      if (dependency.strength !== 'hard' || !byDumpId.has(dependency.targetDumpId)) {
        continue;
      }
      const target = dependency.targetDumpId;
      if (!indexByDumpId.has(target)) {
        strongConnect(target);
        lowLink.set(dumpId, Math.min(lowLink.get(dumpId) as number, lowLink.get(target) as number));
      } else if (onStack.has(target)) {
        lowLink.set(
          dumpId,
          Math.min(lowLink.get(dumpId) as number, indexByDumpId.get(target) as number),
        );
      }
    }

    if (lowLink.get(dumpId) === indexByDumpId.get(dumpId)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
        if (member === dumpId) {
          break;
        }
      }
      if (component.length > 1) {
        cycles.push({ memberDumpIds: component.sort(byCodepoint) });
      }
    }
  };

  for (const entry of entries) {
    if (!indexByDumpId.has(entry.dumpId)) {
      strongConnect(entry.dumpId);
    }
  }
  return cycles;
}
