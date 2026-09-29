import type { Readable } from 'node:stream';

/**
 * Anything {@link restoreSqlDump}/{@link streamSqlStatements} can read a dump
 * from.
 *
 * `Buffer`/`Uint8Array` is accepted alongside `string` for a reason that
 * matters: the native `.dump` writes a `TEXT` value's stored bytes verbatim,
 * so a database holding text that is not valid UTF-8 produces a dump that is
 * not valid UTF-8 either. Forcing a caller to `.toString()` such a dump
 * before restoring it would replace every invalid sequence with U+FFFD and
 * silently corrupt the data, so the bytes are taken directly instead.
 *
 * `Readable` streams are consumed through their own async-iterable protocol
 * (`for await`), so `fs.createReadStream(path)` needs no adapter.
 */
export type SqlDumpSource =
  string | Buffer | Uint8Array | Readable | AsyncIterable<string | Buffer | Uint8Array>;
