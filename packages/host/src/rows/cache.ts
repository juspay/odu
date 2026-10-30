/**
 * THE `cache` ROW — Nix binary cache buckets, served BESIDE the runs.
 *
 * A row is a `definePlugin`: it names what it needs, builds its share of the
 * daemon while that scope is open, and has everything it registered unwound in
 * reverse when the scope closes. So the cache's database handle is released by
 * the row's own cleanup rather than by a line in somebody else's `finally`.
 *
 * ## What it contributes, and why it is a SIBLING
 *
 * The runs are the wire's ROOT — their tags are the bare ones every face was
 * published against. The cache is served BESIDE them, under the key `cache`, so
 * its members read `surface/cache/bucket/create` on the wire and
 * `cache_bucket_create` to an agent. That is the whole shape of PR 1.5: a row
 * that names only itself.
 *
 * It brings three things to the composition, and the host spends all three:
 *
 *   - its SURFACE (`@odu/cache/surface`), mounted through the framework's own
 *     transactional `mount`, which proves the route set disjoint across root and
 *     siblings before anything is committed;
 *   - its PROTOCOL ROUTES (`@odu/cache/routes`), the standard Nix HTTP binary
 *     cache served at `/cache/<bucket>/…`;
 *   - its ROWS, published through the sibling's own `ctx` once it is mounted —
 *     so a push that lands while a board is open moves the board, and nothing
 *     polls for it.
 *
 * ## The facts it is handed
 *
 * The state root, the operator's root token, the `--store` URI, the origin the
 * daemon is BOUND at and the public one a proxy publishes. The cache builds a
 * bucket's substituter URL from the last two, which is why it takes them at
 * construction: the URL is the cache's own fact now, not a field the service
 * pasted on afterwards.
 */

import { Effect } from "effect";
import { definePlugin } from "@olai/effect-cordis";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import { createCache, type Cache } from "@odu/cache/cache";
import { cacheRoutes } from "@odu/cache/routes";
import { cacheServer, type CachePublisher } from "@odu/cache/server";
import {
  type CacheBucket,
  ODU_CACHE_EXPOSE,
  ODU_CACHE_MCP_INSTRUCTIONS,
} from "@odu/cache/surface";
import {
  BoundOrigin,
  Log,
  NixStore,
  PublicOrigin,
  RootToken,
  Rows,
  StateDir,
} from "../services";

export const CACHE_ROW = "cache";

/** Where the protocol is mounted under the origin — the cache's own constant,
 *  re-exported by the row so the composition has one spelling of it. */
export { CACHE_MOUNT } from "@odu/cache/paths";

export const cacheRow = definePlugin({
  name: CACHE_ROW,
  needs: [Rows, StateDir, RootToken, NixStore, BoundOrigin, PublicOrigin, Log],
  apply: Effect.gen(function* () {
    const rows = yield* Rows;
    const stateDir = yield* StateDir;
    const rootToken = yield* RootToken;
    const store = yield* NixStore;
    const boundOrigin = yield* BoundOrigin;
    const publicOrigin = yield* PublicOrigin;
    const log = yield* Log;

    const cache: Cache = createCache({ stateRoot: stateDir, rootToken, store });
    const mount = "/cache";
    const server = cacheServer({
      cache,
      // The address a client must be told: the proxy's when one stands in
      // front, the bound one otherwise. A loopback URL in a `nix.conf` is a
      // substituter that works for nobody.
      publicOrigin: publicOrigin ?? boundOrigin,
      mount,
    });

    /** Filled by `attach` below; the row body cannot mount itself, because the
     *  bundle is the host's. */
    let publisher: CachePublisher | null = null;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rows.drop(CACHE_ROW);
        server.detach();
        cache.close();
      }),
    );

    rows.put(CACHE_ROW, {
      runtime: null,
      // The sibling joins the runs' bundle through the framework's own door: it
      // walks the arriving surface and proves the whole route set disjoint
      // before anything is committed, and it hands back the ctx this row
      // publishes through.
      attach: (root: RootedSurfacesRuntime<never>) => {
        const mounted = root.mount("cache", server.surface, server.deps);
        publisher = {
          upsert: (key: string, row: CacheBucket) => mounted.ctx.collections.buckets.upsert(key, row),
          remove: (key: string) => mounted.ctx.collections.buckets.remove(key),
        };
        server.attach(publisher);
        log.info(
          { mount, buckets: cache.snapshot().length },
          "odu web: the cache row is serving",
        );
      },
      routes: cacheRoutes(cache),
      agent: {
        surface: server.surface,
        expose: ODU_CACHE_EXPOSE,
        instructions: ODU_CACHE_MCP_INSTRUCTIONS,
      },
      done: null,
    });
  }),
});
