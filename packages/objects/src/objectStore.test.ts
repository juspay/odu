/**
 * BOTH IMPLEMENTATIONS, through the one contract: the disk store, and the S3
 * store against versitygw. Nothing here names a path the interface does not
 * own, except each fixture's `rewriteBehind`, which is how the suite proves
 * facts are read back rather than recomputed.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { objectStoreContract } from "../test/contract";
import { type Gateway, startGateway } from "../test/versitygw";
import { createHash } from "node:crypto";
import { diskObjectStore, s3ObjectStore, UnrecordedObject } from "./objectStore";
import { s3Fetch, type S3Target } from "./s3sign";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-object-store-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

objectStoreContract("disk", async () => ({
  store: diskObjectStore({ dir: scratch }),
  rewriteBehind: async (key, bytes) => {
    writeFileSync(join(scratch, "objects", key), bytes);
  },
  partSize: null,
  memorySpec: { kind: "disk", dir: scratch },
  dispose: async () => {},
}));

let gateway: Gateway;
beforeAll(async () => {
  gateway = await startGateway();
});
afterAll(async () => {
  await gateway.stop();
});

/** Five MiB parts (S3's floor) and two keys a page, so multipart and paging
 *  are exercised by objects and listings a test can afford. */
const PART = 5 * 1024 * 1024;

objectStoreContract("s3 (versitygw)", async () => {
  const target = await gateway.bucket();
  return {
    store: s3ObjectStore({ target, partSize: PART, listPageSize: 2 }),
    // A PLAIN PUT over the key, carrying the metadata the store wrote: the
    // bytes change, the store's record does not.
    rewriteBehind: async (key, bytes) => {
      const head = await s3Fetch(target, "HEAD", key);
      const meta = Object.fromEntries([...head.headers.entries()].filter(([name]) => name.startsWith("x-amz-meta-")));
      const put = await s3Fetch(target, "PUT", key, {
        headers: { ...meta, "content-length": String(bytes.length) },
        body: bytes as Uint8Array<ArrayBuffer>,
      });
      if (!put.ok) throw new Error(`rewrite ${key}: ${put.status}`);
    },
    partSize: PART,
    memorySpec: { kind: "s3", target, partSize: PART },
    dispose: async () => {},
  };
});

