import type { ArchiveObjectType, DumpSection } from './types.js';

const SECTION_BY_OBJECT_TYPE: Record<ArchiveObjectType, DumpSection> = {
  table: 'tables',
  tableData: 'tables',
  virtualTable: 'tables',
  index: 'schema',
  trigger: 'schema',
  view: 'schema',
};

const SECTION_PRIORITY: Record<DumpSection, number> = {
  tables: 0,
  schema: 1,
};

/**
 * Ordering *within* one table's group in the `tables` section: structure,
 * then rows — the native `.dump` writes each table's `INSERT`s directly
 * after its `CREATE TABLE`.
 */
const TABLE_GROUP_PRIORITY: Record<ArchiveObjectType, number> = {
  table: 0,
  virtualTable: 0,
  tableData: 1,
  index: 0,
  trigger: 0,
  view: 0,
};

export function assignDumpSection(objectType: ArchiveObjectType): DumpSection {
  return SECTION_BY_OBJECT_TYPE[objectType];
}

export function dumpSectionPriority(section: DumpSection): number {
  return SECTION_PRIORITY[section];
}

export function tableGroupPriority(objectType: ArchiveObjectType): number {
  return TABLE_GROUP_PRIORITY[objectType];
}
