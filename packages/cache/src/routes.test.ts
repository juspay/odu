import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { asRoot, localStores } from "./testlib";
import { HttpRouter } from "effect/http";
import { base32, storePathHash } from "./narinfo";
import { base32Bytes, storePathHashOf } from "./storePath";
import { type Cache, createCache } from "./cache";
import { openCacheRepo } from "./db";
import { CACHE_MOUNT } from "./paths";
import { nixCacheInfo } from "./staging";
import { cacheRoutes } from "./routes";
import { FakeStore, hashOf } from "../test/fakeStore";
import { type Gateway, startGateway } from "@odu/objects/testing";
import { type ObjectStore, s3ObjectStore } from "@odu/objects";

let gateway: Gateway;
beforeAll(async () => {
  gateway = await startGateway();
});
afterAll(async () => {
  await gateway.stop();
});

interface Where {
  name: string;
  store?: () => Promise<ObjectStore>;
}
const ON_DISK: Where = { name: "local" };
const ON_S3: Where = {
  name: "s3",
  store: async () => s3ObjectStore({ target: await gateway.bucket() }),
};

const ROOT = "root-token-please";
const NOW = 1_700_000_000_000;
let clock = NOW;
const HELLO = "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3";
const GLIBC = "/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57";

function nar(text: string): { bytes: Uint8Array; narHash: string } {
  const bytes = new TextEncoder().encode(text);
  return { bytes, narHash: `sha256:${base32(createHash("sha256").update(bytes).digest())}` };
}

interface Harness {
  cache: Cache;
  store: FakeStore;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  raw: (path: string, init?: RequestInit) => Promise<Response>;
  tokens: { read: string; write: string; admin: string };
  root: string;
  staging: string;
  dispose: () => Promise<void>;
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-routes-"));
  clock = NOW;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

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

async function harness(
  publicBucket: boolean,
  boardOrigin = "https://odu.example.org",
  log?: (event: string, fields: Record<string, unknown>) => void,
  where: Where = ON_DISK,
): Promise<Harness> {
  const store = new FakeStore();
  const hello = nar("a NAR, in pieces");
  store.add(
    {
      storePath: HELLO,
      narHash: hello.narHash,
      narSize: hello.bytes.length,
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
    publicOrigin: boardOrigin,
    legacyStore: { dump: (path) => store.dump(path) },
    now: () => clock,
    log,
    stores: new Map([
      ...localStores(scratch),
      ...(where.store === undefined ? [] : [[where.name, await where.store()] as const]),
    ]),
  });
  const created = await cache.admin.create({
    ...asRoot(ROOT),
    name: "main",
    public: publicBucket,
    retentionDays: 30,
    upstreamKeys: ["cache.nixos.org-1"],
    store: where.name,
  });
  expect(created.ok).toBe(true);

  const tokens = {
    read: await mint(cache, "read"),
    write: await mint(cache, "write"),
    admin: await mint(cache, "admin"),
  };
  const { handler, dispose } = HttpRouter.toWebHandler(
    cacheRoutes(cache, (name) => `${CACHE_MOUNT}/${name}`).layer,
    { disableLogger: true },
  );
  const fetchIt = (path: string, init?: RequestInit): Promise<Response> =>
    handler(new Request(`http://127.0.0.1:18440${CACHE_MOUNT}${path}`, init));
  const raw = (path: string, init?: RequestInit): Promise<Response> =>
    handler(new Request(`http://127.0.0.1:18440${path}`, init));

  expect((await upload(fetchIt, tokens.write, HELLO, hello, { sigs: ["cache.nixos.org-1:AAAA"] })).status).toBe(200);

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

function asPreObjectRow(storePath: string, file: string): void {
  rmSync(join(scratch, "cache", "objects", "main", "nar", file), { force: true });
  const repo = openCacheRepo(join(scratch, "cache", "cache.sqlite"));
  const row = repo.object("main", storePath);
  if (row === null) throw new Error(`no row for ${storePath}`);
  repo.putObject({ ...row, fileHash: null, fileSize: null });
  repo.close();
}

async function upload(
  fetchIt: Harness["fetch"],
  token: string,
  storePath: string,
  payload: { bytes: Uint8Array; narHash: string },
  options: {
    references?: readonly string[];
    narHash?: string;
    compression?: string;
    skipNar?: boolean;
    ca?: string;
    sigs?: readonly string[];
  } = {},
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
    ...(options.ca === undefined ? [] : [`CA: ${options.ca}`]),
    ...(options.sigs ?? []).map((sig) => `Sig: ${sig}`),
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

/** The DOM lib's `BodyInit` does not admit a `Uint8Array` directly in this
 *  TypeScript version, though every runtime does. */
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
    expect(facts).toMatchObject({
      name: "main",
      publicKey: expect.stringContaining("main-1:"),
    });
    expect(facts.url).toContain("/cache/main");
    expect(facts.upstreamKeys).toEqual(["cache.nixos.org-1"]);
    expect(facts.use).toContain("extra-substituters");
    const bare = await h.fetch("/main");
    expect(bare.status).toBe(200);
    expect((await bare.text()).includes("extra-substituters")).toBe(true);
    const page = await h.fetch("/main/");
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body.includes("main-1:")).toBe(true);
    for (const title of ["nix.conf", "NixOS / nix-darwin", "flake.nix", "GitHub Actions"]) {
      expect({ title, heading: body.includes(`<h3>${title}</h3>`) }).toEqual({
        title,
        heading: true,
      });
    }
    expect(body.split(`<button type="button" data-copy>`).length - 1).toBe(5);
    expect(body.includes("netrc-file")).toBe(false);
    expect(body).toContain(`odu cache push --cache ${facts.url} &lt;paths&gt;`);
    expect(body).toContain(
      `<a href="/cache/main/nix-cache-info">nix-cache-info</a>`,
    );
    expect(body).toContain(
      `<p class="served">served by <a href="https://odu.kolu.dev/">odu</a></p>`,
    );
    await h.dispose();
  });

  it("does not leak a private bucket's existence to an anonymous reader", async () => {
    const h = await harness(false);
    expect((await h.fetch("/main/")).status).toBe(404);
    const withToken = await h.fetch("/main/", {
      ...bearer(h.tokens.read),
      headers: { ...(bearer(h.tokens.read).headers as Record<string, string>), accept: "application/json" },
    });
    expect(withToken.status).toBe(200);
    const page = await h.fetch("/main/", bearer(h.tokens.read));
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("<h3>netrc</h3>");
    expect(body).toContain("netrc-file");
    await h.dispose();
  });
});

