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
 * bundle to mount on, and the router mount for the protocol routes. The one
 * fact that is this row's own configuration — the stores the operator declared
 * — arrives as the factory's argument, read by {@link readCacheStores} at the
 * host's boot.
 */

import { join } from "node:path";
import type { Row } from "@odu/cordis/services";
import { CACHE_ROW } from "./surface";
import { Cause, Data, Duration, Effect } from "effect";
import { definePlugin, offer } from "@olai/effect-cordis";
import { type ImplementSurfaceDeps, inMemoryStore } from "@kolu/surface/server";
import {
  BoundOrigin,
  Bundle,
  BucketDomains,
  type BucketDomains as BucketDomainsFacts,
  CacheGrants,
  CachePurge,
  Log,
  Metrics,
  NixStore,
  PublicOrigin,
  RootToken,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import {
  createCache,
  type CacheMountRefusal,
  mountRefusalMessage,
  roleAuthority,
  type Authority,
  type BucketFacts,
  type Cache,
  type CacheOutcome,
} from "./cache";
import type { GcCollection, GcRemoval, GcReport } from "./gc";
import { cacheMeter } from "./meter";
import { objectStores, type StoreDeclarations, storeFacts } from "./stores";
import { may, principalOf, type Principal } from "@odu/cordis/principal";
import { bucketOf, CACHE_MOUNT, CACHE_ROUTE_PATHS } from "./paths";
import { cacheRoutes } from "./routes";
import { nixDump, nixPathInfo } from "./store";
import {
  cacheInfoKey,
  narFileKey,
  narinfoKey,
  publicBucketUrl,
  publicObjectUrl,
} from "./staging";
import {
  type CacheBucket,
  CACHE_KEY,
  CacheRefused,
  type CacheStore,
  DEFAULT_RETENTION_DAYS,
  LOCAL_STORE,
  oduCacheSurface,
} from "./surface";

type CacheSpec = (typeof oduCacheSurface)["spec"];

/** The key whose signature makes a path "already upstream" when a caller names
 *  none — nixpkgs', which is what a bucket almost always means. */
const DEFAULT_UPSTREAM_KEY = "cache.nixos.org-1";
export type CacheSurfaceDeps = ImplementSurfaceDeps<CacheSpec>;

/** The sibling's publishing half, as the composed bundle hands it over — the
 *  collection this row owns. */
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
  /** The stores a bucket may live in, for the `stores` cell. */
  readonly stores: readonly CacheStore[];
  /**
   * WHERE A DELETION IS ANNOUNCED — the host's purge broker, or nothing.
   *
   * A collection removes narinfos and NARs an edge may still be serving, and
   * an edge serving a path the origin has forgotten is a client importing
   * bytes nobody can re-fetch. The row turns what left into URLs (it is the
   * only thing here that knows where a bucket is reachable) and hands them
   * over; who purges them, and whether anybody does, is not this row's
   * business — see `@odu/cordis`'s `CachePurge`.
   */
  readonly purge: CachePurge;
  /** One operational line. The row hands the daemon's logger over. */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
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
  /** COLLECT EVERY BUCKET NOW, announcing what left — what the schedule
   *  repeats, and what a test drives instead of waiting for a timer. */
  readonly collect: () => Promise<void>;
  /** Stop listening. The activation's cleanup, alongside the cache's own. */
  readonly detach: () => void;
  /** The substituter URL for one bucket, as the cache row publishes it — the
   *  same string the board's row carries, for a route that takes no root token. */
  readonly substituterUrl: (name: string) => string;
  /** ANNOUNCE WHAT CHANGED OR WENT (PLAN 2.8): a finished store-to-store
   *  move, or a re-push that rewrote a text object. The CACHE names what it
   *  touched — it is the only thing that knows — and the ROW turns that into
   *  the addresses it was served at. */
  readonly announceMoved: (input: {
    bucket: string;
    /** A store the bucket is no longer on, whose domain served these objects
     *  a moment ago; for a re-push, the one it still lives on. */
    store: string;
    reason: "migrate" | "repush" | "delete";
    removals: readonly GcRemoval[];
    /** The bucket's own `nix-cache-info`, which no removal names. */
    cacheInfo?: boolean;
  }) => void;
}

