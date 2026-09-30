/**
 * Incremental output sink for rendered dump text.
 *
 * `write` accepts a `Buffer` as well as a `string` because a SQLite dump is
 * not necessarily valid UTF-8. SQLite does not validate the encoding of the
 * text it stores, and the native `.dump` command writes a `TEXT` value's
 * bytes out exactly as stored — so a value holding bytes that are not valid
 * UTF-8 produces a dump line that is not valid UTF-8 either. Routing those
 * bytes through a JavaScript string would replace every invalid sequence
 * with U+FFFD and silently corrupt the data, so that path hands the writer a
 * `Buffer` instead.
 *
 * Implementations never close the underlying resource; callers own its
 * lifecycle.
 */
export interface DumpWriter {
  /** Writes one chunk, resolving once it is safe to write again (respects backpressure). */
  write(chunk: string | Buffer, signal?: AbortSignal): Promise<void>;
  /** Total bytes written so far. */
  readonly bytesWritten: number;
}
