import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cache, createCache, RUN_TOKEN_LIFETIME_MS } from "./cache";
import type { BucketRow } from "./db";
import { asRoot, localStores } from "./testlib";

const ROOT = "root-token";
const NOW = 1_700_000_000_000;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-run-token-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function served(...names: readonly string[]): Promise<Cache> {
  const cache = createCache({
    publicOrigin: "http://cache.test",
    stateRoot: scratch,
    stores: localStores(scratch),
    rootToken: ROOT,
    now: () => NOW,
  });
  for (const name of names) {
    await cache.admin.create({
      ...asRoot(ROOT),
      name,
      public: true,
      upstreamKeys: [],
      retentionDays: 30,
    });
  }
  return cache;
}

function bucketOf(cache: Cache, name: string): BucketRow {
  const row = cache.bucket(name);
  if (row === null) throw new Error(`no bucket ${name}`);
  return row;
}

describe("a run's write token", () => {
  it("is write-scoped to exactly its bucket, labelled, and expires in MILLISECONDS", async () => {
    const cache = await served("main");
    const granted = cache.grantRunToken({
      bucket: "main",
      runId: "r-1",
    });
    expect(granted).not.toBeNull();
    if (granted === null) return;

    const listed = await cache.admin.tokenList({ ...asRoot(ROOT), bucket: "main" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((facts) => facts.id === granted.id)).toMatchObject({
      scope: "write",
      bucketGlob: "main",
      label: "run r-1",
      expires: NOW + RUN_TOKEN_LIFETIME_MS,
    });
    await cache.close();
  });

  it("opens the bucket, and stops the moment it is revoked", async () => {
    const cache = await served("main");
    const granted = cache.grantRunToken({
      bucket: "main",
      runId: "r-1",
    });
    if (granted === null) throw new Error("no grant");
    expect(
      cache.authorize(`Bearer ${granted.token}`, bucketOf(cache, "main"), "write"),
    ).toEqual({ ok: true });

    cache.revokeToken(granted.id);
    expect(
      cache.authorize(`Bearer ${granted.token}`, bucketOf(cache, "main"), "write"),
    ).toMatchObject({ ok: false, status: 403 });
    await cache.close();
  });

  it("cannot touch a bucket it was not minted for", async () => {
    const cache = await served("main", "other");
    const granted = cache.grantRunToken({
      bucket: "main",
      runId: "r-1",
    });
    if (granted === null) throw new Error("no grant");
    expect(
      cache.authorize(`Bearer ${granted.token}`, bucketOf(cache, "other"), "write"),
    ).toMatchObject({ ok: false, status: 403 });
    await cache.close();
  });

  it("answers null for a bucket this daemon does not serve", async () => {
    const cache = await served("main");
    expect(
      cache.grantRunToken({ bucket: "nope", runId: "r-1" }),
    ).toBeNull();
    await cache.close();
  });

  it("lets an unknown id go without complaining", async () => {
    const cache = await served("main");
    expect(() => cache.revokeToken("not-a-token")).not.toThrow();
    await cache.close();
  });
});
