/**
 * THE `ObjectStore` CONTRACT — run against every implementation.
 *
 * Disk and S3 (a versitygw fixture) run the SAME suite, which is the point: a
 * route or a GC pass must not learn a second dialect of "put"/"get" when the
 * bytes move off the pod's disk.
 *
 * A factory owns its own temporary backing and answers the store, a dispose
 * that removes it, and `rewriteBehind` — a write to the BACKING that keeps the
 * store's own record of the object, which is how the suite proves `facts`
 * reads that record instead of re-hashing the bytes. The suite never names a
 * path, a bucket or a filesystem.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { base32 } from "../src/narinfo";
import type { ObjectFacts, ObjectStore, PutOutcome } from "../src/objectStore";
import type { StoreSpec } from "./storeMemory";

export interface ContractSubject {
  store: ObjectStore;
  /** Replace the bytes at `key` in the backing, keeping the store's record of
   *  the object (disk's sidecar, S3's metadata) as it was. */
  rewriteBehind: (key: string, bytes: Uint8Array) => Promise<void>;
  /** The store's multipart part size, or null for a store with no parts. */
  partSize: number | null;
  /** How to build this same store in another process, for the memory case. */
  memorySpec: StoreSpec;
  dispose: () => Promise<void>;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const factsOf = (payload: Uint8Array): ObjectFacts => ({
  size: payload.length,
  sha256: `sha256:${base32(createHash("sha256").update(payload).digest())}`,
});

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

/** `size` bytes of a pattern seeded by `seed`, in 1 MiB pieces. */
function patterned(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at++) out[at] = (at * 31 + seed) & 0xff;
  return out;
}

function pieces(payload: Uint8Array, size = 1024 * 1024): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < payload.length; at += size) out.push(payload.subarray(at, at + size));
  return out;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

async function read(store: ObjectStore, key: string): Promise<Uint8Array | null> {
  const got = await store.get(key);
  return got === null ? null : drain(got.stream);
}

const kept = (outcome: PutOutcome): ObjectFacts => {
  if (!outcome.ok) throw new Error(`expected a put to keep, got ${outcome.refusal.kind}`);
  return outcome.facts;
};

