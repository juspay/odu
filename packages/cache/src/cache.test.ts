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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { asRoot } from "./testlib";
import { base32, canonicalNarHash } from "./narinfo";
import { base32Bytes, storePathHashOf } from "./storePath";
import { type Cache, createCache } from "./cache";
import type { NarinfoOutcome } from "./staging";
import { hashOf } from "../test/fakeStore";
import { openCacheRepo } from "./db";

const ROOT = "root-token";
const NOW = 1_700_000_000_000;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-admin-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function cacheWith(rootToken: string | null): Cache {
  return createCache({
    stateRoot: scratch,
    rootToken,
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
const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

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
  it("refuses a path the bucket does not have", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const refused = await cache.admin.pin({
      ...asRoot(ROOT),
      bucket: "main",
      name: "p",
      paths: ["/nix/store/00000000000000000000000000000000-absent"],
    });
    expect(refused).toMatchObject({ ok: false, code: "bad_input" });
    await cache.close();
  });

  it("resolves a closure through the bucket's own rows", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const child = "/nix/store/11111111111111111111111111111111-child";
    const parent = "/nix/store/22222222222222222222222222222222-parent";
    const childPayload = nar("child bytes");
    const parentPayload = nar("parent bytes");
    for (const [path, payload, refs] of [
      [child, childPayload, []],
      [parent, parentPayload, [child]],
    ] as const) {
      await putNar(cache, "main", payload);
      await cache.acceptNarinfo(
        cache.bucket("main") as never,
        hashOf(path),
        stream(narinfoText(path, payload, refs)),
      );
    }

    const pinned = await cache.admin.pin({
      ...asRoot(ROOT),
      bucket: "main",
      name: "release-1",
      paths: [parent],
    });
    expect(pinned).toMatchObject({ ok: true });
    if (!pinned.ok) return;
    expect([...pinned.value.rootPaths].sort()).toEqual([child, parent].sort());
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
  it("keeps the rows and the object files", async () => {
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    const path = "/nix/store/dddddddddddddddddddddddddddddddd-restart";
    const payload = nar("bytes that outlive a process");
    await putNar(first, "main", payload);
    await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload)),
    );
    first.close();

    const second = cacheWith(ROOT);
    expect(await second.admin.stats(asRoot(ROOT))).toMatchObject({
      ok: true,
      value: { objects: 1, bytes: payload.bytes.length },
    });
    const source = await second.narSource(second.bucket("main") as never, `${payload.narHash.slice(7)}.nar.zst`);
    expect(source).toMatchObject({ kind: "file", size: payload.bytes.length });
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
    for (let tries = 0; tries < 200 && existsSync(partPath); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(existsSync(partPath)).toBe(false);

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

describe("gc and pin", () => {
  it("deletes the object of an expired row and keeps a pin", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, retentionDays: 0 });
    const kept = "/nix/store/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk-kept";
    const gone = "/nix/store/llllllllllllllllllllllllllllllll-gone";
    for (const path of [kept, gone]) {
      const payload = nar(path);
      await putNar(cache, "main", payload);
      await cache.acceptNarinfo(
        cache.bucket("main") as never,
        hashOf(path),
        stream(narinfoText(path, payload)),
      );
    }
    expect(await cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "keep", paths: [kept] })).toMatchObject({ ok: true });
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET last_accessed = 0");
    db.close();
    expect(await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" })).toMatchObject({ ok: true });
    expect(cache.narinfoText(cache.bucket("main") as never, hashOf(kept))).not.toBeNull();
    expect(cache.narinfoText(cache.bucket("main") as never, hashOf(gone))).toBeNull();
    expect(
      await cache.narSource(cache.bucket("main") as never, `${nar(gone).narHash.slice(7)}.nar`),
    ).toBeNull();
    expect(
      await cache.narSource(cache.bucket("main") as never, `${nar(kept).narHash.slice(7)}.nar`),
    ).toMatchObject({ kind: "file" });
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

describe("a reference that is a derivation", () => {
  it("refuses the import instead of holding it for ever", async () => {
    const parent = "/nix/store/abababababababababababababababab-parent";
    const drv = "/nix/store/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd-thing.drv";
    const cache = cacheWith(ROOT);
    await cache.admin.create({ ...createInput, upstreamKeys: ["cache.nixos.org-1"] });
    const payload = nar("parent that names a recipe");
    await putNar(cache, "main", payload);
    const outcome = await cache.acceptNarinfo(
      cache.bucket("main") as never,
      hashOf(parent),
      stream(narinfoText(parent, payload, [drv])),
    );
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    if (!outcome.ok) {
      expect(outcome.message).toContain("references a derivation");
      expect(outcome.message).toContain(drv);
    }
    await cache.close();
  });
});

describe("CA is proved from the path", () => {
  it("records and serves the CA of a content-addressed path", async () => {
    const cache = cacheWith(ROOT);
    await cache.admin.create(createInput);
    const payload = nar("a content-addressed path");
    const hash = payload.narHash.slice(7);
    const name = "ca-thing";
    const path = `/nix/store/${storePathHashOf("source", base32Bytes(hash), name)}-${name}`;
    await putNar(cache, "main", payload);
    const accepted = await cache.acceptNarinfo(
      cache.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload, [])),
    );
    expect(accepted).toMatchObject({ ok: true, status: 200 });
    expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).toContain(
      `CA: fixed:r:sha256:${hash}`,
    );

    // A ROW FROM BEFORE THE PROOF: null, then proved at boot without a store.
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET ca = NULL, ca_proof = 'unknown'");
    db.close();
    expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).not.toContain("CA:");
    expect(await cache.boot()).toMatchObject({ caProved: 1 });
    expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).toContain("CA:");
    await cache.close();
  });

  it("proves a self-referencing CA at import, and backfills a null row at boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-self-cache-"));
    try {
      const drv = join(dir, "selfref.nix");
      writeFileSync(
        drv,
        'derivation { name = "selfref"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo $out > $out" ]; }',
      );
      const built = spawnSync(
        "nix",
        ["build", "--impure", "--no-link", "--print-out-paths", "-f", drv],
        { encoding: "utf-8" },
      );
      expect(built.status).toBe(0);
      const rewritten = spawnSync(
        "nix",
        ["store", "make-content-addressed", "--json", built.stdout.trim()],
        { encoding: "utf-8" },
      );
      expect(rewritten.status).toBe(0);
      const path = Object.values(
        (JSON.parse(rewritten.stdout) as { rewrites: Record<string, string> }).rewrites,
      )[0] as string;
      const info = JSON.parse(
        spawnSync("nix", ["path-info", "--json", path], { encoding: "utf-8" }).stdout,
      ) as Record<string, { ca: string | null; narHash: string; references: string[] }>;
      const facts = Object.values(info)[0];
      if (facts === undefined || facts.ca === null) throw new Error("no self CA");
      const nar = spawnSync("nix", ["store", "dump-path", path], { maxBuffer: 8 << 20 });
      expect(nar.status).toBe(0);
      const payload = {
        bytes: new Uint8Array(nar.stdout),
        narHash: canonicalNarHash(facts.narHash),
      };

      const logs: string[] = [];
      const cache = createCache({
        stateRoot: scratch,
        rootToken: ROOT,
        now: () => NOW,
        log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
      });
      await cache.admin.create(createInput);
      await putNar(cache, "main", payload);
      const accepted = await cache.acceptNarinfo(
        cache.bucket("main") as never,
        hashOf(path),
        stream(narinfoText(path, payload, facts.references)),
      );
      expect(accepted).toMatchObject({ ok: true, status: 200 });
      expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).toContain(
        `CA: ${facts.ca}`,
      );

      // A RETRIED PUT takes the second-possession branch (the staged NAR is
      // gone) and has no selfHash; the same NarHash must keep the proved CA.
      const retried = await cache.acceptNarinfo(
        cache.bucket("main") as never,
        hashOf(path),
        stream(narinfoText(path, payload, facts.references)),
      );
      expect(retried).toMatchObject({ ok: true, status: 200 });
      expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).toContain(
        `CA: ${facts.ca}`,
      );

      // THE BACKGROUND BACKFILL: the verdict is unknown (though a value may be
      // stored), so boot does not serve or read it; proveSelf reads once.
      const db = new Database(join(scratch, "cache", "cache.sqlite"));
      db.run("UPDATE object SET ca = ?, ca_proof = 'unknown'", [facts.ca]);
      db.close();
      expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).not.toContain("CA:");
      expect(await cache.boot()).toMatchObject({ caProved: 0 });
      expect(await cache.proveSelf()).toMatchObject({ rows: 1, proved: 1, refused: 0 });
      expect(cache.narinfoText(cache.bucket("main") as never, hashOf(path))).toContain(
        `CA: ${facts.ca}`,
      );
      // A SECOND PASS EXAMINES NOTHING: the verdict is persisted.
      expect(await cache.proveSelf()).toMatchObject({ rows: 0 });
      await cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a row whose object was never kept, then serves the object file", async () => {
    const path = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-migrated";
    const payload = nar("bytes the old store still has");
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    await putNar(first, "main", payload);
    await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload)),
    );
    first.close();
    const objectPath = join(scratch, "cache", "objects", "main", "nar", `${payload.narHash.slice(7)}.nar.zst`);
    rmSync(objectPath, { force: true });
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET file_hash = NULL, file_size = NULL");
    db.close();

    const orphanDir = join(scratch, "cache", "objects", "orphan", "nar");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "dead.nar.zst"), "no row");
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      now: () => NOW,
      migrationFreeFloor: 0,
      legacyStore: { dump: () => bytesStream(payload.bytes) },
    });
    expect(await second.boot()).toMatchObject({ orphansSwept: 1 });
    expect(await second.migrate()).toMatchObject({
      migrated: 1,
      complete: true,
      paused: null,
    });
    expect(await second.narSource(second.bucket("main") as never, `${payload.narHash.slice(7)}.nar.zst`)).toMatchObject({
      kind: "file",
      size: payload.bytes.length,
    });
    await second.close();
  });

  it("serves through the old store while the migration is still writing", async () => {
    const path = "/nix/store/cccccccccccccccccccccccccccccccc-transition";
    const payload = nar("bytes available from the old store");
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    await putNar(first, "main", payload);
    await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload)),
    );
    first.close();
    rmSync(join(scratch, "cache", "objects", "main", "nar", `${payload.narHash.slice(7)}.nar`), { force: true });
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET file_hash = NULL, file_size = NULL");
    db.close();

    const gate = Promise.withResolvers<void>();
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      now: () => NOW,
      migrationFreeFloor: 0,
      legacyStore: {
        dump: () =>
          new ReadableStream({
            async start(controller) {
              await gate.promise;
              controller.enqueue(payload.bytes);
              controller.close();
            },
          }),
      },
    });
    const migrating = second.migrate();
    // THE ROW ANSWERS NOW, through the transition path, before the put lands.
    expect(
      await second.narSource(second.bucket("main") as never, `${payload.narHash.slice(7)}.nar`),
    ).toMatchObject({ kind: "legacy" });
    gate.resolve();
    expect(await migrating).toMatchObject({ migrated: 1, complete: true });
    expect(
      await second.narSource(second.bucket("main") as never, `${payload.narHash.slice(7)}.nar`),
    ).toMatchObject({ kind: "file" });
    await second.close();
  });

  it("does not retain the migration's per-object producers", async () => {
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    const repo = openCacheRepo(join(scratch, "cache", "cache.sqlite"));
    const COUNT = 1000;
    for (let i = 0; i < COUNT; i++) {
      repo.putObject({
        bucket: "main",
        storePath: `/nix/store/${String(i).padStart(32, "0")}-migrated`,
        hash: String(i).padStart(32, "0"),
        // Unique per row; the migration never re-parses it.
        narHash: `sha256:${Math.floor(i / 2).toString(36).padEnd(52, "0")}`,
        narSize: 1024,
        references: [],
        deriver: null,
        ca: null,
        caProof: "unknown",
        compression: "zstd",
        fileHash: null,
        fileSize: null,
        sigs: [],
        hits: 0,
        created: 0,
        lastAccessed: 0,
      });
    }
    repo.close();
    first.close();

    const payload = new Uint8Array(1024);
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      now: () => NOW,
      migrationFreeFloor: 0,
      legacyStore: { dump: () => bytesStream(payload) },
      migrationRetryMs: 1,
    });
    const baseline = process.memoryUsage().rss;
    expect(await second.migrate()).toMatchObject({ migrated: COUNT, complete: true });
    // A full GC once, then the heap should be near where it started: the bug
    // was one live dump producer per TWIN row, not the bytes themselves.
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const growth = process.memoryUsage().rss - baseline;
    expect({ growth, within: growth < 192 * 1024 * 1024 }).toEqual({ growth, within: true });
    await second.close();
  });

  it("refuses old-store bytes whose NarHash is not the row's", async () => {
    const path = "/nix/store/abababababababababababababababab-mismatch";
    const payload = nar("bytes the row did not sign");
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    await putNar(first, "main", payload);
    await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload)),
    );
    first.close();
    rmSync(join(scratch, "cache", "objects", "main", "nar", `${payload.narHash.slice(7)}.nar`), { force: true });
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET file_hash = NULL, file_size = NULL");
    db.close();

    let dumped = false;
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      now: () => NOW,
      migrationFreeFloor: 0,
      legacyStore: {
        dump: () => {
          dumped = true;
          return bytesStream(payload.bytes);
        },
        pathInfo: async () => ({ ca: null, narHash: `sha256:${"f".repeat(52)}` }),
      },
    });
    expect(await second.migrate()).toMatchObject({ migrated: 0, failures: 1, complete: false });
    expect(dumped).toBe(false);
    await second.close();
  });

  it("close() returns while a migration is waiting on the old store", async () => {
    const path = "/nix/store/dddddddddddddddddddddddddddddddd-close";
    const payload = nar("bytes behind a stalled dump");
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    await putNar(first, "main", payload);
    await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload)),
    );
    first.close();
    rmSync(join(scratch, "cache", "objects", "main", "nar", `${payload.narHash.slice(7)}.nar`), { force: true });
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET file_hash = NULL, file_size = NULL");
    db.close();

    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      now: () => NOW,
      migrationFreeFloor: 0,
      legacyStore: {
        // NEVER PRODUCES A BYTE: close must cut the wait, not join it.
        dump: () => new ReadableStream({ start: () => {} }),
      },
    });
    const migrating = second.migrate();
    const closed = second.close();
    expect(
      await Promise.race([
        closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]),
    ).toBe("closed");
    expect(await migrating).toMatchObject({ complete: false });
  });

  it("pauses below the free-space floor, then resumes without a restart", async () => {
    const path = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-paused";
    const payload = nar("bytes that wait for disk");
    const first = cacheWith(ROOT);
    await first.admin.create(createInput);
    await putNar(first, "main", payload);
    await first.acceptNarinfo(
      first.bucket("main") as never,
      hashOf(path),
      stream(narinfoText(path, payload)),
    );
    first.close();
    rmSync(join(scratch, "cache", "objects", "main", "nar", `${payload.narHash.slice(7)}.nar.zst`), { force: true });
    const db = new Database(join(scratch, "cache", "cache.sqlite"));
    db.run("UPDATE object SET file_hash = NULL, file_size = NULL");
    db.close();

    let reads = 0;
    const second = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      now: () => NOW,
      migrationFreeFloor: 1024,
      migrationRetryMs: 1,
      // LOW ONCE, THEN SPACE RETURNS: the same run must resume.
      freeBytes: async () => (++reads === 1 ? 0 : 10 * 1024),
      legacyStore: { dump: () => bytesStream(payload.bytes) },
    });
    expect(await second.migrate()).toMatchObject({ migrated: 1, complete: true });
    await second.close();
  });
});
