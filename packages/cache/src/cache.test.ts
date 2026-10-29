/**
 * The ADMIN verbs, called directly.
 *
 * The route suite grades what a Nix client meets; this one grades what the
 * service's port answers, which is where every refusal code is decided. The
 * cases are the ones a caller can actually reach: a service with no root token
 * (the developer's `odu web`), a name that already exists, a name that could
 * not be one, and the two numbers that turn a typo into data loss.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Cache, createCache } from "./cache";
import { FakeStore } from "../test/fakeStore";

const ROOT = "root-token";
const NOW = 1_700_000_000_000;

let scratch: string;
let store: FakeStore;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-admin-"));
  store = new FakeStore();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function cacheWith(rootToken: string | null): Cache {
  return createCache({
    stateRoot: scratch,
    rootToken,
    store: null,
    blob: store,
    now: () => NOW,
  });
}

const createInput = {
  rootToken: ROOT,
  name: "main",
  public: true,
  retentionDays: 30,
  upstreamKeys: [],
};

describe("the root token", () => {
  it("refuses every admin verb when the service has none", async () => {
    const cache = cacheWith(null);
    const attempts = [
      cache.admin.create(createInput),
      cache.admin.list({ rootToken: ROOT }),
      cache.admin.tokenMint({ rootToken: ROOT, bucket: "main", bucketGlob: null, scope: "write", expiresDays: null }),
      cache.admin.tokenList({ rootToken: ROOT, bucket: null }),
      cache.admin.tokenRevoke({ rootToken: ROOT, id: "x" }),
      cache.admin.pin({ rootToken: ROOT, bucket: "main", name: "p", paths: ["/nix/store/x"] }),
      cache.admin.gc({ rootToken: ROOT, bucket: null }),
      cache.admin.stats({ rootToken: ROOT }),
    ];
    for (const attempt of attempts) {
      expect(await attempt).toMatchObject({ ok: false, code: "no_root_token" });
    }
    cache.close();
  });

  it("refuses a wrong token, and says which of the two it is", async () => {
    const absent = cacheWith(null);
    expect(await absent.admin.list({ rootToken: "" })).toMatchObject({
      ok: false,
      code: "no_root_token",
    });
    expect((await absent.admin.list({ rootToken: "" })) as { message: string }).toMatchObject({
      message: expect.stringContaining("without a root token"),
    });
    absent.close();

    const present = cacheWith(ROOT);
    const refused = await present.admin.list({ rootToken: "nope" });
    expect(refused).toMatchObject({ ok: false, code: "no_root_token" });
    expect((refused as { message: string }).message).toContain("does not match");
    present.close();
  });

  it("does not let an empty configured token become a credential", async () => {
    const cache = cacheWith("");
    expect(await cache.admin.list({ rootToken: "" })).toMatchObject({
      ok: false,
      code: "no_root_token",
    });
    cache.close();
  });
});

describe("create", () => {
  it("makes a bucket with its own key, and refuses the second", async () => {
    const cache = cacheWith(ROOT);
    const first = await cache.admin.create(createInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.keyName).toBe("main-1");
    expect(first.value.objects).toBe(0);
    expect(await cache.admin.create(createInput)).toMatchObject({
      ok: false,
      code: "bucket_exists",
    });
    cache.close();
  });

  it("refuses a name that could not be a path segment", async () => {
    const cache = cacheWith(ROOT);
    for (const name of ["", "Main", "a/b", "a.b", "-leading", "x".repeat(64)]) {
      expect({ name, answer: await cache.admin.create({ ...createInput, name }) }).toMatchObject({
        name,
        answer: { ok: false, code: "bad_input" },
      });
    }
    cache.close();
  });

  it("refuses a negative retention, which would be a destructive reading of a typo", async () => {
    const cache = cacheWith(ROOT);
    expect(await cache.admin.create({ ...createInput, retentionDays: -1 })).toMatchObject({
      ok: false,
      code: "bad_input",
    });
    expect(await cache.admin.create({ ...createInput, retentionDays: 0 })).toMatchObject({ ok: true });
    cache.close();
  });
});

describe("describe", () => {
  it("answers without a root token, and only for a bucket that exists", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const described = await cache.admin.describe({ bucket: "main" });
    expect(described).toMatchObject({ ok: true });
    if (described.ok) expect(described.value.publicKey.startsWith("main-1:")).toBe(true);
    expect(await cache.admin.describe({ bucket: "nope" })).toMatchObject({
      ok: false,
      code: "unknown_bucket",
    });
    cache.close();
  });
});

describe("tokenMint", () => {
  it("refuses a zero or negative expiry, and accepts a positive one", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const mint = (expiresDays: number | null) =>
      cache.admin.tokenMint({
        rootToken: ROOT,
        bucket: "main",
        bucketGlob: null,
        scope: "write",
        expiresDays,
      });
    expect(await mint(0)).toMatchObject({ ok: false, code: "bad_input" });
    expect(await mint(-5)).toMatchObject({ ok: false, code: "bad_input" });
    const ok = await mint(7);
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.value.facts.expires).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
    cache.close();
  });

  it("honours a glob, so one token can cover a team's buckets", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const minted = await cache.admin.tokenMint({
      rootToken: ROOT,
      bucket: "main",
      bucketGlob: "team-*",
      scope: "write",
      expiresDays: null,
    });
    expect(minted).toMatchObject({ ok: true });
    if (!minted.ok) return;
    expect(minted.value.facts.bucketGlob).toBe("team-*");
    // The glob is the authorisation: it covers `team-ci`, and it does NOT cover
    // the bucket the token was minted under.
    const listed = await cache.admin.tokenList({ rootToken: ROOT, bucket: "team-ci" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    const elsewhere = await cache.admin.tokenList({ rootToken: ROOT, bucket: "main" });
    if (elsewhere.ok) expect(elsewhere.value).toHaveLength(0);
    cache.close();
  });

  it("refuses a glob that is not one", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    expect(
      await cache.admin.tokenMint({
        rootToken: ROOT,
        bucket: "main",
        bucketGlob: "Main!",
        scope: "write",
        expiresDays: null,
      }),
    ).toMatchObject({ ok: false, code: "bad_input" });
    cache.close();
  });
});

describe("pin", () => {
  it("refuses a path the store does not have, in one closure query", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const refused = await cache.admin.pin({
      rootToken: ROOT,
      bucket: "main",
      name: "p",
      paths: ["/nix/store/00000000000000000000000000000000-absent"],
    });
    expect(refused).toMatchObject({ ok: false, code: "bad_input" });
    expect(store.calls.filter((call) => call.op === "closure")).toHaveLength(1);
    cache.close();
  });

  it("resolves a closure through the store and roots every member", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const child = "/nix/store/11111111111111111111111111111111-child";
    const parent = "/nix/store/22222222222222222222222222222222-parent";
    store.add({ storePath: child, narHash: `sha256:${"1".repeat(52)}`, narSize: 1, references: [] });
    store.add({ storePath: parent, narHash: `sha256:${"2".repeat(52)}`, narSize: 1, references: [child] });

    const pinned = await cache.admin.pin({
      rootToken: ROOT,
      bucket: "main",
      name: "release-1",
      paths: [parent],
    });
    expect(pinned).toMatchObject({ ok: true });
    if (!pinned.ok) return;
    expect([...pinned.value.rootPaths].sort()).toEqual([child, parent].sort());
    expect(store.isRetained("main", child)).toBe(true);
    expect(store.isRetained("main", parent)).toBe(true);
    cache.close();
  });
});

describe("stats", () => {
  it("counts in SQL rather than loading every row", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const stats = await cache.admin.stats({ rootToken: ROOT });
    expect(stats).toMatchObject({
      ok: true,
      value: { objects: 0, bytes: 0, hits: 0, lastAccessed: null },
    });
    cache.close();
  });
});

describe("file modes", () => {
  it("keeps the database and its directory private", () => {
    // The database holds every bucket's ed25519 SECRET key and every token
    // hash, so it is a secret rather than a cache.
    const cache = cacheWith(ROOT);
    cache.close();
    expect(statSync(join(scratch, "cache")).mode & 0o777).toBe(0o700);
    expect(statSync(join(scratch, "cache", "cache.sqlite")).mode & 0o777).toBe(0o600);
  });
});
