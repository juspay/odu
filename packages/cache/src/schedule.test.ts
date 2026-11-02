/**
 * THE COLLECTION NOBODY ASKED FOR, and the announcement it makes.
 *
 * Two facts about the ROW rather than about the engine, and both are
 * invisible from a verb's answer: a cache that no operator ever administers
 * must still stop growing, and what a collection deleted has to reach whatever
 * is serving those bytes at the edge. The engine's own cases live in
 * `gc.test.ts` and `gcStores.test.ts`; these are about the row's wiring.
 *
 * The schedule is driven at a few milliseconds rather than a day: the interval
 * is this row's own option precisely so a test can state the claim "it runs
 * again without being asked" in under a second.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { purgeBroker } from "@odu/cordis/services";
import { type Cache, createCache } from "./cache";
import { base32, storePathHash } from "./narinfo";
import { cacheServer } from "./server";
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
    stores: localStores(scratch),
    now: () => clock,
  });

/** One pushed path, with bytes the cache will keep. */
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
  );
  if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
}

const serverOver = (cache: Cache, purge: ReturnType<typeof purgeBroker>, everyMs?: number) =>
  cacheServer({
    cache,
    publicOrigin: "https://odu.example.org",
    mount: "/cache",
    stores: [{ name: "local", kind: "local", default: true }],
    purge,
    ...(everyMs === undefined ? {} : { collectEveryMs: everyMs }),
  });

const EXPIRED = "/nix/store/dddddddddddddddddddddddddddddddd-expired";

describe("the row's own collection", () => {
  it("collects on its schedule, with nobody asking", async () => {
    const cache = cacheWith();
    await cache.admin.create({
      ...asRoot(ROOT),
      name: "main",
      public: true,
      retentionDays: 0,
      upstreamKeys: [],
    });
    await push(cache, EXPIRED);
    // Retention is zero and nothing references or pins it, so the next
    // collection takes it — whoever runs that collection.
    clock += 1;

    // THE SIGNAL IS THE ANNOUNCEMENT, not a sleep: a collection that removed
    // something tells the purge port, so the test waits for the fact it is
    // asserting rather than for a duration somebody guessed.
    const collected = Promise.withResolvers<void>();
    const purge = purgeBroker();
    purge.register(() => collected.resolve());
    const server = serverOver(cache, purge, 1);
    const stop = server.schedule();
    await collected.promise;
    expect(cache.narinfoText(cache.bucket("main") as never, storePathHash(EXPIRED))).toBeNull();
    await stop();
    server.detach();
    await cache.close();
  });

  it("stops with the row, and joins the collection in flight", async () => {
    // A timer that outlived its row would collect into a closed database:
    // the stop waits for the run in flight, and the database closes next.
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
    const started = Promise.withResolvers<void>();
    const purge = purgeBroker();
    purge.register(() => started.resolve());
    const server = serverOver(cache, purge, 1);
    const stop = server.schedule();
    await started.promise;
    await stop();
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
    // An edge may hold either address. Purging one and leaving the other is a
    // CDN still serving a path this cache has forgotten.
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
