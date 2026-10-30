/**
 * The PORTS — what the service needs done that it does not know how to do.
 *
 * The service owns cross-run orchestration: which run a request is about, what
 * a request id means the second time it arrives, and what the board says. It
 * does not own a RUN. Scheduling, the verdict gate, the retry closure and
 * GitHub posting all live in `@odu/execution`, and this package cannot import
 * it — the wall is asserted by `src/closure.test.ts`, not by discipline.
 *
 * So the three things the service must CAUSE — start a coordinator, retry a
 * recorded run, reach a live coordinator to cancel — arrive as function types
 * the composition root binds. Three consequences, and each is the reason the
 * seam is here rather than an import:
 *
 *   - **The service is testable without a machine.** A suite hands it a
 *     launcher that records the request and starts nothing, and every path
 *     through acceptance, receipts and reconciliation is exercised at the speed
 *     of a function call.
 *   - **The web face cannot acquire a second scheduler.** There is exactly one
 *     answer to "what does retrying mean", it lives in `./recovery`, and the
 *     service reaches it through this seam rather than growing its own.
 *   - **The closure stays free of a terminal emulator.** `@odu/execution` is
 *     the engine; `@odu/cli` carries a renderer. A daemon that imported either
 *     would ship both to every browser tab's server.
 *
 * The shapes below are the ones `@odu/execution` publishes
 * (`LaunchRequest`/`LaunchReceipt` on `coordinator/launcher`,
 * `RetryInput`/`RetryOutcome` on `coordinator/recovery`), spelled here so the
 * arrow points from the root inward. They are not re-inventions: both sides
 * name the same `RunScope` out of `@odu/run-history/schema`, so the compiler
 * proves that much at the root rather than a comment claiming it.
 *
 * **The launch shape differs by exactly the caller.** This package names a
 * {@link Caller}; the engine still carries the caller's `$ODU_HOSTS` as the
 * flat `hostsFile` it has always taken. Neither may name the other's type, so
 * `webPorts.ts` — the one root both are in scope — is where they reconcile.
 */

import type { CatalogOptions } from "@odu/run-history/store";
import type { RunScope } from "@odu/run-history/schema";
import type { Caller } from "./caller";

// ── starting a run ──────────────────────────────────────────────────────────

/** What the service asks for when it accepts a `run.start`. Every field is
 *  decided before anything is started, so the request can be recorded,
 *  replayed or refused without a process existing. */
export interface LaunchRequest {
  readonly checkout: string;
  readonly catalog?: CatalogOptions;
  /** The id the new run will publish under — minted by the SERVICE, before the
   *  spawn, which is what makes a lost reply a directory lookup rather than a
   *  guess. */
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly requestId: string | null;
  readonly scope: RunScope;
  readonly expectedSha: string;
  readonly noStrict: boolean;
  readonly noSnapshot: boolean;
  readonly noPost: boolean;
  readonly hostPins: readonly string[];
  /** WHO this run is for. The service carries the caller's `$ODU_HOSTS` rather
   *  than reading its own: the daemon's environment belongs to the shell that
   *  started it, never to the person asking for this run. See {@link Caller}. */
  readonly caller: Caller;
  /** The caller said it really did mean to take this checkout from the run
   *  already in progress there. Carried through rather than consumed here: what
   *  superseding MEANS — cancel the incumbent, confirm it is gone, then claim
   *  the lock — belongs to the process that is about to hold that lock, because
   *  only it can do the three without a window in between. */
  readonly supersede: boolean;
  /** Park the coordinator at settle instead of tearing down. */
  readonly linger: boolean;
}

export interface LaunchReceipt {
  ok: boolean;
  runId: string;
  endpoint: string;
  pid?: number;
  /** How independent the coordinator actually is, and why — "your run survives
   *  this shell" and "your run dies with this unit" are different promises. */
  lifetime?: string;
  error?: string;
}

export type RunLauncher = (request: LaunchRequest) => Promise<LaunchReceipt>;

// ── retrying a recorded run ─────────────────────────────────────────────────

/** The receipt a retry answers with. `mode` is the field that matters, because
 *  the caller did not choose it. */
