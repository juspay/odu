/**
 * THE ROW'S TEARDOWN, over a real host — the one order nothing else can check.
 *
 * A row registers its cleanup in the order it wants it to run REVERSED: the
 * framework runs finalizers last-registered-first. The cache's own order is not
 * a style question — its mount is the thing a publish lands on, and its database
 * is what a publish reads. Close the database while the mount still stands and a
 * publish arriving in that window reads a torn-down cache; drop the mount while
 * the database is open and the ask simply ends. So the mount goes FIRST, and
 * this test proves it the only way an order can be proved from outside: from
 * inside the drop, ask the cache a question that needs its database.
 *
 * The question goes through the ROUTES the row registers, with kolu's own
 * `toWebHandler` — the same routing the listener uses — so what answers is the
 * server a client meets rather than a private handle the test reached for.
 *
 * The host carries TWO rows, because that is the shape the daemon has and the
 * shape where a teardown order can interleave. What is asserted about the close
 * itself is what the reviewer asked for: it does not throw, and it leaves no
 * unhandled rejection behind.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HttpRouter } from "effect/http";
import { Effect } from "effect";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import type { Logger } from "@kolu/surface-daemon";
import { closeHost, definePlugin, mountPlugin, openHost, provide, rowReport, settled, standing } from "@olai/effect-cordis";
import {
  BoundOrigin,
  Bundle,
  type HttpRoutes,
  Log,
  NixStore,
  PublicOrigin,
  RootToken,
  type ClaimedRoutes,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { CACHE_KEY } from "./surface";
import { cacheRow } from "./server";
import { diskObjectStore } from "./objectStore";
import { createCache } from "./cache";
import { openCacheRepo } from "./db";
import { asRoot } from "./testlib";
import { canonicalNarHash } from "./narinfo";

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** What the test watches for, in the order the host runs it. */
const seen: string[] = [];

/** The routes the rows registered, in registration order — the host's stub of
 *  `HttpRoutes`, which a real daemon hands to its listener. */
const layers: ClaimedRoutes[] = [];
const routesStub: HttpRoutes = {
  add: (routes) => {
    layers.push(routes);
    return () => {
      const at = layers.indexOf(routes);
      if (at !== -1) layers.splice(at, 1);
    };
  },
  layers: () => layers,
};

/** A bucket no cache has, asked of the cache's OWN routes: a refusal needs the
 *  database, so a `404` says "still open" and anything that throws says the
 *  database went first. */
type CacheRoutes = Parameters<typeof HttpRouter.toWebHandler>[0];

async function cacheAnswers(): Promise<boolean> {
  const only = layers[0]?.layer;
  if (only === undefined) return false;
  // The row registers `cacheRoutes(cache)`; the seam it arrives through is typed
  // for the daemon's composed router, which is broader than one row's layer. The
  // cast is that seam, not a claim about the layer.
  const { handler, dispose } = HttpRouter.toWebHandler(only as unknown as CacheRoutes, {
    disableLogger: true,
  });
  try {
    const answer = await handler(
      new Request("http://127.0.0.1:18440/cache/teardown-probe/nix-cache-info"),
    );
    return answer.status === 404;
  } catch {
    return false;
  } finally {
    await dispose();
  }
}

/** The sibling row: no services, one finalizer, so the host tears down more than
 *  one activation and the order between them is the framework's business. */
const siblingRow = definePlugin({
  name: "sibling",
  needs: [],
  apply: Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        seen.push("sibling");
      }),
    );
  }),
});

