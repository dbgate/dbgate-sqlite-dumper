import type { DumpWriter } from './types.js';

/**
 * In-memory {@link DumpWriter}, for tests and bounded previews. Not for
 * production dump sizes.
 *
 * Accumulates `Buffer`s rather than strings so a dump containing text that
 * is not valid UTF-8 round-trips byte-exactly; {@link toString} is a
 * convenience for the common all-text case and will replace invalid UTF-8
 * with U+FFFD, so use {@link toBuffer} when binary fidelity matters.
 */
export class BufferDumpWriter implements DumpWriter {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  get bytesWritten(): number {
    return this.bytes;
  }

  async write(chunk: string | Buffer, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.chunks.push(buffer);
    this.bytes += buffer.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  toString(): string {
    return this.toBuffer().toString('utf8');
  }
}
