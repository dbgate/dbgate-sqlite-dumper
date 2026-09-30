/**
 * Redacts the value side of the credential-carrying statements that exist
 * in the SQLite world, so a failing statement never echoes an actual secret
 * into a preview, a diagnostic, or an error message.
 *
 * Plain SQLite has no credentials, but the encryption extensions most
 * applications use — SQLCipher and the SQLite Encryption Extension — take
 * their key through SQL: `PRAGMA key = '...'`, `PRAGMA rekey`,
 * `PRAGMA hexkey`/`hexrekey`, `PRAGMA textkey`, and `ATTACH ... KEY '...'`.
 * A script that opens an encrypted database starts with exactly such a
 * statement.
 *
 * Deliberately narrow and pattern-based rather than a parser: it covers the
 * specific syntax those extensions use, not arbitrary "looks sensitive" text.
 */
const SQL_SECRET_PATTERNS: readonly RegExp[] = [
  // PRAGMA [schema.]key = 'secret' / PRAGMA key('secret'), and the rekey/hexkey/textkey forms
  /(\bPRAGMA\s+(?:[\w"`[\]]+\s*\.\s*)?(?:hex|text)?(?:re)?key\s*(?:=\s*|\(\s*))(?:'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s;)]+)/gi,
  // ATTACH DATABASE 'file' AS name KEY 'secret'
  /(\bATTACH\b[\s\S]*?\bKEY\s+)(?:'(?:[^']|'')*'|"(?:[^"]|"")*"|X'[0-9A-Fa-f]*'|[^\s;)]+)/gi,
];

export function redactSecrets(text: string): string {
  return SQL_SECRET_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (_match, prefix: string) => `${prefix}'***REDACTED***'`),
    text,
  );
}