export interface RetryReceipt {
  request_id: string | null;
  mode: "live" | "relaunched";
  effective_run: string;
  parent_run: string | null;
  roots: readonly string[];
  reset_dependants: readonly string[];
  attempts: readonly { node: string; attempt: number }[];
  scope: RunScope;
  sha: string;
  cursor: string;
  lifetime?: string;
}

/**
 * WHY a retry was refused, as a value.
 *
 * The same union `@odu/execution`'s retry policy declares, spelled here because
 * the arrow runs cli → execution and this package must not import the engine.
 * Two spellings of one union, and the compiler proves them equal exactly where
 * the composition root binds one to the other — which is the only place both
 * are in scope, and the only place a divergence could be caught at all.
 *
 * `partial` is the arm that only a retry has: the request acted on some of its
 * roots and was declined for the rest, which is a refusal rather than a
 * qualified success — a caller reading `ok: true` would act as if the whole
 * thing had happened.
 */
export type RetryRefusal =
  | "bad_input"
  | "unknown_run"
  | "not_replayable"
  | "request_conflict"
  | "request_unresolved"
  | "stale_attempt"
  | "partial"
  | "launch_failed"
  /** The parent's recorded placement cannot be expressed against today's
   *  declared inventory. A replay reproduces WHERE a run was allowed to run;
   *  when it cannot, it refuses rather than placing the work somewhere the
   *  original never was. */
  | "no_venue"
  /** Retention has expired the run's evidence. */
  | "expired";

export type RetryOutcome =
  | { ok: true; receipt: RetryReceipt; replayed: boolean }
  | {
      ok: false;
      code: RetryRefusal;
      message: string;
      suggestion?: readonly string[];
    };

export interface RetryRequest {
  runId: string;
  selector: string;
  requestId?: string;
  expectAttempt?: { node: string; attempt: number };
  catalog?: CatalogOptions;
}

/** Retry a recorded run. The POLICY — live attempt or linked replay — is the
 *  port's, not the service's: which one applies is a fact about the run, and a
 *  caller that chose would choose wrongly. */
export type RunRetrier = (request: RetryRequest) => Promise<RetryOutcome>;

// ── cancelling ──────────────────────────────────────────────────────────────

/** What a cancel was asked to stop. The three scopes are separate because they
 *  reach different machinery — a whole-run teardown, one unit of work, one
 *  platform lane — and a caller that meant one of them must not get another. */
export type CancelScope =
  | { kind: "run" }
  | { kind: "node"; node: string }
  | { kind: "lane"; platform: string };

export interface CancelRequest {
  /** Where a coordinator serves. Read off the run's ownership record rather
   *  than its manifest — but an endpoint is a PATH, and `.ci/odu.sock` is
   *  scoped to a checkout that serves one run after another. So it is not an
   *  identity, which is what {@link CancelRequest.expect} is for. */
  endpoint: string;
  /** The run the caller named, for the message. */
  runId: string;
  /**
   * WHO must be on the other end of that socket.
   *
   * `<sha>#<seq>` is the identity the coordinator publishes and the catalog
   * stores, and the adapter compares it before it mutates anything. Without
   * this, a run whose coordinator crashed keeps its endpoint through the
   * heartbeat grace while a NEW run takes the same checkout — and cancelling
   * the dead one would tear down the live one, with a receipt naming the run
   * that was already over. `seq: null` is a run that reserved no ordinal and so
   * cannot prove which run it is; the adapter refuses rather than guessing,
   * because the cost of the wrong answer is stopping a stranger's CI.
   */
  expect: { sha: string; seq: number | null };
  scope: CancelScope;
}

/**
 * What reaching the coordinator came to. THREE arms, because a lost reply is
 * not a `false`.
 *
 * A run-scope cancel routes into the same teardown a SIGINT takes, so the
 * coordinator may exit before its ack flushes — which means "no answer" covers
 * both "it did it and died" and "it never heard me". Collapsing that into
 * success writes a completed receipt for a mutation nobody confirmed;
 * collapsing it into failure tells a caller nothing happened when it did. So
 * the adapter confirms by the socket going away — the run surface's own
 * documented signal — and reports `unresolved` only when it could not.
 */
