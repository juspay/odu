/**
 * THE `ObjectStore` CONTRACT — run against every implementation.
 *
 * Disk and S3 (a versitygw fixture) run the SAME suite, which is the point: a
 * caller must not learn a second dialect of "put"/"get" when the bytes move off
 * a local disk.
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
  sha256: createHash("sha256").update(payload).digest("hex"),
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

    it("answers the survivors of a collection, with their sizes still right", async () => {
      // THE SHAPE OF A COLLECTION: walk a bucket's prefix, delete the keys that
      // walk answered and nothing else, and walk again. What comes back is
      // exactly what was kept, and each survivor still answers its own size —
      // the number the next dry run adds up.
      const { store, dispose } = await make();
      const payloads: [string, Uint8Array][] = [
        ["main/nar/keep1.nar.zst", bytes("k")],
        ["main/nar/evict1.nar.zst", bytes("ee")],
        ["main/nar/keep2.nar.zst", bytes("kkk")],
        ["main/nar/evict2.nar.zst", bytes("eeee")],
      ];
      for (const [key, payload] of payloads) await store.put(key, streamOf([payload]));
      const walked = await store.list("main");
      expect(walked.map((entry) => entry.key).sort()).toEqual(payloads.map(([key]) => key).sort());
      for (const entry of walked.filter((entry) => entry.key.includes("evict"))) await store.delete(entry.key);
      const left = await store.list("main");
      expect(left.map((entry) => ({ key: entry.key, size: entry.size })).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: "main/nar/keep1.nar.zst", size: 1 },
        { key: "main/nar/keep2.nar.zst", size: 3 },
      ]);
      expect(new TextDecoder().decode((await read(store, "main/nar/keep2.nar.zst")) as Uint8Array)).toBe("kkk");
      await dispose();
    });

    it("empties one prefix and leaves the others whole: a collection is one bucket's", async () => {
      // A COLLECTION THAT EVICTS EVERYTHING a bucket holds says nothing about
      // the bucket next to it, not even the one whose prefix begins with this
      // one's name.
      const { store, dispose } = await make();
      await store.put("main/nar/one.nar.zst", streamOf([bytes("1")]));
      await store.put("main/nar/two.nar.zst", streamOf([bytes("22")]));
      await store.put("main2/nar/four.nar.zst", streamOf([bytes("4444")]));
      await store.put("other/nar/three.nar.zst", streamOf([bytes("333")]));
      for (const entry of await store.list("main")) await store.delete(entry.key);
      expect(await store.list("main")).toEqual([]);
      expect((await store.list("main2")).map((entry) => entry.key)).toEqual(["main2/nar/four.nar.zst"]);
      expect((await store.list("other")).map((entry) => entry.key)).toEqual(["other/nar/three.nar.zst"]);
      expect(new TextDecoder().decode((await read(store, "other/nar/three.nar.zst")) as Uint8Array)).toBe("333");
      await dispose();
    });

    it("lists the whole object's size, for a stream and for a file", async () => {
      // A DRY RUN NEVER OPENS AN OBJECT: it adds up what `list` answered, so
      // that number is the stored object's own length — a multipart upload's
      // whole length rather than a part's, and a file's rather than whatever
      // the store staged on the way in.
      const { store, partSize, dispose } = await make();
      const streamed = patterned((partSize ?? 5 * 1024 * 1024) + 1024, 9);
      await store.put("main/nar/streamed.nar.zst", streamOf(pieces(streamed)));
      const scratch = mkdtempSync(join(tmpdir(), "odu-gc-size-"));
      try {
        const file = join(scratch, "staged.nar.zst");
        writeFileSync(file, "a file's own bytes");
        const facts = factsOf(bytes("a file's own bytes"));
        kept(await store.put("main/nar/filed.nar.zst", Bun.file(file), facts));
        const listed = (await store.list("main")).sort((a, b) => a.key.localeCompare(b.key));
        expect(listed).toEqual([
          { key: "main/nar/filed.nar.zst", size: facts.size },
          { key: "main/nar/streamed.nar.zst", size: streamed.length },
        ]);
        expect(listed.reduce((sum, entry) => sum + entry.size, 0)).toBe(streamed.length + facts.size);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      await dispose();
    });

    it("takes a second delete of a key, and a delete while another prefix is being walked", async () => {
      // A COLLECTION DELETES WHILE IT WALKS, and two rows may name the same
      // bytes, so it evicts one key twice and does so with the next bucket's
      // walk — several pages of it — still in flight. Neither is an error, and
      // the walk answers the prefix it was given.
      const { store, dispose } = await make();
      const walked = Array.from({ length: 7 }, (_, at) => `main/nar/w${at}.nar.zst`);
      for (const key of walked) await store.put(key, streamOf([bytes(key)]));
      await store.put("other/nar/doomed.nar.zst", streamOf([bytes("doomed")]));
      await store.put("other/nar/spared.nar.zst", streamOf([bytes("spared")]));
      const walking = store.list("main");
      await store.delete("other/nar/doomed.nar.zst");
      await store.delete("other/nar/doomed.nar.zst");
      expect((await walking).map((entry) => entry.key).sort()).toEqual(walked.slice().sort());
      expect((await store.list("other")).map((entry) => entry.key)).toEqual(["other/nar/spared.nar.zst"]);
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

    it("hands a reader a URL of its own, which fetches the bytes and takes a Range", async () => {
      const { store, dispose } = await make();
      const payload = bytes("0123456789abcdef");
      await store.put("main/nar/p.nar.zst", streamOf([payload]));
      if (store.presignGet === undefined) {
        // A STORE WITH NO URLS OF ITS OWN leaves the member out, and that
        // absence is the whole answer: its objects are reachable only through
        // whoever holds the store. Nothing else here applies to it.
        await dispose();
        return;
      }
      const url = store.presignGet("main/nar/p.nar.zst", 600);
      // A PLAIN `fetch`: no Authorization, no netrc, no client of this
      // store's — the URL carries every bit of authority the read needs.
      const whole = await fetch(url);
      expect({ status: whole.status, text: await whole.text() }).toEqual({ status: 200, text: "0123456789abcdef" });
      // THE READER RE-SENDS ITS RANGE to the store, so the store must answer
      // one: a redirected Nix client resuming a NAR depends on it.
      const ranged = await fetch(url, { headers: { range: "bytes=3-6" } });
      expect({
        status: ranged.status,
        range: ranged.headers.get("content-range"),
        text: await ranged.text(),
      }).toEqual({ status: 206, range: "bytes 3-6/16", text: "3456" });
      await dispose();
    });

    it("lets a presigned URL expire", async () => {
      const { store, dispose } = await make();
      if (store.presignGet === undefined) {
        await dispose();
        return;
      }
      await store.put("main/nar/short.nar.zst", streamOf([bytes("briefly readable")]));
      // ONE SECOND, then two of them pass: the URL is not a key to the object
      // for ever, which is what makes handing one out safe for a private
      // bucket.
      const url = store.presignGet("main/nar/short.nar.zst", 1);
      await Bun.sleep(2_000);
      const late = await fetch(url);
      expect({ ok: late.ok, status: late.status }).toEqual({ ok: false, status: 403 });
      await late.body?.cancel().catch(() => {});
      await dispose();
    });

    it("takes a reader's content type and cache lifetime, one part or many", async () => {
      const { store, partSize, dispose } = await make();
      const options = { contentType: "application/x-nix-nar", cacheControl: "public, max-age=31536000, immutable" };
      const small = bytes("one part of a NAR");
      // LARGER THAN ONE PART, both ways a multipart object is made: with its
      // facts promised it goes straight to the key, and without them it is
      // staged and copied into place — and the copy is what carries the
      // headers for the second, so both are asked.
      const big = patterned((partSize ?? 5 * 1024 * 1024) + 1024, 13);
      kept(await store.put("main/nar/opt-small.nar.zst", streamOf([small]), undefined, options));
      kept(await store.put("main/nar/opt-direct.nar.zst", streamOf(pieces(big)), factsOf(big), options));
      kept(await store.put("main/nar/opt-copied.nar.zst", streamOf(pieces(big)), undefined, options));
      // THE OPTIONS DECIDE NOTHING ABOUT THE OBJECT: the bytes and the facts
      // are what they would have been without them, on every store.
      expect(new TextDecoder().decode((await read(store, "main/nar/opt-small.nar.zst")) as Uint8Array)).toBe(
        "one part of a NAR",
      );
      for (const key of ["main/nar/opt-direct.nar.zst", "main/nar/opt-copied.nar.zst"]) {
        expect(await store.facts(key)).toEqual(factsOf(big));
      }
      if (store.presignGet === undefined) {
        // A STORE WITH NO RESPONSES OF ITS OWN took them and dropped them.
        await dispose();
        return;
      }
      for (const key of ["main/nar/opt-small.nar.zst", "main/nar/opt-direct.nar.zst", "main/nar/opt-copied.nar.zst"]) {
        const response = await fetch(store.presignGet(key, 600));
        expect({
          key,
          status: response.status,
          type: response.headers.get("content-type"),
          cache: response.headers.get("cache-control"),
        }).toEqual({ key, status: 200, type: options.contentType, cache: options.cacheControl });
        await response.body?.cancel().catch(() => {});
      }
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

    it("puts a local file (a Blob) as the object, once", async () => {
      const { store, dispose } = await make();
      const scratch = mkdtempSync(join(tmpdir(), "odu-blob-"));
      try {
        const file = join(scratch, "staged.nar.zst");
        writeFileSync(file, "kept bytes");
        const facts = factsOf(bytes("kept bytes"));
        expect(await store.put("main/nar/k.nar.zst", Bun.file(file), facts)).toEqual({ ok: true, facts });
        writeFileSync(file, "other byte");
        expect(await store.put("main/nar/k.nar.zst", Bun.file(file), factsOf(bytes("other byte")))).toEqual({
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
