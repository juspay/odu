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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asRoot } from "./testlib";
import { base32 } from "./narinfo";
import { type Cache, createCache } from "./cache";
import type { NarinfoOutcome } from "./staging";
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

/** Poll for a BACKGROUND effect — the row's upstream fetch queue. A real
 *  `nix-store -r` cannot be driven by fake timers, so this is the integration
 *  exception: short, bounded, and the condition is the thing awaited. */
async function until(what: string, ask: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ask()) {
    if (Date.now() > deadline) throw new Error(`odu cache test: ${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
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
    await cache.close();
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
    await absent.close();

    const present = cacheWith(ROOT);
    const refused = await present.admin.list(asRoot("nope"));
    expect(refused).toMatchObject({ ok: false, code: "no_root_token" });
    expect((refused as { message: string }).message).toContain("does not match");
    await present.close();
  });

  it("does not let an empty configured token become a credential", async () => {
    const cache = cacheWith("");
    expect(await cache.admin.list(asRoot(""))).toMatchObject({
      ok: false,
      code: "no_root_token",
    });
    await cache.close();
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
    await cache.close();
  });

  it("refuses a name that could not be a path segment", async () => {
    const cache = cacheWith(ROOT);
    for (const name of ["", "Main", "a/b", "a.b", "-leading", "x".repeat(64)]) {
      expect({ name, answer: await cache.admin.create({ ...createInput, name }) }).toMatchObject({
        name,
        answer: { ok: false, code: "bad_input" },
      });
    }
    await cache.close();
  });

  it("refuses a negative retention, which would be a destructive reading of a typo", async () => {
    const cache = cacheWith(ROOT);
    expect(await cache.admin.create({ ...createInput, retentionDays: -1 })).toMatchObject({
      ok: false,
      code: "bad_input",
    });
    expect(await cache.admin.create({ ...createInput, retentionDays: 0 })).toMatchObject({ ok: true });
    await cache.close();
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
    await cache.close();
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
      expect(Object.keys(described.value).sort()).toEqual([
        "domain",
        "name",
        "public",
        "publicKey",
      ]);
    }
    await cache.close();
  });
});

describe("a bucket's domain", () => {
  it("sets, normalizes and clears a name, and one name belongs to one bucket", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    await cache.admin.create({ ...createInput, name: "other" });

    const named = await cache.admin.domain({
      ...asRoot(ROOT),
      bucket: "main",
      domain: "Cache.Example.ORG",
    });
    expect(named).toMatchObject({ ok: true, value: { domain: "cache.example.org" } });
    expect(cache.bucketByDomain("cache.example.org")?.name).toBe("main");

    const taken = await cache.admin.domain({
      ...asRoot(ROOT),
      bucket: "other",
      domain: "cache.example.org",
    });
    expect(taken).toMatchObject({ ok: false, code: "bad_input" });
    if (!taken.ok) expect(taken.message).toContain('"main"');

    // A SCHEME IS NOT A NAME: the substituter URL adds it, and a stored
    // `https://…` would be a host header no request carries.
    expect(
      await cache.admin.domain({
        ...asRoot(ROOT),
        bucket: "main",
        domain: "https://cache.example.org",
      }),
    ).toMatchObject({ ok: false, code: "bad_input" });

    const cleared = await cache.admin.domain({
      ...asRoot(ROOT),
      bucket: "main",
      domain: null,
    });
    expect(cleared).toMatchObject({ ok: true, value: { domain: null } });
    expect(cache.bucketByDomain("cache.example.org")).toBeNull();
    await cache.close();
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
    await cache.close();
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
    await cache.close();
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
    await cache.close();
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
    await cache.close();
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
    await cache.close();
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
    await cache.close();
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

describe("chunked uploads", () => {
  it("refuses an oversized part, joins the rest, and names a gap", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const bucket = cache.bucket("main") as never;
    const file = "abc.nar.zst";

    const big = await cache.beginPart(bucket, file, 0, 4);
    expect(await big.write(new Uint8Array(5))).toBe("too-large");
    await big.discard();

    for (const [index, bytes] of [
      [0, new Uint8Array([1, 2, 3, 4])],
      [1, new Uint8Array([5, 6, 7])],
    ] as const) {
      const part = await cache.beginPart(bucket, file, index, 4);
      expect(await part.write(bytes)).toBe("ok");
      await part.commit();
    }
    expect(await cache.completeUpload(bucket, file, 3)).toEqual({
      ok: false,
      missing: [2],
    });
    // TWO COMPLETES OF ONE FILE: the second is the state the first produced,
    // not an unlink race.
    expect(await cache.completeUpload(bucket, file, 2)).toEqual({ ok: true, parts: 2 });
    expect(await cache.completeUpload(bucket, file, 2)).toEqual({ ok: true, parts: 2 });
    // The joined bytes are the parts in order, and the narinfo's own proof is
    // what turns them into a stored path.
    expect(
      readFileSync(join(scratch, "cache", "staging", "main", "nar", file)),
    ).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7]));
    expect(
      readdirSync(join(scratch, "cache", "staging", "main", "nar")).filter((name) =>
        name.includes(".part-"),
      ),
    ).toEqual([]);
    await cache.close();
  });

  it("does not sweep the parts of an upload that is still running", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const bucket = cache.bucket("main") as never;
    const file = "slow.nar.zst";
    const part = await cache.beginPart(bucket, file, 0, 100);
    await part.write(new Uint8Array([1, 2, 3]));
    await part.commit();
    const narDir = join(scratch, "cache", "staging", "main", "nar");
    const partPath = join(narDir, `${file}.part-0`);
    const markerPath = join(narDir, `${file}.uploading`);

    // AN ABANDONED PART AND ITS MARKER: the sweep takes both.
    utimesSync(partPath, new Date(0), new Date(0));
    utimesSync(markerPath, new Date(0), new Date(0));
    await cache.beginUpload(bucket, "idle.nar.zst");
    await until("the abandoned part to be swept", () => !existsSync(partPath));

    // A PART WHOSE MARKER IS FRESH IS AN UPLOAD IN PROGRESS, however old the
    // part is (a slow 2 GiB closure touches its marker per part).
    const again = await cache.beginPart(bucket, file, 0, 100);
    await again.write(new Uint8Array([4]));
    await again.commit();
    utimesSync(partPath, new Date(0), new Date(0));
    await cache.beginUpload(bucket, "idle2.nar.zst");
    expect(existsSync(partPath)).toBe(true);
    await cache.close();
  });
});