export type CancelOutcome =
  /** The coordinator took the mutation, or is confirmed gone. */
  | { kind: "cancelled"; detail: string | null }
  /** Understood and declined — no such node, no such lane, or the socket is
   *  serving a different run than the one the caller named. */
  | { kind: "declined"; detail: string }
  /** Dispatched, and what became of it is not known. Never recorded as a
   *  finished request: a repeat must be free to ask again, which is safe
   *  because cancelling twice cancels once. */
  | { kind: "unresolved"; detail: string };

export type RunCanceller = (request: CancelRequest) => Promise<CancelOutcome>;

// ── validating a checkout before accepting work ─────────────────────────────

/** What the service can learn about a checkout without running anything. */
export interface CheckoutFacts {
  /** The checkout exists and is a git repository. */
  isRepo: boolean;
  /** Full 40-hex HEAD, or null when it cannot be read. */
  head: string | null;
  /** The branch HEAD names, or null for a detached HEAD. */
  branch: string | null;
  /** A run is already live in this checkout, and this is its id — read from
   *  the catalog's ownership records rather than from the checkout, because a
   *  socket file is not a run (see the retry policy's own note on why). */
  liveRunId: string | null;
}

/** Probe a checkout. Injected because it shells out to git, which a suite that
 *  wants to state "the checkout moved on" must be able to say without one. */
export type CheckoutProbe = (checkout: string) => CheckoutFacts;

// ── reading a checkout's pipeline ───────────────────────────────────────────

/** One recipe in a resolved DAG. Structurally `@odu/execution`'s `TaskSpec`,
 *  spelled here for the reason the header gives. */
export interface TaskFacts {
  readonly id: string;
  readonly name: string | null;
  readonly command: string;
  readonly needs: readonly string[];
  readonly os: readonly string[];
  readonly shards: number | null;
}

export interface PipelineFacts {
  readonly name: string;
  readonly tasks: readonly TaskFacts[];
  /** The DAG as Mermaid, rendered by the engine that owns the graph — so
   *  `odu graph` and a browser cannot be two renderers that drift. */
  readonly mermaid: string;
}

export type PipelineOutcome =
  | { ok: true; facts: PipelineFacts }
  /** No justfile, or one that could not be read as a pipeline. `message` is the
   *  engine's own sentence: it knows which recipe was malformed and this layer
   *  does not. */
  | { ok: false; message: string };

/** Resolve a checkout's `[metadata("ci")]` DAG. Reads a file and runs nothing. */
export type PipelineReader = (request: {
  checkout: string;
  root?: string;
}) => PipelineOutcome;

// ── venues: the machines, and the holds on them ─────────────────────────────

export interface VenueHolderFacts {
  readonly holder: string;
  readonly run: string | null;
  readonly sinceMs: number;
}

export interface VenueRowFacts {
  readonly platform: string;
  readonly host: string;
  readonly slot: number;
  readonly slots: number;
  readonly state: "free" | "busy" | "local" | "down";
  readonly heldBy: VenueHolderFacts | null;
  readonly error: string | null;
}

export type VenueProbeOutcome =
  | {
      ok: true;
      source: string | null;
      warnings: readonly string[];
      rows: readonly VenueRowFacts[];
    }
  /** No hosts are configured at all — the one case that is a refusal rather
   *  than an empty inventory, because "nothing is configured" and "everything
   *  is busy" call for opposite actions. */
  | { ok: false; message: string };

/** Probe configured venues. Dials each machine, and acquires nothing. An empty
 *  `platforms` means every configured one. */
export type VenueProber = (request: {
  platforms: readonly string[];
  /** WHO the caller is. The inventory is resolved HERE, in a per-user singleton
   *  whose environment belongs to whoever started it — so without this,
   *  `odu hosts` and `odu run` can address different fleets from the same
   *  shell. See {@link Caller}. */
  caller: Caller;
}) => Promise<VenueProbeOutcome>;

