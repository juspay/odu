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
import { objectStoreContract } from "../test/objectStore.contract";
import { type Gateway, startGateway } from "../test/versitygw";
import { diskObjectStore, s3ObjectStore } from "./objectStore";
import { s3Fetch } from "./s3sign";

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
    const facts = await store.keep("main/nar/a.nar.zst", staged, { size: 10, sha256: "sha256:x" });
    expect(facts).toEqual({ ok: true, facts: { size: 10, sha256: "sha256:x" } });
    expect(await store.head("main/nar/a.nar.zst")).toBe(10);

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