describe("nix-cache-info", () => {
  it("answers the three lines a client reads first, and loses the tie to nixos.org", async () => {
    const h = await harness(true);
    const response = await h.fetch("/main/nix-cache-info");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe(nixCacheInfo({ origin: "https://odu.example.org", bucket: "main" }));
    // 41 is one WORSE than cache.nixos.org's 40, so an upstream-signed path
    // this bucket also holds is fetched from the CDN whatever order a
    // client's `substituters` are in.
    expect(text).toContain("Priority: 41\n");
    await h.dispose();
  });

  it("names the daemon a push goes to, and the bucket it is pushing to", async () => {
    const h = await harness(true);
    const text = await (await h.fetch("/main/nix-cache-info")).text();
    expect(text).toContain("Odu-Origin: https://odu.example.org\n");
    expect(text).toContain("Odu-Bucket: main\n");
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
    expect(text).toContain("Compression: none");
    expect(text).toMatch(/^Sig: main-1:/m);
    expect(text).toContain("Sig: cache.nixos.org-1:AAAA");
    await h.dispose();
  });

  it("signs AT READ TIME, so a rotated key cannot survive in a row", async () => {
    const h = await harness(true);
    const first = await (await h.fetch(`/main/${hashOf(HELLO)}.narinfo`)).text();
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

  it("serves the CA its path proves, and ignores the pusher's claim", async () => {
    const h = await harness(true);
    const payload = nar("a content-addressed NAR");
    const hash = payload.narHash.slice(7);
    const name = "ca-route";
    const path = `/nix/store/${storePathHashOf("source", base32Bytes(hash), name)}-${name}`;
    const put = await upload(h.fetch, h.tokens.write, path, payload, {
      ca: `fixed:r:sha256:${"B".repeat(52)}`,
    });
    expect(put.status).toBe(200);
    const served = await (await h.fetch(`/main/${hashOf(path)}.narinfo`)).text();
    expect(served.split("\n")).toContain(`CA: fixed:r:sha256:${hash}`);
    await h.dispose();
  });

  it("refuses a derivation's narinfo", async () => {
    const h = await harness(true);
    const drv = "/nix/store/11111111111111111111111111111111-thing.drv";
    const response = await h.fetch(`/main/${hashOf(drv)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${drv}\nURL: nar/x.nar.zst\nNarHash: sha256:${"0".repeat(52)}\nNarSize: 1\nReferences: \n`,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("is a derivation");
    await h.dispose();
  });

  it("does not answer a name that is not a narinfo", async () => {
    const h = await harness(true);
    const notProtocol = await h.fetch("/main/hello-2.12.3");
    expect(notProtocol.status).toBe(404);
    expect(await notProtocol.text()).toContain("no such cache path");
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
    const h = await harness(false);
    const path = `/main/${hashOf(HELLO)}.narinfo`;
    expect((await h.fetch(path)).status).toBe(404);
    expect((await h.fetch(path, bearer(h.tokens.read))).status).toBe(200);
    expect((await h.fetch(path, basic(h.tokens.read))).status).toBe(200);
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
      stores: localStores(scratch),
      rootToken: ROOT,
      publicOrigin: "https://odu.example.org",
      legacyStore: { dump: (path) => h.store.dump(path) },
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
    const spaces = `Bearer${" ".repeat(10_000)}`;
    const started = performance.now();
    const verdict = h.cache.authorize(spaces, h.cache.bucket("main") as never, "read");
    expect(performance.now() - started).toBeLessThan(250);
    expect(verdict).toMatchObject({ ok: false, status: 403 });
    const tail = h.cache.authorize(`${spaces}x\n`, h.cache.bucket("main") as never, "read");
    expect(tail).toMatchObject({ ok: false, status: 403 });
    await h.dispose();
  });

  it("mounts under a literal, so a bucket cannot shadow the board", async () => {
    const h = await harness(true);
    expect(CACHE_MOUNT).toBe("/cache");
    expect((await h.fetch("/main/nix-cache-info")).status).toBe(200);
    expect((await h.raw("/main/nix-cache-info")).status).toBe(404);
    expect((await h.raw("/assets/main-abc123.js")).status).toBe(404);
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

describe("operational lines", () => {
  it("logs one line for a served NAR and one for a refusal", async () => {
    const lines: string[] = [];
    const h = await harness(true, "https://odu.example.org", (event, fields) =>
      lines.push(`${event} ${JSON.stringify(fields)}`),
    );
    const hello = nar("a NAR, in pieces");
    const response = await h.fetch(`/main/nar/${hello.narHash.replace(/^sha256:/, "")}.nar.zst`);
    expect(lines.some((line) => line.startsWith("cache.nar.served"))).toBe(false);
    await response.arrayBuffer();
    const servedLine = lines.find((line) => line.startsWith("cache.nar.served"));
    expect(servedLine).toContain('"source":"object"');
    expect(servedLine).toContain(`"bytes":${hello.bytes.length}`);
    expect(servedLine).toContain('"cancelled":false');

    const cancelled = await h.fetch(`/main/nar/${hello.narHash.replace(/^sha256:/, "")}.nar.zst`);
    await cancelled.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      lines.some((line) => line.startsWith("cache.nar.served") && line.includes('"cancelled":true')),
    ).toBe(true);

    await h.fetch("/main/nar/.hidden.nar.zst");
    expect(lines.some((line) => line.startsWith("cache.request.refused") && line.includes("not a NAR file name"))).toBe(true);
    await h.dispose();
  });

  it("logs one narinfo line per read — hit and miss, on both of the routes that serve one", async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const h = await harness(true, "https://odu.example.org", (event, fields) =>
      events.push({ event, fields }),
    );
    expect(
      await h.cache.admin.domain({ ...asRoot(ROOT), bucket: "main", domain: "cache.example.org" }),
    ).toMatchObject({ ok: true });
    const host = (path: string, init: RequestInit = {}): Promise<Response> =>
      h.raw(path, { ...init, headers: { host: "cache.example.org" } });
    const absent = hashOf("/nix/store/33333333333333333333333333333333-absent");
    events.length = 0;

    expect((await h.fetch(`/main/${hashOf(HELLO)}.narinfo`)).status).toBe(200);
    expect((await h.fetch(`/main/${absent}.narinfo`)).status).toBe(404);
    expect((await h.fetch(`/main/${hashOf(HELLO)}.narinfo`, { method: "HEAD" })).status).toBe(200);
    expect((await host(`/${hashOf(HELLO)}.narinfo`)).status).toBe(200);
    expect((await host(`/${absent}.narinfo`)).status).toBe(404);

    expect(
      events
        .filter((line) => line.event === "cache.narinfo.served")
        .map((line) => ({ bucket: line.fields.bucket, hit: line.fields.hit })),
    ).toEqual([
      { bucket: "main", hit: true },
      { bucket: "main", hit: false },
      { bucket: "main", hit: true },
      { bucket: "main", hit: true },
      { bucket: "main", hit: false },
    ]);
    await h.dispose();
  });
});

describe("the NAR, from local disk", () => {
  const where = ON_DISK;

  it("serves the KEPT file with a length and the file's own hash", async () => {
    const h = await harness(true, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const response = await h.fetch(`/main/nar/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-nix-nar");
    expect(response.headers.get("content-length")).toBe(String(hello.bytes.length));
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(hello.bytes));
    expect(h.store.calls.filter((call) => call.op === "dump")).toHaveLength(0);
    const narinfo = await (await h.fetch(`/main/${hashOf(HELLO)}.narinfo`)).text();
    expect(narinfo).toContain(`FileSize: ${hello.bytes.length}`);
    expect(narinfo).toContain(`FileHash: sha256:${base32(createHash("sha256").update(body).digest())}`);
    await h.dispose();
  });

  it("serves each twin's own compression when NarHashes collide", async () => {
    const h = await harness(true, undefined, undefined, where);
    const raw = new TextEncoder().encode("identical NAR, two compression choices");
    const zstd = spawnSync("zstd", ["-q", "-c"], { input: raw });
    const xz = spawnSync("xz", ["-c"], { input: raw });
    expect(zstd.status).toBe(0);
    expect(xz.status).toBe(0);
    const narHash = `sha256:${base32(createHash("sha256").update(raw).digest())}`;
    const zstdBytes = new Uint8Array(zstd.stdout);
    const xzBytes = new Uint8Array(xz.stdout);
    const one = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-twin-zstd";
    const two = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-twin-xz";
    expect((await upload(h.fetch, h.tokens.write, one, { bytes: zstdBytes, narHash }, { compression: "zstd" })).status).toBe(200);
    expect((await upload(h.fetch, h.tokens.write, two, { bytes: xzBytes, narHash }, { compression: "xz" })).status).toBe(200);
    const oneNar = await h.fetch(`/main/nar/${narHash.slice(7)}.nar.zst`);
    const twoNar = await h.fetch(`/main/nar/${narHash.slice(7)}.nar.xz`);
    expect(oneNar.status).toBe(200);
    expect(twoNar.status).toBe(200);
    expect(Array.from(new Uint8Array(await oneNar.arrayBuffer()))).toEqual(Array.from(zstdBytes));
    expect(Array.from(new Uint8Array(await twoNar.arrayBuffer()))).toEqual(Array.from(xzBytes));
    expect(await (await h.fetch(`/main/${hashOf(one)}.narinfo`)).text()).toContain("Compression: zstd");
    expect(await (await h.fetch(`/main/${hashOf(two)}.narinfo`)).text()).toContain("Compression: xz");
    await h.dispose();
  });

  it("keeps an xz upload as xz and serves those exact bytes", async () => {
    const h = await harness(true, undefined, undefined, where);
    const raw = new TextEncoder().encode("a NAR compressed with xz");
    const xz = spawnSync("xz", ["-c"], { input: raw });
    expect(xz.status).toBe(0);
    const payload = {
      bytes: new Uint8Array(xz.stdout),
      narHash: `sha256:${base32(createHash("sha256").update(raw).digest())}`,
    };
    const path = "/nix/store/dddddddddddddddddddddddddddddddd-xz";
    const response = await upload(h.fetch, h.tokens.write, path, payload, { compression: "xz" });
    expect(response.status).toBe(200);
    const narinfo = await (await h.fetch(`/main/${hashOf(path)}.narinfo`)).text();
    expect(narinfo).toContain("Compression: xz");
    expect(narinfo).toContain(`FileSize: ${payload.bytes.length}`);
    const name = `${payload.narHash.slice(7)}.nar.xz`;
    const nar = await h.fetch(`/main/nar/${name}`);
    expect(nar.status).toBe(200);
    expect(nar.headers.get("content-length")).toBe(String(payload.bytes.length));
    expect(Array.from(new Uint8Array(await nar.arrayBuffer()))).toEqual(Array.from(payload.bytes));
    await h.dispose();
  });

  it("answers a Range from the file", async () => {
    const h = await harness(true, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const response = await h.fetch(`/main/nar/${hello.narHash.replace(/^sha256:/, "")}.nar.zst`, {
      headers: { range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 2-5/${hello.bytes.length}`,
    );
    expect(response.headers.get("content-length")).toBe("4");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(hello.bytes.subarray(2, 6)),
    );
    await h.dispose();
  });

  it("answers suffix and open-ended ranges, and refuses past the end", async () => {
    const h = await harness(true, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.slice(7)}.nar.zst`;
    const suffix = await h.fetch(`/main/nar/${name}`, { headers: { range: "bytes=-4" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(
      `bytes ${hello.bytes.length - 4}-${hello.bytes.length - 1}/${hello.bytes.length}`,
    );
    expect(Array.from(new Uint8Array(await suffix.arrayBuffer()))).toEqual(
      Array.from(hello.bytes.subarray(hello.bytes.length - 4)),
    );
    const open = await h.fetch(`/main/nar/${name}`, {
      headers: { range: `bytes=${hello.bytes.length - 2}-` },
    });
    expect(open.status).toBe(206);
    expect(Array.from(new Uint8Array(await open.arrayBuffer()))).toEqual(
      Array.from(hello.bytes.subarray(hello.bytes.length - 2)),
    );
    for (const range of [
      `bytes=${hello.bytes.length}-`,
      `bytes=${hello.bytes.length + 1}-`,
      "bytes=-0",
      "bytes=-",
    ]) {
      expect({ range, status: (await h.fetch(`/main/nar/${name}`, { headers: { range } })).status }).toEqual({
        range,
        status: 416,
      });
    }
    await h.dispose();
  });

  it("finds the path by the hash alone, whatever compression the client asked for", async () => {
    const h = await harness(true, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const hash = hello.narHash.replace(/^sha256:/, "");
    expect((await h.fetch(`/main/nar/${hash}.nar.xz`)).status).toBe(200);
    expect((await h.fetch(`/main/nar/${"1".repeat(52)}.nar.zst`)).status).toBe(404);
    await h.dispose();
  });
});

function countingS3(): { where: Where; minted: () => number } {
  let minted = 0;
  return {
    where: {
      name: "s3",
      store: async () => {
        const store = await (ON_S3.store as () => Promise<ObjectStore>)();
        const sign = store.presignGet;
        if (sign === undefined) throw new Error("an S3 store signs reads; this one does not");
        return {
          ...store,
          presignGet: (key: string, seconds: number) => {
            minted += 1;
            return sign(key, seconds);
          },
        };
      },
    },
    minted: () => minted,
  };
}

describe("the NAR, from S3", () => {
  it("redirects to a signed URL on the store's own host, with no body", async () => {
    const lines: string[] = [];
    const { where } = countingS3();
    const h = await harness(true, "https://odu.example.org", (event, fields) =>
      lines.push(`${event} ${JSON.stringify(fields)}`), where);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const response = await h.fetch(`/main/nar/${name}`);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin).toBe(gateway.endpoint.origin);
    expect(location.origin).not.toBe("http://127.0.0.1:18440");
    expect(location.searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(location.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");

    const fromStore = await fetch(location.href);
    expect(fromStore.status).toBe(200);
    expect(Array.from(new Uint8Array(await fromStore.arrayBuffer()))).toEqual(Array.from(hello.bytes));

    const served = lines.find((line) => line.startsWith("cache.nar.served"));
    expect(served).toContain('"source":"redirect"');
    expect(served).toContain('"bytes":0');
    await h.dispose();
  });

  it("answers a HEAD with the same redirect, so a HEAD never becomes a GET", async () => {
    const { where } = countingS3();
    const h = await harness(true, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const response = await h.fetch(`/main/nar/${name}`, { method: "HEAD" });
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin).toBe(gateway.endpoint.origin);
    expect(location.searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await h.dispose();
  });

  it("hands a Range to the store instead of answering it, and the store answers it", async () => {
    const { where } = countingS3();
    const h = await harness(true, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const response = await h.fetch(`/main/nar/${name}`, { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(307);
    expect(response.headers.get("content-range")).toBeNull();

    const location = response.headers.get("location") as string;
    const ranged = await fetch(location, { headers: { range: "bytes=2-5" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 2-5/${hello.bytes.length}`);
    expect(Array.from(new Uint8Array(await ranged.arrayBuffer()))).toEqual(
      Array.from(hello.bytes.subarray(2, 6)),
    );
    await h.dispose();
  });

  it("404s an anonymous reader of a private bucket before it signs anything", async () => {
    const { where, minted } = countingS3();
    const h = await harness(false, undefined, undefined, where);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const refused = await h.fetch(`/main/nar/${name}`);
    expect(refused.status).toBe(404);
    expect(refused.headers.get("location")).toBeNull();
    expect(minted()).toBe(0);

    const allowed = await h.fetch(`/main/nar/${name}`, bearer(h.tokens.read));
    expect(allowed.status).toBe(307);
    expect(minted()).toBe(1);
    await h.dispose();
  });
});

describe("the NAR before its object", () => {
  it("falls back to the FIFO dump when the file is not there yet", async () => {
    const h = await harness(true);
    const hello = nar("a NAR, in pieces");
    const name = `${hello.narHash.replace(/^sha256:/, "")}.nar.zst`;
    asPreObjectRow(HELLO, `${hello.narHash.slice(7)}.nar`);
    const response = await h.fetch(`/main/nar/${name}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a NAR, in pieces");
    expect(h.store.calls.filter((call) => call.op === "dump")).toHaveLength(1);
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
    expect(await response.json()).toEqual({
      missing: [other],
      skippedUpstream: [GLIBC],
      substituter: "/cache/main",
    });
    await h.dispose();
  });

  it("asks a whole push for what an upstream key signed", async () => {
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
        whole: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      missing: [GLIBC, other],
      skippedUpstream: [],
      substituter: "/cache/main",
    });
    await h.dispose();
  });

  it("refuses a `whole` that is not true or false, with a sentence", async () => {
    const h = await harness(true);
    const response = await h.raw("/_odu/v1/buckets/main/missing", {
      ...bearer(h.tokens.write),
      method: "POST",
      headers: { ...bearer(h.tokens.write).headers, "content-type": "application/json" },
      body: JSON.stringify({ paths: [{ path: GLIBC }], whole: "yes" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('"whole" is true or false');
    await h.dispose();
  });

  it("takes everything when the bucket has no upstream keys", async () => {
    const h = await harness(true);
    const created = await h.cache.admin.create({
      ...asRoot(ROOT),
      name: "everything",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    expect(created.ok).toBe(true);
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
    expect(await response.json()).toEqual({
      missing: [GLIBC],
      skippedUpstream: [],
      substituter: "/cache/everything",
    });
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

describe("a pin made with a write token", () => {
  it("holds the closure, and re-points when the same name is pinned again", async () => {
    const h = await harness(true);
    const write = bearer(h.tokens.write);
    const second = "/nix/store/00000000000000000000000000000001-second";
    expect((await upload(h.fetch, h.tokens.write, second, nar("a second NAR"))).status).toBe(200);
    const pin = (paths: readonly string[]): Promise<Response> =>
      h.raw("/_odu/v1/buckets/main/pin", {
        ...write,
        method: "POST",
        headers: { ...write.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "master", paths }),
      });

    const first = await pin([HELLO]);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ bucket: "main", name: "master" });

    const again = await pin([second]);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ name: "master", rootPaths: [second] });
    const listed = await h.cache.admin.pinList({ ...asRoot(ROOT), bucket: "main" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) expect(listed.value.map((one) => one.rootPaths)).toEqual([[second]]);
    await h.dispose();
  });

  it("may not re-point an ADMIN's pin, which an admin may still re-point", async () => {
    const h = await harness(true);
    const second = "/nix/store/00000000000000000000000000000001-second";
    expect((await upload(h.fetch, h.tokens.write, second, nar("a second NAR"))).status).toBe(200);
    expect(
      await h.cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "release-1.0", paths: [HELLO] }),
    ).toMatchObject({ ok: true });

    const write = bearer(h.tokens.write);
    const stolen = await h.raw("/_odu/v1/buckets/main/pin", {
      ...write,
      method: "POST",
      headers: { ...write.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "release-1.0", paths: [second] }),
    });
    expect(stolen.status).toBe(403);
    expect(await stolen.text()).toContain("made by an administrator");
    const held = await h.cache.admin.pinList({ ...asRoot(ROOT), bucket: "main" });
    if (held.ok) expect(held.value.map((one) => one.rootPaths)).toEqual([[HELLO]]);

    expect(
      (
        await h.raw("/_odu/v1/buckets/main/pin", {
          ...write,
          method: "POST",
          headers: { ...write.headers, "content-type": "application/json" },
          body: JSON.stringify({ name: "master", paths: [HELLO] }),
        })
      ).status,
    ).toBe(200);
    expect(
      await h.cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "master", paths: [second] }),
    ).toMatchObject({ ok: true, value: { createdBy: "admin" } });
    expect(
      await h.cache.admin.pin({
        ...asRoot(ROOT),
        bucket: "main",
        name: "release-1.0",
        paths: [second],
      }),
    ).toMatchObject({ ok: true });
    await h.dispose();
  });

  it("refuses a read token, a path the bucket lacks, and a body it cannot read", async () => {
    const h = await harness(true);
    const read = bearer(h.tokens.read);
    expect(
      (
        await h.raw("/_odu/v1/buckets/main/pin", {
          ...read,
          method: "POST",
          headers: { ...read.headers, "content-type": "application/json" },
          body: JSON.stringify({ name: "master", paths: [HELLO] }),
        })
      ).status,
    ).toBe(403);

    const write = bearer(h.tokens.write);
    const absent = await h.raw("/_odu/v1/buckets/main/pin", {
      ...write,
      method: "POST",
      headers: { ...write.headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "master",
        paths: ["/nix/store/00000000000000000000000000000000-nope"],
      }),
    });
    expect(absent.status).toBe(400);
    expect(await absent.text()).toContain("no such path in the bucket");

    const malformed = await h.raw("/_odu/v1/buckets/main/pin", {
      ...write,
      method: "POST",
      headers: { ...write.headers, "content-type": "application/json" },
      body: '{"name": "master"}',
    });
    expect(malformed.status).toBe(400);
    await h.dispose();
  });
});

describe("uploading", () => {
  it("records a path whose bytes match its narinfo", async () => {
    const h = await harness(true);
    const staged = "/nix/store/11111111111111111111111111111111-uploaded";
    const payload = nar("uploaded bytes");
    const response = await upload(h.fetch, h.tokens.write, staged, payload);
    expect(response.status).toBe(200);
    const read = await h.fetch(`/main/${hashOf(staged)}.narinfo`);
    expect(read.status).toBe(200);
    const narinfo = await read.text();
    expect(narinfo).toContain("Sig: main-1:");
    expect(narinfo).toContain(`FileSize: ${payload.bytes.length}`);
    await h.dispose();
  });

  it("refuses a narinfo with no NAR behind it — even for a path the store already has", async () => {
    const h = await harness(true);
    const priv = "/nix/store/22222222222222222222222222222222-private";
    const payload = nar("somebody else's bytes");
    h.store.add({ storePath: priv, narHash: payload.narHash, narSize: 1, references: [] }, true);

    const response = await upload(h.fetch, h.tokens.write, priv, payload, { skipNar: true });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("never uploaded");
    await h.dispose();
  });

  it("refuses bytes that do not hash to the narinfo's NarHash", async () => {
    const h = await harness(true);
    const staged = "/nix/store/33333333333333333333333333333333-truncated";
    const real = nar("the real bytes");
    const claimed = nar("the bytes somebody claimed");

    const response = await upload(h.fetch, h.tokens.write, staged, real, {
      narHash: claimed.narHash,
    });
    expect(response.status).toBe(400);
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

  it("records a parent whose reference is not in the bucket — a name, not a path", async () => {
    const h = await harness(true);
    const child = "/nix/store/44444444444444444444444444444444-child";
    const parent = "/nix/store/55555555555555555555555555555555-parent";
    const parentPayload = nar("parent bytes");
    const early = await upload(h.fetch, h.tokens.write, parent, parentPayload, {
      references: [child],
    });
    expect(early.status).toBe(200);
    expect((await h.fetch(`/main/${hashOf(parent)}.narinfo`)).status).toBe(200);
    const childPayload = nar("child bytes");
    const late = await upload(h.fetch, h.tokens.write, child, childPayload);
    expect(late.status).toBe(200);
    await h.dispose();
  });

  it("records twins whose NARs both land before either narinfo does", async () => {
    const h = await harness(true);
    const one = "/nix/store/66666666666666666666666666666666-one";
    const two = "/nix/store/77777777777777777777777777777777-two";
    const payload = nar("identical bytes");

    const name = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    for (const path of [one, two]) {
      const put = await h.fetch(`/main/nar/${name}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: body(payload.bytes),
      });
      expect({ path, status: put.status }).toEqual({ path, status: 200 });
    }
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
    const name = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const split = [payload.bytes.subarray(0, 5), payload.bytes.subarray(5)];
    const part = (index: number) =>
      h.fetch(`/main/nar/${name}/parts/${index}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: body(split[index] as Uint8Array),
      });
    const complete = () =>
      h.fetch(`/main/nar/${name}/complete`, {
        ...bearer(h.tokens.write),
        method: "POST",
        headers: {
          authorization: `Bearer ${h.tokens.write}`,
          "x-odu-parts": "2",
        },
      });

    expect((await part(0)).status).toBe(204);
    const gap = await complete();
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ missing: [1] });

    expect((await part(1)).status).toBe(204);
    expect((await complete()).status).toBe(200);
    const narinfo = await h.fetch(`/main/${hashOf(staged)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${staged}\nURL: nar/${name}\nCompression: none\nNarHash: ${payload.narHash}\nNarSize: ${payload.bytes.length}\nReferences: \n`,
    });
    expect(narinfo.status).toBe(200);
    expect((await h.fetch(`/main/${hashOf(staged)}.narinfo`)).status).toBe(200);
    await h.dispose();
  });

  it("keeps each session's parts apart, and refuses a malformed session", async () => {
    const h = await harness(true);
    const staged = "/nix/store/cccccccccccccccccccccccccccccccc-sessions";
    const payload = nar("parts that belong to one upload");
    const other = nar("parts that belong to another upload!");
    const name = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const part = (session: string, bytes: Uint8Array) =>
      h.fetch(`/main/nar/${name}/parts/0`, {
        method: "PUT",
        headers: { authorization: `Bearer ${h.tokens.write}`, "x-odu-upload": session },
        body: body(bytes),
      });
    expect((await part("mine", payload.bytes)).status).toBe(204);
    expect((await part("theirs", other.bytes)).status).toBe(204);
    expect(stagedFiles().filter((file) => file.includes(".part-0")).sort()).toEqual([
      `/main/nar/${name}.s-mine.part-0`,
      `/main/nar/${name}.s-theirs.part-0`,
    ]);
    const complete = (session: string, parts: number) =>
      h.fetch(`/main/nar/${name}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.tokens.write}`,
          "x-odu-upload": session,
          "x-odu-parts": String(parts),
        },
      });
    expect((await complete("mine", 1)).status).toBe(200);
    expect((await complete("mine", 1)).status).toBe(200);
    const gap = await complete("theirs", 2);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ missing: [1] });
    const narinfo = await h.fetch(`/main/${hashOf(staged)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${staged}\nURL: nar/${name}\nCompression: none\nNarHash: ${payload.narHash}\nNarSize: ${payload.bytes.length}\nReferences: \n`,
    });
    expect(narinfo.status).toBe(200);
    expect((await part("../escape", payload.bytes)).status).toBe(400);
    await h.dispose();
  });

  it("names the path, parts and bytes when a joined upload fails its proof", async () => {
    const lines: string[] = [];
    const h = await harness(true, "https://odu.example.org", (event, fields) =>
      lines.push(`${event} ${JSON.stringify(fields)}`),
    );
    const staged = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bad-nar";
    const payload = nar("three parts that will not match the narinfo");
    const wrong = nar("some other bytes");
    const name = `${payload.narHash.slice(7)}.nar.zst`;
    const split = [
      payload.bytes.subarray(0, 5),
      payload.bytes.subarray(5, 10),
      payload.bytes.subarray(10),
    ];
    const put = (index: number) =>
      h.fetch(`/main/nar/${name}/parts/${index}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: body(split[index] as Uint8Array),
      });
    expect((await Promise.all([put(2), put(0), put(1)])).map((r) => r.status)).toEqual([
      204, 204, 204,
    ]);
    expect(
      (
        await h.fetch(`/main/nar/${name}/complete`, {
          ...bearer(h.tokens.write),
          method: "POST",
          headers: { authorization: `Bearer ${h.tokens.write}`, "x-odu-parts": "3" },
        })
      ).status,
    ).toBe(200);
    const refused = await h.fetch(`/main/${hashOf(staged)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${staged}\nURL: nar/${name}\nCompression: none\nNarHash: ${wrong.narHash}\nNarSize: ${payload.bytes.length}\nReferences: \n`,
    });
    expect(refused.status).toBe(400);
    const line = lines.find((entry) => entry.startsWith("cache.request.refused"));
    expect(line).toContain(`"storePath":"${staged}"`);
    expect(line).toContain('"parts":3');
    expect(line).toContain(`"bytesReceived":${payload.bytes.length}`);
    expect(line).toMatch(new RegExp(`"stagedFile":"main/nar/${name.replaceAll(".", "\\.")}\\.[0-9a-f-]{36}\\.claimed"`));
    expect(line).toContain(`"stagedBytes":${payload.bytes.length}`);
    await h.dispose();
  });

  it("says nothing was staged when a narinfo names a NAR nobody uploaded", async () => {
    const lines: string[] = [];
    const h = await harness(true, "https://odu.example.org", (event, fields) =>
      lines.push(`${event} ${JSON.stringify(fields)}`),
    );
    const missing = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-never-sent";
    const refused = await upload(h.fetch, h.tokens.write, missing, nar("never sent"), {
      skipNar: true,
    });
    expect(refused.status).toBe(400);
    const line = lines.find((entry) => entry.startsWith("cache.request.refused"));
    expect(line).toContain('"stagedFile":null');
    expect(line).not.toContain("stagedBytes");
    await h.dispose();
  });

  it("joins 3+ parts uploaded concurrently and out of index order", async () => {
    const h = await harness(true);
    const staged = "/nix/store/99999999999999999999999999999999-concurrent";
    const MB = 1024 * 1024;
    const bytes = new Uint8Array(130 * MB);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
    const narHash = `sha256:${base32(createHash("sha256").update(bytes).digest())}`;
    const payload = { bytes, narHash };
    const name = `${narHash.slice(7)}.nar.zst`;
    const split = [
      bytes.subarray(0, 64 * MB),
      bytes.subarray(64 * MB, 128 * MB),
      bytes.subarray(128 * MB),
    ];
    const part = (index: number) =>
      h.fetch(`/main/nar/${name}/parts/${index}`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: body(split[index] as Uint8Array),
      });
    const uploaded = await Promise.all([part(2), part(1), part(0)]);
    expect(uploaded.map((response) => response.status)).toEqual([204, 204, 204]);
    const complete = await h.fetch(`/main/nar/${name}/complete`, {
      ...bearer(h.tokens.write),
      method: "POST",
      headers: {
        authorization: `Bearer ${h.tokens.write}`,
        "x-odu-parts": "3",
      },
    });
    expect(complete.status).toBe(200);
    const narinfo = await h.fetch(`/main/${hashOf(staged)}.narinfo`, {
      ...bearer(h.tokens.write),
      method: "PUT",
      body: `StorePath: ${staged}\nURL: nar/${name}\nCompression: none\nNarHash: ${payload.narHash}\nNarSize: ${payload.bytes.length}\nReferences: \n`,
    });
    expect(await narinfo.text()).toBe("");
    expect(narinfo.status).toBe(200);
    const read = await h.fetch(`/main/nar/${name}`);
    expect(Array.from(new Uint8Array(await read.arrayBuffer()))).toEqual(
      Array.from(payload.bytes),
    );
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
    const infoText = await info.text();
    expect(infoText).toContain("WantMassQuery");
    expect(infoText).toBe(nixCacheInfo({ origin: "https://odu.example.org", bucket: "main" }));

    const narinfo = await host(`/${hashOf(HELLO)}.narinfo`);
    expect(narinfo.status).toBe(200);
    const text = await narinfo.text();
    expect(text).toContain("Sig: main-1:");
    const nar = await host(`/${text.split("\n").find((line) => line.startsWith("URL: "))!.slice(5)}`);
    expect(nar.status).toBe(200);

    expect(
      (await h.raw("/nix-cache-info", { headers: { host: "other.example.org" } })).status,
    ).toBe(404);
    expect((await host("/sw.js")).status).toBe(404);
    await h.dispose();
  });
});