/**
 * HOW OFTEN A CACHE COLLECTS ITSELF.
 *
 * Daily, which is the floor retention's own granularity sets: a collection
 * that ran more often would read the same day-counted clock and delete
 * nothing, and one that ran less often would let a bucket sit over its
 * retention for the gap. A bucket at ZERO days is the one case where sooner
 * would find more — it waits up to one interval, or until somebody presses
 * the button, which is what the button is for.
 *
 * The first run is one interval after the row mounts, not at boot: a daemon
 * restarting in a crash loop must not spend each boot walking every bucket.
 */
export const GC_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * THE DAILY COLLECTION, AS AN EFFECT THE ROW'S SCOPE OWNS.
 *
 * One lifetime idiom in this row, not two: the migration is a `forkScoped`
 * fibre and so is this, so a scope that closes is the whole answer to "when
 * does it stop" — no stop function, no timer handle, nothing to forget to
 * call.
 *
 * The collection itself is UNINTERRUPTIBLE, which is the guarantee that
 * matters: interruption arrives between deletes otherwise, and a row deleted
 * with its object still in the store (or the reverse) is exactly what the
 * write lock exists to prevent. Interrupting a scope therefore WAITS for the
 * collection in flight — and only then does the row's finalizer close the
 * database.
 *
 * A failed collection does not end the schedule. A store that was unreachable
 * this midnight may answer the next one, and a cache that stopped collecting
 * because of one outage would grow silently until somebody noticed.
 */
export function collectEvery(
  everyMs: number,
  collect: () => Promise<void>,
  log?: (event: string, fields: Record<string, unknown>) => void,
): Effect.Effect<never> {
  const once = Effect.uninterruptible(
    Effect.tryPromise({
      try: collect,
      catch: (err) => err,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => log?.("cache.gc.failed", { reason: Cause.pretty(cause) })),
      ),
    ),
  );
  // SLEEP FIRST: the first collection is one interval after the row mounts,
  // so a daemon in a crash loop never spends its boot walking every bucket.
  return Effect.forever(Effect.flatMap(Effect.sleep(Duration.millis(everyMs)), () => once));
}

/**
 * WHICH PRIVATE BUCKETS A BOUND DOMAIN EXPOSES — a read of what is declared,
 * asked at mount.
 *
 * `create` and `migrate` refuse the combination, so this names only what was
 * already there when the operator bound the domain: its narinfos and NARs
 * answer at `<publicUrl>/<bucket>/…` to anyone who knows the name, because
 * the binding covers every prefix in the store and cannot ask who is asking.
 *
 * Not part of the probe below, though both run at mount: this is a fact about
 * the operator's CONFIGURATION and that one is a fact about the NETWORK, and
 * they go wrong for different reasons on different days.
 */
export function exposedBuckets(input: {
  stores: readonly CacheStore[];
  buckets: readonly { name: string; public: boolean; store: string }[];
  log?: (event: string, fields: Record<string, unknown>) => void;
}): readonly { bucket: string; store: string; url: string }[] {
  const exposed: { bucket: string; store: string; url: string }[] = [];
  for (const store of input.stores) {
    if (store.publicUrl === null) continue;
    for (const row of input.buckets) {
      if (row.public || row.store !== store.name) continue;
      const found = {
        bucket: row.name,
        store: store.name,
        url: publicBucketUrl(store.publicUrl, row.name),
      };
      exposed.push(found);
      input.log?.("cache.bucket.exposed", found);
    }
  }
  return exposed;
}

/** A store whose public URL did not answer what a Nix client needs. */
export interface UnreachableStore {
  store: string;
  url: string;
  /** The status it answered, or `null` when the request itself failed. */
  status: number | null;
}

/**
 * DOES THE STORE'S PUBLIC URL ACTUALLY SERVE? — asked once, at mount, for
 * every store that declares one and holds at least one PUBLIC bucket.
 *
 * A `publicUrl` is a promise the operator made outside odu: a custom domain
 * bound to an R2 bucket, a CDN in front of it. Odu advertises it as the
 * substituter URL of every public bucket on that store, so a typo there is a
 * cache that answers 404 to everyone while every page says it is fine.
 * `nix-cache-info` is the first file a Nix client reads and the cheapest
 * thing to ask for, and the daemon wrote it as an object at bucket create.
 *
 * A LOGGED REFUSAL, NEVER A BOOT FAILURE. The daemon still serves every
 * bucket itself; a domain that is being provisioned must not take the cache
 * down while DNS propagates.
 */
