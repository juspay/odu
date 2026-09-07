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
 * The shapes below are structurally the ones `@odu/execution` already
 * publishes (`LaunchRequest`/`LaunchReceipt` on `coordinator/launcher`,
 * `RetryInput`/`RetryOutcome` on `coordinator/recovery`), spelled here so the
 * arrow points from the root inward. They are not re-inventions: both sides
 * name the same `RunScope` out of `@odu/run-history/schema`, so the compiler
 * proves the binding at the root rather than a comment claiming it.
 */

import type { CatalogOptions } from "@odu/run-history/store";
import type { RunScope } from "@odu/run-history/schema";

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
  /** The caller said it really did mean to take this checkout from the run
   *  already in progress there. Carried through rather than consumed here: what
   *  superseding MEANS — cancel the incumbent, confirm it is gone, then claim
   *  the lock — belongs to the process that is about to hold that lock, because
   *  only it can do the three without a window in between. */
  readonly supersede: boolean;
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
  | "launch_failed";

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

/** The whole set the composition root binds. One object rather than four
 *  parameters, so adding a port is one edit at the root and one here. */
export interface ServicePorts {
  launch: RunLauncher;
  retry: RunRetrier;
  cancel: RunCanceller;
  probeCheckout: CheckoutProbe;
}
