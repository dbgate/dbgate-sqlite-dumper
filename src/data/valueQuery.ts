import type { SqliteColumnValue, SqliteRow } from '../connection/types.js';
import { isUtf8 } from 'node:buffer';
import { renderBlobLiteral, renderTextLiteral } from '../security/literals.js';
import type { TextLiteralStyle } from '../security/literals.js';

/**
 * The SQL expression that renders a `REAL` exactly as the native `.dump`
 * renders it, evaluated by SQLite itself. `shell.c` does this:
 *
 * ```c
 * if( ur==0x7ff0000000000000LL )       oputz("9.0e+999");
 * else if( ur==0xfff0000000000000LL )  oputz("-9.0e+999");
 * else {
 *   sqlite3_int64 ir = (sqlite3_int64)r;
 *   if( r==(double)ir ) sqlite3_snprintf(50,z,"%lld.0", ir);
 *   else                sqlite3_snprintf(50,z,"%!.20g", r);
 * }
 * ```
 *
 * Doing it in SQL rather than in JavaScript is the point. The digits
 * `%!.20g` produces come from SQLite's own floating-point formatter, which
 * no JavaScript routine reproduces (and which changed between SQLite
 * releases); asking the database to format the value is the only way to
 * write the same digits the shell of the same SQLite version would. It also
 * means the value never passes through the driver as a JavaScript number.
 *
 * `9e999` is how SQLite spells infinity in SQL: it overflows to `Inf` on
 * parse, which is also why the dump writes it that way.
 */
function realLiteralExpression(column: string): string {
  return (
    `CASE WHEN ${column} = 9e999 THEN '9.0e+999' ` +
    `WHEN ${column} = -9e999 THEN '-9.0e+999' ` +
    `WHEN ${column} >= -9223372036854775808.0 AND ${column} < 9223372036854775808.0 AND ${column} = CAST(${column} AS INTEGER) ` +
    `THEN CAST(CAST(${column} AS INTEGER) AS TEXT) || '.0' ` +
    `ELSE printf('%!.20g', ${column}) END`
  );
}

/**
 * The select-list for one column: its storage class, and a value shaped so
 * that only exact representations cross the driver boundary.
 *
 * - `INTEGER` → decimal text, so a 64-bit value is exact whatever the
 *   driver would have done with it;
 * - `REAL` → the literal text, see {@link realLiteralExpression};
 * - `TEXT` → the stored bytes (`CAST(... AS BLOB)`), so text that is not
 *   valid UTF-8 is not "repaired" by the driver's decoder on the way out.
 *   In a UTF-16 database those bytes would be UTF-16, so there the value is
 *   read as text instead and the driver's (lossless, for valid UTF-16)
 *   conversion is used;
 * - `BLOB` → the bytes; `NULL` → `NULL`.
 */
export function columnValueSelect(column: string, index: number, utf8Database: boolean): string {
  const textBranch = utf8Database ? `CAST(${column} AS BLOB)` : column;
  return (
    `typeof(${column}) AS "t${index}", ` +
    `CASE typeof(${column}) ` +
    `WHEN 'integer' THEN CAST(${column} AS TEXT) ` +
    `WHEN 'real' THEN ${realLiteralExpression(column)} ` +
    `WHEN 'text' THEN ${textBranch} ` +
    `ELSE ${column} END AS "v${index}"`
  );
}

function asBytes(value: SqliteColumnValue): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(String(value), 'utf8');
}

/**
 * Renders column `index` of a row produced by {@link columnValueSelect} as
 * the SQL literal the native `.dump` writes for it.
 *
 * Returns a `Buffer` only for text that is not valid UTF-8: the shell writes
 * such bytes out raw, and so does this package, so the dump reproduces the
 * stored value exactly (see `DumpWriter` for why that cannot go through a
 * string).
 */
export function renderColumnLiteral(
  row: SqliteRow,
  index: number,
  textStyle: TextLiteralStyle,
): string | Buffer {
  const storageClass = row[`t${index}`];
  const value = row[`v${index}`] ?? null;
  switch (storageClass) {
    case 'integer':
    case 'real':
      return String(value);
    case 'text': {
      if (typeof value === 'string') {
        return renderTextLiteral(value, textStyle);
      }
      const bytes = asBytes(value);
      if (isUtf8(bytes)) {
        return renderTextLiteral(bytes.toString('utf8'), textStyle);
      }
      // Escape as a byte string (one code unit per byte) and hand the exact
      // bytes back; every character the escaping reacts to is ASCII.
      return Buffer.from(renderTextLiteral(bytes.toString('latin1'), textStyle), 'latin1');
    }
    case 'blob':
      return renderBlobLiteral(asBytes(value));
    default:
      return 'NULL';
  }
}
