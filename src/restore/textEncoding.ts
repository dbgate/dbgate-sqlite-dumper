import { isUtf8 } from 'node:buffer';
import { InvalidTextEncodingError } from './errors.js';

/**
 * Converts a statement's bytes into text SQLite can be handed, preserving
 * every byte.
 *
 * SQLite does not validate the encoding of the text it stores, and the
 * native `.dump` writes a `TEXT` value's bytes exactly as stored — so a value
 * holding bytes that are not valid UTF-8 appears in the dump as a string
 * literal that is not valid UTF-8 either. The `sqlite3` shell passes those
 * bytes straight to `sqlite3_prepare()`, which stores them unchanged. A
 * JavaScript driver cannot: its statement text is a JavaScript string, and
 * every invalid sequence would become U+FFFD on the way in.
 *
 * So a literal that is not valid UTF-8 is rewritten into an expression that
 * yields the identical bytes as text, written entirely in ASCII:
 *
 * ```sql
 * 'caf\xE9'   →   (CAST(X'636166e9' AS TEXT))
 * ```
 *
 * In a UTF-8 database (every database the native `.dump` can reproduce
 * exactly) that is byte-for-byte the value the shell would have stored.
 * Invalid bytes inside a comment are dropped along with the comment; invalid
 * bytes anywhere else — in an identifier or keyword position — cannot be
 * represented and raise {@link InvalidTextEncodingError}.
 *
 * `statement` is a byte string: one code unit per byte, as `latin1` decodes
 * it. Returns the statement as ordinary text, plus how many literals were
 * rewritten.
 */
export function decodeStatementBytes(
  statement: string,
  startLine: number,
): { sql: string; literalsRewritten: number } {
  const bytes = Buffer.from(statement, 'latin1');
  if (isUtf8(bytes)) {
    return { sql: bytes.toString('utf8'), literalsRewritten: 0 };
  }

  let output = '';
  let literalsRewritten = 0;
  let line = startLine;
  let index = 0;
  const length = statement.length;

  const appendPlain = (segment: string): void => {
    const segmentBytes = Buffer.from(segment, 'latin1');
    if (!isUtf8(segmentBytes)) {
      throw new InvalidTextEncodingError(
        'The statement contains bytes that are not valid UTF-8 outside any string literal, so it cannot be executed as text without corrupting them',
        line,
      );
    }
    output += segmentBytes.toString('utf8');
  };

  let plainStart = 0;
  while (index < length) {
    const character = statement[index] as string;
    if (character === '\n') {
      line++;
      index++;
      continue;
    }
    if (character === "'") {
      appendPlain(statement.slice(plainStart, index));
      let end = index + 1;
      for (;;) {
        const close = statement.indexOf("'", end);
        if (close === -1) {
          end = length;
          break;
        }
        if (statement[close + 1] === "'") {
          end = close + 2;
          continue;
        }
        end = close + 1;
        break;
      }
      const literal = statement.slice(index, end);
      const literalBytes = Buffer.from(literal, 'latin1');
      if (isUtf8(literalBytes)) {
        output += literalBytes.toString('utf8');
      } else {
        const value = literal.slice(1, literal.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
        output += `(CAST(X'${Buffer.from(value, 'latin1').toString('hex')}' AS TEXT))`;
        literalsRewritten++;
      }
      for (let scan = index; scan < end; scan++) {
        if (statement[scan] === '\n') line++;
      }
      index = end;
      plainStart = end;
      continue;
    }
    if (character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character;
      let end = statement.indexOf(close, index + 1);
      end = end === -1 ? length : end + 1;
      index = end;
      continue;
    }
    if (character === '-' && statement[index + 1] === '-') {
      appendPlain(statement.slice(plainStart, index));
      const end = statement.indexOf('\n', index);
      const commentEnd = end === -1 ? length : end;
      const comment = statement.slice(index, commentEnd);
      output += isUtf8(Buffer.from(comment, 'latin1'))
        ? Buffer.from(comment, 'latin1').toString('utf8')
        : '--';
      index = commentEnd;
      plainStart = commentEnd;
      continue;
    }
    if (character === '/' && statement[index + 1] === '*') {
      appendPlain(statement.slice(plainStart, index));
      const end = statement.indexOf('*/', index + 2);
      const commentEnd = end === -1 ? length : end + 2;
      const comment = statement.slice(index, commentEnd);
      const commentBytes = Buffer.from(comment, 'latin1');
      output += isUtf8(commentBytes) ? commentBytes.toString('utf8') : ' ';
      for (let scan = index; scan < commentEnd; scan++) {
        if (statement[scan] === '\n') line++;
      }
      index = commentEnd;
      plainStart = commentEnd;
      continue;
    }
    index++;
  }
  appendPlain(statement.slice(plainStart));
  return { sql: output, literalsRewritten };
}
