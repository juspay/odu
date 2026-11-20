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
  type GrantedBucket,
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

const DEFAULT_UPSTREAM_KEY = "cache.nixos.org-1";
export type CacheSurfaceDeps = ImplementSurfaceDeps<CacheSpec>;

export interface CachePublisher {
  readonly buckets: {
    upsert(key: string, row: CacheBucket): void;
    remove(key: string): void;
  };
}

export interface CacheServerOptions {
  readonly cache: Cache;
  readonly publicOrigin: string;
  readonly mount: string;
  readonly stores: readonly CacheStore[];
  readonly purge: CachePurge;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface CacheServer {
  readonly surface: typeof oduCacheSurface;
  readonly deps: CacheSurfaceDeps;
  readonly attach: (publisher: CachePublisher) => void;
  readonly publish: () => void;
  readonly collect: () => Promise<void>;
  readonly detach: () => void;
  readonly substituterUrl: (name: string) => string;
  readonly bucketAt: (substituter: string) => GrantedBucket | null;
  readonly announceMoved: (input: {
    bucket: string;
    store: string;
    reason: "migrate" | "repush" | "delete";
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }) => void;
}

export const GC_EVERY_MS = 24 * 60 * 60 * 1000;

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
  return Effect.forever(Effect.flatMap(Effect.sleep(Duration.millis(everyMs)), () => once));
}

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

export interface UnreachableStore {
  store: string;
  url: string;
  status: number | null;
}

