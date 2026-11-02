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

import type { RowAgent } from "@odu/cordis/services";
import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";

// ── the row ─────────────────────────────────────────────────────────────────

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
   *  a bucket in its path. The page's push block and the docs use this. */
  pushUrl: Schema.String,
  /** When the last narinfo landed here; `null` for a bucket nothing has been
   *  pushed to. */
  lastPush: Schema.NullOr(Schema.Number),
  /** narinfo reads, summed over the bucket's objects. */
  hits: Schema.Int,
});
export type CacheBucket = typeof CacheBucketSchema.Type;

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
  lastUsed: Schema.NullOr(Schema.Number),
  revoked: Schema.Boolean,
  created: Schema.Number,
});
export type CacheToken = typeof CacheTokenSchema.Type;

/** One stored path, as a bucket lists it. */
export const CachePathSchema = Schema.Struct({
  storePath: Schema.String,
  narSize: Schema.Int,
  /** When the narinfo landed — what "newest first" sorts on. */
  created: Schema.Number,
  hits: Schema.Int,
  lastAccessed: Schema.Number,
});
export type CachePath = typeof CachePathSchema.Type;

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
  retentionDays: Schema.Int,
  /** Defaults to `["cache.nixos.org-1"]` — the filter that keeps nixpkgs out
   *  of a bucket. An empty list takes everything. */
  upstreamKeys: Schema.optionalKey(Schema.Array(Schema.String)),
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

const PinInputSchema = Schema.Struct({
  rootToken: Schema.String,
  bucket: Schema.String,
  name: CheckedName,
  paths: Schema.Array(Schema.String),
});
const PinOutputSchema = Schema.Struct({
  bucket: Schema.String,
  name: Schema.String,
  /** The closure resolved at pin time. */
  rootPaths: Schema.Array(Schema.String),
  created: Schema.Number,
});

const GcInputSchema = Schema.Struct({
  rootToken: Schema.String,
  /** Absent collects every bucket. */
  bucket: Schema.optionalKey(Schema.String),
});
const GcBucketSchema = Schema.Struct({
  bucket: Schema.String,
  evicted: Schema.Int,
  /** Rows dropped whose bytes another root on this machine still holds. */
  kept: Schema.Int,
  bytes: Schema.Int,
});
const GcOutputSchema = Schema.Struct({
  buckets: Schema.Array(GcBucketSchema),
  evicted: Schema.Int,
  kept: Schema.Int,
  bytes: Schema.Int,
});
export type CacheGcReport = typeof GcOutputSchema.Type;

const StatsInputSchema = Schema.Struct({ rootToken: Schema.String });
const StatsOutputSchema = Schema.Struct({
  buckets: Schema.Array(CacheBucketSchema),
  objects: Schema.Int,
  bytes: Schema.Int,
  hits: Schema.Int,
  /** The newest read across the whole cache; null when it holds nothing. */
  lastAccessed: Schema.NullOr(Schema.Number),
});
export type CacheStats = typeof StatsOutputSchema.Type;

/** One page of a bucket's paths, newest first.
 *
 *  The cursor is the LAST row of the page you were given, opaque to the caller
 *  and stable against a push landing between two pages: it names a position in
 *  `(created, storePath)` order rather than an offset, so a new path at the top
 *  shifts nothing you are about to read. */
const PathsInputSchema = Schema.Struct({
  bucket: Schema.String.check(Schema.isMinLength(1)),
  /** A substring the store path must contain — the board's filter box, and the
   *  same shape `odu history list`'s search takes. */
  filter: Schema.optionalKey(Schema.String),
  /** Absent means the first page. */
  after: Schema.optionalKey(Schema.String),
});
const PathsOutputSchema = Schema.Struct({
  paths: Schema.Array(CachePathSchema),
  /** Absent when this is the last page. */
  next: Schema.optionalKey(Schema.String),
});
export type CachePaths = typeof PathsOutputSchema.Type;

// ── what both faces print ───────────────────────────────────────────────────

/** How many paths one `cache.paths` page carries: what the board's list renders
 *  without a scroll, and what a person reading a bucket wants before deciding to
 *  filter. Here because the VERB's page and the VIEW's page are one number. */
export const PATH_PAGE_SIZE = 100;

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
  return `# netrc — Nix reads only the file named by netrc-file, never ~/.netrc,
# and it does NOT expand ~ there: give it an absolute path.${
    input.home === null
      ? "\n# (replace <home> below with yours — a page cannot know it)\nnetrc-file = <home>/.netrc"
      : `\nnetrc-file = ${input.home}/.netrc`
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
 * The bucket is named, and the ORIGIN is the daemon's public origin, so the
 * command works on a build box that never ran `odu cache login` and through a
 * bucket's domain or the instance's own name alike. `token` is the JUST-MINTED
 * write token while the page can still show it — the once-shown moment is
 * exactly when a person pastes it into a CI secret — and `null` (the
 * placeholder) otherwise.
 */
export function pushBlock(input: {
  readonly origin: string;
  readonly bucket: string;
  readonly token: string | null;
}): string {
  return `# push — a write token, exported where the build runs (a build secret)
export ODU_CACHE_TOKEN=${input.token ?? WRITE_TOKEN_PLACEHOLDER}
odu cache push ${input.bucket} <paths> --origin ${input.origin.replace(/\/$/, "")}
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
 * No cells: a bucket is not a singleton fact, and nothing else about the cache
 * is a value on the wire.
 *
 * **AND A VERSION OF ITS OWN** — {@link CACHE_CONTRACT_VERSION}, which any
 * change to this surface bumps: adding a verb is a minor bump, changing a shape
 * is a major one. It is enforced, which is what an earlier row-local version
 * was not: `contract.test.ts` pins it to a fingerprint of this surface, and the
 * host publishes it so a client is admitted against the rows it reads.
 */
export const oduCacheSurface = defineSurface({
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
    },
    gc: {
      run: { input: GcInputSchema, output: GcOutputSchema, error: REFUSES },
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
 * `cache_bucket_describe`, `cache_bucket_paths`, `cache_token_mint`,
 * `cache_token_list`, `cache_token_revoke`, `cache_pin_create`, `cache_gc_run`
 * and `cache_stats_read`.
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
  "bucket.create": { tool: { mutates: true } },
  "bucket.list": { tool: { mutates: false } },
  "bucket.describe": { tool: { mutates: false } },
  "bucket.domain": { tool: { mutates: true } },
  "bucket.paths": { tool: { mutates: false } },
  "token.mint": { tool: { mutates: true } },
  "token.list": { tool: { mutates: false } },
  "token.revoke": { tool: { mutates: true } },
  "pin.create": { tool: { mutates: true } },
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
  "uses; `cache_pin_create` keeps a closure out of `cache_gc_run`, which evicts",
  "only what retention has expired AND nothing retained references AND no pin",
  "holds. `cache_bucket_paths` pages a bucket's paths newest first, and takes a",
  "substring `filter` and the `after` cursor it returned. `cache_bucket_domain`",
  "gives a bucket a DNS name of its own (clear it with no `domain`); the",
  "advertised `url` becomes that name while `pushUrl` keeps the path the push",
  "API needs.",
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
 */
export const CACHE_CONTRACT_VERSION = "3.0";

/** THE CACHE AND NOTHING ELSE — what a face that reads only this row declares
 *  (`odu cache …`), in the shape `admitService` takes. */
export const CACHE_NEEDS = { [CACHE_KEY]: CACHE_CONTRACT_VERSION } as const;

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
