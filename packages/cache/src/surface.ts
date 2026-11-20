import type { RowAgent, RowFacts } from "@odu/cordis/services";
import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";

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
  bytes: Schema.Int,
});
export type CacheMigration = typeof CacheMigrationSchema.Type;

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
  /** WHERE A PUSH ADDRESSES THIS BUCKET: always `<origin>/cache/<name>`. It is
   *  the address the cache states in its own `nix-cache-info`
   *  (`Odu-Origin`/`Odu-Bucket`) and a client resolves from
   *  `--cache <substituter>`. */
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
   */
  writesTo: Schema.Literals(["store", "odu"]),
  /** The store-to-store move running on this bucket, or `null`. */
  migration: Schema.NullOr(CacheMigrationSchema),
});
export type CacheBucket = typeof CacheBucketSchema.Type;

/**
 * ONE STORE A BUCKET CAN LIVE IN, as the board offers it: its declared name and
 * what kind it is. Never its endpoint or credentials.
 */
export const CacheStoreSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["local", "s3"]),
  /** The store a bucket created without one lands on — true on exactly one
   *  entry. */
  default: Schema.Boolean,
  /** WHERE THE WORLD READS THIS STORE'S OBJECTS, when the operator bound a
   *  domain to it (`<publicUrl>/<bucket>/…`). `null` for a store nobody
   *  fronts, and always `null` for the local disk. */
  publicUrl: Schema.NullOr(Schema.String),
});
export type CacheStore = typeof CacheStoreSchema.Type;

export const LOCAL_STORE = "local";

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
 * WHAT KEEPS A PATH IN ITS BUCKET, and when that runs out.
 *
 * `kind` is the verdict: `pin` (a pin's closure reaches it — it stays until
 * that pin is deleted or re-pointed), `retention` (its own last want is the
 * latest clock holding it), `reference` (a path that references it, directly
 * or not, was wanted later — `via` names that path), or `nothing` (no pin,
 * every clock has run out: the next collection takes it). `pins` names every
 * pin that holds it. `until` is when the latest clock holding it runs out —
 * `lastWanted + retention` of the path itself or of `via` — and is stated
 * under a pin too.
 */
export const CacheKeptBySchema = Schema.Struct({
  kind: Schema.Literals(["pin", "retention", "reference", "nothing"]),
  pins: Schema.Array(Schema.String),
  via: Schema.NullOr(Schema.String),
  until: Schema.Number,
});
export type CacheKeptBy = typeof CacheKeptBySchema.Type;

export const CachePathSchema = Schema.Struct({
  storePath: Schema.String,
  narSize: Schema.Int,
  /** When the narinfo landed — what "newest first" sorts on. */
  created: Schema.Number,
  hits: Schema.Int,
  /** WHEN SOMEBODY LAST WANTED IT: a push, or a `missing` query that named
   *  it. Retention counts from here, and a read never moves it. */
  lastWanted: Schema.Number,
  /** WHAT BUILT IT (PLAN 4.2) — the run that pushed it and the commit it was
   *  built from, both as the pusher stated them and null where nothing was
   *  said. `optionalKey` so a daemon older than this field still decodes
   *  here. */
  run: Schema.optionalKey(Schema.NullOr(Schema.String)),
  commit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** WHAT KEEPS IT, and until when (4.9). `optionalKey` for the same reason
   *  `run` is: a daemon older than the field still decodes here. */
  keptBy: Schema.optionalKey(CacheKeptBySchema),
});
export type CachePath = typeof CachePathSchema.Type;

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

export const CacheRefusalCodeSchema = Schema.Literals([
  "no_root_token",
  "unknown_bucket",
  "bucket_exists",
  "bad_input",
  /** `bucket.create` named a store this daemon does not declare (3.1). */
  "unknown_store",
  /** The caller is not allowed to administer buckets. */
  "not_permitted",
]);
export type CacheRefusalCode = typeof CacheRefusalCodeSchema.Type;