describe("the cache row's teardown", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "odu-cache-teardown-"));
    seen.length = 0;
    layers.length = 0;
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("starts the migration after apply returns, scoped to the row", async () => {
    // A REAL ROW, OBJECTLESS: a store path in the test machine's own store, a
    // bucket, and a row with no object. The migration must find it with no
    // request; the old bug forked it with `forkChild`, which was interrupted
    // when apply's fiber ended.
    const source = join(scratch, "migrate-me");
    writeFileSync(source, "the migration must keep this");
    const added = spawnSync("nix", ["store", "add-file", source], { encoding: "utf-8" });
    expect(added.status).toBe(0);
    const storePath = added.stdout.trim();
    const rowHash = "d".repeat(32);
    const info = JSON.parse(
      spawnSync("nix", ["path-info", "--json", storePath], { encoding: "utf-8" }).stdout,
    ) as Record<string, { narHash: string; narSize: number }> | { narHash: string; narSize: number }[];
    const facts = Array.isArray(info) ? info[0] : Object.values(info)[0];
    if (facts === undefined) throw new Error("nix path-info answered nothing");
    const cache = createCache({ stateRoot: scratch, rootToken: "root-token" });
    await cache.admin.create({
      ...asRoot("root-token"),
      name: "main",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    const repo = openCacheRepo(join(scratch, "cache", "cache.sqlite"));
    repo.putObject({
      bucket: "main",
      storePath,
      hash: rowHash,
      narHash: canonicalNarHash(facts.narHash),
      narSize: facts.narSize,
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
    repo.close();
    await cache.close();

    const run = standing();
    const host = await run(openHost);
    await run(provide(host, StateDir, () => scratch));
    await run(provide(host, RootToken, () => "root-token"));
    await run(provide(host, NixStore, () => null));
    await run(provide(host, BoundOrigin, () => "http://127.0.0.1:18440"));
    await run(provide(host, PublicOrigin, () => null));
    await run(provide(host, Log, () => silentLog));
    await run(provide(host, Routes, () => routesStub));
    await run(
      provide(host, Bundle, () => ({
        mount: () => ({
          ctx: { collections: { buckets: { upsert: () => {}, remove: () => {} } } },
          drop: async () => {},
        }),
      }) as unknown as RootedSurfacesRuntime<never>),
    );
    await run(mountPlugin(host, cacheRow(new Map())));

    // NO REQUEST: the row's scoped fiber must put the object.
    const deadline = Date.now() + 10_000;
    let row = null;
    while (Date.now() < deadline) {
      const read = openCacheRepo(join(scratch, "cache", "cache.sqlite"));
      row = read.object("main", storePath);
      read.close();
      if (row?.fileHash !== null && row?.fileHash !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(row?.fileHash ?? null).not.toBeNull();
    await run(closeHost(host));
  });

  it("refuses to mount a bucket whose store is no longer declared, saying which", async () => {
    // A BUCKET ON A STORE the operator has since removed from the config.
    const before = createCache({
      stateRoot: scratch,
      rootToken: "root-token",
      stores: new Map([["nas", diskObjectStore({ dir: join(scratch, "nas") })]]),
    });
    await before.admin.create({ ...asRoot("root-token"), name: "main", public: true, retentionDays: 30, upstreamKeys: [], store: "nas" });
    await before.close();

    const run = standing();
    const host = await run(openHost);
    await run(provide(host, StateDir, () => scratch));
    await run(provide(host, RootToken, () => "root-token"));
    await run(provide(host, NixStore, () => null));
    await run(provide(host, BoundOrigin, () => "http://127.0.0.1:18440"));
    await run(provide(host, PublicOrigin, () => null));
    await run(provide(host, Log, () => silentLog));
    await run(provide(host, Routes, () => routesStub));
    await run(provide(host, Bundle, () => ({}) as unknown as RootedSurfacesRuntime<never>));
    await run(mountPlugin(host, cacheRow(new Map())));
    await run(settled(host, [CACHE_KEY]));
    const report = await run(rowReport(host, [CACHE_KEY]));
    // THE SENTENCE THE HOST PRINTS: "the cache row failed to start: …".
    expect(report.get(CACHE_KEY)).toMatchObject({
      state: "failed",
      fault: expect.stringContaining('the bucket "main" keeps its objects in the store "nas"'),
    });
    expect(layers).toEqual([]);
    await run(closeHost(host));
  });

  it("drops the mount before the database closes, and closes cleanly", async () => {
    const rejections: unknown[] = [];
    const watch = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", watch);

    const run = standing();
    try {
      const host = await run(openHost);
      await run(provide(host, StateDir, () => scratch));
      await run(provide(host, RootToken, () => "root-token"));
      await run(provide(host, NixStore, () => null));
      await run(provide(host, BoundOrigin, () => "http://127.0.0.1:18440"));
      await run(provide(host, PublicOrigin, () => null));
      await run(provide(host, Log, () => silentLog));
      await run(provide(host, Routes, () => routesStub));
      // THE BUNDLE, as far as this row uses it: it mounts, and it hands back the
      // context to publish through. The drop is OURS, which is the whole point —
      // it is the instant this test has to be standing in.
      await run(
        provide(host, Bundle, () => ({
          mount: () => ({
            ctx: {
              collections: {
                buckets: {
                  upsert: () => {},
                  remove: () => {},
                },
              },
            },
            drop: async () => {
              seen.push(`drop:${(await cacheAnswers()) ? "database-open" : "database-closed"}`);
            },
          }),
        }) as unknown as RootedSurfacesRuntime<never>),
      );

      await run(mountPlugin(host, siblingRow));
      await run(mountPlugin(host, cacheRow(new Map())));

      // ONE attach, so the publish half is wired before anything moves.
      expect(layers.length).toBe(1);

      // The cache answers before the close — the baseline the probe needs.
      expect(await cacheAnswers()).toBe(true);

      await run(closeHost(host));

      // A rejection is reported on a LATER turn of the loop, not at the throw:
      // one macrotask boundary is the soonest it can be observed, and it is the
      // event this test waits for rather than a duration it hopes is long
      // enough.
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toEqual([]);
      expect(seen).toContain("drop:database-open");
      expect(seen).toContain("sibling");
    } finally {
      process.off("unhandledRejection", watch);
    }
  });
});
