/**
 * THE CACHE'S CONTRACT — one row of the board, and every verb that administers
 * it.
 *
 * This file is the wall's other half. A bucket used to be spelled three times:
 * `@odu/cache`'s own `BucketFacts`, `@odu/service`'s `CacheAdmin` port, and the
 * ci surface's `CacheBucketSchema` — with the *service* prefixing a `url` it had
 * no business knowing anything about. So the cache's contract lives here, at
 * the cache, and the composition serves it beside the runs instead of through
 * them.
 *
 * ## It is a SIBLING, and the names are unchanged
 *
 * The composition mounts this surface under the key `cache`, so every tag gains
 * that segment (`surface/cache/bucket/create`) and every MCP tool and argv verb
 * gains that word (`cache_bucket_create`). The namespaces below are therefore
 * the NOUN — `bucket`, `token`, `pin`, `gc`, `stats` — because `cache_bucket_create`
 * is what an agent should read: the row, then the thing, then the act.
 *
 * THIS IS THE ONE THING A CLIENT CAN FEEL, and it is the price of the cut:
 * `cache_create` is `cache_bucket_create` now. The alternative — keeping one
 * namespace for the cache's own name — would spell `cache_cache_create`, and the
 * alternative to THAT is a surface that cannot be a sibling at all.
 *
 * ## Browser-safe
 *
 * Schemas, a contract version and a tagged refusal — nothing else. `./server`
 * implements it, `./cli` projects it as argv, `./face` renders it, and none of
 * those are reachable from here. That is what lets the board hold a cache client
 * without holding a database.
 */

import type { RowAgent, RowFacts } from "@odu/cordis/services";
import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";

// ── the row ─────────────────────────────────────────────────────────────────

/**
 * A BUCKET MOVING BETWEEN STORES, as the board watches it (PLAN 2.8).
 *
 * It is on the ROW rather than behind a verb because the board already
 * follows the rows: a move is minutes of copying, and a panel that had to
 * poll a procedure for progress would be the two-RPCs-per-second problem the
 * collection already solved with deltas.
 */
export const CacheMigrationSchema = Schema.Struct({
  /** The store it is moving to. Until it is done, the bucket is still served
   *  from the `store` beside this. */
  to: Schema.String,
  /** `copying` fills the new store, `flipping` is the moment the bucket
   *  changes hands under the write lock, `deleting` lets the old copies go. */
  state: Schema.Literals(["copying", "flipping", "deleting"]),
  /** Objects dealt with so far, out of how many the move found. */
  copied: Schema.Int,
  total: Schema.Int,
  /** Bytes copied so far. */
  bytes: Schema.Int,
});
export type CacheMigration = typeof CacheMigrationSchema.Type;

/**
 * ONE BUCKET, as an administrator sees it: the public key a client has to
 * trust, the substituter URL to put in `nix.conf`, and how much is in it.
 *
 * The SECRET key is absent, and that is not an oversight — nothing outside the
 * cache package ever needs it, and a surface that could carry one would be a
 * surface whose logs could carry one.
 *
 * `lastPush` and `hits` are the two facts a BOARD needs and an operator used to
 * ask for separately: when the bucket last took a narinfo, and how many reads it
 * has answered. They are on the row rather than behind a verb because the board
 * paints them per bucket and a per-row call would be a call per row.
 */
export const CacheBucketSchema = Schema.Struct({
  name: Schema.String,
  public: Schema.Boolean,
  /** Days an object survives unread, subject to references and pins. */
  retentionDays: Schema.Int,
  keyName: Schema.String,
  /** `<keyName>:<base64 32>`, ready for `extra-trusted-public-keys`. */
  publicKey: Schema.String,
  /** Key names whose signatures make a path "already upstream". */
  upstreamKeys: Schema.Array(Schema.String),
  /** The name this bucket is served at, when it has one. Set it and the
   *  advertised URL is that name instead of a path under this origin. */
  domain: Schema.NullOr(Schema.String),
  objects: Schema.Int,
  bytes: Schema.Int,
  created: Schema.Number,
  /** The substituter URL — the bucket's domain when it has one, otherwise
   *  `<origin>/<name>`. What `extra-substituters` takes. */
  url: Schema.String,
  /** WHERE A PUSH ADDRESSES THIS BUCKET: always `<origin>/cache/<name>`, so the
   *  push API works through a bucket domain without the domain needing to name
   *  a bucket in its path. It is the address the cache states in its own
   *  `nix-cache-info` (`Odu-Origin`/`Odu-Bucket`) and a client resolves from
   *  `--cache <substituter>`; the page's push block and the docs name the
   *  SUBSTITUTER (`url`) and let the cache answer with this. */
  pushUrl: Schema.String,
  /** When the last narinfo landed here; `null` for a bucket nothing has been
   *  pushed to. */
  lastPush: Schema.NullOr(Schema.Number),
  /** narinfo reads, summed over the bucket's objects. */
  hits: Schema.Int,
  /** The store its objects live in, by declared name — `local`, or one of
   *  the `stores` cell's names. Fixed at creation (3.1). */
  store: Schema.String,
  /**
   * WHO ANSWERS A READ OF THIS BUCKET (PLAN 2.8). `"store"` when its store
   * publishes a public URL and the bucket is public — the substituter URL
   * above is the store's own, and a client never reaches odu at all.
   * `"odu"` otherwise: the daemon renders the narinfo and either streams the
   * NAR (disk) or redirects to the store for it (S3).
   */
  readsFrom: Schema.Literals(["store", "odu"]),
  /**
   * WHO TAKES A PUSH'S BYTES (PLAN 2.9) — `readsFrom`'s mirror. `"store"`
   * when the bucket's store takes them itself: `odu cache push` is handed
   * presigned URLs, the NAR never crosses the daemon, and odu reads the
   * object back to prove it before the path is recorded. `"odu"` when they
   * come through the daemon into staging — every disk-backed bucket.
   *
   * It is the STORE's capability, not a setting: nothing turns it on or off,
   * and a client that cannot speak the negotiation is refused rather than
   * quietly served the old way.
   */
  writesTo: Schema.Literals(["store", "odu"]),
  /** The store-to-store move running on this bucket, or `null`. */
  migration: Schema.NullOr(CacheMigrationSchema),
});
export type CacheBucket = typeof CacheBucketSchema.Type;

/**
 * ONE STORE A BUCKET CAN LIVE IN, as the board offers it: its declared name and
 * what kind it is. Never its endpoint or credentials — those are the operator's
 * configuration, and nothing on the wire needs them.
 */
export const CacheStoreSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["local", "s3"]),
  /** The store a bucket created without one lands on — true on exactly one
   *  entry, so a face never guesses it from the order. */
  default: Schema.Boolean,
  /** WHERE THE WORLD READS THIS STORE'S OBJECTS, when the operator bound a
   *  domain to it (`<publicUrl>/<bucket>/…`). `null` for a store nobody
   *  fronts, and always `null` for the local disk. */
  publicUrl: Schema.NullOr(Schema.String),
});
export type CacheStore = typeof CacheStoreSchema.Type;

