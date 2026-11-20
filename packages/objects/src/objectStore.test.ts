import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { objectStoreContract } from "../test/contract";
import { type Gateway, shortWindowFrom, startGateway } from "../test/testing";
import { createHash } from "node:crypto";
import { diskObjectStore } from "./diskStore";
import { ObjectChanged, UnrecordedObject } from "./objectStore";
import { s3ObjectStore } from "./s3Store";
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

const factsOf = (bytes: Uint8Array) => ({
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const once = (stream: Uint8Array) => new Response(stream as Uint8Array<ArrayBuffer>).body as ReadableStream<Uint8Array>;

/**
 * A `send` that answers the first `times` CONDITIONAL writes with `409
 * ConditionalRequestConflict` and forwards everything else to the gateway —
 * the answer versitygw never gives and AWS gives when a delete is in flight.
 * `meanwhile` runs at each 409.
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

/**
 * A `send` that ANSWERS `DeleteObjects` itself and forwards everything else
 * to the gateway. The keys are read back out of the body: one request per
 * chunk, each with its own Content-MD5, which S3 requires on this call.
 */
function batchDeletes(answer: (at: number) => Response) {
  const sent: { keys: string[]; md5: string | null; body: Uint8Array }[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const asked = new URL(url as string | URL);
    if (init?.method !== "POST" || !asked.searchParams.has("delete")) return fetch(url as string | URL, init);
    const body = init.body as Uint8Array;
    const text = new TextDecoder().decode(body);
    const headers = (init.headers ?? {}) as Record<string, string>;
    sent.push({
      keys: [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((found) => found[1] as string),
      md5: headers["content-md5"] ?? null,
      body,
    });
    return answer(sent.length);
  }) as typeof fetch;
  return { send, sent };
}

const slowDown = (): Response =>
  new Response(
    "<Error><Code>ServiceUnavailable</Code><Message>Reduce your concurrent " +
      "request rate for the same object.</Message></Error>",
    { status: 429 },
  );
const deleted = (): Response => new Response("<DeleteResult></DeleteResult>", { status: 200 });

describe("s3 object store: deleting a set of keys", () => {
  let target: S3Target;
  beforeEach(async () => {
    target = await gateway.bucket();
  });
  const keys = Array.from({ length: 2500 }, (_, at) => `main/nar/k${at}.nar.zst`);

  it("sends one DeleteObjects per 1000 keys, each signed with its own Content-MD5", async () => {
    const { send, sent } = batchDeletes(deleted);
    await s3ObjectStore({ target, partSize: PART, send }).deleteMany(keys);
    expect(sent.map((request) => request.keys.length)).toEqual([1000, 1000, 500]);
    expect(sent.flatMap((request) => request.keys)).toEqual(keys);
    expect(sent.map((request) => request.md5)).toEqual(
      sent.map((request) => createHash("md5").update(request.body).digest("base64")),
    );
  });

  it("asks again when the service says it is being asked too fast", async () => {
    const { send, sent } = batchDeletes((at) => (at === 1 ? slowDown() : deleted()));
    await s3ObjectStore({ target, partSize: PART, send }).deleteMany(keys.slice(0, 3));
    expect(sent.length).toBe(2);
    expect(sent.map((request) => request.keys)).toEqual([keys.slice(0, 3), keys.slice(0, 3)]);
  });

  it(
    "gives up after five tries, saying what the service said and not its XML",
    async () => {
      const { send, sent } = batchDeletes(slowDown);
      const refused = s3ObjectStore({ target, partSize: PART, send }).deleteMany(keys.slice(0, 3));
      await expect(refused).rejects.toThrow(/429 ServiceUnavailable .* after 5 tries/);
      await expect(refused).rejects.toThrow(/Reduce your concurrent request rate/);
      expect(sent.length).toBe(5);
    },
    20_000,
  );
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

  it("is one whose bytes no longer measure the size it recorded, when the answer measured them", async () => {
    const target = await gateway.bucket();
    const store = s3ObjectStore({ target, partSize: PART });
    const bytes = new TextEncoder().encode("the bytes the put recorded");
    expect((await store.put("main/nar/y.nar.zst", new Blob([bytes]))).ok).toBe(true);
    const head = await s3Fetch(target, "HEAD", "main/nar/y.nar.zst");
    const meta = Object.fromEntries([...head.headers.entries()].filter(([name]) => name.startsWith("x-amz-meta-")));
    const shorter = new TextEncoder().encode("fewer bytes");
    const put = await s3Fetch(target, "PUT", "main/nar/y.nar.zst", {
      headers: { ...meta, "content-length": String(shorter.length) },
      body: shorter as Uint8Array<ArrayBuffer>,
    });
    expect(put.ok).toBe(true);
    await expect(store.facts("main/nar/y.nar.zst")).rejects.toBeInstanceOf(UnrecordedObject);
  });
});

describe("s3 object store: an edge that re-encodes the answer", () => {
  /**
   * AN ANSWER THAT DID NOT MEASURE THE OBJECT, in the two shapes one comes
   * in: a `content-encoding` over a body of its own, and no `content-length`
   * to read at all. Cloudflare in front of R2 sends both at once — measured
   * on `cache.kolu.dev`, a HEAD of a `text/plain` object from a client that
   * accepts an encoding (Bun's `fetch` offers one) answers with
   * `content-encoding` and no length.
   */
  const reencoding = (encoding: string | null): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(url as string | URL, init);
      if (init?.method !== "HEAD" || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      if (encoding !== null) headers.set("content-encoding", encoding);
      return new Response(null, { status: response.status, headers });
    }) as typeof fetch;

  /** `nix-cache-info` is the one object of the protocol whose content type an
   *  edge compresses, which is why it alone was refused (#151). */
  const KEY = "main/nix-cache-info";
  const text = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n";
  const bytes = new TextEncoder().encode(text);

  for (const encoding of ["gzip", null]) {
    it(`is an object with facts, not one this store did not write (${encoding ?? "no content-encoding"})`, async () => {
      const target = await gateway.bucket();
      const written = s3ObjectStore({ target, partSize: PART });
      expect(await written.put(KEY, new Blob([bytes]), factsOf(bytes), { contentType: "text/plain" })).toEqual({
        ok: true,
        facts: factsOf(bytes),
      });

      const store = s3ObjectStore({ target, partSize: PART, send: reencoding(encoding) });
      expect(await store.facts(KEY)).toEqual(factsOf(bytes));
      expect(await store.head(KEY)).toBe(bytes.length);
      const next = new TextEncoder().encode(`${text}Odu-Origin: https://odu.example\n`);
      expect(await store.put(KEY, new Blob([next]), factsOf(next), { contentType: "text/plain" })).toEqual({
        ok: false,
        refusal: { kind: "exists", key: KEY, facts: factsOf(bytes) },
      });
    });
  }
});

describe("s3 object store: a put killed mid-upload", () => {
  const uploadsIn = async (target: S3Target): Promise<string[]> => {
    const response = await s3Fetch(target, "GET", "", { query: { uploads: "" } });
    expect(response.ok).toBe(true);
    return [...(await response.text()).matchAll(/<Key>([^<]*)<\/Key>/g)].map((found) => found[1] as string).sort();
  };
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
    expect(await uploadsIn(target)).toEqual(["main/nar/live.nar.zst", "other/nar/not-ours.nar.zst"]);
  });
});

