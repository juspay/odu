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


/** The target and the credential, as a launch carries them. Spelled beside
 *  {@link LaunchRequest} because the engine takes the same shape — see
 *  `@odu/execution/coordinator/launcher`. */
export interface LaunchPush {
  readonly substituter: string;
  /** `Odu-Origin`: where the push is aimed. RESOLVED by the daemon from its
   *  own bucket, never read back off a server the repository named. */
  readonly origin: string;
  readonly bucket: string;
  /** How the token is revoked at finalize. Recorded on the manifest; the
   *  token itself never is. */
  readonly tokenId: string;
  /** The plaintext write token. It travels to the lane as process environment
   *  and appears in no log, no journal and no command line. */
  readonly token: string;
}

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
  /**
   * WHERE THIS RUN PUSHES WHAT IT BUILDS, and the credential to do it with
   * (PLAN 4.1) — or `null` for a run that pushes nothing.
   *
   * Resolved here and NOT part of the request digest: a repeated `requestId`
   * re-resolves, because the cache a checkout reads from is a fact about the
   * world and the digest is a fact about what the caller sent.
   */
  readonly push: LaunchPush | null;
  /** WHY THIS RUN PUSHES NOTHING, for its setup log — null when it does. */
  readonly pushSkipped: string | null;
  /** WHAT IS WRONG WHILE IT DOES: the bucket's key is missing from the
   *  repository's `trusted-public-keys`. Null when there is nothing to say.
   *  A separate field from the one above, not a second meaning of it: a run
   *  that is pushing and a run that is not are opposite states, and a reader
   *  holding one sentence had to consult `push` to learn which it held. */
  readonly pushKeyWarning: string | null;
  /** THE CLONE WAS MOVED to get here — one sentence for the setup log, beside
   *  the push's own. Null when nothing was moved, which is every run started
   *  from a checkout the caller is standing in. */
  readonly checkoutMoved: string | null;
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

// ── where a run's builds are pushed ─────────────────────────────────────────

/**
 * THE CACHE A REPOSITORY ALREADY READS FROM, resolved (PLAN 4.1).
 *
 * The `extra-substituters` line in `flake.nix`'s `nixConfig` is the whole
 * declaration; a run pushes what it builds to the one odu cache named there
 * that THIS daemon serves. Everything about how that is learnt — evaluating a
 * flake, asking a `nix-cache-info`, knowing which buckets are ours — belongs to
 * the composition root, which is why it is a port.
 */
export interface PushTarget {
  /** The URL the repository substitutes from. */
  readonly substituter: string;
  /** `Odu-Origin`: where a push is aimed. */
  readonly origin: string;
  /** `Odu-Bucket`: which bucket at that origin. */
  readonly bucket: string;
  /** The published key is missing from `trusted-public-keys`, so the repo can
   *  push to this cache and will not trust what it reads back. A warning, not
   *  a refusal: the bytes are still worth storing. Null when the key is there. */
  readonly keyWarning: string | null;
}

export type PushResolution =
  | { readonly kind: "target"; readonly target: PushTarget }
  /** Nothing to push to, and WHY — no flake, an eval that failed, no odu cache
   *  in `nixConfig`, or one this daemon does not serve. The run proceeds
   *  exactly as it did before and the sentence lands in its setup log. */
  | { readonly kind: "skipped"; readonly reason: string }
  /** Two odu caches this daemon serves. A repository builds for ONE cache, so
   *  this REFUSES the start rather than choosing — there is no override key
   *  until somebody hits it. */
  | { readonly kind: "ambiguous"; readonly substituters: readonly string[] };

/** The run's own write token: the id to revoke it by, and the plaintext, which
 *  exists only in this value and in the lane's process environment. */
export interface PushGrant {
  readonly tokenId: string;
  readonly token: string;
}

export interface PushPort {
  /** What `flake.nix` says, and which of it this daemon can grant. Async
   *  because it evaluates somebody else's Nix, which is why it is not part of
   *  {@link CheckoutProbe}. */
  resolve: (checkout: string) => Promise<PushResolution>;
  /** Mint the run's write token for a resolved bucket. `null` when the bucket
   *  has gone between resolution and launch.
   *
   *  No lifetime and no label: how long a run's credential may outlive its
   *  run, and what word the bucket page's Tokens list shows for it, are the
   *  CACHE's decisions. A caller that passed either would be two callers that
   *  could pass different ones. */
  grant: (request: { bucket: string; runId: string }) => PushGrant | null;
  /** Let a run's token go. Idempotent. */
  revoke: (tokenId: string) => void;
}

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

// ── moving a checkout to the commit it was asked for ────────────────────────

