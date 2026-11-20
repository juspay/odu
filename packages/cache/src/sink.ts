export interface ByteSink {
  write(chunk: Uint8Array): number | Promise<number>;
}

/**
 * Bun's FileSink returns the count it took, and a large or slow write can be
 * short.
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
