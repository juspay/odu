/**
 * The ROUTES, over the real router and a fake store.
 *
 * `HttpRouter.toWebHandler` gives the same routing the listener uses — route
 * ranking, parameters, HEAD falling back to GET — as a `fetch`-shaped function,
 * so what is asserted here is what a client meets rather than what a handler
 * returns. The store is the fake, because half the matrix is about the answer
 * and the other half is about whether the store was reached at all.
 *
 * **Every upload here carries REAL bytes.** The cache hashes a staged NAR
 * against the narinfo's `NarHash` before it will import it, and that check is
 * the invariant the private-bucket story rests on — so a fixture that skipped
 * it would be testing a server nobody ships.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asRoot } from "./testlib";
import { HttpRouter } from "effect/http";
import { base32, storePathHash } from "./narinfo";
import { type Cache, createCache } from "./cache";
import { CACHE_MOUNT } from "./paths";
import { NIX_CACHE_INFO } from "./staging";
import { cacheRoutes } from "./routes";
import { FakeStore, hashOf } from "../test/fakeStore";

const ROOT = "root-token-please";
const NOW = 1_700_000_000_000;
const HELLO = "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3";
const GLIBC = "/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57";

/** Bytes, and the NAR hash a narinfo has to claim for them. */
function nar(text: string): { bytes: Uint8Array; narHash: string } {
  const bytes = new TextEncoder().encode(text);
  return { bytes, narHash: `sha256:${base32(createHash("sha256").update(bytes).digest())}` };
}

interface Harness {
  cache: Cache;
  store: FakeStore;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** The same listener without the mount prepended. */
  raw: (path: string, init?: RequestInit) => Promise<Response>;
  tokens: { read: string; write: string; admin: string };
  root: string;
  staging: string;
  dispose: () => Promise<void>;
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-routes-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Every file under the staging root, so a test can say "and nothing was
 *  written". */
function stagedFiles(): string[] {
  const root = join(scratch, "cache", "staging");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path.slice(root.length));
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return out.sort();
}