describe("upstream references", () => {
  const child = "/nix/store/cccccccccccccccccccccccccccccccc-child";
  const parent = "/nix/store/pppppppppppppppppppppppppppppppp-parent";

  /** A parent whose only reference is absent from this store. */
  async function parentWaitingOnChild(
    upstreamKeys: readonly string[],
  ): Promise<{ cache: Cache; outcome: NarinfoOutcome }> {
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, upstreamKeys });
    const childPayload = nar("child bytes");
    const parentPayload = nar("parent bytes");
    store.upstream.set(child, {
      storePath: child,
      narHash: childPayload.narHash,
      narSize: 1,
      references: [],
      // Signed by the key the bucket trusts — and therefore fetchable.
      sigs: ["cache.nixos.org-1:c2ln"],
    });
    store.add(
      { storePath: parent, narHash: parentPayload.narHash, narSize: 1, references: [child] },
      false,
    );
    await putNar(cache, "main", parentPayload);
    const outcome = await cache.acceptNarinfo(
      cache.bucket("main") as never,
      hashOf(parent),
      stream(narinfoText(parent, parentPayload, [child])),
    );
    return { cache, outcome };
  }

  it("fetches a reference upstream signed OFF the request, then imports the referrer", async () => {
    const { cache, outcome } = await parentWaitingOnChild(["cache.nixos.org-1"]);
    // THE REQUEST ANSWERS 202 WHILE THE FETCH RUNS: `nix-store -r` can outlive a
    // proxy's origin timeout, and sitting behind it would turn a hold into a
    // gateway error.
    expect(outcome).toMatchObject({ ok: true, status: 202, fetching: 1 });
    await until("the referrer to import", () => cache.bucket("main") !== null && cache.held().length === 0);
    // Scoped to the BUCKET's key: the fetch trusts what the bucket trusts and
    // nothing else.
    expect(store.substituted).toEqual([
      { paths: [child], keyNames: ["cache.nixos.org-1"] },
    ]);
    expect(store.present.has(child)).toBe(true);
    await cache.close();
  });

  it("holds a reference that is neither here nor upstream, and publishes it", async () => {
    // The upstream has the path, but signed by a key this bucket does not
    // trust — so it is not "upstream" for this bucket, and the referrer is held.
    const { cache, outcome } = await parentWaitingOnChild(["some-other-key"]);
    expect(outcome).toMatchObject({ ok: true, status: 202 });
    if (outcome.ok && outcome.status === 202) expect(outcome.missing).toEqual([child]);
    // The fetch is attempted, fails to find a trusted signature, and the hold
    // becomes the FINAL reason — not a fetching state for ever.
    await until("the fetch to settle", () => cache.held()[0]?.fetching === 0);
    expect(cache.held()).toMatchObject([
      { bucket: "main", storePath: parent, missing: [child], fetching: 0 },
    ]);
    await cache.close();
  });

  it("fetches nothing for a --no-upstream bucket", async () => {
    const { cache, outcome } = await parentWaitingOnChild([]);
    expect(outcome).toMatchObject({ ok: true, status: 202, fetching: 0 });
    expect(store.substituted).toEqual([]);
    expect(cache.held()).toHaveLength(1);
    await cache.close();
  });

  it("keeps the held row across a restart", async () => {
    const { cache } = await parentWaitingOnChild(["some-other-key"]);
    // Let the (failing) fetch write its final reason before the process "dies".
    await until("the fetch to settle", () => cache.held()[0]?.fetching === 0);
    await cache.close();
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      store: null,
      blob: store,
      now: () => NOW,
    });
    // The reason is a ROW, not a drain's memory: a new process reads it before
    // it has attempted anything.
    expect(second.held()).toMatchObject([{ bucket: "main", storePath: parent, missing: [child] }]);
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
    await cache.close();
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
    await cache.close();
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
    await cache.close();
  });
});