describe("disk object store details", () => {
  it("links a kept file into place, and sweeps only old temp files", async () => {
    const store = diskObjectStore({ dir: scratch });
    const staged = join(scratch, "staged.nar.zst");
    writeFileSync(staged, "kept bytes");
    const facts = { size: 10, sha256: "0".repeat(64) };
    expect(await store.link?.("main/nar/a.nar.zst", staged, facts)).toEqual({ ok: true, facts });
    expect(await store.head("main/nar/a.nar.zst")).toBe(10);
    // THE SOURCE NAME IS GONE: the object never aliases a file its caller holds.
    expect(existsSync(staged)).toBe(false);

    const old = join(scratch, "objects", "main", "nar", ".tmp-old");
    const young = join(scratch, "objects", "main", "nar", ".tmp-young");
    writeFileSync(old, "old");
    writeFileSync(young, "young");
    utimesSync(old, new Date(0), new Date(0));
    expect(await store.sweepTemp("main", Date.now() - 1_000)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  it("hashes an object from before facts were kept, once", async () => {
    // A 3b object: the file, and no sidecar beside it.
    const store = diskObjectStore({ dir: scratch });
    const path = join(scratch, "objects", "main", "nar", "old.nar.zst");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "from 3b");
    const facts = await store.facts("main/nar/old.nar.zst");
    expect(facts?.size).toBe(7);
    expect(existsSync(join(scratch, "objects", ".facts", "main", "nar", "old.nar.zst"))).toBe(true);
    expect(await store.list("main")).toEqual([{ key: "main/nar/old.nar.zst", size: 7 }]);
  });
});

/** `bytes`' facts, spelled as a store records them. */
const factsOf = (bytes: Uint8Array) => ({
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const once = (stream: Uint8Array) => new Response(stream as Uint8Array<ArrayBuffer>).body as ReadableStream<Uint8Array>;

/**
 * A `send` that answers the first `times` CONDITIONAL writes with `409
 * ConditionalRequestConflict` and forwards everything else to the gateway —
 * the answer versitygw never gives and AWS gives when a delete is in flight.
 * `meanwhile` runs at each 409: whatever the other party did while it stood.
 */
function conflicting(times: number, meanwhile: () => Promise<void> = async () => {}) {
  const seen = { conflicts: 0 };
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["if-none-match"] === "*" && seen.conflicts < times) {
      seen.conflicts += 1;
      await meanwhile();
      return new Response("<Error><Code>ConditionalRequestConflict</Code></Error>", { status: 409 });
    }
    return fetch(url, init);
  }) as typeof fetch;
  return { send, seen };
}

describe("s3 object store: a 409 decides nothing", () => {
  let target: S3Target;
  beforeEach(async () => {
    target = await gateway.bucket();
  });
  const small = new TextEncoder().encode("one part");
  const large = new Uint8Array(PART + 1).map((_, at) => at % 251);

  it("sends a one-part put again, and keeps it", async () => {
    const { send, seen } = conflicting(2);
    const store = s3ObjectStore({ target, partSize: PART, send });
    expect(await store.put("main/nar/a.nar.zst", once(small))).toEqual({ ok: true, facts: factsOf(small) });
    expect(seen.conflicts).toBe(2);
    expect(await store.facts("main/nar/a.nar.zst")).toEqual(factsOf(small));
  });

  it("is refused with the winner's facts when the other writer landed meanwhile", async () => {
    const theirs = new TextEncoder().encode("the other writer's");
    const { send } = conflicting(1, async () => {
      const other = s3ObjectStore({ target, partSize: PART });
      expect((await other.put("main/nar/a.nar.zst", once(theirs))).ok).toBe(true);
    });
    const store = s3ObjectStore({ target, partSize: PART, send });
    expect(await store.put("main/nar/a.nar.zst", once(small))).toEqual({
      ok: false,
      refusal: { kind: "exists", key: "main/nar/a.nar.zst", facts: factsOf(theirs) },
    });
  });

  it("starts a conflicted multipart upload again — from the kept file, or from the temp copy", async () => {
    const file = join(scratch, "staged.nar.zst");
    writeFileSync(file, large);
    const kept = conflicting(1);
    const keeping = s3ObjectStore({ target, partSize: PART, send: kept.send });
    // NO LOCAL FILES, so no `link`: a caller puts the file, and a Blob body is
    // what lets a conflicted upload start over from it.
    expect(keeping.link).toBeUndefined();
    expect(await keeping.put("main/nar/k.nar.zst", Bun.file(file), factsOf(large))).toEqual({
      ok: true,
      facts: factsOf(large),
    });
    expect(kept.seen.conflicts).toBe(1);

    const copied = conflicting(1);
    const putting = s3ObjectStore({ target, partSize: PART, send: copied.send });
    expect(await putting.put("main/nar/p.nar.zst", once(large))).toEqual({ ok: true, facts: factsOf(large) });
    expect(copied.seen.conflicts).toBe(1);
    expect(await putting.list("main")).toEqual([
      { key: "main/nar/k.nar.zst", size: large.length },
      { key: "main/nar/p.nar.zst", size: large.length },
    ]);
  });

  it("gives up refused with `conflict`, naming the key and the tries, and keeps nothing", async () => {
    const store = s3ObjectStore({ target, partSize: PART, send: conflicting(Number.POSITIVE_INFINITY).send });
    expect(await store.put("main/nar/a.nar.zst", once(small))).toEqual({
      ok: false,
      refusal: { kind: "conflict", key: "main/nar/a.nar.zst", tries: 6 },
    });
    expect(await store.head("main/nar/a.nar.zst")).toBeNull();
  });
});

describe("s3 object store: an object odu did not write", () => {
  it("is an UnrecordedObject naming the key, never a re-read of its bytes", async () => {
    const target = await gateway.bucket();
    const bytes = new TextEncoder().encode("dropped in by hand");
    const response = await s3Fetch(target, "PUT", "main/nar/x.nar.zst", {
      headers: { "content-length": String(bytes.length) },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    expect(response.ok).toBe(true);
    const store = s3ObjectStore({ target, partSize: PART });
    const facts = store.facts("main/nar/x.nar.zst");
    await expect(facts).rejects.toBeInstanceOf(UnrecordedObject);
    await facts.catch((err: UnrecordedObject) => expect(err.key).toBe("main/nar/x.nar.zst"));
  });
});

describe("s3 object store: a put killed mid-upload", () => {
  /** The keys of every incomplete multipart upload in the bucket. */
  const uploadsIn = async (target: S3Target): Promise<string[]> => {
    const response = await s3Fetch(target, "GET", "", { query: { uploads: "" } });
    expect(response.ok).toBe(true);
    return [...(await response.text()).matchAll(/<Key>([^<]*)<\/Key>/g)].map((found) => found[1] as string).sort();
  };
  /** What a daemon killed mid-put leaves: an upload with a part, never
   *  completed and never aborted. */
  const abandon = async (target: S3Target, key: string): Promise<void> => {
    const created = await s3Fetch(target, "POST", key, { query: { uploads: "" } });
    const uploadId = /<UploadId>([^<]*)<\/UploadId>/.exec(await created.text())?.[1];
    if (uploadId === undefined) throw new Error(`CreateMultipartUpload ${key}: ${created.status}`);
    const part = new Uint8Array(PART).fill(7);
    const put = await s3Fetch(target, "PUT", key, {
      query: { partNumber: "1", uploadId },
      headers: { "content-length": String(part.length) },
      body: part as Uint8Array<ArrayBuffer>,
    });
    expect(put.ok).toBe(true);
    await put.text();
  };

  it("is aborted by the boot sweep when it began before the boot, and a live one is left", async () => {
    const target = await gateway.bucket();
    await abandon(target, "main/nar/dead.nar.zst");
    await abandon(target, "other/nar/not-ours.nar.zst");
    // `Initiated` is the service's clock, to the second: the boot is placed
    // strictly between the dead upload and the live one.
    await Bun.sleep(1_100);
    const boot = Date.now();
    await Bun.sleep(1_100);
    await abandon(target, "main/nar/live.nar.zst");
    expect(await uploadsIn(target)).toEqual(["main/nar/dead.nar.zst", "main/nar/live.nar.zst", "other/nar/not-ours.nar.zst"]);

    const store = s3ObjectStore({ target, partSize: PART, listPageSize: 1 });
    expect(await store.sweepTemp("main", boot)).toBe(1);
    // Only the bucket's own prefix, and only what began before the boot.
    expect(await uploadsIn(target)).toEqual(["main/nar/live.nar.zst", "other/nar/not-ours.nar.zst"]);
  });
});