export interface VenueHoldResult {
  readonly platform: string;
  readonly status: "held" | "waiting" | "already";
  readonly host: string | null;
  readonly holderPid: number | null;
  readonly waitingBehind: VenueHolderFacts | null;
  readonly message: string;
}

export type VenueHoldOutcome =
  | { ok: true; results: readonly VenueHoldResult[] }
  | { ok: false; message: string };

/**
 * Take a hold on a venue, for a checkout, that outlives the caller.
 *
 * **The holder is now the SERVICE's child.** `odu lease` used to fork a
 * detached `odu lease-hold` from the caller's own shell, which made a hold's
 * lifetime a property of which terminal took it. Through the service, the
 * holder is parented by the daemon — which is what "held across runs" was
 * always supposed to mean, and is the only arrangement under which a browser
 * or an agent can take one at all.
 */
export type VenueHolder = (request: {
  checkout: string;
  platforms: readonly string[];
  /** WHO the hold is for. The inventory is resolved HERE, in a per-user
   *  singleton whose environment belongs to whoever started it — so without
   *  this, `odu hosts` and `odu run` can address different fleets from the same
   *  shell. See {@link Caller}. */
  caller: Caller;
  noWait: boolean;
}) => Promise<VenueHoldOutcome>;

export interface VenueReleaseResult {
  readonly platform: string;
  readonly effective: "released" | "nothing";
  readonly host: string | null;
  readonly detail: string | null;
}

export type VenueReleaser = (request: {
  checkout: string;
  platforms: readonly string[];
  /** WHO the release is for. The inventory is resolved HERE, in a per-user
   *  singleton whose environment belongs to whoever started it — so without
   *  this, `odu hosts` and `odu run` can address different fleets from the same
   *  shell. See {@link Caller}. */
  caller: Caller;
}) => Promise<{ results: readonly VenueReleaseResult[] }>;

// ── branch protection ───────────────────────────────────────────────────────

export interface ProtectFacts {
  /** Null under `dryRun` — the contexts do not need the forge, so a dry run
   *  does not consult it. See `ProtectOutputSchema`. */
  readonly repo: string | null;
  readonly branch: string | null;
  readonly contexts: readonly string[];
  readonly rulesetId: number | null;
  readonly applied: boolean;
  readonly created: boolean;
  readonly derivedFrom: string | null;
  readonly detail: string | null;
}

export type ProtectOutcome =
  | { ok: true; facts: ProtectFacts }
  | {
      ok: false;
      /** `no_credential` when `gh` cannot authenticate — which is a fixable
       *  situation with an argv-shaped recovery, not a generic failure. */
      code: "checkout_refused" | "pipeline_refused" | "no_credential" | "bad_input";
      message: string;
      suggestion?: readonly string[];
    };

/**
 * Set a branch's required status checks to exactly the contexts odu posts.
 *
 * This spends the user's `gh` credential, and it is the service that spends it
 * — which is not a new exposure: the coordinator the daemon launches has always
 * posted commit statuses with the same credential, and `--no-post` is the
 * opt-out. A face that kept this local on the grounds that "the daemon must not
 * spend your credential" would have been asserting something already false, and
 * would have left the browser and an agent unable to do it at all.
 */
export type RulesetWriter = (request: {
  checkout: string;
  branch?: string;
  platforms: readonly string[];
  /** WHO the protection is for. An unsliced `protect` DERIVES its platform set
   *  from the hosts file, and that derivation runs here — in a per-user
   *  singleton whose environment belongs to whoever started it, not to whoever
   *  asked. See {@link Caller}. */
  caller: Caller;
  dryRun: boolean;
  create: boolean;
}) => Promise<ProtectOutcome>;

// ── the cache ───────────────────────────────────────────────────────────────

/**
 * A Nix binary cache, administered — the port the service delegates to.
 *
 * The service defines the SHAPE and `@odu/cache` implements it structurally;
 * neither imports the other's module, and that is deliberate. The cache is the
 * bottom of the graph (it may not import anything of odu's), and the service is
 * forbidden `@odu/execution`; a port is the one place a signature can be stated
 * twice without an edge.
 *
 * **The root token travels through.** The service does not check it — it does
 * not know what the cache was started with — it only carries the caller's
 * `rootToken` into the call, and the cache answers `no_root_token` when the two
 * do not match. That keeps "who may administer" in the package that holds the
 * secret, and it is why every input below carries one.
 */