describe("s3 object store: round trips", () => {
  const recording = (fail?: (method: string, url: URL) => boolean) => {
    const seen: { method: string; url: URL; signal: AbortSignal | undefined }[] = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const parsed = new URL(String(url));
      seen.push({ method, url: parsed, signal: init?.signal ?? undefined });
      if (fail?.(method, parsed)) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      return fetch(url, init);
    }) as typeof fetch;
    return { send, seen };
  };

  it("reads with no HEAD: one GET answers absent, size and the first bytes", async () => {
    const target = await gateway.bucket();
    const bytes = new Uint8Array(3 * 1024 * 1024 + 5).map((_, at) => at % 251);
    expect((await s3ObjectStore({ target, partSize: PART }).put("main/nar/r", once(bytes))).ok).toBe(true);
    const { send, seen } = recording();
    const store = s3ObjectStore({ target, partSize: PART, send });

    expect(await store.get("main/nar/missing")).toBeNull();
    expect(seen.map((one) => one.method)).toEqual(["GET"]);

    seen.length = 0;
    const got = await store.get("main/nar/r", { start: 1_000_000, end: 1_000_009 });
    expect(got?.size).toBe(bytes.length);
    expect(new Uint8Array(await new Response(got?.stream).arrayBuffer())).toEqual(bytes.subarray(1_000_000, 1_000_010));
    expect(seen.map((one) => one.method)).toEqual(["GET"]);
  });

  it("keeps one window prefetched, and a cancel aborts every GET in flight", async () => {
    const target = await gateway.bucket();
    const bytes = new Uint8Array(4 * 1024 * 1024).map((_, at) => at % 251);
    expect((await s3ObjectStore({ target, partSize: PART }).put("main/nar/w", once(bytes))).ok).toBe(true);
    const { send, seen } = recording();
    const store = s3ObjectStore({ target, partSize: PART, send });
    const got = await store.get("main/nar/w");
    const reader = (got?.stream as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(seen.filter((one) => one.method === "GET")).toHaveLength(2);
    await reader.cancel("enough");
    expect(seen.every((one) => one.signal?.aborted === true)).toBe(true);
  });

  it("fails the read as a CHANGED OBJECT when a window answers fewer bytes than its range", async () => {
    const target = await gateway.bucket();
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, at) => at % 251);
    expect((await s3ObjectStore({ target, partSize: PART }).put("main/nar/s", once(bytes))).ok).toBe(true);
    for (const from of [1024 * 1024, 0]) {
      const got = await s3ObjectStore({ target, partSize: PART, send: shortWindowFrom(from) }).get("main/nar/s");
      expect(got?.size).toBe(bytes.length);
      const read = new Response(got?.stream).arrayBuffer();
      await expect(read).rejects.toBeInstanceOf(ObjectChanged);
      await expect(read).rejects.toThrow(
        `main/nar/s changed while it was being read — a window of ${1024 * 1024} bytes answered ${1024 * 1024 - 10}`,
      );
    }
  });

  it("fails the read with the SAME sentence when a later window answers 412", async () => {
    const target = await gateway.bucket();
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, at) => at % 251);
    expect((await s3ObjectStore({ target, partSize: PART }).put("main/nar/m", once(bytes))).ok).toBe(true);
    const refusing = (async (url: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      if (range?.startsWith("bytes=1048576-") !== true) return fetch(url, init);
      return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
    }) as typeof fetch;
    const got = await s3ObjectStore({ target, partSize: PART, send: refusing }).get("main/nar/m");
    const read = new Response(got?.stream).arrayBuffer();
    await expect(read).rejects.toBeInstanceOf(ObjectChanged);
    await expect(read).rejects.toThrow("main/nar/m changed while it was being read");
  });

  it("uploads parts in parallel, and one failing part aborts the rest and the upload", async () => {
    const target = await gateway.bucket();
    const bytes = new Uint8Array(4 * PART + 1).map((_, at) => at % 251);
    const { send, seen } = recording((method, url) => method === "PUT" && url.searchParams.get("partNumber") === "2");
    const store = s3ObjectStore({ target, partSize: PART, parallelParts: 4, send });
    await expect(store.put("main/nar/p", once(bytes))).rejects.toThrow("UploadPart");
    expect(await store.head("main/nar/p")).toBeNull();
    expect(seen.filter((one) => one.method === "DELETE" && one.url.searchParams.has("uploadId"))).toHaveLength(1);
    const listed = await s3Fetch(target, "GET", "", { query: { uploads: "" } });
    expect(await listed.text()).not.toContain("<Upload>");
  });
});