export class CacheRefused extends Schema.TaggedError<CacheRefused>(
  "@odu/cache/CacheRefused",
)("CacheRefused", {
  code: CacheRefusalCodeSchema,
  message: Schema.String,
}) {}

const REFUSES = CacheRefused;

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
 * Refused for a bucket with a DOMAIN bound to it and for one with a move in
 * flight.
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

const GcPlanInputSchema = Schema.Struct({
  rootToken: Schema.String,
  /** Absent plans for every bucket. */
  bucket: Schema.optionalKey(Schema.String),
  /** ASK AS IF the bucket kept a path this many days from `lastWanted`.
   *  Absent is each bucket's own; `0` is "keep only what a reference or a
   *  pin holds". Whole days, zero or more — the row refuses the rest in
   *  words. */
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
 * shape keeps all of itself under `name`.
 */
export function storePathParts(storePath: string): {
  readonly hash: string;
  readonly name: string;
} {
  const slash = storePath.lastIndexOf("/");
  const dash = storePath.indexOf("-", slash + 1);
  if (slash === -1 || dash === -1) return { hash: "", name: storePath };
  return { hash: storePath.slice(slash + 1, dash), name: storePath.slice(dash + 1) };
}

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
 */
const PathsInputSchema = Schema.Struct({
  bucket: Schema.String.check(Schema.isMinLength(1)),
  /** A substring the store path must contain. */
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
   *  Absent is `pushed`.
   *
   *  `reads` is the one order whose column MOVES while a reader pages: a
   *  narinfo served between two pages changes a row's `hits`, so a keyset
   *  page on it may repeat or skip a row. */
  sort: Schema.optionalKey(PathSortSchema),
  /** Absent is TRUE — biggest, newest, most read, Z before A. */
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
  /** The NEWEST version's push, and the latest want across all of them. */
  pushed: Schema.Number,
  wanted: Schema.Number,
  /** The newest version's store path: the hash a reader compares by. */
  storePath: Schema.String,
  /** The newest version's PROVENANCE — read off that same row. */
  run: Schema.optionalKey(Schema.NullOr(Schema.String)),
  commit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** WHAT KEEPS THE VERSION HELD LONGEST (4.9) — any pinned one, else the
   *  latest `until` — over the versions the filter leaves. */
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

export const PATH_PAGE_SIZE = 20;

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
 */
export const DEFAULT_NAR_PART_BYTES = 64 * 1024 * 1024;
export const MAX_NAR_PART_BYTES = 96 * 1024 * 1024;

/**
 * WHICH CONTRACT ADDED THE UPLOAD NEGOTIATION — the one number a push client
 * names when an origin answers 404 to `…/nar/<file>/upload`.
 */
export const UPLOAD_NEGOTIATION_SINCE = "4.2";

export const PRESIGN_SECONDS = 600;

export const WHOLE_PUSH_SINCE = "juspay/odu#182";

export const WRITE_TOKEN_PLACEHOLDER = "<your-write-token>";

export const READ_TOKEN_PLACEHOLDER = "<your-read-token>";

export const MACHINE_CONFIG_NOTE =
  "On a machine with the Nix daemon, the bucket's address and key (extra-substituters and " +
  "extra-trusted-public-keys) go in the machine's Nix configuration: /etc/nix/nix.conf, or " +
  "nix.settings on NixOS and nix-darwin. For a user not in the daemon's trusted-users, it " +
  "ignores them in that user's own nix.conf or on the command line, and Nix then builds " +
  "everything itself.";

export const FLAKE_CONFIG_NOTE =
  "A flake's nixConfig takes effect only when it is accepted (--accept-flake-config), and " +
  "then only for a trusted user, or on a machine whose Nix configuration already lists " +
  "this substituter under trusted-substituters and its key under trusted-public-keys.";

function commentLines(text: string): string {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ")) {
    if (line.length + 1 + word.length > 78 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line = `${line} ${word}`;
  }
  lines.push(line);
  return lines.join("\n");
}

export function nixConfBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `extra-substituters = ${input.url}
extra-trusted-public-keys = ${input.publicKey}`;
}

export function nixOsBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `nix.settings = {
  extra-substituters = [ "${input.url}" ];
  extra-trusted-public-keys = [ "${input.publicKey}" ];
};`;
}

export function flakeBlock(input: { readonly url: string; readonly publicKey: string }): string {
  return `{
  nixConfig = {
    extra-substituters = [ "${input.url}" ];
    extra-trusted-public-keys = [ "${input.publicKey}" ];
  };
}`;
}

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
 * fails with `not an absolute path`.
 *
 * THE HOST, NEVER THE PORT. A netrc `machine` is matched against the host
 * alone, so `machine 127.0.0.1:18440` matches nothing: Nix sends no
 * credential, and a private bucket answers "not found".
 */
export function netrcBlock(input: {
  readonly url: string;
  readonly home: string | null;
}): string {
  const host = ((): string => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return input.url;
    }
  })();
  return `# netrc — an absolute path, no ~${
    input.home === null ? "\nnetrc-file = <home>/.netrc" : `\nnetrc-file = ${input.home}/.netrc`
  }
machine ${host} password ${READ_TOKEN_PLACEHOLDER}`;
}

