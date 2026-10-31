/**
 * The ADMIN verbs, called directly.
 *
 * The route suite grades what a Nix client meets; this one grades what the
 * service's port answers, which is where every refusal code is decided. The
 * cases are the ones a caller can actually reach: a service with no root token
 * (the developer's `odu web`), a name that already exists, a name that could
 * not be one, and the two numbers that turn a typo into data loss.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asRoot } from "./testlib";
import { base32 } from "./narinfo";
import { type Cache, createCache } from "./cache";
import { FakeStore, hashOf } from "../test/fakeStore";

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

/** A body for `acceptNarinfo`, which takes a stream because a real one does. */
const stream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

/** Bytes, and the NAR hash a narinfo has to claim for them. */
function nar(text: string): { bytes: Uint8Array; narHash: string } {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    narHash: `sha256:${base32(createHash("sha256").update(bytes).digest())}`,
  };
}

async function putNar(cache: Cache, bucket: string, payload: { bytes: Uint8Array; narHash: string }): Promise<void> {
  const row = cache.bucket(bucket);
  if (row === null) throw new Error(`no bucket ${bucket}`);
  const upload = await cache.beginUpload(row, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(payload.bytes);
  await upload.commit();
}

const narinfoText = (
  storePath: string,
  payload: { narHash: string },
  references: readonly string[] = [],
): string =>
  [
    `StorePath: ${storePath}`,
    `URL: nar/${payload.narHash.slice("sha256:".length)}.nar.zst`,
    "Compression: none",
    `NarHash: ${payload.narHash}`,
    `NarSize: 1`,
    `References: ${references.map((path) => path.slice("/nix/store/".length)).join(" ")}`,
    "",
  ].join("\n");

const createInput = {
  ...asRoot(ROOT),
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
      cache.admin.list(asRoot(ROOT)),
      cache.admin.tokenMint({ ...asRoot(ROOT), bucket: "main", bucketGlob: null, scope: "write", expiresDays: null }),
      cache.admin.tokenList({ ...asRoot(ROOT), bucket: null }),
      cache.admin.tokenRevoke({ ...asRoot(ROOT), id: "x" }),
      cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "p", paths: ["/nix/store/x"] }),
      cache.admin.gc({ ...asRoot(ROOT), bucket: null }),
      cache.admin.stats(asRoot(ROOT)),
    ];
    for (const attempt of attempts) {
      expect(await attempt).toMatchObject({ ok: false, code: "no_root_token" });
    }
    cache.close();
  });

  it("refuses a wrong token, and says which of the two it is", async () => {
    const absent = cacheWith(null);
    expect(await absent.admin.list(asRoot(""))).toMatchObject({
      ok: false,
      code: "no_root_token",
    });
    expect((await absent.admin.list(asRoot(""))) as { message: string }).toMatchObject({
      message: expect.stringContaining("without a root token"),
    });
    absent.close();

    const present = cacheWith(ROOT);
    const refused = await present.admin.list(asRoot("nope"));
    expect(refused).toMatchObject({ ok: false, code: "no_root_token" });
    expect((refused as { message: string }).message).toContain("does not match");
    present.close();
  });

  it("does not let an empty configured token become a credential", async () => {
    const cache = cacheWith("");
    expect(await cache.admin.list(asRoot(""))).toMatchObject({
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

  it("answers the substituter's identity and nothing about the operator's cache", async () => {
    // It takes no credential, so it must not report the object count, the
    // bytes, the retention or the upstream key names — those are what
    // `CacheBucket` is for, and `CacheBucket` is the root-token view.
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, upstreamKeys: ["cache.nixos.org-1"] });
    const described = await cache.admin.describe({ bucket: "main" });
    expect(described).toMatchObject({ ok: true });
    if (described.ok) {
      expect(Object.keys(described.value).sort()).toEqual(["name", "public", "publicKey"]);
    }
    cache.close();
  });
});

