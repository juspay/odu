import { describe, expect, it } from "bun:test";
import { writeAll } from "./sink";

describe("writeAll", () => {
  it("loops a sink that accepts half of each chunk", async () => {
    const written: number[] = [];
    const sink = {
      write(chunk: Uint8Array): number {
        const take = Math.max(1, Math.floor(chunk.length / 2));
        written.push(take);
        return take;
      },
    };
    const chunk = new Uint8Array(10).fill(7);
    await writeAll(sink, chunk, "a part");
    // 5, 2, 1, 1, 1 — and never more than the
    // bytes the chunk had left.
    expect(written).toEqual([5, 2, 1, 1, 1]);
  });

  it("refuses a non-number result instead of believing the chunk was written", async () => {
    await expect(
      writeAll({ write: (() => undefined) as never }, new Uint8Array(4), "a part"),
    ).rejects.toThrow(/not a number/);
  });
});