export async function probePublicStores(input: {
  stores: readonly CacheStore[];
  buckets: readonly { name: string; public: boolean; store: string }[];
  info: (bucket: string) => string;
  log?: (event: string, fields: Record<string, unknown>) => void;
  send?: typeof fetch;
}): Promise<readonly UnreachableStore[]> {
  const send = input.send ?? fetch;
  const unreachable: UnreachableStore[] = [];
  for (const store of input.stores) {
    if (store.publicUrl === null) continue;
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


function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}

export function cacheServer(opts: CacheServerOptions): CacheServer {
  const { cache } = opts;
  const published = new Map<string, string>();
  const rows = new Map<string, CacheBucket>();
  let publisher: CachePublisher | null = null;

  const scheme = ((): string => {
    try {
      return new URL(opts.publicOrigin).protocol;
    } catch {
      return "https:";
    }
  })();

  const storeUrls = new Map(
    opts.stores.flatMap((store) => (store.publicUrl === null ? [] : [[store.name, store.publicUrl] as const])),
  );

  const readsFromOf = (facts: { name: string; public: boolean; store: string }): "store" | "odu" =>
    facts.public && storeUrls.has(facts.store) ? "store" : "odu";

  const urlOf = (facts: { name: string; public: boolean; domain: string | null; store: string }): string =>
    readsFromOf(facts) === "store"
      ? publicBucketUrl(storeUrls.get(facts.store) as string, facts.name)
      : facts.domain === null
        ? `${opts.publicOrigin}${opts.mount}/${facts.name}`
        : `${scheme}//${facts.domain}`;

  const pushUrlOf = (name: string): string => `${opts.publicOrigin}${opts.mount}/${name}`;
  const bucketAt = (substituter: string): GrantedBucket | null => {
    let url: URL;
    try {
      url = new URL(substituter.trim());
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = withoutTrailingSlashes(url.pathname);
    const origin = `${url.protocol}//${url.host}`;
    const segments = path.split("/").filter((part) => part !== "");
    const last = segments[segments.length - 1];
    const row =
      segments.length === 0
        ? cache.bucketByDomain(url.host)
        : last === undefined
          ? null
          : cache.bucket(last);
    if (row === null) return null;
    const facts = {
      name: row.name,
      public: row.isPublic,
      domain: row.domain,
      store: row.store,
    };
    const advertised = new Map(
      [
        urlOf(facts),
        pushUrlOf(row.name),
        ...(row.domain === null ? [] : [`${scheme}//${row.domain}`]),
      ].map((one) => [withoutTrailingSlashes(one), one]),
    );
    const confirmed = advertised.get(`${origin}${path}`);
    if (confirmed === undefined) return null;
    return {
      name: row.name,
      publicKey: row.publicKey,
      origin: opts.publicOrigin,
      substituter: confirmed,
    };
  };

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
    for (const name of [...published.keys()]) {
      if (next.has(name)) continue;
      published.delete(name);
      rows.delete(name);
      publisher.buckets.remove(name);
    }

  };

  const urlsFor = (input: {
    bucket: string;
    alsoStore: string | null;
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }): string[] => {
    const facts = cache.bucket(input.bucket);
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

  const announced = (done: GcCollection): GcReport => {
    announce(done);
    return done.report;
  };

  const collect = async (): Promise<void> => {
    announced(await cache.collect());
  };

  const answer = <A, B>(
    work: () => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused> =>
    Effect.flatMap(Effect.promise(work), (outcome) =>
      outcome.ok
        ? Effect.succeed(map(outcome.value))
        : Effect.fail(new CacheRefused({ code: outcome.code, message: outcome.message })),
    );

  const authorityOf = (
    principal: Principal,
    input: { rootToken: string },
  ): Authority =>
    principal.kind === "user"
      ? roleAuthority(principal.login)
      : { kind: "root", rootToken: input.rootToken };

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
      stores: { store: inMemoryStore<readonly CacheStore[]>(opts.stores) },
    },
    collections: {
      buckets: {
        readAll: () => rows,
        // PERSISTENCE ONLY — the framework wraps these to publish.
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
                retentionDays: input.retentionDays ?? DEFAULT_RETENTION_DAYS,
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
    bucketAt,
    announceMoved,
  };
}

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
    const purges = yield* CachePurge;
    const grants = yield* CacheGrants;
    const log = yield* Log;
    const metrics = yield* Metrics;

    const meter = cacheMeter();
    const say = (event: string, fields: Record<string, unknown>): void => {
      meter.observe(event, fields);
      log.info(fields, `odu cache: ${event}`);
    };

    let announceMoved: CacheServer["announceMoved"] | null = null;
    const stores = storeFacts(declared);
    const cache = createCache({
      stateRoot: stateDir,
      rootToken,
      publicOrigin: publicOrigin ?? boundOrigin,
      stores: objectStores(declared, join(stateDir, "cache")),
      frontedStores: new Set(
        stores.flatMap((declaredStore) =>
          declaredStore.publicUrl === null ? [] : [declaredStore.name],
        ),
      ),
      // `NixStore` NULL IS THE HOST'S OWN /nix/store (the contract).
      legacyStore: {
        dump: (path) => nixDump(path, store),
        pathInfo: (path) => nixPathInfo(path, store),
      },
      log: say,
      purged: (moved) => announceMoved?.(moved),
    });
    const booted = yield* Effect.promise(() => cache.boot());
    if (!booted.ok) {
      yield* Effect.promise(() => cache.close());
      // A PLUGIN'S APPLY HAS NO ERROR CHANNEL: the refusal ends the row as a
      // defect that still carries the value.
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

    const domains: BucketDomainsFacts = {
      current: () =>
        cache.snapshot().flatMap((bucket) =>
          bucket.domain === null ? [] : [{ bucket: bucket.name, domain: bucket.domain }],
        ),
      subscribe: (listener) => cache.onChange(listener),
      paths: CACHE_ROUTE_PATHS,
      bucketOf,
    };
    yield* offer(BucketDomains, () => domains);

    const server = cacheServer({
      cache,
      publicOrigin: publicOrigin ?? boundOrigin,
      mount: CACHE_MOUNT,
      stores,
      purge: purges,
      log: say,
    });
    announceMoved = server.announceMoved;

    const withdrawGrants = grants.register({
      bucketAt: (substituter) => server.bucketAt(substituter),
      mint: (request) => cache.grantRunToken(request),
      revoke: (id) => cache.revokeToken(id),
    });

    const mounted = bundle.mount(CACHE_KEY, server.surface, server.deps);
    server.attach({
      buckets: {
        upsert: (key, row) => mounted.ctx.collections.buckets.upsert(key, row),
        remove: (key) => mounted.ctx.collections.buckets.remove(key),
      },
    });

    routes.add(cacheRoutes(cache, (name) => server.substituterUrl(name)));

    const withdrawMetrics = metrics.add({
      name: CACHE_KEY,
      read: () => meter.reading(cache.meterGauges()),
    });

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

    yield* Effect.forkScoped(Effect.promise(() => cache.resumeMigrations()));

    exposedBuckets({ stores, buckets: cache.snapshot(), log: say });
    probeStoreEndpoints({
      stores: [...declared].map(([name, store]) => ({ name, endpoint: store.target.endpoint })),
      buckets: cache.snapshot(),
      log: say,
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        server.detach();
        await cache.close();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => mounted.drop()));
    yield* Effect.addFinalizer(() => Effect.sync(withdrawMetrics));
    yield* Effect.addFinalizer(() => Effect.sync(withdrawGrants));
    yield* Effect.forkScoped(collectEvery(GC_EVERY_MS, server.collect, say));

    log.info(
      { mount: CACHE_MOUNT, buckets: cache.snapshot().length },
      "odu web: the cache row is serving",
    );
  }),
});

export { cacheRoutes } from "./routes";

export const cacheRowRecord = (declared: StoreDeclarations): Row => ({
  ...CACHE_ROW,
  plugin: cacheRow(declared),
});

export { readCacheStores, storeConfigMessage } from "./stores";