async function harness(publicBucket: boolean): Promise<Harness> {
  const store = new FakeStore();
  const hello = nar("a NAR, in pieces");
  store.add(
    {
      storePath: HELLO,
      narHash: hello.narHash,
      narSize: hello.bytes.length,
      // A self-reference only: the seed must be importable on its own.
      references: [HELLO],
      deriver: "/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv",
      sigs: ["cache.nixos.org-1:AAAA"],
      bytes: hello.bytes,
      chunks: 3,
    },
    false,
  );
  const cache = createCache({
    stateRoot: scratch,
    rootToken: ROOT,
    store: null,
    blob: store,
    now: () => NOW,
  });
  const created = await cache.admin.create({
    ...asRoot(ROOT),
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
  const { handler, dispose } = HttpRouter.toWebHandler(cacheRoutes(cache).layer, {
    disableLogger: true,
  });
  // The tests below name a path as a BUCKET names it (`/main/nix-cache-info`),
  // and this puts it where the protocol actually is. The mount is pinned on its
  // own, once, in "the protocol's mount is not the origin's first segment".
  const fetchIt = (path: string, init?: RequestInit): Promise<Response> =>
    handler(new Request(`http://127.0.0.1:18440${CACHE_MOUNT}${path}`, init));
  /** The listener as it really is, mount and all — for the one test that asks. */
  const raw = (path: string, init?: RequestInit): Promise<Response> =>
    handler(new Request(`http://127.0.0.1:18440${path}`, init));

  // SEEDED THROUGH THE PROTOCOL, not behind it: an object row exists because a
  // NAR and its narinfo were accepted, so the fixture is a push rather than a
  // row inserted past the code under test.
  expect((await upload(fetchIt, tokens.write, HELLO, hello)).status).toBe(200);

  return {
    cache,
    store,
    raw,
    tokens,
    root: ROOT,
    staging: join(scratch, "cache", "staging"),
    fetch: fetchIt,
    dispose,
  };
}

/** One complete upload: the NAR, then the narinfo that names it. */
async function upload(
  fetchIt: Harness["fetch"],
  token: string,
  storePath: string,
  payload: { bytes: Uint8Array; narHash: string },
  options: { references?: readonly string[]; narHash?: string; compression?: string; skipNar?: boolean } = {},
): Promise<Response> {
  const name = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
  if (options.skipNar !== true) {
    const put = await fetchIt(`/main/nar/${name}`, {
      ...bearer(token),
      method: "PUT",
      body: body(payload.bytes),
    });
    expect(put.status).toBe(200);
  }
  const narinfo = [
    `StorePath: ${storePath}`,
    `URL: nar/${name}`,
    `Compression: ${options.compression ?? "none"}`,
    `NarHash: ${options.narHash ?? payload.narHash}`,
    `NarSize: ${payload.bytes.length}`,
    `References: ${(options.references ?? []).map((path) => path.slice("/nix/store/".length)).join(" ")}`,
    "",
  ].join("\n");
  return fetchIt(`/main/${storePathHash(storePath)}.narinfo`, {
    ...bearer(token),
    method: "PUT",
    body: narinfo,
  });
}

async function mint(cache: Cache, scope: "read" | "write" | "admin"): Promise<string> {
  const minted = await cache.admin.tokenMint({
    ...asRoot(ROOT),
    bucket: "main",
    bucketGlob: null,
    scope,
    expiresDays: null,
  });
  if (!minted.ok) throw new Error(minted.message);
  return minted.value.token;
}

/** A `Uint8Array` as a request body. The DOM lib's `BodyInit` does not admit
 *  one directly in this TypeScript version, though every runtime does. */
const body = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const basic = (token: string): RequestInit => ({
  headers: { authorization: `Basic ${Buffer.from(`anyone:${token}`).toString("base64")}` },
});

describe("a bucket's consumer facts", () => {
  it("answers a PUBLIC bucket with no credential, and a private one only to a reader", async () => {
    const h = await harness(true);
    const json = await h.fetch("/main/", { headers: { accept: "application/json" } });
    expect(json.status).toBe(200);
    const facts = (await json.json()) as {
      name: string;
      url: string;
      publicKey: string;
      upstreamKeys: string[];
      use: string;
    };
    expect(facts).toMatchObject({ name: "main", publicKey: expect.stringContaining("main-1:") });
    expect(facts.url).toContain("/cache/main");
    expect(facts.upstreamKeys).toEqual(["cache.nixos.org-1"]);
    expect(facts.use).toContain("extra-substituters");
    // The SAME PAGE WITHOUT THE SLASH: the substituter URL a person pastes
    // into a browser is `…/cache/main`, and it must not fall to the shell.
    const bare = await h.fetch("/main");
    expect(bare.status).toBe(200);
    expect((await bare.text()).includes("extra-substituters")).toBe(true);
    // The PAGE is the same facts for a person with curl, and the key is in it.
    const page = await h.fetch("/main/");
    expect(page.status).toBe(200);
    // The PAGE carries the key too. (Checked as a substring of the key, not
    // of `facts`: a matcher with an asymmetric expectation can rewrite the
    // object it matched.)
    expect((await page.text()).includes("main-1:")).toBe(true);
    await h.dispose();
  });

  it("does not leak a private bucket's existence to an anonymous reader", async () => {
    const h = await harness(false);
    expect((await h.fetch("/main/")).status).toBe(404);
    // A reader with a read token is answered.
    const withToken = await h.fetch("/main/", {
      ...bearer(h.tokens.read),
      headers: { ...(bearer(h.tokens.read).headers as Record<string, string>), accept: "application/json" },
    });
    expect(withToken.status).toBe(200);
    await h.dispose();
  });
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
});

describe("narinfo", () => {
  it("serves the bucket's signature over the path", async () => {
    const h = await harness(true);
    const response = await h.fetch(`/main/${hashOf(HELLO)}.narinfo`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`StorePath: ${HELLO}`);
    expect(text).toContain("Compression: zstd");
    // The bucket's own signature first, and the client's kept beside it.
    expect(text).toMatch(/^Sig: main-1:/m);
    expect(text).toContain("Sig: cache.nixos.org-1:AAAA");
    await h.dispose();
  });

  it("signs AT READ TIME, so a rotated key cannot survive in a row", async () => {
    const h = await harness(true);
    const first = await (await h.fetch(`/main/${hashOf(HELLO)}.narinfo`)).text();
    // Two reads of one path produce the same signature over the same
    // fingerprint — and the row holds only the CLIENT's, never the bucket's.
    const second = await (await h.fetch(`/main/${hashOf(HELLO)}.narinfo`)).text();
    expect(second).toBe(first);
    expect(first.match(/^Sig: main-1:/gm)).toHaveLength(1);
    await h.dispose();
  });

  it("is a 404 for a path the bucket does not have", async () => {
    const h = await harness(true);
    expect((await h.fetch(`/main/${"0".repeat(32)}.narinfo`)).status).toBe(404);
    await h.dispose();
  });

  it("counts a HEAD as a read", async () => {
    const h = await harness(true);
    expect((await h.fetch(`/main/${hashOf(HELLO)}.narinfo`, { method: "HEAD" })).status).toBe(200);
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
    const name = `${"0".repeat(52)}.nar.zst`;
    expect((await h.fetch(`/main/nar/${name}`)).status).toBe(404);
    await h.dispose();
  });

  it("answers 404 — not 401 — to an anonymous read of a private bucket", async () => {
    // A 401 would confirm the bucket exists, and a private name must not be
    // enumerable.
    const h = await harness(false);
    const path = `/main/${hashOf(HELLO)}.narinfo`;
    expect((await h.fetch(path)).status).toBe(404);
    expect((await h.fetch(path, bearer(h.tokens.read))).status).toBe(200);
    expect((await h.fetch(path, basic(h.tokens.read))).status).toBe(200);
    // The root token is an admin credential, and admin covers read.
    expect((await h.fetch(path, bearer(h.root))).status).toBe(200);
    await h.dispose();
  });

  it("refuses a write without a token, and with a read token", async () => {
    const h = await harness(true);
    const narPath = "/main/nar/0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76.nar.zst";
    expect((await h.fetch(narPath, { method: "PUT", body: "x" })).status).toBe(401);
    expect((await h.fetch(narPath, { ...bearer(h.tokens.read), method: "PUT", body: "x" })).status).toBe(
      403,
    );
    expect((await h.fetch(narPath, { ...bearer(h.tokens.write), method: "PUT", body: "x" })).status).toBe(
      200,
    );
    await h.dispose();
  });

  it("refuses a revoked token, an expired token, and a token for another bucket", async () => {
    const h = await harness(false);
    const path = `/main/${hashOf(HELLO)}.narinfo`;

    const minted = await h.cache.admin.tokenMint({
      ...asRoot(ROOT),
      bucket: "main",
      bucketGlob: null,
      scope: "read",
      expiresDays: null,
    });
    if (!minted.ok) throw new Error(minted.message);
    await h.cache.admin.tokenRevoke({ ...asRoot(ROOT), id: minted.value.facts.id });
    expect((await h.fetch(path, bearer(minted.value.token))).status).toBe(403);

    // An expired token, written straight into the row: `now()` is frozen for
    // the harness, so the expiry is the only moving part.
    const expired = await h.cache.admin.tokenMint({
      ...asRoot(ROOT),
      bucket: "main",
      bucketGlob: null,
      scope: "read",
      expiresDays: 1,
    });
    if (!expired.ok) throw new Error(expired.message);
    const later = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      store: null,
      blob: h.store,
      now: () => NOW + 10 * 24 * 60 * 60 * 1000,
    });
    expect(later.bucket("main")?.name).toBe("main");
    expect(
      later.authorize(`Bearer ${expired.value.token}`, later.bucket("main") as never, "read"),
    ).toMatchObject({
      ok: false,
      status: 403,
      message: expect.stringContaining("expired on 2023-11-15"),
    });
    later.close();

    // A token minted for `main` cannot reach a bucket it does not cover.
    const other = await h.cache.admin.create({
      ...asRoot(ROOT),
      name: "other",
      public: false,
      retentionDays: 30,
      upstreamKeys: [],
    });
    expect(other.ok).toBe(true);
    expect(
      h.cache.authorize(`Bearer ${h.tokens.read}`, h.cache.bucket("other") as never, "read"),
    ).toMatchObject({ ok: false, status: 403 });
    await h.dispose();
  });

  it("reads a credential without backtracking on the header", async () => {
    const h = await harness(true);
    // A header is the one string on this face that arrives before anything is
    // authenticated, and it is somebody else's input. Ten thousand spaces is
    // the shape that made `/^Bearer\\s+(.+)$/i` try every split of `\\s+`
    // against `(.+)$`; the parse is one left-to-right scan, so this is linear
    // and the bound below is generous by three orders of magnitude.
    const spaces = `Bearer${" ".repeat(10_000)}`;
    const started = performance.now();
    const verdict = h.cache.authorize(spaces, h.cache.bucket("main") as never, "read");
    expect(performance.now() - started).toBeLessThan(250);
    // A wholesale-whitespace payload is still a PRESENTED credential: it is
    // refused as a token this service never minted (403), not as an absent one
    // (401) — the distinction costs an attacker nothing and keeps the answer
    // identical to the one the regex gave.
    expect(verdict).toMatchObject({ ok: false, status: 403 });
    // The same header with a failing tail: the case that actually backtracks,
    // because `$` cannot match before a trailing newline.
    const tail = h.cache.authorize(`${spaces}x\n`, h.cache.bucket("main") as never, "read");
    expect(tail).toMatchObject({ ok: false, status: 403 });
    await h.dispose();
  });

  it("mounts under a literal, so a bucket cannot shadow the board", async () => {
    const h = await harness(true);
    // The board serves `/assets/<hashed bundle>` on this same origin, and
    // `/assets` is a legal bucket name — so a bucket at the origin's first
    // segment stole the page's own JavaScript and rendered it blank. The
    // protocol answers under `CACHE_MOUNT` and NOWHERE else.
    expect(CACHE_MOUNT).toBe("/cache");
    expect((await h.fetch("/main/nix-cache-info")).status).toBe(200);
    expect((await h.raw("/main/nix-cache-info")).status).toBe(404);
    expect((await h.raw("/assets/main-abc123.js")).status).toBe(404);
    // A bucket NAMED after the mount still lives under it.
    const created = await h.cache.admin.create({
      ...asRoot(ROOT),
      name: "cache",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    expect(created.ok).toBe(true);
    expect((await h.fetch("/cache/nix-cache-info")).status).toBe(200);
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

describe("route parameters", () => {
  it("refuses a narinfo name that is not a store path hash, and writes nothing", async () => {
    const h = await harness(true);
    const before = stagedFiles();
    for (const name of ["..%2F..%2Fetc%2Fpasswd.narinfo", "short.narinfo", `${"z".repeat(32)}.narinfo`]) {
      const response = await h.fetch(`/main/${name}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: "StorePath: /nix/store/x\n",
      });
      expect({ name, status: response.status }).toEqual({ name, status: 400 });
    }
    expect(stagedFiles()).toEqual(before);
    await h.dispose();
  });

  it("refuses a NAR name with a slash or a leading dot", async () => {
    const h = await harness(true);
    const before = stagedFiles();
    for (const name of ["..%2Fescape.nar.zst", ".hidden.nar.zst", "a%2Fb.nar.zst"]) {
      const response = await h.fetch(`/main/nar/${name}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: "x",
      });
      expect({ name, status: response.status }).toEqual({ name, status: 400 });
    }
    expect(stagedFiles()).toEqual(before);
    await h.dispose();
  });
});

describe("the NAR", () => {
  it("streams the store's bytes, in the chunks the store produced", async () => {
    const h = await harness(true);
    const hello = nar("a NAR, in pieces");
    const response = await h.fetch(`/main/nar/${hello.narHash.replace(/^sha256:/, "")}.nar.zst`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-nix-nar");
    expect(await response.text()).toBe("a NAR, in pieces");
    expect(h.store.calls.filter((call) => call.op === "dump")).toHaveLength(1);
    await h.dispose();
  });

  it("finds the path by the hash alone, whatever compression the client asked for", async () => {
    const h = await harness(true);
    const hello = nar("a NAR, in pieces");
    const hash = hello.narHash.replace(/^sha256:/, "");
    expect((await h.fetch(`/main/nar/${hash}.nar.xz`)).status).toBe(200);
    expect((await h.fetch(`/main/nar/${"1".repeat(52)}.nar.zst`)).status).toBe(404);
    await h.dispose();
  });
});

describe("missing", () => {
  it("drops what the bucket has and what an upstream key signed", async () => {
    const h = await harness(true);
    const other = "/nix/store/00000000000000000000000000000000-unbuilt";
    const response = await h.raw("/_odu/v1/buckets/main/missing", {
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
    expect(await response.json()).toEqual({ missing: [other], skippedUpstream: [GLIBC] });
    await h.dispose();
  });

  it("takes everything when the bucket has no upstream keys", async () => {
    // A server whose store is not the machine that built the paths — a chroot
    // store on a volume, a fresh host — never holds nixpkgs, so a bucket that
    // skips upstream-signed paths leaves every referrer at 202 for ever. An
    // EMPTY list is the answer the surface already documents ("takes
    // everything"); this pins that the skip really is off, not just unused.
    const h = await harness(true);
    const created = await h.cache.admin.create({
      ...asRoot(ROOT),
      name: "everything",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    expect(created.ok).toBe(true);
    // A token minted for `main` cannot ask about this bucket, so mint one that
    // can: the point of the test is the upstream rule, not the scope rule.
    const scoped = await h.cache.admin.tokenMint({
      ...asRoot(ROOT),
      bucket: "everything",
      bucketGlob: null,
      scope: "write",
      expiresDays: null,
    });
    if (!scoped.ok) throw new Error(scoped.message);
    const write = bearer(scoped.value.token);
    const response = await h.raw("/_odu/v1/buckets/everything/missing", {
      ...write,
      method: "POST",
      headers: { ...write.headers, "content-type": "application/json" },
      body: JSON.stringify({ paths: [{ path: GLIBC, sigs: ["cache.nixos.org-1:AAAA"] }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ missing: [GLIBC], skippedUpstream: [] });
    await h.dispose();
  });

  it("needs write scope, and a body it can read", async () => {
    const h = await harness(true);
    expect((await h.raw("/_odu/v1/buckets/main/missing", { method: "POST", body: "{}" })).status).toBe(
      401,
    );
    const bad = await h.raw("/_odu/v1/buckets/main/missing", {
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
  it("records a path whose bytes match its narinfo", async () => {
    const h = await harness(true);
    const staged = "/nix/store/11111111111111111111111111111111-uploaded";
    const payload = nar("uploaded bytes");
    h.store.add(
      { storePath: staged, narHash: payload.narHash, narSize: payload.bytes.length, references: [] },
      false,
    );
    const response = await upload(h.fetch, h.tokens.write, staged, payload);
    expect(response.status).toBe(200);
    expect(h.store.calls.filter((call) => call.op === "import").map((call) => call.storePath)).toContain(
      staged,
    );
    const read = await h.fetch(`/main/${hashOf(staged)}.narinfo`);
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("Sig: main-1:");
    await h.dispose();
  });

  it("refuses a narinfo with no NAR behind it — even for a path the store already has", async () => {
    // THE HOLE: `nix copy --from` copies zero paths and exits 0 when the path
    // is already valid, never opening the NAR. Without the byte check, a write
    // token for one bucket publishes any path the store holds.
    const h = await harness(true);
    const priv = "/nix/store/22222222222222222222222222222222-private";
    const payload = nar("somebody else's bytes");
    // Valid in the store, and NOT in this bucket.
    h.store.add({ storePath: priv, narHash: payload.narHash, narSize: 1, references: [] }, true);

    const response = await upload(h.fetch, h.tokens.write, priv, payload, { skipNar: true });
    expect(response.status).toBe(400);
    // The BODY is the contract here, not prose: `odu cache push` reads this
    // sentence to decide whether to re-send the bytes, so the string is pinned
    // on purpose and the client's fallback is tested against the same words.
    expect(await response.text()).toContain("never uploaded");
    expect(h.store.calls.filter((call) => call.op === "import")).toHaveLength(1); // the seed only
    await h.dispose();
  });

  it("refuses bytes that do not hash to the narinfo's NarHash", async () => {
    const h = await harness(true);
    const staged = "/nix/store/33333333333333333333333333333333-truncated";
    const real = nar("the real bytes");
    const claimed = nar("the bytes somebody claimed");
    h.store.add({ storePath: staged, narHash: claimed.narHash, narSize: 1, references: [] }, false);

    const response = await upload(h.fetch, h.tokens.write, staged, real, {
      narHash: claimed.narHash,
    });
    expect(response.status).toBe(400);
    // Pinned for the same reason: the 400 body is what a pusher is told.
    expect(await response.text()).toContain("hashes to");
    expect((await h.fetch(`/main/${hashOf(staged)}.narinfo`)).status).toBe(404);
    await h.dispose();
  });

  it("refuses a narinfo whose name does not match the path it names", async () => {
    const h = await harness(true);
    const payload = nar("x");
    await h.fetch(`/main/nar/${payload.narHash.replace(/^sha256:/, "")}.nar.zst`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: body(payload.bytes),
    });
    const response = await h.fetch(`/main/${"2".repeat(32)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${HELLO}\nURL: nar/x.nar.zst\nCompression: none\nNarHash: ${payload.narHash}\nNarSize: 1\nReferences: \n`,
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

  it("answers 202 for an early upload, then records it when its reference lands", async () => {
    const h = await harness(true);
    const child = "/nix/store/44444444444444444444444444444444-child";
    const parent = "/nix/store/55555555555555555555555555555555-parent";
    const childPayload = nar("child bytes");
    const parentPayload = nar("parent bytes");
    h.store.add(
      { storePath: child, narHash: childPayload.narHash, narSize: 1, references: [] },
      false,
    );
    h.store.add(
      { storePath: parent, narHash: parentPayload.narHash, narSize: 1, references: [child] },
      false,
    );

    const early = await upload(h.fetch, h.tokens.write, parent, parentPayload, {
      references: [child],
    });
    expect(early.status).toBe(202);
    expect(await early.text()).toContain(child);
    expect((await h.fetch(`/main/${hashOf(parent)}.narinfo`)).status).toBe(404);

    const late = await upload(h.fetch, h.tokens.write, child, childPayload);
    expect(late.status).toBe(200);
    expect((await h.fetch(`/main/${hashOf(parent)}.narinfo`)).status).toBe(200);
    await h.dispose();
  });

  it("records twins whose NARs both land before either narinfo does", async () => {
    // THE INTERLEAVING A PUSH PRODUCES: one wave of four sends NAR A, NAR B,
    // narinfo A, narinfo B. Two store paths with identical content share one
    // NAR name, so recording A takes the file — and B's narinfo must still be
    // accepted, proved by the object A wrote and rebuilt from it.
    const h = await harness(true);
    const one = "/nix/store/66666666666666666666666666666666-one";
    const two = "/nix/store/77777777777777777777777777777777-two";
    const payload = nar("identical bytes");
    h.store.add({ storePath: one, narHash: payload.narHash, narSize: 1, references: [] }, false);
    h.store.add({ storePath: two, narHash: payload.narHash, narSize: 1, references: [] }, false);

    const name = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    for (const path of [one, two]) {
      const put = await h.fetch(`/main/nar/${name}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: body(payload.bytes),
      });
      expect({ path, status: put.status }).toEqual({ path, status: 200 });
    }
    // ONE staged NAR, not two: both uploads named the same file.
    expect(
      stagedFiles().filter((file) => file.endsWith(".nar.zst")),
    ).toHaveLength(1);

    const narinfo = (storePath: string): string =>
      `StorePath: ${storePath}\nURL: nar/${name}\nCompression: none\nNarHash: ${payload.narHash}\nNarSize: 1\nReferences: \n`;
    for (const path of [one, two]) {
      const put = await h.fetch(`/main/${hashOf(path)}.narinfo`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: narinfo(path),
      });
      expect({ path, status: put.status }).toEqual({ path, status: 200 });
    }
    expect((await h.fetch(`/main/${hashOf(one)}.narinfo`)).status).toBe(200);
    expect((await h.fetch(`/main/${hashOf(two)}.narinfo`)).status).toBe(200);
    await h.dispose();
  });

  it("reassembles a chunked NAR, refusing a gap", async () => {
    const h = await harness(true);
    const staged = "/nix/store/88888888888888888888888888888888-chunked";
    const payload = nar("bytes that arrive in pieces");
    h.store.add(
      { storePath: staged, narHash: payload.narHash, narSize: payload.bytes.length, references: [] },
      false,
    );
    const name = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const split = [payload.bytes.subarray(0, 5), payload.bytes.subarray(5)];
    const part = (index: number) =>
      h.raw(`/_odu/v1/buckets/main/nar/${name}/parts/${index}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: body(split[index] as Uint8Array),
      });
    const complete = () =>
      h.raw(`/_odu/v1/buckets/main/nar/${name}/complete`, {
        ...bearer(h.tokens.write),
        method: "POST",
        headers: {
          authorization: `Bearer ${h.tokens.write}`,
          "x-odu-parts": "2",
        },
      });

    expect((await part(0)).status).toBe(204);
    // A GAP IS THE CLIENT'S TO FILL: the answer names the index, not a
    // half-assembled NAR.
    const gap = await complete();
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ missing: [1] });

    expect((await part(1)).status).toBe(204);
    expect((await complete()).status).toBe(200);
    // The narinfo then proves the joined bytes exactly as it would a single
    // request — the chunking is invisible to the proof.
    const narinfo = await h.fetch(`/main/${hashOf(staged)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${staged}\nURL: nar/${name}\nCompression: none\nNarHash: ${payload.narHash}\nNarSize: ${payload.bytes.length}\nReferences: \n`,
    });
    expect(narinfo.status).toBe(200);
    expect((await h.fetch(`/main/${hashOf(staged)}.narinfo`)).status).toBe(200);
    await h.dispose();
  });
});

describe("a private read is not shareable", () => {
  it("marks a public bucket's read shareable, with no cache header", async () => {
    const pub = await harness(true);
    expect(
      (await pub.fetch(`/main/${hashOf(HELLO)}.narinfo`)).headers.get("cache-control"),
    ).toBeNull();
    await pub.dispose();
  });

  it("marks a private bucket's narinfo and NAR private, no-store", async () => {
    const priv = await harness(false);
    const narinfo = await priv.fetch(`/main/${hashOf(HELLO)}.narinfo`, bearer(priv.tokens.read));
    expect(narinfo.status).toBe(200);
    expect(narinfo.headers.get("cache-control")).toBe("private, no-store");
    const url = (await narinfo.text())
      .split("\n")
      .find((line) => line.startsWith("URL: "))!
      .slice(5);
    const nar = await priv.fetch(`/main/${url}`, bearer(priv.tokens.read));
    expect(nar.status).toBe(200);
    expect(nar.headers.get("cache-control")).toBe("private, no-store");
    await priv.dispose();
  });
});

describe("a bucket's domain", () => {
  it("answers the Nix protocol at the root of its name, and 404s another name", async () => {
    const h = await harness(true);
    const named = await h.cache.admin.domain({
      ...asRoot(ROOT),
      bucket: "main",
      domain: "cache.example.org",
    });
    expect(named.ok).toBe(true);
    const host = (path: string, init: RequestInit = {}): Promise<Response> =>
      h.raw(path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), host: "cache.example.org" },
      });

    const info = await host("/nix-cache-info");
    expect(info.status).toBe(200);
    expect(await info.text()).toContain("WantMassQuery");

    const narinfo = await host(`/${hashOf(HELLO)}.narinfo`);
    expect(narinfo.status).toBe(200);
    const text = await narinfo.text();
    expect(text).toContain("Sig: main-1:");
    const nar = await host(`/${text.split("\n").find((line) => line.startsWith("URL: "))!.slice(5)}`);
    expect(nar.status).toBe(200);

    // THE WRONG NAME IS A 404, not the path form and not the shell.
    expect(
      (await h.raw("/nix-cache-info", { headers: { host: "other.example.org" } })).status,
    ).toBe(404);
    // And the claim is the hash's shape, not every one-segment path.
    expect((await host("/sw.js")).status).toBe(404);
    await h.dispose();
  });
});

describe("the shell's own paths", () => {
  it("is not reached by the cache's two-segment GET", async () => {
    // `/:bucket/:name` is the narinfo route, and the shell serves fixed assets
    // beside it. None of these is two segments, so none can match — pinned
    // because a future fixed path that IS two segments belongs above this
    // layer, not beside it.
    const h = await harness(true);
    for (const path of ["/sw.js", "/manifest.webmanifest", "/_app/assets/x.js"]) {
      const status = await h
        .fetch(path)
        .then((response) => response.status)
        .catch(() => 404);
      expect({ path, handled: status === 200 }).toEqual({ path, handled: false });
    }
    await h.dispose();
  });
});