/** The store every daemon has: the disk under its state directory. */
export const LOCAL_STORE = "local";

/**
 * One bucket's PUBLIC identity, and NO root token.
 *
 * A bucket's substituter URL and public key are what it publishes to every
 * client that talks to it, so demanding the operator's credential for them
 * would make `odu cache use` — a read-only question a developer asks — an
 * administrative act. The NAME is the capability, exactly as it is in the
 * substituter URL.
 */
export const CacheBucketIdentitySchema = Schema.Struct({
  name: Schema.String,
  public: Schema.Boolean,
  /** `<keyName>:<base64 32>`, ready for `extra-trusted-public-keys`. */
  publicKey: Schema.String,
  /** The name the bucket is served at, or `null` for the path form. */
  domain: Schema.NullOr(Schema.String),
  /** The substituter URL — the domain when it has one. */
  url: Schema.String,
  /** Whether a read of this bucket is answered by its store or by odu — see
   *  {@link CacheBucketSchema}'s own `readsFrom`. */
  readsFrom: Schema.Literals(["store", "odu"]),
});
export type CacheBucketIdentity = typeof CacheBucketIdentitySchema.Type;

/** The three scopes, ordered: admin covers write covers read. */
export const CacheScopeSchema = Schema.Literals(["read", "write", "admin"]);
export type CacheScope = typeof CacheScopeSchema.Type;

/** A token's public half. The plaintext appears exactly once, in the answer
 *  that minted it. */
export const CacheTokenSchema = Schema.Struct({
  id: Schema.String,
  bucketGlob: Schema.String,
  scope: CacheScopeSchema,
  expires: Schema.NullOr(Schema.Number),
  /** WHAT MINTED IT — `run <id>` for a run's own write token (PLAN 4.1), null
   *  for an administrator's. `optionalKey` so a daemon older than this field
   *  still decodes here. */
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastUsed: Schema.NullOr(Schema.Number),
  revoked: Schema.Boolean,
  created: Schema.Number,
});
export type CacheToken = typeof CacheTokenSchema.Type;

/**
 * WHAT KEEPS A PATH IN ITS BUCKET, and when that runs out — the collector's
 * own answer (`gc.ts`'s `holdsOf`, which is what `gc.run` evicts by), read at
 * the moment the page was asked for.
 *
 * `kind` is the verdict: `pin` (a pin's closure reaches it — it stays until
 * that pin is deleted or re-pointed), `retention` (its own last want is the
 * latest clock holding it), `reference` (a path that references it, directly
 * or not, was wanted later — `via` names that path), or `nothing` (no pin,
 * every clock has run out: the next collection takes it). `pins` names every
 * pin that holds it. `until` is when the latest clock holding it runs out —
 * `lastWanted + retention` of the path itself or of `via` — and is stated
 * under a pin too, because it is what happens when the pin lets go.
 *
 * ONE FLAT STRUCT, not a union: `via` and `until` mean the same thing under
 * every kind.
 */
export const CacheKeptBySchema = Schema.Struct({
  kind: Schema.Literals(["pin", "retention", "reference", "nothing"]),
  pins: Schema.Array(Schema.String),
  via: Schema.NullOr(Schema.String),
  until: Schema.Number,
});
export type CacheKeptBy = typeof CacheKeptBySchema.Type;

/** One stored path, as a bucket lists it. */
export const CachePathSchema = Schema.Struct({
  storePath: Schema.String,
  narSize: Schema.Int,
  /** When the narinfo landed — what "newest first" sorts on. */
  created: Schema.Number,
  hits: Schema.Int,
  /** WHEN SOMEBODY LAST WANTED IT: a push, or a `missing` query that named
   *  it. Retention counts from here, and a read never moves it — reads are
   *  leaving odu, so the busiest paths would be the first to look idle. */
  lastWanted: Schema.Number,
  /** WHAT BUILT IT (PLAN 4.2) — the run that pushed it and the commit it was
   *  built from, both as the pusher stated them and null where nothing was
   *  said. `optionalKey` so a daemon older than this field still decodes
   *  here, spelled as `label` was for the same reason. */
  run: Schema.optionalKey(Schema.NullOr(Schema.String)),
  commit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** WHAT KEEPS IT, and until when (4.9). `optionalKey` for the same reason
   *  `run` is: a daemon older than the field still decodes here. */
  keptBy: Schema.optionalKey(CacheKeptBySchema),
});
export type CachePath = typeof CachePathSchema.Type;

/** One pin, and what it holds. */
export const CachePinSchema = Schema.Struct({
  bucket: Schema.String,
  name: Schema.String,
  /** The closure resolved at pin time. GC also walks the bucket's own
   *  references from these roots, so a path added later is held too. */
  rootPaths: Schema.Array(Schema.String),
  created: Schema.Number,
  /** WHO MADE IT, and therefore who may take it back: a pin a write token
   *  made (a push's `--pin`) may be re-pointed by any write token of this
   *  bucket; an administrator's may not, because re-pointing releases
   *  whatever the pin held before. Deleting is an administrator's either way. */
  createdBy: Schema.Literals(["write", "admin"]),
});
export type CachePin = typeof CachePinSchema.Type;

// ── the refusal ─────────────────────────────────────────────────────────────

/**
 * Why the cache declined, on the surface's error channel.
 *
 * Its OWN class rather than the service's `ServiceRefused`, which is the whole
 * point of the cut: a refusal raised by the cache is decodable without
 * `@odu/service-client`, so `@odu/cache/server` and a face that holds only the
 * cache client can both branch on it. The CODES are the cache's own table —
 * `no_root_token` is a fact about the daemon's environment, `bucket_exists` about
 * the database — and the composition adds nothing to them.
 */
export const CacheRefusalCodeSchema = Schema.Literals([
  "no_root_token",
  "unknown_bucket",
  "bucket_exists",
  "bad_input",
  /** `bucket.create` named a store this daemon does not declare (3.1). */
  "unknown_store",
  /** The caller is not allowed to administer buckets. Reached when an identity
   *  provider is mounted and a signed-in MEMBER asked an admin verb: the root
   *  token is not the rule on such a daemon, the caller's role is. */
  "not_permitted",
]);
export type CacheRefusalCode = typeof CacheRefusalCodeSchema.Type;

export class CacheRefused extends Schema.TaggedError<CacheRefused>(
  "@odu/cache/CacheRefused",
)("CacheRefused", {
  code: CacheRefusalCodeSchema,
  message: Schema.String,
}) {}

/** Every procedure declares the same error channel. Named once so no member can
 *  quietly declare a narrower one and leave a face unable to branch. */
const REFUSES = CacheRefused;

// ── inputs and outputs ──────────────────────────────────────────────────────

