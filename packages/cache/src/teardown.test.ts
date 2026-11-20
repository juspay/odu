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
  CacheGrants,
  CachePurge,
  type HttpRoutes,
  Log,
  Metrics,
  NixStore,
  PublicOrigin,
  grantsBroker,
  purgeBroker,
  RootToken,
  type ClaimedRoutes,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { metricsBroker } from "@odu/cordis/metrics";
import { CACHE_KEY } from "./surface";
import { cacheRow } from "./server";
import { diskObjectStore } from "@odu/objects";
import { createCache } from "./cache";
import { openCacheRepo } from "./db";
import { asRoot, localStores } from "./testlib";
import { canonicalNarHash } from "./narinfo";

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const seen: string[] = [];

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

type CacheRoutes = Parameters<typeof HttpRouter.toWebHandler>[0];

async function cacheAnswers(): Promise<boolean> {
  const only = layers[0]?.layer;
  if (only === undefined) return false;
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
    const cache = createCache({
      stateRoot: scratch,
      stores: localStores(scratch),
      rootToken: "root-token",
      publicOrigin: "http://cache.test",
    });
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
      lastWanted: 0,
      run: null,
      commit: null,
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
    await run(provide(host, CachePurge, () => purgeBroker()));
    await run(provide(host, CacheGrants, () => grantsBroker()));
    await run(provide(host, Routes, () => routesStub));
    await run(provide(host, Metrics, () => metricsBroker()));
    await run(
      provide(host, Bundle, () => ({
        mount: () => ({
          ctx: { collections: { buckets: { upsert: () => {}, remove: () => {} } } },
          drop: async () => {},
        }),
      }) as unknown as RootedSurfacesRuntime<never>),
    );
    await run(mountPlugin(host, cacheRow(new Map())));

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
    const before = createCache({
      stateRoot: scratch,
      rootToken: "root-token",
      publicOrigin: "http://cache.test",
      stores: new Map([...localStores(scratch), ["nas", diskObjectStore({ dir: join(scratch, "nas") })]]),
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
    await run(provide(host, CachePurge, () => purgeBroker()));
    await run(provide(host, CacheGrants, () => grantsBroker()));
    await run(provide(host, Routes, () => routesStub));
    await run(provide(host, Metrics, () => metricsBroker()));
    await run(provide(host, Bundle, () => ({}) as unknown as RootedSurfacesRuntime<never>));
    await run(mountPlugin(host, cacheRow(new Map())));
    await run(settled(host, [CACHE_KEY]));
    const report = await run(rowReport(host, [CACHE_KEY]));
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
    await run(provide(host, CachePurge, () => purgeBroker()));
    await run(provide(host, CacheGrants, () => grantsBroker()));
      await run(provide(host, Routes, () => routesStub));
      await run(provide(host, Metrics, () => metricsBroker()));
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

      expect(layers.length).toBe(1);

      expect(await cacheAnswers()).toBe(true);

      await run(closeHost(host));

      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toEqual([]);
      expect(seen).toContain("drop:database-open");
      expect(seen).toContain("sibling");
    } finally {
      process.off("unhandledRejection", watch);
    }
  });
});