export function objectStoreContract(name: string, make: () => Promise<ContractSubject>): void {
  describe(`${name}: ObjectStore contract`, () => {
    it("puts and gets a round trip, with the compressed size and sha256", async () => {
      const { store, dispose } = await make();
      const payload = bytes("a compressed NAR, in pieces");
      const facts = kept(await store.put("main/nar/a.nar.zst", streamOf([payload.subarray(0, 5), payload.subarray(5)])));
      expect(facts).toEqual(factsOf(payload));
      expect(await store.head("main/nar/a.nar.zst")).toBe(payload.length);
      const got = await store.get("main/nar/a.nar.zst");
      expect(got?.size).toBe(payload.length);
      expect(Array.from(await drain(got?.stream as ReadableStream<Uint8Array>))).toEqual(Array.from(payload));
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
      expect(await store.facts("main/nar/gone.nar.zst")).toBeNull();
      await dispose();
    });

    it("lists by prefix, and only that prefix", async () => {
      const { store, dispose } = await make();
      await store.put("main/nar/one.nar.zst", streamOf([bytes("1")]));
      await store.put("main/nar/two.nar.zst", streamOf([bytes("22")]));
      await store.put("main2/nar/four.nar.zst", streamOf([bytes("4444")]));
      await store.put("other/nar/three.nar.zst", streamOf([bytes("333")]));
      const main = await store.list("main");
      expect(main.map((entry) => entry.key).sort()).toEqual(["main/nar/one.nar.zst", "main/nar/two.nar.zst"]);
      expect(main.find((entry) => entry.key.endsWith("two.nar.zst"))?.size).toBe(2);
      expect((await store.list("other/nar")).length).toBe(1);
      await dispose();
    });

    it("lists every page of a long prefix", async () => {
      // The S3 fixture pages two keys at a time, so seven keys are four LISTs.
      const { store, dispose } = await make();
      const keys = Array.from({ length: 7 }, (_, at) => `main/nar/k${at}.nar.zst`);
      for (const key of keys) await store.put(key, streamOf([bytes(key)]));
      expect((await store.list("main")).map((entry) => entry.key).sort()).toEqual(keys.sort());
      await dispose();
    });

    it("reads a byte range, and reports the whole size", async () => {
      const { store, dispose } = await make();
      const payload = bytes("0123456789abcdef");
      await store.put("main/nar/r.nar.zst", streamOf([payload]));
      const middle = await store.get("main/nar/r.nar.zst", { start: 3, end: 6 });
      expect(middle?.size).toBe(16);
      expect(new TextDecoder().decode(await drain(middle?.stream as ReadableStream<Uint8Array>))).toBe("3456");
      const last = await store.get("main/nar/r.nar.zst", { start: 15, end: 15 });
      expect(new TextDecoder().decode(await drain(last?.stream as ReadableStream<Uint8Array>))).toBe("f");
      expect(await store.get("main/nar/absent.nar.zst", { start: 0, end: 1 })).toBeNull();
      await dispose();
    });

    it("reads the facts its put wrote, never the bytes", async () => {
      const { store, rewriteBehind, dispose } = await make();
      expect(await store.facts("main/nar/none.nar.zst")).toBeNull();
      // A READ: asking about a missing key does not create it.
      expect(await store.head("main/nar/none.nar.zst")).toBeNull();
      const put = kept(await store.put("main/nar/f.nar.zst", streamOf([bytes("stored "), bytes("bytes")])));
      expect(await store.facts("main/nar/f.nar.zst")).toEqual(put);
      // THE BYTES CHANGE UNDER IT, same length: a store that re-hashed would
      // answer the new bytes' sha256. It answers what the put recorded.
      await rewriteBehind("main/nar/f.nar.zst", bytes("other bytes!"));
      expect(await store.facts("main/nar/f.nar.zst")).toEqual(put);
      await dispose();
    });

    it("is immutable: a second put of a key is refused, and the first bytes stay", async () => {
      const { store, dispose } = await make();
      const first = bytes("first");
      const a = kept(await store.put("main/nar/same.nar.zst", streamOf([first])));
      const b = await store.put("main/nar/same.nar.zst", streamOf([bytes("second")]));
      expect(b).toEqual({ ok: false, refusal: { kind: "exists", key: "main/nar/same.nar.zst", facts: a } });
      expect(Array.from((await read(store, "main/nar/same.nar.zst")) as Uint8Array)).toEqual(Array.from(first));
      await dispose();
    });

    it("lets exactly one of two concurrent puts of one key win", async () => {
      const { store, partSize, dispose } = await make();
      // Small and multipart both: the two writes S3 makes conditional.
      for (const size of [64, partSize === null ? 6 * 1024 * 1024 : partSize * 2 + 17]) {
        const key = `main/nar/race-${size}.nar.zst`;
        const one = patterned(size, 1);
        const two = patterned(size, 2);
        const outcomes = await Promise.all([store.put(key, streamOf(pieces(one))), store.put(key, streamOf(pieces(two)))]);
        const winners = outcomes.filter((outcome) => outcome.ok);
        expect(winners.length).toBe(1);
        const stored = (await read(store, key)) as Uint8Array;
        const winner = outcomes[0]?.ok === true ? one : two;
        expect(factsOf(stored)).toEqual(factsOf(winner));
        const loser = outcomes.find((outcome) => !outcome.ok);
        expect(loser).toEqual({ ok: false, refusal: { kind: "exists", key, facts: factsOf(winner) } });
      }
      await dispose();
    });

    it("puts an object larger than one part, with and without its facts promised", async () => {
      const { store, partSize, dispose } = await make();
      const size = (partSize ?? 5 * 1024 * 1024) * 2 + 12_345;
      const payload = patterned(size, 7);
      const promised = kept(await store.put("main/nar/big1.nar.zst", streamOf(pieces(payload)), factsOf(payload)));
      const learned = kept(await store.put("main/nar/big2.nar.zst", streamOf(pieces(payload))));
      expect(promised).toEqual(factsOf(payload));
      expect(learned).toEqual(factsOf(payload));
      for (const key of ["main/nar/big1.nar.zst", "main/nar/big2.nar.zst"]) {
        expect(factsOf((await read(store, key)) as Uint8Array)).toEqual(factsOf(payload));
        expect(await store.facts(key)).toEqual(factsOf(payload));
      }
      // NO TEMP LEFT BEHIND: the unpromised put staged and copied, and its
      // temp is gone — neither listed nor waiting for a sweep.
      expect((await store.list("main")).map((entry) => entry.key).sort()).toEqual([
        "main/nar/big1.nar.zst",
        "main/nar/big2.nar.zst",
      ]);
      expect(await store.sweepTemp("main", Number.POSITIVE_INFINITY)).toBe(0);
      await dispose();
    });

    it("refuses bytes that are not the facts it was promised, and keeps nothing", async () => {
      const { store, partSize, dispose } = await make();
      for (const size of [10, (partSize ?? 5 * 1024 * 1024) + 3]) {
        const key = `main/nar/lie-${size}.nar.zst`;
        const payload = patterned(size, 3);
        const promised = { size, sha256: factsOf(patterned(size, 4)).sha256 };
        expect(await store.put(key, streamOf(pieces(payload)), promised)).toEqual({
          ok: false,
          refusal: { kind: "facts_mismatch", key, expected: promised, actual: factsOf(payload) },
        });
        expect(await store.head(key)).toBeNull();
      }
      await dispose();
    });

    it("does not leave a partial object when the stream errors mid-put", async () => {
      const { store, partSize, dispose } = await make();
      for (const size of [10, (partSize ?? 5 * 1024 * 1024) + 1024]) {
        const key = `main/nar/broken-${size}.nar.zst`;
        const broken = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(patterned(size, 5));
            controller.error(new Error("connection dropped"));
          },
        });
        await expect(store.put(key, broken)).rejects.toThrow("connection dropped");
        expect(await store.head(key)).toBeNull();
      }
      expect(await store.list("main")).toEqual([]);
      await dispose();
    });

    it("keeps a local file as the object, once", async () => {
      const { store, dispose } = await make();
      const scratch = mkdtempSync(join(tmpdir(), "odu-keep-"));
      try {
        const file = join(scratch, "staged.nar.zst");
        writeFileSync(file, "kept bytes");
        const facts = factsOf(bytes("kept bytes"));
        expect(await store.keep("main/nar/k.nar.zst", file, facts)).toEqual({ ok: true, facts });
        writeFileSync(file, "other byte");
        expect(await store.keep("main/nar/k.nar.zst", file, factsOf(bytes("other byte")))).toEqual({
          ok: false,
          refusal: { kind: "exists", key: "main/nar/k.nar.zst", facts },
        });
        expect(new TextDecoder().decode((await read(store, "main/nar/k.nar.zst")) as Uint8Array)).toBe("kept bytes");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      await dispose();
    });

    it("streams a 300 MB object at constant memory, to a slow reader too", async () => {
      // OUT OF PROCESS (test/storeMemory.ts): the same store, rebuilt from its
      // spec in a fresh process, so the number is the store's and not the
      // garbage of the tests before it.
      const { memorySpec, dispose } = await make();
      const child = Bun.spawn([process.execPath, join(import.meta.dirname, "storeMemory.ts"), JSON.stringify(memorySpec)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
      const growth = JSON.parse(out) as { put: number; get: number };
      expect({ growth, within: growth.put < 64 * 1024 * 1024 && growth.get < 64 * 1024 * 1024 }).toEqual({
        growth,
        within: true,
      });
      await dispose();
    }, 120_000);
  });
}