/** A name the ROW checks (the bucket-name pattern, a pin's non-empty name), not
 *  the schema: a schema check dies as a `SchemaError` before the row can say
 *  why, and the board sends the field as typed so the person reads the row's
 *  sentence. */
const CheckedName = Schema.String;

const CreateInputSchema = Schema.Struct({
  rootToken: Schema.String,
  name: CheckedName,
  /** A public bucket reads without a token; a private one needs read scope. */
  public: Schema.Boolean,
  /** Days from `lastWanted`. Absent is {@link DEFAULT_RETENTION_DAYS}, and a
   *  bucket changes its mind with `bucket.retention`. */
  retentionDays: Schema.optionalKey(Schema.Int),
  /** Defaults to `["cache.nixos.org-1"]` — the filter that keeps nixpkgs out
   *  of a bucket. An empty list takes everything. */
  upstreamKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Which declared store keeps the bucket's objects; absent means `local`.
   *  A name the daemon did not declare is refused (3.1). */
  store: Schema.optionalKey(Schema.String),
});
const ListInputSchema = Schema.Struct({ rootToken: Schema.String });
const ListOutputSchema = Schema.Struct({ buckets: Schema.Array(CacheBucketSchema) });

const DescribeInputSchema = Schema.Struct({
  bucket: Schema.String.check(Schema.isMinLength(1)),
});

const DomainInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  /** A DNS name, or absent/blank to take the name away. */
  domain: Schema.optionalKey(Schema.String),
});

const TokenMintInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  /** A bucket GLOB, so one token can cover `team-*`. Absent means the bucket. */
  bucketGlob: Schema.optionalKey(Schema.String),
  scope: CacheScopeSchema,
  /** Absent means "does not expire" — the shape a CI secret wants. */
  expiresDays: Schema.optionalKey(Schema.Int),
});
const TokenMintOutputSchema = Schema.Struct({
  /** Shown ONCE. The server keeps a hash. */
  token: Schema.String,
  facts: CacheTokenSchema,
});
const TokenListInputSchema = Schema.Struct({
  rootToken: Schema.String,
  /** Absent lists every token in the service, whatever its bucket. */
  bucket: Schema.optionalKey(Schema.String),
});
const TokenListOutputSchema = Schema.Struct({ tokens: Schema.Array(CacheTokenSchema) });
const TokenRevokeInputSchema = Schema.Struct({
  rootToken: Schema.String,
  id: Schema.String,
});
const TokenRevokeOutputSchema = Schema.Struct({
  id: Schema.String,
  revoked: Schema.Boolean,
});

const RetentionInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  /** Days from `lastWanted`. Zero expires everything nothing references and
   *  no pin holds. */
  retentionDays: Schema.Int,
});

/**
 * MOVE A BUCKET'S OBJECTS TO ANOTHER DECLARED STORE.
 *
 * The answer is the bucket's row the moment the move is RECORDED, with
 * `migration` on it; the copy runs in the background and the row's deltas
 * carry its progress. Refused for a store this daemon does not declare, for
 * the store the bucket already lives in, and for a bucket that is already
 * moving.
 */
const MigrateInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  /** A name from the `stores` cell. */
  store: Schema.String,
});

/**
 * TAKE A BUCKET AWAY — its objects, its rows, its tokens and its pins.
 *
 * One verb for the whole thing, because half a deleted bucket is the worst of
 * the three states: a name whose key is gone and whose objects are not, or
 * rows pointing at a store prefix nothing serves. Refused for a bucket with a
 * DOMAIN bound to it (the operator takes the name away first, so no DNS
 * record is left pointing at a bucket that is not there) and for one with a
 * move in flight.
 */
const DeleteInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
});
const DeleteOutputSchema = Schema.Struct({
  name: Schema.String,
  /** STORE OBJECTS removed, not paths: every NAR, the narinfo beside each one,
   *  the bucket's own `nix-cache-info`, anything orphaned under its prefix and
   *  any temp a dead put left. A bucket's `objects` fact counts PATHS; this
   *  counts what the store gave up. */
  objects: Schema.Int,
  /** What those objects weighed, as the store listed them. */
  bytes: Schema.Int,
});

const PinInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  name: CheckedName,
  paths: Schema.Array(Schema.String),
});
/** What a pin answers: the row itself — the same shape `pin.list` carries,
 *  so a face renders one list whether it just made the pin or read it. */
const PinOutputSchema = CachePinSchema;
const PinListInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
});
const PinListOutputSchema = Schema.Struct({ pins: Schema.Array(CachePinSchema) });
const PinDeleteInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  name: CheckedName,
});
const PinDeleteOutputSchema = Schema.Struct({
  bucket: Schema.String,
  name: Schema.String,
});

const GcInputSchema = Schema.Struct({
  rootToken: Schema.String,
  /** Absent collects every bucket. */
  bucket: Schema.optionalKey(Schema.String),
});
const GcBucketSchema = Schema.Struct({
  bucket: Schema.String,
  evicted: Schema.Int,
  /** Rows dropped whose bytes a TWIN row still names: the narinfo went, the
   *  object stayed. */
  kept: Schema.Int,
  bytes: Schema.Int,
  /** Object keys the store held that no row named — a put whose record never
   *  landed, found by listing the bucket's own prefix. */
  orphans: Schema.Int,
});
const GcOutputSchema = Schema.Struct({
  buckets: Schema.Array(GcBucketSchema),
  evicted: Schema.Int,
  kept: Schema.Int,
  bytes: Schema.Int,
  orphans: Schema.Int,
  /** WHY IT DID NOT FINISH — one plain sentence, or null when it did. A
   *  collection deletes in batches and a store that refuses one stops it:
   *  the counts above are what left, everything else is still recorded, and
   *  asking again carries on from there. Never a service's XML. */
  stopped: Schema.NullOr(Schema.String),
});
export type CacheGcReport = typeof GcOutputSchema.Type;

/** THE DRY RUN: what the next collection would do, and nothing done. */
const GcPlanBucketSchema = Schema.Struct({
  bucket: Schema.String,
  /** The WHOLE count and total, however many paths are listed below. */
  evicted: Schema.Int,
  bytes: Schema.Int,
  remaining: Schema.Int,
  /** A readable head of them, oldest want first — the row decides how many,
   *  and `evicted` above is the whole count either way. */
  paths: Schema.Array(
    Schema.Struct({
      storePath: Schema.String,
      bytes: Schema.Int,
      lastWanted: Schema.Number,
    }),
  ),
});

/**
 * THE DRY RUN'S OWN INPUT — the collection's, plus a retention it may ask
 * the question WITH.
 *
 * A separate schema rather than one field on {@link GcInputSchema}, because
 * the split is the guarantee: `gc.run` cannot be handed a retention it would
 * then evict by, so "this number only ever asks" is a fact about the wire
 * rather than a promise in a doc. The bucket's own `retentionDays` is
 * unchanged either way — nothing here writes a row.
 */
