import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { purgeBroker } from "@odu/cordis/services";
import { type Cache, createCache } from "./cache";
import { base32, storePathHash } from "./narinfo";
import { cacheServer, collectEvery } from "./server";
import { asRoot, localStores } from "./testlib";

const ROOT = "root-token";
const START = 1_700_000_000_000;

let scratch: string;
let clock = START;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-schedule-"));
  clock = START;
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const cacheWith = (): Cache =>
  createCache({
    stateRoot: scratch,
    rootToken: ROOT,
    publicOrigin: "https://odu.example.org",
    stores: localStores(scratch),
    now: () => clock,
  });

async function push(cache: Cache, storePath: string): Promise<void> {
  const bucket = cache.bucket("main");
  if (bucket === null) throw new Error("no bucket main");
  const bytes = new TextEncoder().encode(storePath);
  const narHash = `sha256:${base32(createHash("sha256").update(bytes).digest())}`;
  const upload = await cache.beginUpload(bucket, `${narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(bytes);
  await upload.commit();
  const narinfo = [
    `StorePath: ${storePath}`,
    `URL: nar/${narHash.slice("sha256:".length)}.nar.zst`,
    "Compression: none",
    `NarHash: ${narHash}`,
    "NarSize: 1",
    "References: ",
    "",
  ].join("\n");
  const outcome = await cache.acceptNarinfo(
    bucket,
    storePathHash(storePath),
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(narinfo));
        controller.close();
      },
    }),
    { run: null, commit: null },
  );
  if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
}

const serverOver = (cache: Cache, purge: ReturnType<typeof purgeBroker>) =>
  cacheServer({
    cache,
    publicOrigin: "https://odu.example.org",
    mount: "/cache",
    stores: [{ name: "local", kind: "local", default: true, publicUrl: null }],
    purge,
  });

const EXPIRED = "/nix/store/dddddddddddddddddddddddddddddddd-expired";

async function withExpiredPath(cache: Cache): Promise<void> {
  await cache.admin.create({
    ...asRoot(ROOT),
    name: "main",
    public: true,
    retentionDays: 0,
    upstreamKeys: [],
  });
  await push(cache, EXPIRED);
  clock += 1;
}

const forkInto = async (scope: Scope.Scope, every: number, collect: () => Promise<void>): Promise<void> => {
  await Effect.runPromise(
    Effect.provideService(Effect.forkScoped(collectEvery(every, collect)), Scope.Scope, scope),
  );
};

describe("the row's own collection", () => {
  it("collects on its schedule, with nobody asking", async () => {
    const cache = cacheWith();
    await withExpiredPath(cache);

    const collected = Promise.withResolvers<void>();
    const purge = purgeBroker();
    purge.register(() => collected.resolve());
    const server = serverOver(cache, purge);
    const scope = Scope.makeUnsafe();
    await forkInto(scope, 1, server.collect);
    await collected.promise;
    expect(cache.narinfoText(cache.bucket("main") as never, storePathHash(EXPIRED))).toBeNull();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    server.detach();
    await cache.close();
  });

  it("ends with its scope, and the close waits for the collection in flight", async () => {
    const cache = cacheWith();
    await withExpiredPath(cache);
    const server = serverOver(cache, purgeBroker());
    let entered = 0;
    let left = 0;
    const started = Promise.withResolvers<void>();
    const slow = async (): Promise<void> => {
      entered += 1;
      started.resolve();
      await server.collect();
      await new Promise((resolve) => setTimeout(resolve, 50));
      left += 1;
    };
    const scope = Scope.makeUnsafe();
    await forkInto(scope, 1, slow);
    await started.promise;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect({ entered, left }).toEqual({ entered, left: entered });
    expect(left).toBeGreaterThan(0);
    server.detach();
    await cache.close();
  });

  it("keeps collecting after one collection failed", async () => {
    const cache = cacheWith();
    const server = serverOver(cache, purgeBroker());
    let attempts = 0;
    const twice = Promise.withResolvers<void>();
    const flaky = async (): Promise<void> => {
      attempts += 1;
      if (attempts >= 2) twice.resolve();
      throw new Error("the store is unreachable");
    };
    const scope = Scope.makeUnsafe();
    await forkInto(scope, 1, flaky);
    await twice.promise;
    expect(attempts).toBeGreaterThanOrEqual(2);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    server.detach();
    await cache.close();
  });
});

describe("what a collection announces", () => {
  it("hands the removed narinfo and NAR URLs to whoever is caching them", async () => {
    const cache = cacheWith();
    await cache.admin.create({
      ...asRoot(ROOT),
      name: "main",
      public: true,
      retentionDays: 0,
      upstreamKeys: [],
    });
    await push(cache, EXPIRED);
    clock += 1;

    const purge = purgeBroker();
    const announced: string[][] = [];
    purge.register((urls) => announced.push([...urls]));
    const server = serverOver(cache, purge);
    await server.collect();

    expect(announced).toHaveLength(1);
    const urls = announced[0] as string[];
    expect(urls).toContain(
      `https://odu.example.org/cache/main/${storePathHash(EXPIRED)}.narinfo`,
    );
    expect(urls.some((url) => url.startsWith("https://odu.example.org/cache/main/nar/"))).toBe(true);
    server.detach();
    await cache.close();
  });

  it("announces a bucket's own domain as well as its path form", async () => {
    const cache = cacheWith();
    await cache.admin.create({
      ...asRoot(ROOT),
      name: "main",
      public: true,
      retentionDays: 0,
      upstreamKeys: [],
    });
    await cache.admin.domain({ ...asRoot(ROOT), bucket: "main", domain: "cache.example.org" });
    await push(cache, EXPIRED);
    clock += 1;

    const purge = purgeBroker();
    const announced: string[] = [];
    purge.register((urls) => announced.push(...urls));
    const server = serverOver(cache, purge);
    await server.collect();

    expect(announced).toContain(`https://cache.example.org/${storePathHash(EXPIRED)}.narinfo`);
    expect(announced).toContain(
      `https://odu.example.org/cache/main/${storePathHash(EXPIRED)}.narinfo`,
    );
    server.detach();
    await cache.close();
  });

  it("says nothing when a collection removed nothing", async () => {
    const cache = cacheWith();
    await cache.admin.create({
      ...asRoot(ROOT),
      name: "main",
      public: true,
      retentionDays: 90,
      upstreamKeys: [],
    });
    await push(cache, EXPIRED);

    const purge = purgeBroker();
    const announced: string[] = [];
    purge.register((urls) => announced.push(...urls));
    const server = serverOver(cache, purge);
    await server.collect();

    expect(announced).toEqual([]);
    server.detach();
    await cache.close();
  });
});
