/**
 * THE CACHE, AS A ROW — the surface implemented, the bucket rows published,
 * and nothing about who is serving it.
 *
 * ## What moved here, and why it is not a port any more
 *
 * The service used to administer this cache through a `CacheAdmin` port, and
 * every one of the eight verbs carried the caller's `rootToken` across the wire
 * so the CACHE could decide whether it matched. That was one authority pretending
 * to be two: the port's own contribution was a `url`, which the service built
 * from a `publicOrigin` it had been told, and the rest was delegation. So the
 * cache implements its own surface and builds its own URLs, which means
 * `publicOrigin` and the mount point are facts it is CONSTRUCTED with — the
 * composition root's only remaining job is to say where the daemon is reachable.
 *
 * ## The row is published, not polled
 *
 * `buckets` is a collection, and every row in it is a bucket's totals. The cache
 * knows when those move — a narinfo landed, a bucket was created, a closure was
 * pinned or collected, reads accumulated (`Cache.onChange`) — so this module
 * subscribes once and republishes. Nothing walks the catalog on a timer.
 *
 * A publish is a DIFF: a bucket whose row did not change is not republished,
 * because every upsert wakes every subscriber and a cache being read from moves
 * a counter once a second.
 *
 * ## `attach`, and why the server does not mount itself
 *
 * A sibling's publishing handle comes from the composed bundle's own `mount`, and
 * the HOST is what composes. So the row hands the server the handle once it is
 * mounted (`attach`) and the server publishes through it from then on. Before
 * `attach` there is nothing to publish to, and nothing has happened yet either:
 * the rows are read from the database, not held in memory.
 */

import { Effect } from "effect";
import type { ImplementSurfaceDeps } from "@kolu/surface/server";
import type { BucketFacts, Cache, CacheOutcome } from "./cache";
import {
  type CacheBucket,
  CacheRefused,
  oduCacheSurface,
} from "./surface";

type CacheSpec = (typeof oduCacheSurface)["spec"];

/** The key whose signature makes a path "already upstream" when a caller names
 *  none — nixpkgs', which is what a bucket almost always means. */
const DEFAULT_UPSTREAM_KEY = "cache.nixos.org-1";
export type CacheSurfaceDeps = ImplementSurfaceDeps<CacheSpec>;

/** The sibling's publishing half, as the composed bundle hands it over. */
export interface CachePublisher {
  upsert(key: string, row: CacheBucket): void;
  remove(key: string): void;
}

export interface CacheServerOptions {
  readonly cache: Cache;
  /** The origin a bucket's substituter URL is published under — the PUBLIC one
   *  when a proxy stands in front, the bound one otherwise. */
  readonly publicOrigin: string;
  /** Where the protocol is mounted under that origin, `/cache` by default. */
  readonly mount: string;
}

export interface CacheServer {
  readonly surface: typeof oduCacheSurface;
  readonly deps: CacheSurfaceDeps;
  /** Hand over the publishing half once the sibling is mounted. */
  readonly attach: (publisher: CachePublisher) => void;
  /** Republish every changed row now. Called by `attach` and by `onChange`. */
  readonly publish: () => void;
  /** Stop listening. The activation's cleanup, alongside the cache's own. */
  readonly detach: () => void;
}