const GcPlanInputSchema = Schema.Struct({
  rootToken: Schema.String,
  /** Absent plans for every bucket. */
  bucket: Schema.optionalKey(Schema.String),
  /** ASK AS IF the bucket kept a path this many days from `lastWanted`.
   *  Absent is each bucket's own; `0` is "keep only what a reference or a
   *  pin holds", which is what makes a plan say what a scratch bucket would
   *  cost. Whole days, zero or more — the row refuses the rest in words. */
  retentionDays: Schema.optionalKey(Schema.Int),
});
const GcPlanOutputSchema = Schema.Struct({
  buckets: Schema.Array(GcPlanBucketSchema),
  evicted: Schema.Int,
  bytes: Schema.Int,
});
export type CacheGcPlan = typeof GcPlanOutputSchema.Type;

const StatsInputSchema = Schema.Struct({ rootToken: Schema.String });
const StatsOutputSchema = Schema.Struct({
  buckets: Schema.Array(CacheBucketSchema),
  objects: Schema.Int,
  bytes: Schema.Int,
  hits: Schema.Int,
  /** The newest RENEWAL across the whole cache — a push or a `missing` query;
   *  null when it holds nothing. */
  lastWanted: Schema.NullOr(Schema.Number),
});
export type CacheStats = typeof StatsOutputSchema.Type;

/**
 * A STORE PATH'S TWO HALVES: the hash a person compares two builds by, and
 * the name they are looking for.
 *
 * `/nix/store/<32 base-32 characters>-<name>` — and a path that is not that
 * shape keeps all of itself under `name`, because inventing a hash for it
 * would be a guess printed in a monospace column.
 *
 * HERE, not in the view and not in the database: the name is what a bucket's
 * paths are GROUPED by, so the rule belongs beside the contract that carries
 * it. The row applies it when a path is stored; the board applies it to
 * label a row and to split the hash off.
 */
export function storePathParts(storePath: string): {
  readonly hash: string;
  readonly name: string;
} {
  const slash = storePath.lastIndexOf("/");
  const dash = storePath.indexOf("-", slash + 1);
  // A STORE PATH HAS A DIRECTORY AND A DASH. Without both, the string is
  // something else — a filter's leftovers, a row from another cache — and
  // the first hyphen in it is not a hash boundary.
  if (slash === -1 || dash === -1) return { hash: "", name: storePath };
  return { hash: storePath.slice(slash + 1, dash), name: storePath.slice(dash + 1) };
}

/** WHAT A PAGE OF PATHS MAY BE ORDERED BY — the wire's word, and the one the
 *  storage maps to a column and the board draws a header for. Declared here
 *  because it is a CONTRACT: the ledger watches this list. */
export const PathSortSchema = Schema.Literals(["name", "size", "pushed", "reads"]);
export type PathSort = typeof PathSortSchema.Type;

/**
 * ONE PAGE OF A BUCKET'S PATHS — as paths, as PACKAGES, or as one package's
 * versions.
 *
 * The cursor is the LAST row of the page you were given, opaque to the caller
 * and stable against a push landing between two pages: it names a POSITION in
 * the order you asked for rather than an offset, so a new path at the top
 * shifts nothing you are about to read.
 *
 * GROUPING AND ORDERING ARE THE ROW'S, not a reader's. A client that grouped
 * a page it had already been given would state the page's totals — "6
 * versions, 1.3 GiB" over whatever happened to be in the first hundred — and
 * say the number changed when somebody pressed "show more". The counts, the
 * sums and the order are therefore computed over the WHOLE bucket, in SQL,
 * and paged like anything else.
 */
const PathsInputSchema = Schema.Struct({
  bucket: Schema.String.check(Schema.isMinLength(1)),
  /** A substring the store path must contain — the board's filter box, and the
   *  same shape `odu ci history list`'s search takes. */
  filter: Schema.optionalKey(Schema.String),
  /** Absent means the first page. */
  after: Schema.optionalKey(Schema.String),
  /** `name` answers `groups` — one row per package, over the whole bucket.
   *  Absent answers `paths`. */
  group: Schema.optionalKey(Schema.Literals(["name"])),
  /** One package's versions, as paths. Exclusive with `group`: a group of one
   *  name opened is this call. */
  name: Schema.optionalKey(Schema.String),
  /** What the page is ordered by — of the group's aggregate when grouped.
   *  Absent is `pushed`, which with the default direction is exactly the
   *  order every release before 4.5 answered in.
   *
   *  `reads` is the one order whose column MOVES while a reader pages: a
   *  narinfo served between two pages changes a row's `hits`, so a keyset
   *  page on it may repeat or skip a row. The other three are immutable
   *  facts about a path. */
  sort: Schema.optionalKey(PathSortSchema),
  /** Absent is TRUE — biggest, newest, most read, Z before A. The board
   *  sends what its header says; it does not rely on a default. */
  descending: Schema.optionalKey(Schema.Boolean),
});

/** One PACKAGE in a bucket: every version of a store path's name, summed. */
export const CachePathGroupSchema = Schema.Struct({
  /** The store path's name — everything after the hash. */
  name: Schema.String,
  /** How many versions of it the bucket holds. */
  versions: Schema.Int,
  /** Summed over them: what this package costs the bucket, and how often
   *  anything of it has been fetched. */
  bytes: Schema.Int,
  hits: Schema.Int,
  /** The NEWEST version's push, and the latest want across all of them — a
   *  version nobody wants must not make the package look idle. */
  pushed: Schema.Number,
  wanted: Schema.Number,
  /** The newest version's store path: the hash a reader compares by. */
  storePath: Schema.String,
  /** And the newest version's PROVENANCE — read off that same row, so a
   *  package never shows one build's hash beside another's commit. */
  run: Schema.optionalKey(Schema.NullOr(Schema.String)),
  commit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** WHAT KEEPS THE VERSION HELD LONGEST (4.9) — any pinned one, else the
   *  latest `until` — over the versions the filter leaves: the package stays
   *  as long as that version does. Open the package for each one's. */
  keptBy: Schema.optionalKey(CacheKeptBySchema),
});
export type CachePathGroup = typeof CachePathGroupSchema.Type;

const PathsOutputSchema = Schema.Struct({
  paths: Schema.Array(CachePathSchema),
  /** Present, and the whole answer, when `group` was asked for. */
  groups: Schema.optionalKey(Schema.Array(CachePathGroupSchema)),
  /** Absent when this is the last page. */
  next: Schema.optionalKey(Schema.String),
});
export type CachePaths = typeof PathsOutputSchema.Type;

// ── what both faces print ───────────────────────────────────────────────────

/** How many rows one `cache.paths` page carries — packages, paths, or one
 *  package's versions. Twenty: what a bucket page shows without becoming a
 *  wall, and what a reader scans before deciding to filter instead. Here
 *  because the VERB's page and the VIEW's page are one number. */