describe("file modes", () => {
  it("keeps the database and its directory private", async () => {
    // The database holds every bucket's ed25519 SECRET key and every token
    // hash, so it is a secret rather than a cache.
    const cache = cacheWith(ROOT);
    await cache.close();
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
    await cache.close();
  });
});

describe("one fetch job over the whole missing set", () => {
  it("imports a referrer with three upstream references after ONE job", async () => {
    const parent = "/nix/store/pppppppppppppppppppppppppppppppp-parent";
    const children = [
      "/nix/store/c111111111111111111111111111111111-first",
      "/nix/store/c222222222222222222222222222222222-second",
      "/nix/store/c333333333333333333333333333333333-third",
    ];
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, upstreamKeys: ["cache.nixos.org-1"] });
    for (const child of children) {
      const bytes = nar(child);
      store.upstream.set(child, {
        storePath: child,
        narHash: bytes.narHash,
        narSize: 1,
        references: [],
        sigs: ["cache.nixos.org-1:c2ln"],
      });
    }
    const parentPayload = nar("parent bytes");
    store.add(
      {
        storePath: parent,
        narHash: parentPayload.narHash,
        narSize: 1,
        references: children,
      },
      false,
    );
    // NIX NAMES ONE. The job must still ask for all three.
    store.reportOneMissing = true;
    await putNar(cache, "main", parentPayload);
    const outcome = await cache.acceptNarinfo(
      cache.bucket("main") as never,
      hashOf(parent),
      stream(narinfoText(parent, parentPayload, children)),
    );
    expect(outcome).toMatchObject({ ok: true, status: 202, fetching: 3 });
    if (outcome.ok && outcome.status === 202) expect(outcome.missing).toEqual(children);

    await until("the referrer to import", () => cache.held().length === 0);
    // ONE substitute call, over the full set — not one per reference and not
    // one per attempt.
    expect(store.substituted).toEqual([
      { paths: children, keyNames: ["cache.nixos.org-1"] },
    ]);
    await cache.close();
  });

  it("resumes a held row at row apply after a restart", async () => {
    const child = "/nix/store/cccccccccccccccccccccccccccccccc-child";
    const parent = "/nix/store/pppppppppppppppppppppppppppppppp-parent";
    const first = cacheWith(ROOT);
    await first.admin.create({ ...createInput, upstreamKeys: ["cache.nixos.org-1"] });
    const childPayload = nar("child bytes");
    const parentPayload = nar("parent bytes");
    // The upstream cannot answer yet: the hold is real when the process dies.
    store.add(
      { storePath: parent, narHash: parentPayload.narHash, narSize: 1, references: [child] },
      false,
    );
    await putNar(first, "main", parentPayload);
    const outcome = await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(parent),
      stream(narinfoText(parent, parentPayload, [child])),
    );
    expect(outcome).toMatchObject({ ok: true, status: 202 });
    await until("the fetch to settle", () => first.held()[0]?.fetching === 0);
    await first.close();
    expect(store.substituted.length).toBeGreaterThan(0);

    // The reference becomes available while the pod is down; the restart's
    // row apply must pick the hold up with NO new push.
    store.upstream.set(child, {
      storePath: child,
      narHash: childPayload.narHash,
      narSize: 1,
      references: [],
      sigs: ["cache.nixos.org-1:c2ln"],
    });
    store.substituted.length = 0;
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      store: null,
      blob: store,
      now: () => NOW,
    });
    await second.resume();
    await until("the resumed fetch to import the referrer", () => second.held().length === 0);
    expect(store.substituted).toEqual([
      { paths: [child], keyNames: ["cache.nixos.org-1"] },
    ]);
    await second.close();
  });
});

describe("a failed fetch", () => {
  it("holds with nix's last line, not 'neither here nor upstream'", async () => {
    const child = "/nix/store/f111111111111111111111111111111111-child";
    const parent = "/nix/store/f222222222222222222222222222222222-parent";
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, upstreamKeys: ["cache.nixos.org-1"] });
    store.substituteFailure = "unable to download …: Could not resolve host";
    const childPayload = nar("child bytes");
    const parentPayload = nar("parent bytes");
    store.upstream.set(child, {
      storePath: child,
      narHash: childPayload.narHash,
      narSize: 1,
      references: [],
      sigs: ["cache.nixos.org-1:c2ln"],
    });
    store.add(
      { storePath: parent, narHash: parentPayload.narHash, narSize: 1, references: [child] },
      false,
    );
    await putNar(cache, "main", parentPayload);
    await cache.acceptNarinfo(
      cache.bucket("main") as never,
      hashOf(parent),
      stream(narinfoText(parent, parentPayload, [child])),
    );
    await until("the failed fetch to settle", () => cache.held()[0]?.fetching === 0);
    expect(cache.held()).toMatchObject([
      { storePath: parent, failure: "unable to download …: Could not resolve host" },
    ]);
    await cache.close();
  });
});
