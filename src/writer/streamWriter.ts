import type { Writable } from 'node:stream';
import type { DumpWriter } from './types.js';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

/**
 * Writes incrementally to a caller-owned `Writable`, honoring backpressure
 * (awaiting the stream's own `drain` when `write()` returns `false`) and
 * `AbortSignal` cancellation. Never calls `end()`/`close()` on the stream.
 *
 * `Buffer` chunks are written verbatim; `string` chunks are encoded as
 * UTF-8. See {@link DumpWriter} for why both shapes exist.
 */
export class StreamDumpWriter implements DumpWriter {
  private readonly stream: Writable;
  private bytes = 0;
  private writeError: Error | null = null;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  async write(chunk: string | Buffer, signal?: AbortSignal): Promise<void> {
    if (chunk.length === 0) {
      return;
    }
    if (this.writeError) {
      throw this.writeError;
    }
    throwIfAborted(signal);

    const isBuffer = Buffer.isBuffer(chunk);
    this.bytes += isBuffer ? chunk.length : Buffer.byteLength(chunk, 'utf8');

    const onWritten = (error?: Error | null): void => {
      if (error && !this.writeError) {
        this.writeError = error;
      }
    };

    // Backpressure is gated on `write()`'s return value, with the `drain`
    // listener attached in this same tick. Awaiting the completion callback
    // first would be wrong: Node emits `drain` *before* running the callbacks
    // of the writes that emptied the buffer, so subscribing afterwards waits
    // for an event that has already fired and never fires again.
    const canWriteMore = isBuffer
      ? this.stream.write(chunk, onWritten)
      : this.stream.write(chunk, 'utf8', onWritten);

    if (canWriteMore === false) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.stream.removeListener('drain', onDrain);
          this.stream.removeListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
        };
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        // A consumer that stopped reading never emits `drain`, so this await is
        // exactly where a cancelled dump would otherwise stall indefinitely.
        const onAbort = (): void => {
          cleanup();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    if (this.writeError) {
      throw this.writeError;
    }
    throwIfAborted(signal);
  }
}