export const PATH_PAGE_SIZE = 20;

/**
 * HOW LONG A BUCKET KEEPS WHAT NOBODY WANTS, when its creator says nothing.
 *
 * Ninety days from `lastWanted` — a quarter, which is longer than any release
 * cycle a cache is warming for and short enough that an abandoned project
 * stops costing disk. Each bucket overrides it (`bucket.retention`), and zero
 * means "keep only what is referenced or pinned", which is what the e2e suite
 * uses to make a collection deterministic.
 */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * HOW BIG ONE UPLOAD REQUEST MAY BE.
 *
 * Cloudflare caps a proxied request body at 100 MB (Free and Pro, tunnels
 * included), and a NAR is routinely larger, so `odu cache push` splits its
 * stream into parts under that ceiling. 64 MiB is the default — comfortably
 * under the cap, and few enough parts that a 2 GiB closure is 32 requests.
 * The ceiling odu itself accepts is 96 MiB: the same limit with headroom for
 * headers, so a part that works through Cloudflare also works directly.
 *
 * THIS IS A REQUEST SPLIT, NOT A DEDUP SCHEME, and the neighbours do something
 * else. Attic chunks uncompressed NARs with FastCDC for deduplication — its
 * defaults are 64 KiB minimum / 128 KiB average / 256 KiB maximum, configured
 * on the SERVER and framed inside one upload
 * (https://github.com/zhaofengli/attic/blob/main/book/src/admin-guide/chunking.md).
 * Cachix pushes `--chunk-size` 32 MiB by default, with 4 concurrent chunks
 * (cachix 1.7.2 changelog: https://hackage.haskell.org/package/cachix/changelog).
 * odu's parts exist only to stay under a proxy's body limit; the server joins
 * them and the narinfo's hash proof decides, so no chunk map is kept.
 */
export const DEFAULT_NAR_PART_BYTES = 64 * 1024 * 1024;
export const MAX_NAR_PART_BYTES = 96 * 1024 * 1024;

/**
 * WHICH CONTRACT ADDED THE UPLOAD NEGOTIATION — the one number a push client
 * names when an origin answers 404 to `…/nar/<file>/upload`.
 *
 * A FIXED FACT, not {@link CACHE_CONTRACT_VERSION}: the row's version moves
 * every time the surface grows, and interpolating it told an operator their
 * cache "predates 4.3, which added the upload negotiation" the moment a
 * different verb landed. The sentence is about 4.2 forever.
 */
export const UPLOAD_NEGOTIATION_SINCE = "4.2";

/**
 * In DIRECT mode (PLAN 2.9) nothing proxies the bytes, so the number above
 * stops being a ceiling and becomes the FLOOR a client asks for: the part a
 * store is handed is the larger of its own part size and that ask. S3's own
 * rule — every part but the last at least 5 MiB — is the STORE's to keep,
 * and `s3ObjectStore` keeps it; nothing here needs to know the number.
 */

/**
 * HOW LONG A PRESIGNED URL LIVES — ten minutes, Attic's number for the same
 * redirect, and the same budget for a read and for a write.
 *
 * It is a copy budget, not a session: a client that followed the redirect is
 * already downloading, and a resumed download re-asks odu. Long enough for a
 * multi-gigabyte NAR on a slow link to start, short enough that a URL
 * someone pasted out of a log is dead before it is useful. A direct upload's
 * part URL expires the same way, and an expired one is re-begun by the
 * client rather than refreshed.
 */
export const PRESIGN_SECONDS = 600;

/** What stands where a write token goes, in every block a page or a doc
 *  prints — the netrc line and the push block say the same thing. */
export const WRITE_TOKEN_PLACEHOLDER = "<your-write-token>";

/** What stands where a READ token goes: the netrc line of a private bucket. */
export const READ_TOKEN_PLACEHOLDER = "<your-read-token>";

/** The `nix.conf` pair — the two `extra-` lines a Nix client reads. */
export function nixConfBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `extra-substituters = ${input.url}
extra-trusted-public-keys = ${input.publicKey}`;
}

/** The same pair as a NixOS / nix-darwin attrset. */
export function nixOsBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `nix.settings = {
  extra-substituters = [ "${input.url}" ];
  extra-trusted-public-keys = [ "${input.publicKey}" ];
};`;
}

/** The same pair as a flake's `nixConfig`. */
export function flakeBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `{
  nixConfig = {
    extra-substituters = [ "${input.url}" ];
    extra-trusted-public-keys = [ "${input.publicKey}" ];
  };
}`;
}

/** The same pair inside a workflow's install-nix step. */
export function actionsBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `extra_nix_config: |
  extra-substituters = ${input.url}
  extra-trusted-public-keys = ${input.publicKey}`;
}

/**
 * THE CREDENTIAL LINES, for a PRIVATE bucket only: reading it needs a token.
 *
 * `home` is the caller's ABSOLUTE home directory, or `null` when it has none to
 * offer. It cannot be `~`: Nix expands no tilde here — `--netrc-file ~/.netrc`
 * fails with `not an absolute path` — so a block printed with one is a block
 * that silently does nothing when pasted. The CLI knows `$HOME`; the page does
 * not, and prints a placeholder that says so.
 */
export function netrcBlock(input: {
  readonly url: string;
  readonly home: string | null;
}): string {
  const authority = ((): string => {
    try {
      return new URL(input.url).host;
    } catch {
      return input.url;
    }
  })();
  return `# netrc — an absolute path, no ~${
    input.home === null ? "\nnetrc-file = <home>/.netrc" : `\nnetrc-file = ${input.home}/.netrc`
  }
machine ${authority} password ${READ_TOKEN_PLACEHOLDER}`;
}

/**
 * EVERY BLOCK A CLIENT PASTES, from one function each — the page renders them
 * as separate titled blocks, `odu cache use` prints them one after another, and
 * the docs quote the same strings (`useCopy.test.ts` holds them together).
 */
export function useBlock(input: {
  readonly url: string;
  readonly publicKey: string;
  readonly home: string | null;
}): string {
  return [
    `# nix.conf\n${nixConfBlock(input)}`,
    `# NixOS / nix-darwin\n${nixOsBlock(input)}`,
    `# flake.nix\n${flakeBlock(input)}`,
    `# GitHub Actions\n${actionsBlock(input)}`,
    netrcBlock(input),
  ].join("\n\n");
}

/** The one line that prints {@link useBlock} for a bucket, from a terminal. */
export function useCommand(bucket: string): string {
  return `odu cache use ${bucket}`;
}

