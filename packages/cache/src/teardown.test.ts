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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HttpRouter } from "effect/http";
import { Effect } from "effect";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import type { Logger } from "@kolu/surface-daemon";
import { closeHost, definePlugin, mountPlugin, openHost, provide, standing } from "@olai/effect-cordis";
import {
  BoundOrigin,
  Bundle,
  type HttpRoutes,
  Log,
  NixStore,
  PublicOrigin,
  RootToken,
  type RowRoutes,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { cacheRow } from "./server";

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
const layers: RowRoutes[] = [];
const routesStub: HttpRoutes = {
  add: (routes) => {
    layers.push(routes);
  },
  layers: () => layers,
};

/** A bucket no cache has, asked of the cache's OWN routes: a refusal needs the
 *  database, so a `404` says "still open" and anything that throws says the
 *  database went first. */
type CacheRoutes = Parameters<typeof HttpRouter.toWebHandler>[0];

async function cacheAnswers(): Promise<boolean> {
  const only = layers[0];
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
      await run(mountPlugin(host, cacheRow));

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