export async function probePublicStores(input: {
  stores: readonly CacheStore[];
  buckets: readonly { name: string; public: boolean; store: string }[];
  /** What that bucket's `nix-cache-info` should say — the cache's own
   *  rendering, which carries this daemon's origin and the bucket's name, so
   *  a store serving a STALE copy of it is as unreachable as one serving
   *  nothing. */
  info: (bucket: string) => string;
  log?: (event: string, fields: Record<string, unknown>) => void;
  send?: typeof fetch;
}): Promise<readonly UnreachableStore[]> {
  const send = input.send ?? fetch;
  const unreachable: UnreachableStore[] = [];
  for (const store of input.stores) {
    if (store.publicUrl === null) continue;
    // ONE BUCKET IS THE PROBE for the whole store: the question is whether
    // the domain is bound and serving, not whether each bucket is.
    const bucket = input.buckets.find((row) => row.public && row.store === store.name);
    if (bucket === undefined) continue;
    const url = publicObjectUrl(store.publicUrl, cacheInfoKey(bucket.name));
    const response = await send(url).catch(() => null);
    const body = response === null ? "" : await response.text().catch(() => "");
    if (response !== null && response.status === 200 && body === input.info(bucket.name)) continue;
    const refusal = { store: store.name, url, status: response?.status ?? null };
    unreachable.push(refusal);
    input.log?.("cache.store.public.unreachable", refusal);
  }
  return unreachable;
}

/**
 * IS THIS STORE'S ENDPOINT AN ADDRESS A CLIENT CAN DIAL? — asked once, at
 * mount, for every S3 store that holds a bucket.
 *
 * Before 2.8 the endpoint was dialled by the DAEMON alone, so a loopback or
 * VPC-only address was a fine thing to declare. It is now signed into the
 * presigned URL a 307 hands to `nix build`, which runs somewhere else: an
 * endpoint of `http://127.0.0.1:7070` means every NAR read ends at the
 * client's own machine. The symptom is a substituter that used to work and
 * now cannot fetch, with nothing in odu's log, so the log line is here.
 *
 * It checks the SHAPE, not the reachability: odu cannot dial the client's
 * network, and a name that resolves here may not resolve there. A loopback or
 * link-local literal is the case that is wrong for certain.
 */