/**
 * THE PUSH, for one bucket — the bucket page's block and the docs' Push
 * example, from one function (the docs quote it; `useCopy.test.ts` holds the
 * two together).
 *
 * ONE FACT, THE SUBSTITUTER URL — the same string the `nix.conf` block above
 * it carries, and the same one {@link actionsPushBlock} names. Since `--cache`
 * (cache 4.x), the cache states where a push goes in its own
 * `nix-cache-info` — `Odu-Origin` and `Odu-Bucket` — so a block that spelled
 * the bucket and the daemon's origin made a reader keep three facts current
 * for a bucket that may move stores or gain a domain. `token` is the
 * JUST-MINTED write token while the page can still show it — the once-shown
 * moment is exactly when a person pastes it into a CI secret — and `null`
 * (the placeholder) otherwise.
 */
export function pushBlock(input: {
  /** The substituter URL the bucket publishes: its domain when it has one,
   *  its store's public URL, or the mount path on this daemon. */
  readonly url: string;
  readonly token: string | null;
}): string {
  return `# push — a write token, where the build runs
export ODU_CACHE_TOKEN=${input.token ?? WRITE_TOKEN_PLACEHOLDER}
odu cache push --cache ${input.url.replace(/\/$/, "")} <paths>
`;
}

/**
 * A page cannot know which commit a repository should pin — and here the
 * revision IS a security property, not bookkeeping: the action builds the
 * `odu` it pushes with from the commit it is pinned to, so moving the pin moves
 * the pusher. A placeholder is the honest answer; a tag would be a page
 * choosing a publisher on the reader's behalf.
 */
export const ACTION_REF_PLACEHOLDER = "<odu-revision>";

/**
 * THE SAME PUSH, AS A GITHUB ACTIONS STEP — the bucket page's workflow block
 * and the docs' "Push from GitHub Actions" section, from one function.
 *
 * It is NOT a spelling of {@link pushBlock}: the action takes the token as an
 * input fed from a secret, so the token is a `secrets.` reference here rather
 * than the once-shown value. And it names ONE fact where the shell command
 * names two — the SUBSTITUTER URL, which is the line the reader's `nix.conf`
 * already has. The action reads the push origin and the bucket off that
 * cache's own `nix-cache-info`, so a workflow cannot carry a stale origin for
 * a bucket that moved.
 */
export function actionsPushBlock(input: {
  /** The substituter URL the bucket publishes — its domain or its store's
   *  public URL when it has one, the mount path otherwise. The same string
   *  the `nix.conf` block above it carries. */
  readonly url: string;
  /** The revision the action is pinned to: the daemon's own commit
   *  (`build.commit` on the service cell), or {@link ACTION_REF_PLACEHOLDER}
   *  when its build baked none. */
  readonly ref: string;
}): string {
  return `# .github/workflows — Nix installed in an earlier step
- uses: juspay/odu/.github/actions/push@${input.ref}
  with:
    cache: ${input.url.replace(/\/$/, "")}
    token: \${{ secrets.ODU_CACHE_TOKEN }}
    pin: \${{ github.ref_name == github.event.repository.default_branch }}
`;
}

// ── the surface ─────────────────────────────────────────────────────────────

/**
 * The cache, as one row.
 *
 * `buckets` is a COLLECTION with `deltas` because the board follows it: a
 * bucket's object count and last push move while a page is open, and a reader
 * that had to re-read every bucket to notice one moved would be the two-RPCs-
 * per-second problem the runs board already solved this way.
 *
 * ONE cell, `stores`: the stores this daemon declared, fixed for its tenure —
 * what the create form offers, read from the row rather than re-spelled by the
 * face (3.1).
 *
 * **AND A VERSION OF ITS OWN** — {@link CACHE_CONTRACT_VERSION}, which any
 * change to this surface bumps: adding a verb is a minor bump, changing a shape
 * is a major one. It is enforced, which is what an earlier row-local version
 * was not: `contract.test.ts` pins it to a fingerprint of this surface, and the
 * host publishes it so a client is admitted against the rows it reads.
 */
export const oduCacheSurface = defineSurface({
  cells: {
    stores: {
      schema: Schema.Array(CacheStoreSchema),
      default: [{ name: LOCAL_STORE, kind: "local", default: true }],
      verbs: ["get"],
    },
  },
  collections: {
    buckets: {
      keySchema: Schema.String,
      schema: CacheBucketSchema,
      // READ-ONLY ON THE WIRE. A subscriber follows the rows; it does not write
      // them, and `upsert`/`delete` would have been two unauthenticated members
      // whose only effect is to disagree with the database until the next
      // publish. The row fills them through the sibling's own `ctx`, which is
      // not a wire member.
      verbs: ["keys", "get", "deltas"],
    },
  },
  procedures: {
    bucket: {
      create: { input: CreateInputSchema, output: CacheBucketSchema, error: REFUSES },
      list: { input: ListInputSchema, output: ListOutputSchema, error: REFUSES },
      describe: {
        input: DescribeInputSchema,
        output: CacheBucketIdentitySchema,
        error: REFUSES,
      },
      domain: { input: DomainInputSchema, output: CacheBucketSchema, error: REFUSES },
      paths: { input: PathsInputSchema, output: PathsOutputSchema, error: REFUSES },
      retention: { input: RetentionInputSchema, output: CacheBucketSchema, error: REFUSES },
      migrate: { input: MigrateInputSchema, output: CacheBucketSchema, error: REFUSES },
      delete: { input: DeleteInputSchema, output: DeleteOutputSchema, error: REFUSES },
    },
    token: {
      mint: { input: TokenMintInputSchema, output: TokenMintOutputSchema, error: REFUSES },
      list: { input: TokenListInputSchema, output: TokenListOutputSchema, error: REFUSES },
      revoke: {
        input: TokenRevokeInputSchema,
        output: TokenRevokeOutputSchema,
        error: REFUSES,
      },
    },
    pin: {
      create: { input: PinInputSchema, output: PinOutputSchema, error: REFUSES },
      list: { input: PinListInputSchema, output: PinListOutputSchema, error: REFUSES },
      delete: { input: PinDeleteInputSchema, output: PinDeleteOutputSchema, error: REFUSES },
    },
    gc: {
      run: { input: GcInputSchema, output: GcOutputSchema, error: REFUSES },
      /** THE DRY RUN, and a READ: it changes nothing — which is why it, and
       *  only it, takes a `retentionDays` to ask WITH. */
      plan: { input: GcPlanInputSchema, output: GcPlanOutputSchema, error: REFUSES },
    },
    stats: {
      read: { input: StatsInputSchema, output: StatsOutputSchema, error: REFUSES },
    },
  },
});

export type OduCacheSurface = typeof oduCacheSurface;

// ── the projection policy ───────────────────────────────────────────────────

