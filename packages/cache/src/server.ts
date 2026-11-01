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
 * ## `row` — the plugin, and where the mounting happens
 *
 * A row is a `definePlugin`: it names what it needs, builds its share of the
 * daemon while that scope is open, and has everything it registered unwound when
 * the scope closes. This module ships {@link cacheRow}, which MOUNTS ITSELF on
 * the composed bundle — the framework's transactional `mount`, called inside the
 * row's own `apply` — and drops that mount in its finalizer. Nothing outside
 * this package mounts it, spreads a table, or holds a callback called after the
 * plugins settle.
 *
 * The facts arrive as Cordis services (`@odu/cordis/services`): the state root,
 * the root token, the store URI, the bound and public origins, the logger, the
 * bundle to mount on, and the router mount for the protocol routes.
 */

import { Effect, Fiber } from "effect";
import { definePlugin, offer } from "@olai/effect-cordis";
import type { ImplementSurfaceDeps } from "@kolu/surface/server";
import {
  BoundOrigin,
  Bundle,
  BucketDomains,
  type BucketDomains as BucketDomainsFacts,
  Log,
  NixStore,
  PublicOrigin,
  RootToken,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { createCache, roleAuthority, type Authority, type BucketFacts, type Cache, type CacheOutcome } from "./cache";
import { may, principalOf, type Principal } from "@odu/cordis/principal";
import { bucketOf, CACHE_MOUNT, CACHE_ROUTE_PATHS } from "./paths";
import { cacheRoutes } from "./routes";
import { nixDump, nixPathInfo } from "./store";
import {
  type CacheBucket,
  CACHE_KEY,
  CacheRefused,
  oduCacheSurface,
} from "./surface";

type CacheSpec = (typeof oduCacheSurface)["spec"];

/** The key whose signature makes a path "already upstream" when a caller names
 *  none — nixpkgs', which is what a bucket almost always means. */
const DEFAULT_UPSTREAM_KEY = "cache.nixos.org-1";
export type CacheSurfaceDeps = ImplementSurfaceDeps<CacheSpec>;

/** The sibling's publishing half, as the composed bundle hands it over — the
 *  two collections this row owns, each with its own key type. */
export interface CachePublisher {
  readonly buckets: {
    upsert(key: string, row: CacheBucket): void;
    remove(key: string): void;
  };
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
  /** Hand over the publishing half once the sibling is mounted. Called by the
   *  row, with the `ctx` its own `mount` returned. */
  readonly attach: (publisher: CachePublisher) => void;
  /** Republish every changed row now. Called by `attach` and by the CACHE's own
   *  change notification — never by a verb, because a verb cannot know whether
   *  the row it touched is the one that moved. */
  readonly publish: () => void;
  /** Stop listening. The activation's cleanup, alongside the cache's own. */
  readonly detach: () => void;
  /** The substituter URL for one bucket, as the cache row publishes it — the
   *  same string the board's row carries, for a route that takes no root token. */
  readonly substituterUrl: (name: string) => string;
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
  /** WHERE THIS BUCKET IS REACHABLE — the one string a person pastes into a
   *  `nix.conf`, built once. The board's row and `bucket.describe` both answer
   *  it, and two builders were two chances for them to disagree about the
   *  address the cache is actually served at. */
  /** The SCHEME the deployment's public origin uses — a bucket's domain is
   *  reached over the same TLS story, and the module's test vhost is plain
   *  HTTP. */
  const scheme = ((): string => {
    try {
      return new URL(opts.publicOrigin).protocol;
    } catch {
      return "https:";
    }
  })();

  /**
   * WHERE A CLIENT SUBSTITUTES THIS BUCKET FROM. A domain is the whole
   * address (that is what "a name of its own" means); otherwise the bucket is a
   * path under the origin.
   */
  const urlOf = (facts: { name: string; domain: string | null }): string =>
    facts.domain === null
      ? `${opts.publicOrigin}${opts.mount}/${facts.name}`
      : `${scheme}//${facts.domain}`;

  /** WHERE A PUSH ADDRESSES IT. Always the path form: the push API needs the
   *  bucket's name, and a domain host answers `/cache/<name>` too. */
  const pushUrlOf = (name: string): string => `${opts.publicOrigin}${opts.mount}/${name}`;

  const rowOf = (facts: BucketFacts): CacheBucket => ({
    ...facts,
    upstreamKeys: [...facts.upstreamKeys],
    url: urlOf(facts),
    pushUrl: pushUrlOf(facts.name),
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
      publisher.buckets.upsert(row.name, row);
    }
    // A bucket that went away — `odu cache` has no delete yet, but a row left
    // behind by one would be a row nobody can open.
    for (const name of [...published.keys()]) {
      if (next.has(name)) continue;
      published.delete(name);
      rows.delete(name);
      publisher.buckets.remove(name);
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

  /**
   * HOW this caller may act — the row's one construction of `Authority`.
   *
   * A signed-in person is a ROLE the row has already checked (or not, for a
   * read); the local owner is the operator's ROOT TOKEN. The engine cannot turn
   * one into the other, because they are different arms.
   */
  const authorityOf = (
    principal: Principal,
    input: { rootToken: string },
  ): Authority =>
    principal.kind === "user"
      ? roleAuthority(principal.login)
      : { kind: "root", rootToken: input.rootToken };

  /** One answer, with this ROW's authority rule applied first.
   *
   *  The cache's rule: ADMINISTRATION needs an `admin` — or the operator's root
   *  token, which is the rule when no identity provider is mounted and therefore
   *  the only one a loopback daemon has. A signed-in MEMBER is refused here, by
   *  the row that decided what administration means, and the engine never sees
   *  the call. */
  const admin = <A, B>(
    input: { rootToken: string },
    work: (authority: Authority) => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused> =>
    Effect.flatMap(principalOf, (principal) => {
      if (principal.kind === "user" && !may(principal, "admin")) {
        return Effect.fail(
          new CacheRefused({
            code: "not_permitted",
            message:
              `odu: administering a bucket needs an admin — ${principal.login} ` +
              `is a ${principal.role}`,
          }),
        );
      }
      return answer(() => work(authorityOf(principal, input)), map);
    });

  /** A READ any signed-in person may make: a bucket's rows, its URL and key.
   *
   *  No floor above "signed in" — the gate has already refused an anonymous
   *  connection — and the root token still applies to a local caller. */
  const member = <A, B>(
    input: { rootToken: string },
    work: (authority: Authority) => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused> =>
    Effect.flatMap(principalOf, (principal) =>
      answer(() => work(authorityOf(principal, input)), map),
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
          admin(
            input,
            (authority) =>
              cache.admin.create({
                authority,
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
        list: ({ input }) =>
          member(
            input,
            (authority) => cache.admin.list({ authority }),
            (buckets) => ({
              buckets: buckets.map((facts) => rowOf(facts)),
            }),
          ),
        describe: ({ input }) =>
          answer(() => cache.admin.describe(input), (identity) => ({
            ...identity,
            url: urlOf(identity),
          })),
        domain: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.domain({
                authority,
                bucket: input.bucket,
                domain:
                  input.domain === undefined || input.domain.trim() === ""
                    ? null
                    : input.domain,
              }),
            (facts) => rowOf(facts),
          ),
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
          admin(
            input,
            (authority) =>
              cache.admin.tokenMint({
                authority,
                bucket: input.bucket,
                bucketGlob: input.bucketGlob ?? null,
                scope: input.scope,
                expiresDays: input.expiresDays ?? null,
              }),
            (minted) => ({ token: minted.token, facts: minted.facts }),
          ),
        list: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.tokenList({
                authority,
                bucket: input.bucket ?? null,
              }),
            (tokens) => ({ tokens: tokens.map((facts) => facts) }),
          ),
        revoke: ({ input }) =>
          admin(
            input,
            (authority) => cache.admin.tokenRevoke({ authority, id: input.id }),
            (it) => it,
          ),
      },
      pin: {
        create: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.pin({
                authority,
                bucket: input.bucket,
                name: input.name,
                paths: input.paths,
              }),
            (facts) => ({ ...facts, rootPaths: [...facts.rootPaths] }),
          ),
      },
      gc: {
        run: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.gc({
                authority,
                bucket: input.bucket ?? null,
              }),
            (report) => report,
          ),
      },
      stats: {
        read: ({ input }) =>
          admin(
            input,
            (authority) => cache.admin.stats({ authority }),
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
    substituterUrl: (name) => {
      const bucket = cache.bucket(name);
      return urlOf({ name, domain: bucket?.domain ?? null });
    },
  };
}

// ── the row ─────────────────────────────────────────────────────────────────

/**
 * THE ROW AS A PLUGIN — mounted by the host with the rest of the roster, and
 * mounting ITSELF on the composed bundle.
 *
 * The order inside `apply` is the order it has to be: the cache exists before
 * the surface that serves it, the mount happens before anything can address it,
 * and every one of those is undone in reverse when the scope closes.
 */
export const cacheRow = definePlugin({
  name: CACHE_KEY,
  needs: [Bundle, Routes, StateDir, RootToken, NixStore, BoundOrigin, PublicOrigin, Log],
  apply: Effect.gen(function* () {
    const bundle = yield* Bundle;
    const routes = yield* Routes;
    const stateDir = yield* StateDir;
    const rootToken = yield* RootToken;
    const store = yield* NixStore;
    const boundOrigin = yield* BoundOrigin;
    const publicOrigin = yield* PublicOrigin;
    const log = yield* Log;

    const cache = createCache({
      stateRoot: stateDir,
      rootToken,
      // THE OLD NIX STORE is read ONLY by the one-time object migration. A
      // fresh deployment leaves this null and the cache never shells out.
      // `NixStore` NULL IS THE HOST'S OWN /nix/store (the contract): a module
      // deployment migrates from there; the pod names its chroot store.
      legacyStore: {
        dump: (path) => nixDump(path, store),
        pathInfo: (path) => nixPathInfo(path, store),
      },
      // ONE structured line per operational fact. The Effect logger renders
      // the fields; no per-chunk lines, no narration.
      log: (event, fields) => log.info(fields, `odu cache: ${event}`),
    });
    // BEFORE THE MOUNT: CA proof and the orphan/temp sweep. Nothing is
    // writing yet, so this cannot race a push.
    const boot = yield* Effect.promise(() => cache.boot());
    if (boot.caProved > 0) {
      log.info({ proved: boot.caProved }, "odu cache: boot proved CA");
    }
    if (boot.orphansSwept > 0 || boot.tempSwept > 0) {
      log.info(
        { swept: boot.orphansSwept, temp: boot.tempSwept },
        "odu cache: boot swept orphan objects",
      );
    }

    // THE ROW'S PUBLISHED FACT: the names its buckets carry. A row that routes
    // those names (the cloudflare row) declares this service; it never opens
    // this package's database or calls its verbs.
    const domains: BucketDomainsFacts = {
      current: () =>
        cache.snapshot().flatMap((bucket) =>
          bucket.domain === null ? [] : [{ bucket: bucket.name, domain: bucket.domain }],
        ),
      subscribe: (listener) => cache.onChange(listener),
      // The paths this row answers. A bucket DOMAIN forwards every path of its
      // name to the daemon; the host's gate keeps everything outside this list
      // (the board, `/mcp`, `/auth`, the websocket) off that name.
      paths: CACHE_ROUTE_PATHS,
      bucketOf,
    };
    yield* offer(BucketDomains, () => domains);

    const server = cacheServer({
      cache,
      // The address a client must be told: the proxy's when one stands in
      // front, the bound one otherwise. A loopback URL in a `nix.conf` is a
      // substituter that works for nobody.
      publicOrigin: publicOrigin ?? boundOrigin,
      mount: CACHE_MOUNT,
    });

    // THE MOUNT, in the activation. The framework walks the arriving surface,
    // proves the whole route set disjoint across root and siblings, and hands
    // back the `ctx` this row publishes through.
    const mounted = bundle.mount(CACHE_KEY, server.surface, server.deps);
    server.attach({
      buckets: {
        upsert: (key, row) => mounted.ctx.collections.buckets.upsert(key, row),
        remove: (key) => mounted.ctx.collections.buckets.remove(key),
      },
    });

    // The Nix protocol, registered where the row activates rather than
    // collected by a host that has to know what a row is. The row answers a
    // bucket's anonymous consumer facts from the same URL builder the board's
    // row uses, so the page and a cURL cannot disagree about the address.
    routes.add(
      cacheRoutes(
        cache,
        (name) => server.substituterUrl(name),
        publicOrigin ?? boundOrigin,
      ),
    );

    // AFTER THE MOUNT, AND ROW-OWNED: the migration dumps tens of gigabytes
    // and must not hold `/` or `/cache/*` down while it does. The row's
    // finalizer interrupts it before the database closes.
    const migration = yield* Effect.forkChild(Effect.promise(() => cache.migrate()));
    yield* Effect.addFinalizer(() => Fiber.interrupt(migration));

    // FINALIZERS RUN IN REVERSE, so the one registered SECOND runs FIRST, and
    // the safe order is: the mount goes, THEN the database. A publish that
    // landed on a mount still standing while its database had closed would read
    // a torn-down cache; a mount dropped while the cache is open still is the
    // ask it was built for. So the cleanup is registered first and the drop
    // second, and `teardown.test.ts` closes a two-row host and proves it by
    // probing the cache from inside the drop.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        server.detach();
        await cache.close();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => mounted.drop()));

    log.info(
      { mount: CACHE_MOUNT, buckets: cache.snapshot().length },
      "odu web: the cache row is serving",
    );
  }),
});

/** The routes this row registers, with their claim — for the host's gate test,
 *  which records what the layer registers and checks the claim covers it. */
export { cacheRoutes } from "./routes";
