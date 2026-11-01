/** A byte sink that reports how many bytes it accepted, like Bun's FileSink. */
export interface ByteSink {
  write(chunk: Uint8Array): number | Promise<number>;
}

/**
 * WRITE THE WHOLE CHUNK. A sink may accept a prefix (Bun's FileSink returns the
 * count it took, and a large or slow write can be short). Ignoring that count
 * truncates a NAR part or an object with no error, and the loss only surfaces
 * as a NarHash mismatch much later. A non-number result is a broken sink, not
 * "wrote everything".
 */
export async function writeAll(sink: ByteSink, chunk: Uint8Array, what: string): Promise<void> {
  for (let at = 0; at < chunk.length; ) {
    const wrote = await sink.write(chunk.subarray(at));
    if (typeof wrote !== "number" || wrote <= 0) {
      throw new Error(`writing ${what} accepted ${String(wrote)} bytes, not a number > 0`);
    }
    at += wrote;
  }
}