export type CacheRefusal = "no_root_token" | "unknown_bucket" | "bucket_exists" | "bad_input";

export type CacheOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: CacheRefusal; message: string };

export interface CacheBucketFacts {
  name: string;
  public: boolean;
  retentionDays: number;
  keyName: string;
  publicKey: string;
  upstreamKeys: readonly string[];
  objects: number;
  bytes: number;
  created: number;
}

export type CacheScope = "read" | "write" | "admin";

/** What `describe` answers: the substituter's own identity, and nothing an
 *  operator would call a fact about their cache. */
export interface CacheBucketIdentity {
  name: string;
  public: boolean;
  publicKey: string;
}

export interface CacheTokenFacts {
  id: string;
  bucketGlob: string;
  scope: CacheScope;
  expires: number | null;
  lastUsed: number | null;
  revoked: boolean;
  created: number;
}

export interface CacheGcReport {
  buckets: readonly { bucket: string; evicted: number; kept: number; bytes: number }[];
  evicted: number;
  kept: number;
  bytes: number;
}

export interface CacheAdmin {
  /** Where the protocol is mounted under the origin. The CACHE owns this — it
   *  is the path its routes are registered at — and the service only learns it
   *  so a bucket's substituter URL can be built without a second spelling of
   *  the same literal. */
  readonly mount: string;
  create(input: {
    rootToken: string;
    name: string;
    public: boolean;
    retentionDays: number;
    upstreamKeys: readonly string[];
  }): Promise<CacheOutcome<CacheBucketFacts>>;
  list(input: { rootToken: string }): Promise<CacheOutcome<readonly CacheBucketFacts[]>>;
  /**
   * One bucket's public identity — its name, whether it is public, and the key
   * a client trusts — with no root token.
   *
   * Deliberately NOT `CacheBucketFacts`: the object count, the bytes, the
   * retention and the upstream key names are the operator's, and this verb
   * takes no credential. The service adds `url`, which is the origin it is
   * bound to.
   */
  describe(input: { bucket: string }): Promise<CacheOutcome<CacheBucketIdentity>>;
  tokenMint(input: {
    rootToken: string;
    bucket: string;
    /** A glob; absent means the bucket. */
    bucketGlob: string | null;
    scope: CacheScope;
    expiresDays: number | null;
  }): Promise<CacheOutcome<{ token: string; facts: CacheTokenFacts }>>;
  tokenList(input: {
    rootToken: string;
    bucket: string | null;
  }): Promise<CacheOutcome<readonly CacheTokenFacts[]>>;
  tokenRevoke(input: {
    rootToken: string;
    id: string;
  }): Promise<CacheOutcome<{ id: string; revoked: boolean }>>;
  pin(input: {
    rootToken: string;
    bucket: string;
    name: string;
    paths: readonly string[];
  }): Promise<
    CacheOutcome<{ bucket: string; name: string; rootPaths: readonly string[]; created: number }>
  >;
  gc(input: { rootToken: string; bucket: string | null }): Promise<CacheOutcome<CacheGcReport>>;
  stats(input: { rootToken: string }): Promise<
    CacheOutcome<{
      buckets: readonly CacheBucketFacts[];
      objects: number;
      bytes: number;
      hits: number;
      lastAccessed: number | null;
    }>
  >;
}

/** The whole set the composition root binds. One object rather than N
 *  parameters, so adding a port is one edit at the root and one here. */
export interface ServicePorts {
  launch: RunLauncher;
  retry: RunRetrier;
  cancel: RunCanceller;
  probeCheckout: CheckoutProbe;
  pipeline: PipelineReader;
  probeVenues: VenueProber;
  holdVenue: VenueHolder;
  releaseVenue: VenueReleaser;
  protect: RulesetWriter;
  cache: CacheAdmin;
}