/**
 * WHAT AN AGENT AND A TERMINAL MAY REACH, and what each verb is called.
 *
 * Here rather than in a face, because it is the ROW's vocabulary: `./cli`
 * projects it as argv, the host's MCP route projects it as tools, and the board
 * reads the collection. The names fall out of the framework's own derivation —
 * `<namespace>_<verb>`, with the sibling key in front when the row is composed —
 * so the cache answers `cache_bucket_create`, `cache_bucket_list`,
 * `cache_bucket_describe`, `cache_bucket_paths`, `cache_bucket_retention`,
 * `cache_bucket_delete`, `cache_token_mint`, `cache_token_list`,
 * `cache_token_revoke`, `cache_pin_create`, `cache_pin_list`,
 * `cache_pin_delete`, `cache_gc_plan`, `cache_gc_run` and
 * `cache_stats_read`.
 *
 * `buckets` is a RESOURCE because the board subscribes to it; `paths` is not,
 * because its input is an address (a bucket name and a page cursor) and a stream
 * or resource that requires an input cannot be a static MCP resource.
 *
 * **`mutates` is a safety default, not a label**: the framework treats an
 * unannotated procedure as MUTATING, because `readOnlyHint: true` lets an MCP
 * host auto-execute a call without confirming it. Every entry says which it is.
 */
export const ODU_CACHE_EXPOSE = {
  buckets: "resource",
  stores: "resource",
  "bucket.create": { tool: { mutates: true } },
  "bucket.list": { tool: { mutates: false } },
  "bucket.describe": { tool: { mutates: false } },
  "bucket.domain": { tool: { mutates: true } },
  "bucket.paths": { tool: { mutates: false } },
  "bucket.retention": { tool: { mutates: true } },
  "bucket.migrate": { tool: { mutates: true } },
  // THE ONE VERB THAT TAKES A BUCKET AWAY: mutating, and an agent must be
  // asked before it runs one — there is no undo for a deleted key.
  "bucket.delete": { tool: { mutates: true } },
  "token.mint": { tool: { mutates: true } },
  "token.list": { tool: { mutates: false } },
  "token.revoke": { tool: { mutates: true } },
  "pin.create": { tool: { mutates: true } },
  "pin.list": { tool: { mutates: false } },
  "pin.delete": { tool: { mutates: true } },
  // THE DRY RUN IS A READ: an agent may ask what a collection would evict
  // without a confirmation, and must not run one without.
  "gc.plan": { tool: { mutates: false } },
  "gc.run": { tool: { mutates: true } },
  "stats.read": { tool: { mutates: false } },
} as const satisfies ExposeMap<(typeof oduCacheSurface)["spec"]>;

/**
 * The `instructions` sentence an MCP host is handed about the cache, composed
 * beside the runs' by the route that serves both.
 */
export const ODU_CACHE_MCP_INSTRUCTIONS = [
  "The cache verbs administer Nix binary cache buckets served by the same",
  "daemon, as their own row. Every one that takes `rootToken` passes it",
  "through: the cache decides, so a daemon started without `$ODU_ROOT_TOKEN`",
  "refuses them with `no_root_token` while the substituter keeps serving.",
  "`cache_bucket_describe` and `cache_bucket_paths` take NO root token — a",
  "bucket's substituter URL, its public key and its path list are what it",
  "publishes to every client that can read it anyway. `cache_bucket_create`",
  "answers a substituter URL and a public key; `cache_token_mint` answers a",
  "plaintext token ONCE (only its hash is kept) and is the credential a pusher",
  "uses. RETENTION is a bucket's own number of days (`cache_bucket_retention`,",
  "90 by default), counted from the last time somebody WANTED a path — a push",
  "of it, or a `missing` query naming it. A read never renews it.",
  "`cache_gc_run` evicts only what retention has expired AND nothing retained",
  "references AND no pin holds; `cache_gc_plan` answers the same decision",
  "WITHOUT doing it — the paths and the bytes the next collection would take,",
  "which is what to read before running one. `cache_gc_plan` alone also takes",
  "a `retentionDays` to plan WITH (`0` is \"only what a reference or a pin",
  "holds\"); it writes nothing, and `cache_gc_run` has no such field, so a",
  "retention a plan asked about can never be one a collection evicted by.",
  "`cache_pin_create` keeps a",
  "closure out of collection by name (re-pointing a pin of the same name),",
  "`cache_pin_list` says what each pin holds and who made it, and",
  "`cache_pin_delete` lets one go. A pin a WRITE token made (a push's",
  "`--pin`) may be re-pointed by a write token; an administrator's may not,",
  "because re-pointing releases whatever the pin held before.",
  "`cache_bucket_paths` pages a bucket's paths newest first, and takes a",
  "substring `filter` and the `after` cursor it returned. Each path (and each",
  "package, for its version held longest) answers `keptBy`: `kind` `pin`,",
  "`retention`, `reference` (`via` names the path that still needs it) or",
  "`nothing` (the next collection takes it), the `pins` that hold it, and",
  "`until`, when the latest retention clock holding it runs out — the",
  "collector's own rule, so `nothing` is exactly what `cache_gc_run` evicts.",
  "`cache_bucket_domain`",
  "gives a bucket a DNS name of its own (clear it with no `domain`); the",
  "advertised `url` becomes that name while `pushUrl` keeps the path the push",
  "API needs. A bucket lives in one STORE, named at `cache_bucket_create`",
  "(`store`, default `local`, the daemon's disk); the `stores` resource lists",
  "the stores this daemon declared (local disk and any S3-compatible ones).",
  "`cache_bucket_migrate` moves a bucket's objects to another declared store:",
  "it answers the row as soon as the move is recorded, and the row's",
  "`migration` field ({to, state, copied, total, bytes}) is the progress —",
  "the bucket keeps being served from the OLD store until every object is",
  "copied, so nothing is unavailable while it runs. A store may publish a",
  "`publicUrl` (an R2 custom domain); a PUBLIC bucket on such a store has",
  "`readsFrom: \"store\"` and a substituter URL on that domain, which keeps",
  "serving while odu is down. Everything else has `readsFrom: \"odu\"`, and a",
  "NAR on an S3 store is answered with a 307 to a presigned URL that expires.",
  "A PRIVATE bucket may not live on a store with a `publicUrl`: the bound",
  "domain serves every prefix in it, so `cache_bucket_create` and",
  "`cache_bucket_migrate` refuse that combination with `bad_input`.",
  "`cache_bucket_delete` takes a whole bucket away — its objects, its paths,",
  "its tokens and its pins — and answers how many store objects and bytes it",
  "removed. There is no undo and no trash: ask it only when somebody asked",
  "for it by name. A bucket with a DOMAIN bound to it is refused until the",
  "domain is cleared (no DNS record left pointing at nothing), as is one with",
  "a migration in flight.",
].join("\n");

// ── the row ─────────────────────────────────────────────────────────────────

/**
 * The word this row is served under — the sibling segment on the wire, the
 * subcommand in argv, and the word a browser folds its health under.
 *
 * HERE, in the browser-safe contract, rather than beside the plugin: five faces
 * spell it (the host's roster, the browser's `connectSurfaces`, the argv
 * projection, the stdio bridge and this package's own client) and four of them
 * cannot open `./server`. A constant behind a door they may not use is a literal
 * they each retype, which is how a page connects to a row nothing serves.
 */
