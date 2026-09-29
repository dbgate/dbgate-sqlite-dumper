/**
 * SQL literal rendering, ported from the functions SQLite's own shell uses
 * for `.dump` (`shell.c`), so a value renders exactly as `sqlite3` renders
 * it.
 *
 * SQLite string literals have exactly one escape: a `'` inside the literal
 * is doubled. There are **no** backslash escapes — `'\n'` is a backslash
 * followed by the letter `n` — which is why the shell cannot write a newline
 * as `\n` and instead wraps the literal in a `replace()` call (see
 * {@link renderEscapedStringLiteral}).
 *
 * Every function here works on a JavaScript string in which each code unit
 * may be either a real character or — for text that is not valid UTF-8 — one
 * byte (a `latin1` "byte string"). The characters the escaping reacts to
 * (`'`, `\n`, `\r`) are ASCII, and no byte of a multi-byte UTF-8 sequence can
 * be mistaken for one, so the same code is correct for both representations.
 */

/**
 * `unused_string()` from `shell.c`: returns the first of `a`, `b`, `(a0)`,
 * `(a1)`, ... that does not occur anywhere in `text`, to stand in for a
 * character inside a `replace()`d literal without colliding with the text.
 */
function unusedString(text: string, a: string, b: string): string {
  if (!text.includes(a)) {
    return a;
  }
  if (!text.includes(b)) {
    return b;
  }
  for (let counter = 0; ; counter++) {
    const candidate = `(${a}${counter})`;
    if (!text.includes(candidate)) {
      return candidate;
    }
  }
}

/**
 * `output_quoted_string()`: `'...'` with every `'` doubled, newlines and
 * carriage returns written raw. The shell uses this form under
 * `.dump --newlines`.
 */
export function renderQuotedStringLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * `output_quoted_escaped_string()`: the form the native `.dump` uses by
 * default.
 *
 * A literal containing neither `\n` nor `\r` is written as a plain quoted
 * string. Otherwise each newline is replaced by a placeholder that does not
 * otherwise occur in the text (`\n`, else `\012`, else `(\n0)`, ...) and the
 * literal is wrapped in `replace(..., '<placeholder>', char(10))` — and the
 * same for carriage returns with `char(13)` — so that the dump keeps one
 * statement per line and survives any tool that normalizes line endings.
 *
 * ```sql
 * replace('line one\nline two','\n',char(10))
 * replace(replace('a\r\nb','\r',char(13)),'\n',char(10))
 * ```
 */
export function renderEscapedStringLiteral(text: string): string {
  if (!text.includes('\n') && !text.includes('\r')) {
    return renderQuotedStringLiteral(text);
  }
  const hasNewline = text.includes('\n');
  const hasCarriageReturn = text.includes('\r');
  const newlinePlaceholder = hasNewline ? unusedString(text, '\\n', '\\012') : '';
  const carriageReturnPlaceholder = hasCarriageReturn ? unusedString(text, '\\r', '\\015') : '';

  let body = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index] as string;
    if (character === "'") {
      body += "''";
    } else if (character === '\n') {
      body += newlinePlaceholder;
    } else if (character === '\r') {
      body += carriageReturnPlaceholder;
    } else {
      body += character;
    }
  }

  // The opening `replace(`s are written newline-first, the closing
  // arguments carriage-return-first, exactly as the shell nests them.
  let literal = `${hasNewline ? 'replace(' : ''}${hasCarriageReturn ? 'replace(' : ''}'${body}'`;
  if (hasCarriageReturn) {
    literal += `,'${carriageReturnPlaceholder}',char(13))`;
  }
  if (hasNewline) {
    literal += `,'${newlinePlaceholder}',char(10))`;
  }
  return literal;
}

export type TextLiteralStyle = 'escaped' | 'raw-newlines';

/**
 * Renders a `TEXT` value as a SQL expression.
 *
 * SQLite text may contain `NUL` characters, which the native shell cannot
 * represent at all: it handles values as C strings, so everything after the
 * first `NUL` is silently dropped from the dump. This package keeps them,
 * joining the pieces with `||char(0)||` — an expression that evaluates to
 * the identical value in a database of any text encoding. Text with no
 * `NUL`, which is all text in practice, renders exactly as the shell renders
 * it.
 */
export function renderTextLiteral(text: string, style: TextLiteralStyle = 'escaped'): string {
  const render = style === 'escaped' ? renderEscapedStringLiteral : renderQuotedStringLiteral;
  if (!text.includes('\u0000')) {
    return render(text);
  }
  return text.split('\u0000').map(render).join('||char(0)||');
}

/**
 * `output_hex_blob()`: `X'...'` in lower-case hexadecimal, which is how the
 * native `.dump` writes every `BLOB`. An empty blob is `X''`.
 */
export function renderBlobLiteral(value: Uint8Array): string {
  return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}'`;
}

/**
 * Renders a string as a plain single-quoted SQL literal, for text this
 * package composes itself (table names in `INSERT INTO sqlite_schema ...`,
 * `sqlite_sequence` filters).
 */
export function quoteStringLiteral(text: string): string {
  return renderQuotedStringLiteral(text);
}