export function probeStoreEndpoints(input: {
  stores: readonly { name: string; endpoint: URL }[];
  buckets: readonly { store: string }[];
  log?: (event: string, fields: Record<string, unknown>) => void;
}): readonly { store: string; endpoint: string; host: string }[] {
  // `URL.hostname` keeps an IPv6 literal's brackets and drops the port, so
  // these are the whole of what a loopback or link-local endpoint looks like.
  const local = (host: string): boolean =>
    host === "localhost" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.startsWith("[fe80:");
  const found: { store: string; endpoint: string; host: string }[] = [];
  for (const store of input.stores) {
    if (!local(store.endpoint.hostname)) continue;
    if (!input.buckets.some((bucket) => bucket.store === store.name)) continue;
    const refusal = {
      store: store.name,
      endpoint: store.endpoint.origin,
      host: store.endpoint.hostname,
    };
    found.push(refusal);
    input.log?.("cache.store.endpoint.unreachable", refusal);
  }
  return found;
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

  /** THE PUBLIC URL OF EACH DECLARED STORE, by name — what the operator bound
   *  a domain to. Read once from the declarations the row was built with. */
  const storeUrls = new Map(
    opts.stores.flatMap((store) => (store.publicUrl === null ? [] : [[store.name, store.publicUrl] as const])),
  );

  /**
   * WHO ANSWERS A READ OF THIS BUCKET (PLAN 2.8).
   *
   * The STORE, when it publishes a public URL and the bucket is PUBLIC: the
   * objects are there under `<bucket>/…` and nothing about reading them needs
   * odu, which is the whole point — the cache keeps serving while the daemon
   * is down. A PRIVATE bucket stays odu's however its store is fronted,
   * because a public URL cannot ask who is asking; odu authorises it and
   * redirects the NAR to a URL that expires.
   */
  const readsFromOf = (facts: { name: string; public: boolean; store: string }): "store" | "odu" =>
    facts.public && storeUrls.has(facts.store) ? "store" : "odu";

  /**
   * WHERE A CLIENT SUBSTITUTES THIS BUCKET FROM. The STORE's own domain when
   * its reads come from there; a bucket domain is the whole address (that is
   * what "a name of its own" means); otherwise the bucket is a path under the
   * origin.
   *
   * A STORE-FRONTED BUCKET MAY STILL HAVE A DOMAIN, and odu still honours it
   * for writes and for the `missing` query — but the address advertised to
   * READERS is the store's, because that is the one that answers when odu
   * does not.
   */
  const urlOf = (facts: { name: string; public: boolean; domain: string | null; store: string }): string =>
    readsFromOf(facts) === "store"
      ? publicBucketUrl(storeUrls.get(facts.store) as string, facts.name)
      : facts.domain === null
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
    readsFrom: readsFromOf(facts),
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
    // A bucket that went away — `bucket.delete`, or a row this publisher has
    // outlived. Either way a row left behind is a row nobody can open.
    for (const name of [...published.keys()]) {
      if (next.has(name)) continue;
      published.delete(name);
      rows.delete(name);
      publisher.buckets.remove(name);
    }

  };

  /**
   * WHAT CHANGED, AS URLS — the one place a bucket's object becomes an
   * address, because the row is the one thing here that knows where a bucket
   * is reachable from (its domain, the mount under the origin, the store's
   * own public name).
   *
   * EVERY SPELLING IS ANNOUNCED. An edge may hold
   * `https://cache.example.org/<hash>.narinfo` AND
   * `https://odu.example.org/cache/<bucket>/<hash>.narinfo`, and purging one
   * of them leaves the other serving a path the origin has forgotten.
   *
   * TWO KINDS OF SPELLING, and the difference is what `./narinfo`'s own note
   * warns about: odu's addresses are PROTOCOL PATHS, while a store's are
   * OBJECT KEYS, which are free to move apart from them. So the protocol
   * spelling is composed here and the store's comes from the key builders
   * through `publicObjectUrl`, never by hand.
   *
   * `alsoStore` is a store the bucket is NO LONGER on — what a finished move
   * left behind, whose domain served these very objects a moment ago.
   */
  const urlsFor = (input: {
    bucket: string;
    alsoStore: string | null;
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }): string[] => {
    const facts = cache.bucket(input.bucket);
    // THE READ ADDRESS, not the push API's. They are the same string today
    // and they are different facts: one is where Nix asks, the other is where
    // a client uploads.
    const bases = new Set([`${opts.publicOrigin}${opts.mount}/${input.bucket}`]);
    if (facts?.domain != null) bases.add(`${scheme}//${facts.domain}`);
    const urls: string[] = [];
    for (const base of bases) {
      for (const removal of input.removals) {
        urls.push(`${base}/${removal.hash}.narinfo`);
        if (removal.narFile !== null) urls.push(`${base}/nar/${removal.narFile}`);
      }
      if (input.cacheInfo === true) urls.push(`${base}/nix-cache-info`);
    }
    // THE STORE DOMAINS these objects answer at: the one the bucket lives on
    // and the one it has just left. Not filtered by `public` — a bucket that
    // was public yesterday may be private today, and the edge still holds
    // what it cached then.
    const fronts = new Set(
      [facts?.store ?? null, input.alsoStore].flatMap((store) => {
        const fronted = store === null ? undefined : storeUrls.get(store);
        return fronted === undefined ? [] : [fronted];
      }),
    );
    for (const front of fronts) {
      for (const removal of input.removals) {
        urls.push(publicObjectUrl(front, narinfoKey(input.bucket, removal.hash)));
        if (removal.narFile !== null) {
          urls.push(publicObjectUrl(front, narFileKey(input.bucket, removal.narFile)));
        }
      }
      if (input.cacheInfo === true) urls.push(publicObjectUrl(front, cacheInfoKey(input.bucket)));
    }
    return urls;
  };

  /**
   * EVERY ANNOUNCEMENT GOES THROUGH HERE: a collection, a finished move, a
   * re-push that rewrote a text object.
   *
   * NOTHING IS BUILT WHEN NOBODY FRONTS THESE URLS. The broker knows whether
   * anybody does, and on a daemon with no CDN — most of them — a nightly
   * collection must not compose two URLs per evicted path for a no-op.
   */
  const announceUrls = (event: string, bucket: string, urls: readonly string[]): void => {
    if (urls.length === 0) return;
    opts.log?.(event, { bucket, urls: urls.length });
    opts.purge.announce([...urls]);
  };

  const announce = (collected: GcCollection): void => {
    if (!opts.purge.listening()) return;
    for (const [bucket, removals] of collected.removed) {
      if (removals.length === 0) continue;
      announceUrls("cache.gc.purge", bucket, urlsFor({ bucket, alsoStore: null, removals }));
    }
  };

  /**
   * AN ADDRESS WHOSE BYTES CHANGED OR WENT, announced.
   *
   * A finished MOVE: the objects are identical in the new store, but the old
   * store's domain is about to answer 404 for every one of them. A RE-PUSH:
   * the text object was rewritten, and what it replaced is cacheable for a
   * day while odu's own render is already correct. A DELETED BUCKET: every
   * address it served is gone, and the `store` it names is the one it lived
   * in, read before its row went.
   */
  const announceMoved: CacheServer["announceMoved"] = (input) => {
    if (!opts.purge.listening()) return;
    announceUrls(
      input.reason === "migrate"
        ? "cache.bucket.migrate.purge"
        : input.reason === "delete"
          ? "cache.bucket.delete.purge"
          : "cache.narinfo.purge",
      input.bucket,
      urlsFor({
        bucket: input.bucket,
        alsoStore: input.store,
        removals: input.removals,
        ...(input.cacheInfo === true ? { cacheInfo: true } : {}),
      }),
    );
  };

  /** A collection, announced. BOTH doors go through this — the verb and the
   *  schedule — so "a deletion is announced" is one fact rather than two call
   *  sites that can drift, and what crosses the wire is the report alone. */
  const announced = (done: GcCollection): GcReport => {
    announce(done);
    return done.report;
  };

  const collect = async (): Promise<void> => {
    announced(await cache.collect());
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
    cells: {
      // FIXED FOR THE TENURE: the declarations were read at boot.
      stores: { store: inMemoryStore<readonly CacheStore[]>(opts.stores) },
    },
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
                // The same rule as the upstream keys below: the DEFAULT lives
                // beside the fact it defaults, in the contract.
                retentionDays: input.retentionDays ?? DEFAULT_RETENTION_DAYS,
                // The default lives where the filter is EXPLAINED, in the
                // contract's own doc: an absent list means nixpkgs' key, the
                // filter that keeps an upstream closure out of a bucket.
                upstreamKeys: input.upstreamKeys ?? [DEFAULT_UPSTREAM_KEY],
                ...(input.store === undefined ? {} : { store: input.store }),
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
            name: identity.name,
            public: identity.public,
            publicKey: identity.publicKey,
            domain: identity.domain,
            url: urlOf(identity),
            readsFrom: readsFromOf(identity),
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
                group: input.group ?? null,
                name: input.name ?? null,
                sort: input.sort ?? null,
                descending: input.descending ?? null,
              }),
            (page) => ({
              paths: page.paths.map((path) => ({ ...path })),
              ...(page.groups === null
                ? {}
                : { groups: page.groups.map((group) => ({ ...group })) }),
              ...(page.next === null ? {} : { next: page.next }),
            }),
          ),
        retention: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.retention({
                authority,
                bucket: input.bucket,
                retentionDays: input.retentionDays,
              }),
            (facts) => rowOf(facts),
          ),
        migrate: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.migrateStore({
                authority,
                bucket: input.bucket,
                store: input.store,
              }),
            (facts) => rowOf(facts),
          ),
        delete: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.bucketDelete({ authority, bucket: input.bucket }),
            (gone) => gone,
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
        list: ({ input }) =>
          admin(
            input,
            (authority) => cache.admin.pinList({ authority, bucket: input.bucket }),
            (pins) => ({ pins: pins.map((pin) => ({ ...pin, rootPaths: [...pin.rootPaths] })) }),
          ),
        delete: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.pinDelete({
                authority,
                bucket: input.bucket,
                name: input.name,
              }),
            (it) => it,
          ),
      },
      gc: {
        run: ({ input }) =>
          admin(
            input,
            // THE COLLECTION IS ALSO AN ANNOUNCEMENT: what left has to reach
            // whatever is caching it, and the ROW is where a store path
            // becomes a URL. The wire carries the counts, the port the
            // addresses, and `announced` is the one place that splits them.
            async (authority) => {
              const outcome = await cache.admin.gc({
                authority,
                bucket: input.bucket ?? null,
              });
              return outcome.ok
                ? { ok: true as const, value: announced(outcome.value) }
                : outcome;
            },
            (report) => report,
          ),
        plan: ({ input }) =>
          admin(
            input,
            (authority) =>
              cache.admin.gcPlan({
                authority,
                bucket: input.bucket ?? null,
                retentionDays: input.retentionDays ?? null,
              }),
            (preview) => ({
              ...preview,
              buckets: preview.buckets.map((bucket) => ({
                ...bucket,
                paths: bucket.paths.map((path) => ({ ...path })),
              })),
            }),
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
    collect,
    detach,
    substituterUrl: (name) => {
      const bucket = cache.bucket(name);
      return urlOf({
        name,
        public: bucket?.isPublic ?? false,
        domain: bucket?.domain ?? null,
        store: bucket?.store ?? LOCAL_STORE,
      });
    },
    announceMoved,
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
/** THE ROW REFUSED ITS MOUNT — the refusal value, carried to the host's report. */
export class CacheMountRefused extends Data.TaggedError("CacheMountRefused")<{
  readonly refusal: CacheMountRefusal;
}> {
  override get message(): string {
    return mountRefusalMessage(this.refusal);
  }
}

export const cacheRow = (declared: StoreDeclarations) => definePlugin({
  name: CACHE_KEY,
  needs: [
    Bundle,
    Routes,
    StateDir,
    RootToken,
    NixStore,
    BoundOrigin,
    PublicOrigin,
    CachePurge,
    CacheGrants,
    Log,
    Metrics,
  ],
  apply: Effect.gen(function* () {
    const bundle = yield* Bundle;
    const routes = yield* Routes;
    const stateDir = yield* StateDir;
    const rootToken = yield* RootToken;
    const store = yield* NixStore;
    const boundOrigin = yield* BoundOrigin;
    const publicOrigin = yield* PublicOrigin;
    // WHERE A DELETION IS ANNOUNCED. The host makes one broker per tenure and
    // every daemon has it; whether a CDN row registered on it is not this
    // row's business, and with none registered an announcement is a no-op.
    const purges = yield* CachePurge;
    // WHERE A RUN ASKS FOR ITS WRITE TOKEN (PLAN 4.1). Same shape and same
    // reason as the purge broker above, with the arrow reversed: the runs' row
    // asks, this one answers, and the runs' row is mounted FIRST (it offers
    // `Bundle`), so a `needs` edge from there to here would be a deadlock.
    const grants = yield* CacheGrants;
    const log = yield* Log;
    // WHERE THIS ROW'S NUMBERS GO. The host made one registry for the tenure
    // and serves `/metrics` from it; the row registers a contributor below and
    // withdraws it before its database closes.
    const metrics = yield* Metrics;

    // THE ONE OPERATIONAL LINE, AND THE ONE COUNTER, from the same call. Every
    // fact the cache states — a NAR served, a request refused, an upload
    // recorded, a collection run — arrives through this single lambda, so the
    // meter sees exactly what the log says and nothing instruments the serving
    // path twice. It is bound into `createCache`, into `cacheServer`, into the
    // probes and into the collection schedule, which is every place the cache
    // speaks.
    const meter = cacheMeter();
    const say = (event: string, fields: Record<string, unknown>): void => {
      meter.observe(event, fields);
      log.info(fields, `odu cache: ${event}`);
    };

    // THE MOVE'S PURGE, LATE-BOUND. The cache is built before the server that
    // knows where a bucket is reachable from, and a finished move needs both:
    // the cache names the objects the old store gave up, this hands them to
    // the row's URL builder. Null until the server below exists, which is
    // before any verb can start a move.
    let announceMoved: CacheServer["announceMoved"] | null = null;
    // THE DECLARED STORES AS FACTS, read once: what the `stores` cell
    // publishes, which of them the world reads directly, and what the boot
    // probe asks. Three readers, one reading.
    const stores = storeFacts(declared);
    const cache = createCache({
      stateRoot: stateDir,
      rootToken,
      // WHERE A PUSH IS AIMED, which the cache states in every bucket's
      // `nix-cache-info` (PLAN 2.8). The same string the row builds `pushUrl`
      // and a path-form substituter from: the proxy's origin when one stands
      // in front, the bound one otherwise.
      publicOrigin: publicOrigin ?? boundOrigin,
      // THE STORES AS VALUES, built once from what the operator declared: the
      // cache holds them by name and never asks what kind they are.
      stores: objectStores(declared, join(stateDir, "cache")),
      // AND WHICH OF THEM THE WORLD READS DIRECTLY: a private bucket may not
      // be created on, or moved onto, a store with a bound domain.
      frontedStores: new Set(
        stores.flatMap((declaredStore) =>
          declaredStore.publicUrl === null ? [] : [declaredStore.name],
        ),
      ),
      // THE OLD NIX STORE is read ONLY by the one-time object migration. A
      // fresh deployment leaves this null and the cache never shells out.
      // `NixStore` NULL IS THE HOST'S OWN /nix/store (the contract): a module
      // deployment migrates from there; the pod names its chroot store.
      legacyStore: {
        dump: (path) => nixDump(path, store),
        pathInfo: (path) => nixPathInfo(path, store),
      },
      // ONE structured line per operational fact, and the metrics counter that
      // reads the same event. The Effect logger renders the fields; no
      // per-chunk lines, no narration.
      log: say,
      purged: (moved) => announceMoved?.(moved),
    });
    // BEFORE THE MOUNT: CA proof and the orphan/temp sweep. Nothing is
    // writing yet, so this cannot race a push.
    const booted = yield* Effect.promise(() => cache.boot());
    if (!booted.ok) {
      yield* Effect.promise(() => cache.close());
      // A PLUGIN'S APPLY HAS NO ERROR CHANNEL: the refusal ends the row as a
      // defect that still carries the value, and the host's row report prints
      // its sentence ("the cache row failed to start: …").
      return yield* Effect.die(new CacheMountRefused({ refusal: booted.refusal }));
    }
    const boot = booted.report;
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

    // AND THE GRANT A RUN ASKS FOR (PLAN 4.1): does this daemon serve that
    // bucket, what key does it publish, and a write token scoped to it that
    // expires with the run. Registered rather than offered, for the mount-order
    // reason the `needs` list gives; withdrawn in the finalizer below, so a
    // tenure whose cache has gone away mints nothing.
    const withdrawGrants = grants.register({
      // THE SAME STRING EVERY BUCKET'S `nix-cache-info` STATES as `Odu-Origin`
      // — the proxy's origin when one stands in front, the bound one otherwise
      // — because the whole of the interim write grant is "`Odu-Origin` is us".
      origin: () => publicOrigin ?? boundOrigin,
      bucket: (name) => {
        const row = cache.bucket(name);
        return row === null ? null : { name: row.name, publicKey: row.publicKey };
      },
      mint: (request) => cache.grantRunToken(request),
      revoke: (id) => cache.revokeToken(id),
    });

    const server = cacheServer({
      cache,
      // The address a client must be told: the proxy's when one stands in
      // front, the bound one otherwise. A loopback URL in a `nix.conf` is a
      // substituter that works for nobody.
      publicOrigin: publicOrigin ?? boundOrigin,
      mount: CACHE_MOUNT,
      stores,
      purge: purges,
      log: say,
    });
    announceMoved = server.announceMoved;

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
    routes.add(cacheRoutes(cache, (name) => server.substituterUrl(name)));

    // AND THE ROW'S NUMBERS, registered beside its routes: the counters the
    // tee has been keeping since this apply started, plus the per-bucket
    // gauges read out of SQL at the moment of the scrape. The contributor
    // holds the CACHE and asks it, so nothing here touches a database handle.
    const withdrawMetrics = metrics.add({
      name: CACHE_KEY,
      read: () => meter.reading(cache.meterGauges()),
    });

    // AFTER THE MOUNT, AND ROW-OWNED: the migration dumps tens of gigabytes
    // and must not hold `/` or `/cache/*` down while it does. The row's
    // finalizer interrupts it before the database closes.
    // SCOPED, not detached: a child forked with `forkChild` is interrupted the
    // moment this apply's fiber ends (a few lines later), so the migration never
    // ran on the pod. `forkScoped` lives until the ROW closes, which is exactly
    // the lifecycle `cache.close()`'s stopping flag honours.
    // ONE background task: the self pass needs the objects the migration is
    // about to land, so it starts when migrate settles — not beside it, where a
    // row could be counted unreadable and wait a whole boot. The NARINFO
    // BACKFILL (2.8) sits between them for the same reason: a row whose object
    // the migration has not landed yet has no `FileHash` to put in a narinfo.
    //
    // AND THE PUBLIC-URL PROBE IS LAST OF ALL, after the self pass: it has to
    // come after the BACKFILL because it compares what the store serves with
    // what the cache renders now, and a `$ODU_PUBLIC_ORIGIN` move leaves the
    // stale object there until the backfill rewrites it — a healthy store
    // logged unreachable once, with nothing after it to correct the claim.
    // It goes after the self pass because it DIALS a name: a domain still
    // propagating keeps a request open for curl's own patience, and nothing
    // waiting on it should be work this daemon could have finished.
    yield* Effect.forkScoped(
      Effect.promise(async () => {
        await cache.migrate();
        const backfilled = await cache.backfillObjects();
        if (backfilled.written > 0 || backfilled.failures > 0) {
          log.info(
            { rows: backfilled.rows, written: backfilled.written, failures: backfilled.failures },
            "odu cache: narinfo objects backfilled",
          );
        }
        await cache.proveSelf();
        await probePublicStores({
          stores,
          buckets: cache.snapshot(),
          info: cache.cacheInfoText,
          log: say,
        });
      }),
    );

    // AND ANY MOVE A RESTART INTERRUPTED (2.8). Its own fibre, not queued
    // behind the backfill: a bucket half-way between two stores is serving
    // from the old one and should finish as soon as the row is up.
    yield* Effect.forkScoped(Effect.promise(() => cache.resumeMigrations()));

    // TWO MORE QUESTIONS ABOUT THE DECLARED STORES, asked once the row is up
    // and both answered with a log line rather than a refused boot: which
    // private buckets a bound domain exposes, and whether an endpoint a client
    // now has to dial is a loopback address. Both are READS of what the
    // operator declared, so they are answered here and now; the third, which
    // DIALS the domain, runs at the end of the background fibre above.
    exposedBuckets({ stores, buckets: cache.snapshot(), log: say });
    probeStoreEndpoints({
      stores: [...declared].map(([name, store]) => ({ name, endpoint: store.target.endpoint })),
      buckets: cache.snapshot(),
      log: say,
    });

    // (The schedule is forked below, after the finalizers — see why there.)

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
    // AND THE CONTRIBUTOR GOES FIRST OF ALL — registered LAST, so the reverse
    // order withdraws it before the mount drops and well before
    // `cache.close()`. A scrape that arrives after the withdrawal simply has
    // one fewer row in it; one that reached a closed database would be an
    // error from the surface an operator consults when things are already
    // going wrong.
    yield* Effect.addFinalizer(() => Effect.sync(withdrawMetrics));
    // AND THE GRANT, for the same reason and in the same place: a mint that
    // reached a closed database would be a run told it may push to a bucket
    // that is no longer being served.
    yield* Effect.addFinalizer(() => Effect.sync(withdrawGrants));
    // THE SCHEDULE, ROW-OWNED LIKE THE MIGRATION AND IN THE SAME IDIOM: a
    // cache nobody administers must still stop growing, so the row collects
    // itself daily and the operator's button is that collection asked for
    // sooner.
    //
    // FORKED LAST, which by the rule above means INTERRUPTED FIRST: the
    // fibre's interruption is a finalizer of this scope like any other, and a
    // collection still walking a bucket when the database closed would be an
    // error logged on the way out. Interrupting it waits for the collection
    // in flight, because `collectEvery` runs each one uninterruptibly.
    yield* Effect.forkScoped(collectEvery(GC_EVERY_MS, server.collect, say));

    log.info(
      { mount: CACHE_MOUNT, buckets: cache.snapshot().length },
      "odu web: the cache row is serving",
    );
  }),
});

/** The routes this row registers, with their claim — for the host's gate test,
 *  which records what the layer registers and checks the claim covers it. */
export { cacheRoutes } from "./routes";

/**
 * THIS ROW, AS THE HOST LISTS IT — the cache, a sibling under its own key.
 * Its own facts (`CACHE_ROW`, beside its surface) and its plugin, in one
 * value. The host composes these records and names none of their parts.
 */
export const cacheRowRecord = (declared: StoreDeclarations): Row => ({
  ...CACHE_ROW,
  plugin: cacheRow(declared),
});

/** Re-exported for the host: the row's ONE environment read. */
export { readCacheStores, storeConfigMessage } from "./stores";