/** A clone the SERVICE keeps, the branch it should be on, and the commit on
 *  that branch the caller wants run.
 *
 *  BOTH REFS ARE ALREADY CHECKED when a mover is handed this: `run.start`
 *  holds `sha` to hex and `branch` to git's own branch grammar before any of
 *  it is spelled to a subprocess, because a `branch` of `--upload-pack=…` is
 *  a command and `execFile` does nothing about git's option parsing. */
export interface CheckoutMoveRequest {
  readonly checkout: string;
  readonly branch: string;
  readonly sha: string;
}

/**
 * WHAT MOVING THAT CLONE CAME TO — four refusals and one success, as values.
 *
 * Each arm is a fact the port learned and the SERVICE words, for the reason
 * {@link CheckoutFacts} is a struct of facts: a port that composed the
 * sentence would be a second place refusals are written, and this one has to
 * be stated by a suite that has no git.
 */
export type CheckoutMoveOutcome =
  /** The clone is on `branch` at `sha`, and `head` is what it reads now. */
  | { readonly kind: "moved"; readonly head: string }
  /** Uncommitted work. Refused rather than stashed or discarded: a tree
   *  somebody is holding is not odu's to throw away. */
  | { readonly kind: "dirty"; readonly detail: string }
  /** `git fetch origin <branch>` failed — no such branch, no network, no
   *  credentials. `detail` is git's own sentence. */
  | { readonly kind: "fetch_failed"; readonly detail: string }
  /** The fetch landed and `sha` is NOT an ancestor of `origin/<branch>`:
   *  either a commit on some other branch, or one that was force-pushed away.
   *  `tip` is what `origin/<branch>` is on, so both shas can be said. */
  | { readonly kind: "not_on_branch"; readonly tip: string }
  /** Everything else git refused — the checkout itself, or a HEAD that could
   *  not be read back afterwards. */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Move a clone onto a branch at a commit.
 *
 * A SEPARATE port from {@link CheckoutProbe} and asynchronous, because this
 * one reaches the network: the probe is a synchronous filesystem read that
 * every start performs, and this runs only when a caller handed the service a
 * commit its clone has not got.
 */
export type CheckoutMover = (
  request: CheckoutMoveRequest,
) => Promise<CheckoutMoveOutcome>;

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
   *  `odu ci graph` and a browser cannot be two renderers that drift. */
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
  /** `probing` is a host that has been DIALLED and has not answered yet — a
   *  row that exists before its state does, which is the only way a page can
   *  show the fleet while an unreachable box burns its ssh timeout. */
  readonly state: "probing" | "free" | "busy" | "local" | "down";
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
   *  `odu ci hosts` and `odu ci run` can address different fleets from the same
   *  shell. See {@link Caller}. */
  caller: Caller;
  /**
   * WHAT IS KNOWN SO FAR, as it becomes known.
   *
   * Called once with every configured slot as `probing` — the INVENTORY,
   * before a single machine has been dialled — and again each time a host
   * answers. A probe is as slow as the slowest dead box in it, so without
   * this a page says nothing for the length of an ssh timeout and then
   * everything at once; with it, the fleet is on screen immediately and each
   * row resolves where it stands.
   *
   * Optional, because `odu ci hosts` wants the answer and not the watching.
   */
  onReading?: (partial: {
    source: string | null;
    warnings: readonly string[];
    rows: readonly VenueRowFacts[];
  }) => void;
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
 * **The holder is now the SERVICE's child.** `odu ci lease` used to fork a
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
   *  this, `odu ci hosts` and `odu ci run` can address different fleets from
   *  the same shell. See {@link Caller}. */
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
   *  this, `odu ci hosts` and `odu ci run` can address different fleets from
   *  the same shell. See {@link Caller}. */
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

/** The whole set the composition root binds. One object rather than N
 *  parameters, so adding a port is one edit at the root and one here. */
export interface ServicePorts {
  launch: RunLauncher;
  retry: RunRetrier;
  cancel: RunCanceller;
  /** Where this checkout's run pushes, and the credential for it. A SECOND
   *  port beside the checkout probe rather than a field on it: the probe is
   *  synchronous and pure filesystem, and this evaluates a flake and dials a
   *  substituter. */
  push: PushPort;
  probeCheckout: CheckoutProbe;
  /** Put a service-side clone on the branch and commit a start named. Beside
   *  the probe for the same reason `push` is: it reaches the network. */
  moveCheckout: CheckoutMover;
  pipeline: PipelineReader;
  probeVenues: VenueProber;
  holdVenue: VenueHolder;
  releaseVenue: VenueReleaser;
  protect: RulesetWriter;
}
