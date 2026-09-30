import type { SqliteDiagnostic } from '../model/diagnostics.js';

/**
 * Database state this package deliberately does not dump.
 *
 * Every one of these is either a property of the database *file* rather
 * than of its contents, or lives outside SQL entirely. Rather than silently
 * omitting them — which would make a dump look complete when it is not —
 * each is described here so `unsupportedFeatureDiagnostics()` can report
 * them, and `docs/known-limitations.md` can list them with the same wording.
 */
export const UNSUPPORTED_FEATURES: readonly {
  readonly code: string;
  readonly summary: string;
  readonly detail: string;
}[] = [
  {
    code: 'file-settings-not-dumped',
    summary: 'file-level settings (page_size, auto_vacuum, journal_mode, encoding)',
    detail:
      'These describe how the database file is laid out, not what it contains, and most can only be chosen before the first table is created. The native .dump does not carry them either. Set them on the target database before restoring if they matter; the dump restores correctly under any of them.',
  },
  {
    code: 'temp-and-attached-schemas-not-dumped',
    summary: 'the temp schema and attached databases',
    detail:
      'A dump covers one schema — main by default. Temporary objects belong to one connection, and each attached database is a separate file; dump an attached database on its own by passing its name as schemaName.',
  },
  {
    code: 'application-functions-not-dumped',
    summary: 'application-defined functions, collations and loadable extensions',
    detail:
      'User-defined SQL functions, collating sequences and virtual table modules are registered by the application (or loaded from a shared library), not stored in the database. The schema that uses them is dumped verbatim; the restoring application must register them first, or objects using them cannot be created or queried.',
  },
  {
    code: 'encryption-not-dumped',
    summary: 'encryption keys',
    detail:
      'An encrypted database (SQLCipher, SEE) is dumped as plain SQL once it is opened with its key. The dump itself is not encrypted, and no key is ever written into it.',
  },
];

/** The {@link UNSUPPORTED_FEATURES} as `info` diagnostics, for a UI that lists what a dump does not include. */
export function unsupportedFeatureDiagnostics(): SqliteDiagnostic[] {
  return UNSUPPORTED_FEATURES.map(feature => ({
    severity: 'info',
    code: feature.code,
    message: `Not dumped: ${feature.summary}. ${feature.detail}`,
  }));
}