export function cacheServer(opts: CacheServerOptions): CacheServer {
  const { cache } = opts;
  /** What was last published, per bucket name, so a republish is a DIFF. */
  const published = new Map<string, string>();
  /** The surface's own read model: what a subscriber's `readAll` answers. It is
   *  filled by the framework from the same `upsert`s a publish performs, so the
   *  two cannot disagree. */
  const rows = new Map<string, CacheBucket>();
  let publisher: CachePublisher | null = null;

  /** A bucket's row: the cache's own facts plus the one thing the cache cannot
   *  know — where it is reachable from. */
  const rowOf = (facts: BucketFacts): CacheBucket => ({
    ...facts,
    upstreamKeys: [...facts.upstreamKeys],
    url: `${opts.publicOrigin}${opts.mount}/${facts.name}`,
  });

  const publish = (): void => {
    if (publisher === null) return;
    const next = new Map<string, string>();
    for (const facts of cache.snapshot()) {
      const row = rowOf(facts);
      const encoded = JSON.stringify(row);
      next.set(row.name, encoded);
      if (published.get(row.name) === encoded) continue;
      published.set(row.name, encoded);
      rows.set(row.name, row);
      publisher.upsert(row.name, row);
    }
    // A bucket that went away — `odu cache` has no delete yet, but a row left
    // behind by one would be a row nobody can open.
    for (const name of [...published.keys()]) {
      if (next.has(name)) continue;
      published.delete(name);
      rows.delete(name);
      publisher.remove(name);
    }
  };

  /** One admin call as a procedure's answer: the outcome mapped onto the
   *  surface's declared error channel, so a face branches on ONE tagged error
   *  whichever verb it called. */
  const answer = <A, B>(
    work: () => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused> =>
    Effect.flatMap(Effect.promise(work), (outcome) =>
      outcome.ok
        ? Effect.succeed(map(outcome.value))
        : Effect.fail(new CacheRefused({ code: outcome.code, message: outcome.message })),
    );

  const deps: CacheSurfaceDeps = {
    collections: {
      buckets: {
        readAll: () => rows,
        // PERSISTENCE ONLY — the framework wraps these to publish, and the
        // `upsert` the outside world sees is the one in `publish` above.
        upsert: (key, row) => {
          rows.set(key, row);
        },
        remove: (key) => {
          rows.delete(key);
        },
      },
    },
    procedures: {
      bucket: {
        create: ({ input }) =>
          Effect.tap(
            answer(
              () =>
                cache.admin.create({
                  rootToken: input.rootToken,
                  name: input.name,
                  public: input.public,
                  retentionDays: input.retentionDays,
                  // The default lives where the filter is EXPLAINED, in the
                  // contract's own doc: an absent list means nixpkgs' key, the
                  // filter that keeps an upstream closure out of a bucket.
                  upstreamKeys: input.upstreamKeys ?? [DEFAULT_UPSTREAM_KEY],
                }),
              (facts) => rowOf(facts),
            ),
            // The bucket must be on the board before the answer leaves: a CLI
            // that creates one and a browser that is watching are the same
            // moment, and "I just made it and it is not there" is the one thing
            // a projection must never say.
            () => Effect.sync(publish),
          ),
        list: ({ input }) =>
          answer(
            () => cache.admin.list(input),
            (buckets) => ({
              buckets: buckets.map((facts) => rowOf(facts)),
            }),
          ),
        describe: ({ input }) =>
          answer(() => cache.admin.describe(input), (identity) => ({
            ...identity,
            url: `${opts.publicOrigin}${opts.mount}/${identity.name}`,
          })),
        paths: ({ input }) =>
          answer(
            () =>
              cache.admin.paths({
                bucket: input.bucket,
                filter: input.filter ?? null,
                after: input.after ?? null,
              }),
            (page) => ({
              paths: page.paths.map((path) => ({ ...path })),
              ...(page.next === null ? {} : { next: page.next }),
            }),
          ),
      },
      token: {
        mint: ({ input }) =>
          answer(
            () =>
              cache.admin.tokenMint({
                rootToken: input.rootToken,
                bucket: input.bucket,
                bucketGlob: input.bucketGlob ?? null,
                scope: input.scope,
                expiresDays: input.expiresDays ?? null,
              }),
            (minted) => ({ token: minted.token, facts: minted.facts }),
          ),
        list: ({ input }) =>
          answer(
            () =>
              cache.admin.tokenList({
                rootToken: input.rootToken,
                bucket: input.bucket ?? null,
              }),
            (tokens) => ({ tokens: tokens.map((facts) => facts) }),
          ),
        revoke: ({ input }) => answer(() => cache.admin.tokenRevoke(input), (it) => it),
      },
      pin: {
        create: ({ input }) =>
          Effect.tap(
            answer(
              () =>
                cache.admin.pin({
                  rootToken: input.rootToken,
                  bucket: input.bucket,
                  name: input.name,
                  paths: input.paths,
                }),
              (facts) => ({ ...facts, rootPaths: [...facts.rootPaths] }),
            ),
            () => Effect.sync(publish),
          ),
      },
      gc: {
        run: ({ input }) =>
          Effect.tap(
            answer(
              () =>
                cache.admin.gc({
                  rootToken: input.rootToken,
                  bucket: input.bucket ?? null,
                }),
              (report) => report,
            ),
            () => Effect.sync(publish),
          ),
      },
      stats: {
        read: ({ input }) =>
          answer(
            () => cache.admin.stats(input),
            (stats) => ({
              ...stats,
              buckets: stats.buckets.map((facts) => rowOf(facts)),
            }),
          ),
      },
    },
  };

  const detach = cache.onChange(publish);

  return {
    surface: oduCacheSurface,
    deps,
    attach: (next) => {
      publisher = next;
      publish();
    },
    publish,
    detach,
  };
}
