/**
 * THE `ObjectStore` CONTRACT — run against every implementation.
 *
 * The disk store runs it now; the S3 store in the next phase runs the SAME
 * suite, which is the point: a route or a GC pass must not learn a second
 * dialect of "put"/"get" when the bytes move off the pod's disk.
 *
 * A factory owns its own temporary backing and answers the store plus a dispose
 * that removes it. The suite never names a path, a bucket or a filesystem.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { base32 } from "../src/narinfo";
import type { ObjectStore } from "../src/objectStore";

export interface ContractSubject {
  store: ObjectStore;
  dispose: () => Promise<void>;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function streamOf(parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[at] as Uint8Array);
      at += 1;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) pieces.push(chunk);
  return new Uint8Array(Buffer.concat(pieces));
}

/** Highest RSS growth while `work` runs, sampled every 10 ms. */
async function rssGrowth(work: () => Promise<void>): Promise<number> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return peak - baseline;
}

export function objectStoreContract(name: string, make: () => Promise<ContractSubject>): void {
  describe(`${name}: ObjectStore contract`, () => {
    it("puts and gets a round trip, with the compressed size and sha256", async () => {
      const { store, dispose } = await make();
      const payload = bytes("a compressed NAR, in pieces");
      const facts = await store.put("main/nar/a.nar.zst", streamOf([payload.subarray(0, 5), payload.subarray(5)]));
      expect(facts.size).toBe(payload.length);
      expect(facts.sha256).toBe(
        `sha256:${base32(createHash("sha256").update(payload).digest())}`,
      );
      expect(await store.head("main/nar/a.nar.zst")).toBe(payload.length);
      const got = await store.get("main/nar/a.nar.zst");
      expect(got?.size).toBe(payload.length);
      expect(Array.from(await drain(got?.stream as ReadableStream<Uint8Array>))).toEqual(
        Array.from(payload),
      );
      await dispose();
    });

    it("answers null for a missing key, and delete is idempotent", async () => {
      const { store, dispose } = await make();
      expect(await store.get("main/nar/none.nar.zst")).toBeNull();
      expect(await store.head("main/nar/none.nar.zst")).toBeNull();
      await store.delete("main/nar/none.nar.zst");
      await store.put("main/nar/gone.nar.zst", streamOf([bytes("x")]));
      await store.delete("main/nar/gone.nar.zst");
      await store.delete("main/nar/gone.nar.zst");
      expect(await store.head("main/nar/gone.nar.zst")).toBeNull();
      await dispose();
    });

    it("lists by prefix, newest facts intact", async () => {
      const { store, dispose } = await make();
      await store.put("main/nar/one.nar.zst", streamOf([bytes("1")]));
      await store.put("main/nar/two.nar.zst", streamOf([bytes("22")]));
      await store.put("other/nar/three.nar.zst", streamOf([bytes("333")]));
      const main = await store.list("main/nar");
      expect(main.map((entry) => entry.key).sort()).toEqual([
        "main/nar/one.nar.zst",
        "main/nar/two.nar.zst",
      ]);
      expect(main.find((entry) => entry.key.endsWith("two.nar.zst"))?.size).toBe(2);
      expect((await store.list("other/nar")).length).toBe(1);
      await dispose();
    });

    it("streams a 300 MB object at constant memory", async () => {
      const { store, dispose } = await make();
      let remaining = 300;
      const chunk = new Uint8Array(1024 * 1024);
      chunk.fill(0x5a);
      const putGrowth = await rssGrowth(async () => {
        const facts = await store.put(
          "main/nar/big.nar.zst",
          new ReadableStream({
            pull(controller) {
              if (remaining === 0) {
                controller.close();
                return;
              }
              remaining -= 1;
              controller.enqueue(chunk);
            },
          }),
        );
        expect(facts.size).toBe(300 * 1024 * 1024);
      });
      expect({ growth: putGrowth, within: putGrowth < 64 * 1024 * 1024 }).toEqual({
        growth: putGrowth,
        within: true,
      });
      const getGrowth = await rssGrowth(async () => {
        const got = await store.get("main/nar/big.nar.zst");
        let read = 0;
        for await (const piece of got?.stream as unknown as AsyncIterable<Uint8Array>) read += piece.length;
        expect(read).toBe(300 * 1024 * 1024);
      });
      expect({ growth: getGrowth, within: getGrowth < 64 * 1024 * 1024 }).toEqual({
        growth: getGrowth,
        within: true,
      });
      await dispose();
    });
  });
}
