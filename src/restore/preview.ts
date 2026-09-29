import { redactSecrets } from '../security/redact.js';

/**
 * Truncates SQL for inclusion in an error message or a progress event.
 *
 * Never a full statement — a single `INSERT` can carry a megabyte of blob —
 * and never a literal encryption key.
 */
export function safeSqlPreview(sql: string, maximumLength = 200): string {
  const normalized = redactSecrets(sql).trim().replace(/\s+/g, ' ');
  if (normalized.length <= maximumLength) {
    return normalized;
  }
  let cut = normalized.slice(0, maximumLength);
  // Never split a surrogate pair: an emoji straddling the cut would leave a
  // lone high surrogate, making the preview ill-formed UTF-16 —
  // `JSON.stringify` would emit an unpaired `\ud83d`, and writing it as UTF-8
  // would substitute U+FFFD.
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** The warning line the native `.dump` writes first when the dump contains virtual tables. */
export const DEFENSIVE_WARNING_COMMENT =
  '/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */';

/**
 * Heuristically detects whether `sample` looks like a SQLite dump — whether
 * produced by the native `.dump` command or by this package, which write the
 * same thing.
 *
 * A full dump opens with `PRAGMA foreign_keys=OFF;` and
 * `BEGIN TRANSACTION;`, optionally preceded by the defensive-mode warning
 * comment; that opening is what is recognized. A `--data-only` dump has no
 * such preamble and is indistinguishable from any other script of
 * `INSERT`s, so it is only recognized when it carries the warning comment.
 *
 * Only the first few kilobytes need to be supplied; the check never reads
 * beyond what it is given, so a caller can pass the head of a large file.
 */
export function isSqliteDump(sample: string | Uint8Array): boolean {
  const text = typeof sample === 'string' ? sample : Buffer.from(sample).toString('utf8');
  const head = text
    .slice(0, 8192)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  let rest = head.trimStart();
  if (rest.startsWith(DEFENSIVE_WARNING_COMMENT)) {
    rest = rest.slice(DEFENSIVE_WARNING_COMMENT.length).trimStart();
    if (rest === '' || /^INSERT INTO /.test(rest) || rest.startsWith('PRAGMA foreign_keys=OFF;')) {
      return true;
    }
  }
  return /^PRAGMA foreign_keys=OFF;\s*\nBEGIN TRANSACTION;/.test(rest);
}