describe("tokenMint", () => {
  it("refuses a zero or negative expiry, and accepts a positive one", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const mint = (expiresDays: number | null) =>
      cache.admin.tokenMint({
        ...asRoot(ROOT),
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
      ...asRoot(ROOT),
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
    const listed = await cache.admin.tokenList({ ...asRoot(ROOT), bucket: "team-ci" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    const elsewhere = await cache.admin.tokenList({ ...asRoot(ROOT), bucket: "main" });
    if (elsewhere.ok) expect(elsewhere.value).toHaveLength(0);
    cache.close();
  });

  it("refuses a glob that is not one", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    expect(
      await cache.admin.tokenMint({
        ...asRoot(ROOT),
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
      ...asRoot(ROOT),
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
      ...asRoot(ROOT),
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
    const stats = await cache.admin.stats(asRoot(ROOT));
    expect(stats).toMatchObject({
      ok: true,
      value: { objects: 0, bytes: 0, hits: 0, lastAccessed: null },
    });
    cache.close();
  });
});

describe("a restart", () => {
  it("attempts a narinfo recovered from disk on the next write", async () => {
    // The uploads that survive a restart have no seed of their own: `drain`
    // only tries entries its seed names, so without the recovered seed they
    // would sit until the sweep deleted them an hour later.
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    const child = "/nix/store/cccccccccccccccccccccccccccccccc-child";
    const parent = "/nix/store/pppppppppppppppppppppppppppppppp-parent";
    const childPayload = nar("child bytes");
    const parentPayload = nar("parent bytes");
    store.add({ storePath: child, narHash: childPayload.narHash, narSize: 1, references: [] }, false);
    store.add(
      { storePath: parent, narHash: parentPayload.narHash, narSize: 1, references: [child] },
      false,
    );

    // The parent arrives first, and cannot import: its reference is not valid.
    await putNar(first, "main", parentPayload);
    const early = await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(parent),
      stream(narinfoText(parent, parentPayload, [child])),
    );
    expect(early).toMatchObject({ ok: true, status: 202 });
    first.close();

    // A NEW process over the same state root, which has never seen either.
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      store: null,
      blob: store,
      now: () => NOW,
    });
    await putNar(second, "main", childPayload);
    const late = await second.acceptNarinfo(
      second.bucket("main") as never,
      hashOf(child),
      stream(narinfoText(child, childPayload)),
    );
    expect(late).toMatchObject({ ok: true, status: 200 });

    const stats = await second.admin.stats(asRoot(ROOT));
    // Two: the child this call recorded, and the parent the recovered seed
    // unblocked.
    expect(stats).toMatchObject({ ok: true, value: { objects: 2 } });
    second.close();
  });
});

describe("gc and pin", () => {
  it("does not let a collection interleave with a pin that was already running", async () => {
    // THE WINDOW: `planGc` and the delete are separate awaits. A pin issued
    // while a collection is in flight must either be in the plan or win
    // outright — never be promised a path the delete has already taken.
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, retentionDays: 0 });
    const target = "/nix/store/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk-kept";
    const payload = nar("kept bytes");
    store.add({ storePath: target, narHash: payload.narHash, narSize: 1, references: [] }, false);
    await putNar(cache, "main", payload);
    const recorded = await cache.acceptNarinfo(
      cache.bucket("main") as never,
      hashOf(target),
      stream(narinfoText(target, payload)),
    );
    expect(recorded).toMatchObject({ ok: true, status: 200 });

    // A pin whose closure query is slow, started BEFORE the collection.
    const gate = Promise.withResolvers<void>();
    const closure = store.closure.bind(store);
    store.closure = async (paths) => {
      await gate.promise;
      return closure(paths);
    };

    const pinning = cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "keep", paths: [target] });
    const collecting = cache.admin.gc({ ...asRoot(ROOT), bucket: null });
    gate.resolve();
    const [pinned, collected] = await Promise.all([pinning, collecting]);

    expect(pinned).toMatchObject({ ok: true });
    expect(collected).toMatchObject({ ok: true });
    expect(store.deleted).not.toContain(target);
    cache.close();
  });
});

describe("the wall behind the route", () => {
  it("refuses a NAR name instead of sanitizing it", async () => {
    // A sanitizer turns `../..` into a plausible file name, and a caller that
    // skipped the route would never learn it had.
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const bucket = cache.bucket("main");
    expect(bucket).not.toBeNull();
    if (bucket === null) return;
    for (const name of ["../escape.nar.zst", "a/b.nar.zst", ".hidden"]) {
      await expect(cache.beginUpload(bucket, name)).rejects.toThrow(/not a NAR file name/);
    }
    cache.close();
  });
});

describe("missing", () => {
  it("does not read a signature without a colon as an upstream key", async () => {
    // `sig.slice(0, sig.indexOf(":"))` answers -1 with the whole string minus
    // its last character — a key name that matches nothing, which silently
    // defeats the filter.
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, upstreamKeys: ["cache.nixos.org-1"] });
    const bucket = cache.bucket("main");
    if (bucket === null) throw new Error("no bucket");
    const answer = cache.missing(bucket, [
      { path: "/nix/store/11111111111111111111111111111111-a", sigs: ["no-colon-here"] },
      { path: "/nix/store/22222222222222222222222222222222-b", sigs: ["cache.nixos.org-1:AAAA"] },
    ]);
    expect(answer).toEqual({
      missing: ["/nix/store/11111111111111111111111111111111-a"],
      skipped: ["/nix/store/22222222222222222222222222222222-b"],
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

  it("closes down the WAL the FIRST run creates, not the next one", async () => {
    // `-wal` appears on the first write, so a chmod issued right after `new
    // Database` finds nothing and swallows the error — and the bucket's secret
    // key sits in a world-readable WAL until the process restarts.
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const wal = join(scratch, "cache", "cache.sqlite-wal");
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).mode & 0o777).toBe(0o600);
    cache.close();
  });
});
