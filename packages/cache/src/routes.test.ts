/**
 * The ROUTES, over the real router and a fake store.
 *
 * `HttpRouter.toWebHandler` gives the same routing the listener uses — route
 * ranking, parameters, HEAD falling back to GET — as a `fetch`-shaped function,
 * so what is asserted here is what a client meets rather than what a handler
 * returns. The store is the fake, because half the matrix is about the answer
 * and the other half is about whether the store was reached at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HttpRouter } from "effect/http";
import { createCache, type Cache, NIX_CACHE_INFO } from "./cache";
import { parseNarinfo } from "./narinfo";
import { cacheRoutes } from "./routes";
import { FakeStore, hashOf, narBase32Of } from "../test/fakeStore";

const ROOT = "root-token-please";
const NOW = 1_700_000_000_000;
const HELLO = "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3";
const GLIBC = "/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57";

interface Harness {
  cache: Cache;
  store: FakeStore;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  tokens: { read: string; write: string; admin: string };
  root: string;
  dispose: () => Promise<void>;
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-routes-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function harness(publicBucket: boolean): Promise<Harness> {
  const store = new FakeStore();
  const narHash = "sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76";
  store.add({
    storePath: HELLO,
    narHash,
    narSize: 279592,
    // A self-reference only: the seed must be importable on its own, and the
    // narinfo's `References` line is what the row records.
    references: [HELLO],
    deriver: "/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv",
    sigs: ["cache.nixos.org-1:AAAA"],
    bytes: new TextEncoder().encode("a NAR, in pieces"),
    chunks: 3,
  });
  const cache = createCache({ stateRoot: scratch, rootToken: ROOT, store: null, blob: store, now: () => NOW });
  const created = await cache.admin.create({
    rootToken: ROOT,
    name: "main",
    public: publicBucket,
    retentionDays: 30,
    upstreamKeys: ["cache.nixos.org-1"],
  });
  expect(created.ok).toBe(true);

  const tokens = {
    read: await mint(cache, "read"),
    write: await mint(cache, "write"),
    admin: await mint(cache, "admin"),
  };
  const { handler, dispose } = HttpRouter.toWebHandler(cacheRoutes(cache), { disableLogger: true });
  const fetchIt = (path: string, init?: RequestInit): Promise<Response> =>
    handler(new Request(`http://127.0.0.1:18440${path}`, init));

  // SEEDED THROUGH THE PROTOCOL, not behind it: an object row exists because a
  // narinfo was accepted, so the fixture is a push rather than a row inserted
  // past the code under test.
  const seeded = await fetchIt(`/main/${hashOf(HELLO)}.narinfo`, {
    ...bearer(tokens.write),
    method: "PUT",
    body: [
      `StorePath: ${HELLO}`,
      `URL: nar/x.nar.zst`,
      "Compression: zstd",
      `NarHash: ${narHash}`,
      "NarSize: 279592",
      `References: ${HELLO.slice("/nix/store/".length)} ${GLIBC.slice("/nix/store/".length)}`,
      "",
    ].join("\n"),
  });
  expect(seeded.status).toBe(200);

  return { cache, store, tokens, root: ROOT, fetch: fetchIt, dispose };
}

async function mint(cache: Cache, scope: "read" | "write" | "admin"): Promise<string> {
  const minted = await cache.admin.tokenMint({
    rootToken: ROOT,
    bucket: "main",
    scope,
    expiresDays: null,
  });
  if (!minted.ok) throw new Error(minted.message);
  return minted.value.token;
}

/** The imports attempted after the fixture was seeded — the seed itself is a
 *  push through the same route, and counting it would say nothing. */
const importsSince = (store: FakeStore, from: number): string[] =>
  store.calls
    .slice(from)
    .filter((call) => call.op === "import")
    .map((call) => call.storePath);

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const basic = (token: string): RequestInit => ({
  headers: { authorization: `Basic ${Buffer.from(`anyone:${token}`).toString("base64")}` },
});