describe("the shell's own paths", () => {
  it("is not reached by the cache's two-segment GET", async () => {
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

function pattern(size: number): Uint8Array {
  const chunk = new Uint8Array(size);
  let x = 0x9e3779b9;
  for (let at = 0; at < chunk.length; at++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    chunk[at] = x & 0xff;
  }
  return chunk;
}

function bigStream(count: number, size = 64 * 1024): ReadableStream<Uint8Array> {
  const chunk = pattern(size);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
}

async function rssGrowth(work: () => Promise<void>): Promise<number> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return peak - baseline;
}

describe("a large NAR stays off the heap", () => {
  const CHUNKS = 5000; // ~320 MiB of NAR bytes
  const LIMIT = 64 * 1024 * 1024;

  it("serves it to a slow reader at constant memory", async () => {
    const h = await harness(true);
    const hello = nar("a NAR, in pieces");
    // zstd hands out ~1.5 MB buffers, and Bun keeps a `res.write` chunk alive
    // until the socket drains.
    const chunks = 214;
    const size = 1_500_000;
    h.store.dump = () => bigStream(chunks, size);
    const file = `${hello.narHash.replace(/^sha256:/, "")}.nar`;
    asPreObjectRow(HELLO, file);
    const growth = await rssGrowth(async () => {
      const response = await h.fetch(`/main/nar/${file}`);
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const digest = createHash("sha256");
      let reads = 0;
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        digest.update(next.value);
        bytes += next.value.length;
        reads += 1;
        if (reads % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const expected = createHash("sha256");
      const chunk = pattern(size);
      for (let i = 0; i < chunks; i++) expected.update(chunk);
      expect(bytes).toBe(chunks * size);
      expect(digest.digest("hex")).toBe(expected.digest("hex"));
    });
    expect({ growth, within: growth < LIMIT }).toEqual({ growth, within: true });
    await h.dispose();
  });

  it("accepts an upload of it at constant memory", async () => {
    const h = await harness(true);
    const growth = await rssGrowth(async () => {
      const response = await h.fetch(`/main/nar/big.nar.zst`, {
        ...bearer(h.tokens.write),
        method: "PUT",
        body: bigStream(CHUNKS),
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(200);
    });
    expect({ growth, within: growth < LIMIT }).toEqual({ growth, within: true });
    await h.dispose();
  });
});

describe("a direct upload", () => {
  async function direct(
    h: Harness,
    file: string,
    bytes: Uint8Array,
  ): Promise<{
    plan: { mode: string; upload?: string; partSize?: number; part?: string };
    complete: Response;
  }> {
    const begun = await h.fetch(`/main/nar/${file}/upload`, {
      ...bearer(h.tokens.write),
      method: "POST",
      body: JSON.stringify({ partSize: 1 }),
    });
    expect(begun.status).toBe(200);
    const plan = (await begun.json()) as { mode: string; upload?: string; part?: string };
    if (plan.mode !== "direct") throw new Error(`the bucket answered ${plan.mode}`);
    const put = await fetch(plan.part as string, { method: "PUT", body: body(bytes) });
    expect(put.status).toBe(200);
    const complete = await h.fetch(`/main/nar/${file}/upload/${plan.upload}/complete`, {
      ...bearer(h.tokens.write),
      method: "POST",
      body: JSON.stringify({ parts: [{ index: 0, etag: put.headers.get("etag") }] }),
    });
    return { plan, complete };
  }

  /**
   * A STORE WHOSE TEMP OBJECT CHANGES UNDER THE COPY: AWS and versitygw
   * honour the source condition on `UploadPartCopy`; R2 does not implement
   * it.
   */
  function racingS3(rewrite: Uint8Array): { where: Where; raced: () => number } {
    let raced = 0;
    return {
      where: {
        name: "s3",
        store: async () => {
          const store = await (ON_S3.store as () => Promise<ObjectStore>)();
          const copy = store.copy;
          if (copy === undefined) throw new Error("an S3 store copies; this one does not");
          return {
            ...store,
            copy: async (from: string, to: string, options: Parameters<typeof copy>[2]) => {
              if (from.includes("/.tmp-")) {
                raced += 1;
                await store.delete(from);
                const put = await store.put(from, new Blob([rewrite as BlobPart]));
                expect(put.ok).toBe(true);
              }
              return copy(from, to, options);
            },
          };
        },
      },
      raced: () => raced,
    };
  }

  it("is what an S3 bucket negotiates", async () => {
    const onS3 = await harness(true, "https://odu.example.org", undefined, ON_S3);
    const begun = await onS3.fetch("/main/nar/whatever.nar.zst/upload", {
      ...bearer(onS3.tokens.write),
      method: "POST",
      body: "",
    });
    const plan = (await begun.json()) as Record<string, unknown>;
    expect(plan.mode).toBe("direct");
    // S3 refuses a short part in the middle of an upload.
    expect(plan.partSize as number).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    const part = new URL(plan.part as string);
    expect(part.searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(part.searchParams.get("partNumber")).toBe("1");
    expect(part.searchParams.get("uploadId")).not.toBeNull();
    expect(part.pathname).toContain("/nar/.tmp-");
    expect(Object.keys(plan).sort()).toEqual(["mode", "part", "partSize", "upload"]);
    await onS3.dispose();
  });

  it("is never what a disk bucket negotiates", async () => {
    const onDisk = await harness(true);
    const staged = await onDisk.fetch("/main/nar/whatever.nar.zst/upload", {
      ...bearer(onDisk.tokens.write),
      method: "POST",
      body: "",
    });
    expect(await staged.json()).toEqual({ mode: "staged" });
    await onDisk.dispose();
  });

  it("reads the object back, proves it, copies it into place and records it", async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const h = await harness(
      true,
      "https://odu.example.org",
      (event, fields) => events.push({ event, fields }),
      ON_S3,
    );
    const payload = nar("a NAR that went straight to the store");
    const file = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const { complete } = await direct(h, file, payload.bytes);
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ parts: 1, bytes: payload.bytes.length });
    expect(
      events.find((line) => line.event === "cache.nar.uploaded" && line.fields.file === file)
        ?.fields,
    ).toMatchObject({ bucket: "main", file, mode: "direct", parts: 1, bytes: payload.bytes.length });

    expect(h.cache.narinfoText(h.cache.bucket("main") as never, storePathHash(GLIBC))).toBeNull();

    const landed = await upload(h.fetch, h.tokens.write, GLIBC, payload, { skipNar: true });
    expect(landed.status).toBe(200);
    const read = await h.fetch(`/main/nar/${file}`, bearer(h.tokens.read));
    expect([200, 307]).toContain(read.status);
    const bytes =
      read.status === 307
        ? new Uint8Array(await (await fetch(read.headers.get("location") as string)).arrayBuffer())
        : new Uint8Array(await read.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("a NAR that went straight to the store");
    expect(stagedFiles().filter((name) => name.includes(".tmp-"))).toEqual([]);
    await h.dispose();
  });

  it("refuses a narinfo whose hash the object does not carry, and keeps nothing", async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const h = await harness(
      true,
      "https://odu.example.org",
      (event, fields) => events.push({ event, fields }),
      ON_S3,
    );
    const payload = nar("bytes that are not what the narinfo claims");
    const claimed = nar("the bytes the narinfo claims");
    const file = `${claimed.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const { complete } = await direct(h, file, payload.bytes);
    expect(complete.status).toBe(200);

    const refused = await upload(h.fetch, h.tokens.write, GLIBC, claimed, { skipNar: true });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("hashes to");
    expect(
      events.find((line) => line.event === "cache.nar.verify_failed")?.fields,
    ).toMatchObject({ bucket: "main", mode: "direct", reason: "nar_hash_mismatch" });
    expect(h.cache.narinfoText(h.cache.bucket("main") as never, storePathHash(GLIBC))).toBeNull();
    const read = await h.fetch(`/main/nar/${file}`, bearer(h.tokens.read));
    expect(read.status).toBe(404);
    await h.dispose();
  });

  it("refuses a part or a completion for an upload it does not hold", async () => {
    const h = await harness(true, "https://odu.example.org", undefined, ON_S3);
    const file = "0000000000000000000000000000000000000000000000000000.nar.zst";
    const part = await h.fetch(`/main/nar/${file}/upload/not-an-upload/parts/0`, bearer(h.tokens.write));
    expect(part.status).toBe(404);
    const joined = await h.fetch(`/main/nar/${file}/upload/not-an-upload/complete`, {
      ...bearer(h.tokens.write),
      method: "POST",
      body: JSON.stringify({ parts: [] }),
    });
    expect(joined.status).toBe(404);
    await h.dispose();
  });

  it("takes no upload from a token that may only read", async () => {
    const h = await harness(true, "https://odu.example.org", undefined, ON_S3);
    const begun = await h.fetch("/main/nar/whatever.nar.zst/upload", {
      ...bearer(h.tokens.read),
      method: "POST",
      body: "",
    });
    expect(begun.status).toBe(403);
    await h.dispose();
  });

  it("hands the client no URL that can rewrite the object it will prove", async () => {
    const h = await harness(true, "https://odu.example.org", undefined, ON_S3);
    const payload = nar("bytes the client cannot take back");
    const file = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const { plan, complete } = await direct(h, file, payload.bytes);
    expect(complete.status).toBe(200);

    const again = await fetch(plan.part as string, {
      method: "PUT",
      body: body(new TextEncoder().encode("bytes nobody proved")),
    });
    expect(again.ok).toBe(false);
    expect((await upload(h.fetch, h.tokens.write, GLIBC, payload, { skipNar: true })).status).toBe(200);
    const read = await h.fetch(`/main/nar/${file}`, bearer(h.tokens.read));
    const bytes =
      read.status === 307
        ? new Uint8Array(await (await fetch(read.headers.get("location") as string)).arrayBuffer())
        : new Uint8Array(await read.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("bytes the client cannot take back");
    await h.dispose();
  });

  it("refuses bytes that changed between the verify and the copy, and keeps none of them", async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const honest = nar("the bytes odu verified");
    const swapped = new TextEncoder().encode("the bytes a racing client slipped in");
    const { where, raced } = racingS3(swapped);
    const h = await harness(
      true,
      "https://odu.example.org",
      (event, fields) => events.push({ event, fields }),
      where,
    );
    const file = `${honest.narHash.replace(/^sha256:/, "")}.nar.zst`;
    expect((await direct(h, file, honest.bytes)).complete.status).toBe(200);

    const refused = await upload(h.fetch, h.tokens.write, GLIBC, honest, { skipNar: true });
    expect(raced()).toBe(1);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("was rewritten while odu was verifying it");
    expect(
      events.find((line) => line.event === "cache.nar.verify_failed")?.fields,
    ).toMatchObject({ bucket: "main", mode: "direct", reason: "source_changed" });
    expect(h.cache.narinfoText(h.cache.bucket("main") as never, storePathHash(GLIBC))).toBeNull();
    expect((await h.fetch(`/main/nar/${file}`, bearer(h.tokens.read))).status).toBe(404);
    await h.dispose();
  });

  it("records both of two twin paths that share one NAR name", async () => {
    const h = await harness(true, "https://odu.example.org", undefined, ON_S3);
    const twin = nar("one NAR, two store paths");
    const file = `${twin.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const other = "/nix/store/zzdhrfdsqgnqrsipbdfg1m1h1i17pmg1-twin-2.0";
    expect((await direct(h, file, twin.bytes)).complete.status).toBe(200);

    const [first, second] = await Promise.all([
      upload(h.fetch, h.tokens.write, GLIBC, twin, { skipNar: true }),
      upload(h.fetch, h.tokens.write, other, twin, { skipNar: true }),
    ]);
    expect({ first: first.status, second: second.status }).toEqual({ first: 200, second: 200 });
    for (const path of [GLIBC, other]) {
      const narinfo = h.cache.narinfoText(h.cache.bucket("main") as never, storePathHash(path));
      expect(narinfo).toContain(`StorePath: ${path}`);
      expect(narinfo).toContain(`URL: nar/${twin.narHash.replace(/^sha256:/, "")}.nar`);
      expect(narinfo).toContain(`NarHash: ${twin.narHash}`);
    }
    await h.dispose();
  });

  it("does not reap an upload that is still moving, however long it takes", async () => {
    const h = await harness(true, "https://odu.example.org", undefined, ON_S3);
    const payload = nar("a NAR that took its time");
    const file = `${payload.narHash.replace(/^sha256:/, "")}.nar.zst`;
    const begun = await h.fetch(`/main/nar/${file}/upload`, {
      ...bearer(h.tokens.write),
      method: "POST",
      body: "",
    });
    const plan = (await begun.json()) as { upload: string; part: string };

    clock += 50 * 60 * 1000;
    const signed = await h.fetch(
      `/main/nar/${file}/upload/${plan.upload}/parts/1`,
      bearer(h.tokens.write),
    );
    expect(signed.status).toBe(200);
    clock += 20 * 60 * 1000;
    const other = await h.fetch("/main/nar/other.nar.zst/upload", {
      ...bearer(h.tokens.write),
      method: "POST",
      body: "",
    });
    expect(other.status).toBe(200);

    const put = await fetch(plan.part, { method: "PUT", body: body(payload.bytes) });
    expect(put.status).toBe(200);
    const complete = await h.fetch(`/main/nar/${file}/upload/${plan.upload}/complete`, {
      ...bearer(h.tokens.write),
      method: "POST",
      body: JSON.stringify({ parts: [{ index: 0, etag: put.headers.get("etag") }] }),
    });
    expect(complete.status).toBe(200);
    expect((await upload(h.fetch, h.tokens.write, GLIBC, payload, { skipNar: true })).status).toBe(200);
    await h.dispose();
  });
});