export const CACHE_KEY = "cache";

/**
 * THIS ROW'S OWN CONTRACT VERSION, `major.minor` — the cache's surface above and
 * nothing served beside it. The host publishes it on the identity cell's `rows`;
 * a client that reads the cache is admitted against it, and one that reads only
 * the runs (kolu) never consults it. The rule is the host's: the MINOR when the
 * surface only grows, the MAJOR when something a reader uses changes.
 *
 * 2.4: where the composed wire stood when each row took a version of its own.
 *
 * 3.0: the deprecated `held` collection (always empty since the cache kept what
 * it was pushed), its `/held` route and `odu cache push --wait` are gone. A
 * MAJOR, because a 2.x reader could subscribe to `held`; the host and the other
 * rows stay where they were, so a runs-only client never notices.
 *
 * 3.1: a bucket lives in a STORE — the row's `store`, `bucket.create`'s
 * optional `store`, and the `stores` cell naming what this daemon declared.
 * Additive: a 3.0 reader ignores the field and never asks for the cell.
 *
 * 4.0: RETENTION RUNS ON `lastWanted`. `CachePath.lastAccessed` and
 * `stats.read`'s `lastAccessed` are gone, replaced by `lastWanted` — renewed
 * by a push and by the `missing` query, never by a read. A MAJOR, because a
 * 3.x reader rendered the old field. Additive beside it: `bucket.retention`,
 * `pin.list`, `pin.delete`, `gc.plan` (the dry run), `orphans` on the GC
 * report, `createdBy` on a pin (who may re-point it), and
 * `bucket.create`'s `retentionDays` is now optional (90 days).
 *
 * 4.1: READS LEAVE ODU (PLAN 2.8). Additive, so a 4.0 reader is unaffected:
 * `readsFrom` on a bucket row and on `bucket.describe` (whether the store's
 * own domain or odu answers a read), `publicUrl` on a declared store,
 * `migration` on a bucket row, and the new verb `bucket.migrate` that moves
 * a bucket's objects between stores.
 *
 * 4.2: UPLOADS GO STRAIGHT TO THE STORE (PLAN 2.9). Additive: `writesTo` on a
 * bucket row — `"store"` when a push's bytes are presigned into the store and
 * read back for proof, `"odu"` when they cross the daemon. The push PROTOCOL
 * grows with it (`POST …/nar/<file>/upload` and the part and completion paths
 * that hang off the upload it answers), which is why the number moves at all:
 * a client that speaks 4.2 expects to be able to negotiate, and one that does
 * not keeps the staged routes, which are unchanged.
 *
 * 4.3: A BUCKET CAN BE TAKEN AWAY. Additive: the verb
 * `bucket.delete`, which purges the bucket's objects from its store and then
 * drops its rows, its tokens and its pins. Nothing a 4.2 reader already reads
 * changed, and a reader that does not know the verb simply never calls it.
 *
 * 4.4: THE DRY RUN ASKS ITS OWN QUESTION (PLAN 2.7's open item). Additive:
 * `gc.plan` takes an optional `retentionDays` to plan WITH — the buckets'
 * own rows are untouched, and `gc.run` does not take the field, which is why
 * the two verbs stopped sharing an input schema.
 *
 * 4.5: A BUCKET GROUPED AND ORDERED BY THE ROW. Additive: `bucket.paths`
 * takes `group`, `name`, `sort` and `descending`, and answers `groups` beside
 * `paths` — counted over the whole bucket rather than over one page.
 *
 * 4.6: WHO MINTED A TOKEN (PLAN 4.1). Additive: `label` on a token's public
 * half, so the bucket page's Tokens list says `run <id>` for a credential odu
 * minted for a run rather than leaving an operator to wonder who issued it.
 *
 * 4.7: WHAT BUILT A PATH (PLAN 4.2). Additive: `run` and `commit` on a path
 * and on a package's newest version, stated by the pusher and kept opaque, so
 * a bucket page can say which run put a path there and which commit it was
 * built from. A push states them on both requests that reach a row — the
 * narinfo it uploads, and the `missing` query it asks first, which is the
 * only one a path the bucket ALREADY holds gets — and the bucket fills only
 * a column that is still null and never overwrites one, so the first builder
 * to state a fact keeps it, a run may claim a path its own workflow uploaded
 * at the same commit, and a later unrelated run changes nothing. Optional
 * output fields; a reader that ignores them sees 4.6.
 *
 * 4.8: A COLLECTION THAT STOPS SAYS SO. Additive: `stopped` on `gc.run`'s
 * report — one plain sentence, or null. A collection now deletes in batches,
 * deletes a batch's objects BEFORE dropping its rows, and asks a store that
 * refuses to delete again (five tries) before giving up; what it did not
 * confirm is still recorded, so the counts beside `stopped` are what left and
 * asking again carries on from there. A reader that ignores the field sees
 * 4.7.
 *
 * 4.9: WHAT KEEPS A PATH, AND WHEN IT LEAVES. Additive: `keptBy` on a path
 * and on a package — `kind` (`pin`, `retention`, `reference`, `nothing`),
 * the `pins` that hold it, the `via` path whose clock does, and `until`. It
 * is the collector's own answer, read through the same function `gc.run`
 * evicts by, and it names pins to every reader of `bucket.paths`, which takes
 * no credential. An optional output field; a reader that ignores it sees 4.8.
 */
export const CACHE_CONTRACT_VERSION = "4.9";

/** THE CACHE AND NOTHING ELSE — what a face that reads only this row declares
 *  (`odu cache …`), in the shape `admitService` takes. */
export const CACHE_NEEDS = { [CACHE_KEY]: { requires: CACHE_CONTRACT_VERSION } } as const;

/**
 * WHAT AN AGENT IS TOLD about the cache: its surface, its exposure policy and
 * the paragraph taught at `initialize`.
 *
 * Here for the same reason as the key, and for one more: BOTH dispatch points
 * read it — the daemon's `/mcp` route and the stdio bridge `odu mcp` serves — so
 * a record that lived beside the row would be re-spelled by the bridge, and the
 * two doors would teach different things about the same verbs.
 */
export const CACHE_AGENT: RowAgent = {
  surface: oduCacheSurface,
  expose: ODU_CACHE_EXPOSE,
  instructions: ODU_CACHE_MCP_INSTRUCTIONS,
};

/** THIS ROW'S FACTS — its word on the wire, what an agent is told and its own
 *  contract version, in one value beside the surface. The server's record adds
 *  the plugin; a face that composes rows reads these. */
export const CACHE_ROW: RowFacts = {
  name: CACHE_KEY,
  key: CACHE_KEY,
  agent: CACHE_AGENT,
  contract: CACHE_CONTRACT_VERSION,
};