export function useBlock(input: {
  readonly url: string;
  readonly publicKey: string;
  readonly public: boolean;
  readonly home: string | null;
}): string {
  return [
    commentLines(MACHINE_CONFIG_NOTE),
    `# nix.conf\n${nixConfBlock(input)}`,
    `# NixOS / nix-darwin\n${nixOsBlock(input)}`,
    `# flake.nix\n${commentLines(FLAKE_CONFIG_NOTE)}\n${flakeBlock(input)}`,
    `# GitHub Actions\n${actionsBlock(input)}`,
    ...(input.public ? [] : [netrcBlock(input)]),
  ].join("\n\n");
}

export function useCommand(bucket: string): string {
  return `odu cache use ${bucket}`;
}

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

export const ACTION_REF_PLACEHOLDER = "<odu-revision>";

export function actionsPushBlock(input: {
  /** The substituter URL the bucket publishes — its domain or its store's
   *  public URL when it has one, the mount path otherwise. */
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
      plan: { input: GcPlanInputSchema, output: GcPlanOutputSchema, error: REFUSES },
    },
    stats: {
      read: { input: StatsInputSchema, output: StatsOutputSchema, error: REFUSES },
    },
  },
});

export type OduCacheSurface = typeof oduCacheSurface;

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
  "bucket.delete": { tool: { mutates: true } },
  "token.mint": { tool: { mutates: true } },
  "token.list": { tool: { mutates: false } },
  "token.revoke": { tool: { mutates: true } },
  "pin.create": { tool: { mutates: true } },
  "pin.list": { tool: { mutates: false } },
  "pin.delete": { tool: { mutates: true } },
  "gc.plan": { tool: { mutates: false } },
  "gc.run": { tool: { mutates: true } },
  "stats.read": { tool: { mutates: false } },
} as const satisfies ExposeMap<(typeof oduCacheSurface)["spec"]>;

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

export const CACHE_KEY = "cache";

export const CACHE_CONTRACT_VERSION = "4.9";

export const CACHE_NEEDS = { [CACHE_KEY]: { requires: CACHE_CONTRACT_VERSION } } as const;

export const CACHE_AGENT: RowAgent = {
  surface: oduCacheSurface,
  expose: ODU_CACHE_EXPOSE,
  instructions: ODU_CACHE_MCP_INSTRUCTIONS,
};

export const CACHE_ROW: RowFacts = {
  name: CACHE_KEY,
  key: CACHE_KEY,
  agent: CACHE_AGENT,
  contract: CACHE_CONTRACT_VERSION,
};