describe("nix-cache-info", () => {
  it("answers the three lines a client reads first", async () => {
    const h = await harness(true);
    const response = await h.fetch("/main/nix-cache-info");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NIX_CACHE_INFO);
    await h.dispose();
  });

  it("is a 404 for a bucket that does not exist", async () => {
    const h = await harness(true);
    expect((await h.fetch("/nope/nix-cache-info")).status).toBe(404);
    await h.dispose();
  });

  it("needs a read token when the bucket is private", async () => {
    const h = await harness(false);
    expect((await h.fetch("/main/nix-cache-info")).status).toBe(401);
    expect((await h.fetch("/main/nix-cache-info", bearer(h.tokens.read))).status).toBe(200);
    await h.dispose();
  });
});

describe("narinfo", () => {
  it("serves the bucket's signature over the path", async () => {
    const h = await harness(true);
    const response = await h.fetch(`/main/${hashOf(HELLO)}.narinfo`);
    expect(response.status).toBe(200);
    const info = parseNarinfo(await response.text());
    expect(info.storePath).toBe(HELLO);
    expect(info.narHash).toBe("sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76");
    expect(info.url).toBe("nar/0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76.nar.zst");
    expect(info.compression).toBe("zstd");
    // The bucket's own signature first, and the client's kept beside it.
    expect(info.sigs[0]?.startsWith("main-1:")).toBe(true);
    expect(info.sigs).toContain("cache.nixos.org-1:AAAA");
    await h.dispose();
  });

  it("is a 404 for a path the bucket does not have", async () => {
    const h = await harness(true);
    expect((await h.fetch(`/main/${"0".repeat(32)}.narinfo`)).status).toBe(404);
    await h.dispose();
  });

  it("counts a HEAD as a read", async () => {
    const h = await harness(true);
    const before = h.cache.bucket("main");
    expect(before).not.toBeNull();
    const response = await h.fetch(`/main/${hashOf(HELLO)}.narinfo`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect((await h.fetch(`/main/${"0".repeat(32)}.narinfo`, { method: "HEAD" })).status).toBe(404);
    await h.dispose();
  });

  it("does not answer a name that is not a narinfo", async () => {
    const h = await harness(true);
    expect((await h.fetch("/main/hello-2.12.3")).status).toBe(404);
    await h.dispose();
  });
});

describe("the auth matrix", () => {
  it("lets a public bucket read with no token at all", async () => {
    const h = await harness(true);
    expect((await h.fetch(`/main/${hashOf(HELLO)}.narinfo`)).status).toBe(200);
    expect((await h.fetch(`/main/nar/${narBase32Of({ storePath: HELLO, narHash: "sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76", narSize: 1, references: [] })}.nar.zst`)).status).toBe(200);
    await h.dispose();
  });

  it("refuses a private bucket's read, and takes either credential form", async () => {
    const h = await harness(false);
    const path = `/main/${hashOf(HELLO)}.narinfo`;
    expect((await h.fetch(path)).status).toBe(401);
    expect((await h.fetch(path, bearer(h.tokens.read))).status).toBe(200);
    expect((await h.fetch(path, basic(h.tokens.read))).status).toBe(200);
    // The root token is an admin credential, and admin covers read.
    expect((await h.fetch(path, bearer(h.root))).status).toBe(200);
    await h.dispose();
  });

  it("refuses a write without a token, and with a read token", async () => {
    const h = await harness(true);
    const nar = "/main/nar/0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76.nar.zst";
    expect((await h.fetch(nar, { method: "PUT", body: "x" })).status).toBe(401);
    expect((await h.fetch(nar, { ...bearer(h.tokens.read), method: "PUT", body: "x" })).status).toBe(
      403,
    );
    expect((await h.fetch(nar, { ...bearer(h.tokens.write), method: "PUT", body: "x" })).status).toBe(
      200,
    );
    await h.dispose();
  });

  it("refuses a revoked token, and a token for another bucket", async () => {
    const h = await harness(false);
    const minted = await h.cache.admin.tokenMint({
      rootToken: ROOT,
      bucket: "main",
      scope: "read",
      expiresDays: null,
    });
    if (!minted.ok) throw new Error(minted.message);
    await h.cache.admin.tokenRevoke({ rootToken: ROOT, id: minted.value.facts.id });
    expect((await h.fetch(`/main/${hashOf(HELLO)}.narinfo`, bearer(minted.value.token))).status).toBe(
      403,
    );
    await h.dispose();
  });

  it("is a 404 for an unknown bucket on every route", async () => {
    const h = await harness(true);
    for (const [path, init] of [
      ["/nope/nix-cache-info", {}],
      [`/nope/${hashOf(HELLO)}.narinfo`, {}],
      ["/nope/nar/x.nar.zst", {}],
      ["/nope/nar/x.nar.zst", { method: "PUT", body: "x" }],
      [`/nope/${hashOf(HELLO)}.narinfo`, { method: "PUT", body: "x" }],
      ["/_odu/v1/buckets/nope/missing", { method: "POST", body: '{"paths":[]}' }],
    ] as const) {
      const response = await h.fetch(path, init as RequestInit);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    await h.dispose();
  });
});

describe("the NAR", () => {
  it("streams the store's bytes, in the chunks the store produced", async () => {
    const h = await harness(true);
    const file = `${"0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76"}.nar.zst`;
    const response = await h.fetch(`/main/nar/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-nix-nar");
    expect(await response.text()).toBe("a NAR, in pieces");
    expect(h.store.calls.filter((call) => call.op === "dump")).toHaveLength(1);
    await h.dispose();
  });

  it("finds the path by the hash alone, whatever compression the client asked for", async () => {
    const h = await harness(true);
    const base = "0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76";
    expect((await h.fetch(`/main/nar/${base}.nar.xz`)).status).toBe(200);
    expect((await h.fetch(`/main/nar/${"1".repeat(52)}.nar.zst`)).status).toBe(404);
    await h.dispose();
  });
});

describe("missing", () => {
  it("drops what the bucket has and what an upstream key signed", async () => {
    const h = await harness(true);
    const other = "/nix/store/00000000000000000000000000000000-unbuilt";
    const response = await h.fetch("/_odu/v1/buckets/main/missing", {
      ...bearer(h.tokens.write),
      method: "POST",
      headers: { ...bearer(h.tokens.write).headers, "content-type": "application/json" },
      body: JSON.stringify({
        paths: [
          { path: HELLO },
          { path: GLIBC, sigs: ["cache.nixos.org-1:AAAA"] },
          { path: other },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      missing: [other],
      skippedUpstream: [GLIBC],
    });
    await h.dispose();
  });

  it("needs write scope, and a body it can read", async () => {
    const h = await harness(true);
    expect((await h.fetch("/_odu/v1/buckets/main/missing", { method: "POST", body: "{}" })).status).toBe(
      401,
    );
    const bad = await h.fetch("/_odu/v1/buckets/main/missing", {
      ...bearer(h.tokens.write),
      method: "POST",
      headers: { ...bearer(h.tokens.write).headers, "content-type": "application/json" },
      body: '{"paths": "nope"}',
    });
    expect(bad.status).toBe(400);
    await h.dispose();
  });
});

describe("uploading", () => {
  it("stages a NAR and imports the pair when the narinfo arrives", async () => {
    const h = await harness(true);
    const staged = "/nix/store/11111111111111111111111111111111-uploaded";
    const narHash = "sha256:1z60yvla06nbvnmxpnmcnpimjmrd5yf5yn637jgvxplsr34dxfdx";
    // Metadata only: the bytes arrive with the upload, so the store does not
    // have it until the import.
    h.store.add({ storePath: staged, narHash, narSize: 42, references: [] }, false);

    const seedCalls = h.store.calls.length;
    const putNar = await h.fetch(`/main/nar/1z60yvla06nbvnmxpnmcnpimjmrd5yf5yn637jgvxplsr34dxfdx.nar.zst`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(putNar.status).toBe(200);

    const narinfo = [
      `StorePath: ${staged}`,
      "URL: nar/1z60yvla06nbvnmxpnmcnpimjmrd5yf5yn637jgvxplsr34dxfdx.nar.zst",
      "Compression: zstd",
      `NarHash: ${narHash}`,
      "NarSize: 42",
      "References: ",
      "",
    ].join("\n");
    const putInfo = await h.fetch(`/main/${hashOf(staged)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: narinfo,
    });
    expect(putInfo.status).toBe(200);
    expect(importsSince(h.store, seedCalls)).toEqual([staged]);
    expect(h.cache.bucket("main")).not.toBeNull();
    // And it is now readable, signed by the bucket.
    const read = await h.fetch(`/main/${hashOf(staged)}.narinfo`);
    expect(read.status).toBe(200);
    expect(parseNarinfo(await read.text()).sigs[0]?.startsWith("main-1:")).toBe(true);
    await h.dispose();
  });

  it("refuses a narinfo whose name does not match the path it names", async () => {
    const h = await harness(true);
    const response = await h.fetch(`/main/${"2".repeat(32)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${HELLO}\nURL: nar/x.nar.zst\nNarHash: sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76\nNarSize: 1\nReferences: \n`,
    });
    expect(response.status).toBe(400);
    await h.dispose();
  });

  it("refuses a narinfo it cannot parse", async () => {
    const h = await harness(true);
    const response = await h.fetch(`/main/${hashOf(HELLO)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: "this is not a narinfo",
    });
    expect(response.status).toBe(400);
    await h.dispose();
  });

  it("accepts an early upload and imports it once its references land", async () => {
    const h = await harness(true);
    const child = "/nix/store/33333333333333333333333333333333-child";
    const parent = "/nix/store/44444444444444444444444444444444-parent";
    h.store.add(
      { storePath: child, narHash: `sha256:${"3".repeat(52)}`, narSize: 1, references: [] },
      false,
    );
    h.store.add(
      {
        storePath: parent,
        narHash: `sha256:${"4".repeat(52)}`,
        narSize: 1,
        references: [child],
      },
      false,
    );
    const seedCalls = h.store.calls.length;

    const narinfoOf = (storePath: string, narHash: string, refs: string): string =>
      `StorePath: ${storePath}\nURL: nar/x.nar.zst\nCompression: zstd\nNarHash: ${narHash}\nNarSize: 1\nReferences: ${refs}\n`;

    // The parent arrives FIRST, and its reference is not in the store yet.
    const early = await h.fetch(`/main/${hashOf(parent)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: narinfoOf(parent, `sha256:${"4".repeat(52)}`, child.slice("/nix/store/".length)),
    });
    expect(early.status).toBe(200);
    expect(h.cache.bucket("main")).not.toBeNull();

    // The child lands; the deferred parent is imported on the next pass.
    const late = await h.fetch(`/main/${hashOf(child)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: narinfoOf(child, `sha256:${"3".repeat(52)}`, ""),
    });
    expect(late.status).toBe(200);
    // The early attempt, then the child, then the deferred parent on the next
    // pass — the order that makes an out-of-order closure land.
    expect(importsSince(h.store, seedCalls)).toEqual([parent, parent, child, parent]);
    expect((await h.fetch(`/main/${hashOf(parent)}.narinfo`)).status).toBe(200);
    await h.dispose();
  });
});

describe("bucket keys", () => {
  it("is generated per bucket, in Nix's spelling", async () => {
    const h = await harness(true);
    const bucket = h.cache.bucket("main");
    expect(bucket?.keyName).toBe("main-1");
    expect(bucket?.publicKey.split(":")[0]).toBe("main-1");
    expect(Buffer.from(bucket?.publicKey.split(":")[1] as string, "base64")).toHaveLength(32);
    await h.dispose();
  });
});
