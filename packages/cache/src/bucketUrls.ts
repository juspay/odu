import type { GrantedBucket } from "@odu/cordis/services";
import type { BucketFacts, Cache } from "./cache";
import type { GcRemoval } from "./gc";
import {
  cacheInfoKey,
  narFileKey,
  narinfoKey,
  publicBucketUrl,
  publicObjectUrl,
} from "./staging";
import type { CacheBucket, CacheStore } from "./surface";

export interface BucketUrls {
  readsFromOf(facts: { name: string; public: boolean; store: string }): "store" | "odu";
  urlOf(facts: {
    name: string;
    public: boolean;
    domain: string | null;
    store: string;
  }): string;
  pushUrlOf(name: string): string;
  rowOf(facts: BucketFacts): CacheBucket;
  bucketAt(substituter: string): GrantedBucket | null;
  urlsFor(input: {
    bucket: string;
    alsoStore: string | null;
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }): string[];
}

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}

export function bucketUrls(input: {
  publicOrigin: string;
  mount: string;
  stores: readonly CacheStore[];
  rows: Pick<Cache, "bucket" | "bucketByDomain">;
}): BucketUrls {
  const { rows } = input;
  const scheme = ((): string => {
    try {
      return new URL(input.publicOrigin).protocol;
    } catch {
      return "https:";
    }
  })();

  const storeUrls = new Map(
    input.stores.flatMap((store) =>
      store.publicUrl === null ? [] : [[store.name, store.publicUrl] as const],
    ),
  );

  const readsFromOf = (facts: { name: string; public: boolean; store: string }): "store" | "odu" =>
    facts.public && storeUrls.has(facts.store) ? "store" : "odu";

  const urlOf = (facts: {
    name: string;
    public: boolean;
    domain: string | null;
    store: string;
  }): string =>
    readsFromOf(facts) === "store"
      ? publicBucketUrl(storeUrls.get(facts.store) as string, facts.name)
      : facts.domain === null
        ? `${input.publicOrigin}${input.mount}/${facts.name}`
        : `${scheme}//${facts.domain}`;

  const pushUrlOf = (name: string): string =>
    `${input.publicOrigin}${input.mount}/${name}`;

  return {
    readsFromOf,
    urlOf,
    pushUrlOf,
    rowOf: (facts) => ({
      ...facts,
      upstreamKeys: [...facts.upstreamKeys],
      url: urlOf(facts),
      pushUrl: pushUrlOf(facts.name),
      readsFrom: readsFromOf(facts),
    }),

    bucketAt(substituter) {
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
          ? rows.bucketByDomain(url.host)
          : last === undefined
            ? null
            : rows.bucket(last);
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
        origin: input.publicOrigin,
        substituter: confirmed,
      };
    },

    urlsFor(asked) {
      const facts = rows.bucket(asked.bucket);
      const bases = new Set([`${input.publicOrigin}${input.mount}/${asked.bucket}`]);
      if (facts?.domain != null) bases.add(`${scheme}//${facts.domain}`);
      const urls: string[] = [];
      for (const base of bases) {
        for (const removal of asked.removals) {
          urls.push(`${base}/${removal.hash}.narinfo`);
          if (removal.narFile !== null) urls.push(`${base}/nar/${removal.narFile}`);
        }
        if (asked.cacheInfo === true) urls.push(`${base}/nix-cache-info`);
      }
      const fronts = new Set(
        [facts?.store ?? null, asked.alsoStore].flatMap((store) => {
          const fronted = store === null ? undefined : storeUrls.get(store);
          return fronted === undefined ? [] : [fronted];
        }),
      );
      for (const front of fronts) {
        for (const removal of asked.removals) {
          urls.push(publicObjectUrl(front, narinfoKey(asked.bucket, removal.hash)));
          if (removal.narFile !== null) {
            urls.push(publicObjectUrl(front, narFileKey(asked.bucket, removal.narFile)));
          }
        }
        if (asked.cacheInfo === true) {
          urls.push(publicObjectUrl(front, cacheInfoKey(asked.bucket)));
        }
      }
      return urls;
    },
  };
}
