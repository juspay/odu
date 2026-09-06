/**
 * The coordinator's half of the durable run catalog — the adapter that turns a
 * run's in-process events into `@odu/run-history` records, and the only place
 * in the engine that knows the catalog exists.
 *
 * Three rules shape everything below.
 *
 * **History is never a gate.** A failed catalog write must not fail a run, and
 * it must not change a verdict. That is the rule the checkout ledger already
 * followed and it is stricter here, because there is now much more to write:
 * a full disk in the middle of a pipeline is a bad afternoon, not a lost run.
 * So every method is best-effort, and the constructor itself returns
 * {@link NO_HISTORY} — a working no-op — rather than throwing, so no call site
 * needs a null check.
 *
 * **Except being fenced, which is a gate.** There is exactly one failure this
 * adapter refuses to swallow: discovering that another process now owns this
 * run's record. That is not an I/O hiccup, it is this coordinator having been
 * superseded, and continuing to write would produce the two-writer journal the
 * fence exists to prevent. {@link RunHistory.fenced} goes true and every
 * subsequent write is dropped; the run itself keeps going (its lanes are real
 * and its verdict is real), but it stops claiming to be the author of this
 * run's history.
 *
 * **An attempt is sealed by the LOG BARRIER, not by the status.** This is the
 * one piece of ordering that has to be right, and it is easy to get wrong in
 * both directions. A node's outcome and its output are two facts that arrive
 * separately: for a recipe node the lane's `end` frame is what RELEASES the
 * verdict, so the log lands first; for `_ci-setup@<platform>` the status lands
 * first and the coordinator keeps narrating lane deaths and operator cancels
 * into that log long afterwards. So an attempt closes when BOTH have arrived —
 * the same barrier the verdict gate already holds — and until then its log
 * stays writable. Sealing on the status alone would freeze a setup log
 * half-written; sealing on the log alone would seal an attempt with no outcome.
 *
 * Attempts are also ALLOCATED here. One opens when a node begins work
 * (whichever arrives first: the lane's snapshot reset, or the `running`
 * transition), and the next ordinal is never the same file — so a retry cannot
 * write over the failure somebody is reading.
 */

import type { NodeStatus } from "@odu/run-client/surface";
import { splitFanId } from "@odu/run-client/nodeId";
import { signalFromExit } from "@odu/run-history/exit";
import { mintRunId } from "@odu/run-history/ids";
import {
  HEARTBEAT_INTERVAL_MS,
  heartbeat,
  releaseOwnership,
  type OwnershipToken,
} from "@odu/run-history/owner";
import { isResumptionEvent } from "@odu/run-history/schema";
import type { Placement, RunEvent, RunScope } from "@odu/run-history/schema";
import {
  appendAttemptLog,
  type JournalWriter,
  openJournal,
  type RunHandle,
  readAttemptRecord,
  registerRun,
  sealAttempt,
  startAttempt,
  writeAttemptLog,
  writeVerdict,
} from "@odu/run-history/store";

/** The statuses that leave a node still in flight. Spelled from the status
 *  vocabulary rather than as bare string literals so a new `NodeStatus` is a
 *  compile error here, not a node whose evidence silently never seals. */
const IN_FLIGHT: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "pending",
  "running",
]);

export interface RunHistoryInit {
  repoRoot: string;
  repo: string | null;
  sha: string;
  seq: number | null;
  pipeline: string;
  scope: RunScope;
  snapshotMode: "strict" | "live";
  dirty: boolean;
  runnerFlake: string | null;
  oduVersion: string;
  /** Where this coordinator serves its live surface, so a catalog reader can
   *  find the run behind the record. */
  endpoint: string;
  /** A retry's link back to the run it replays. */
  parentRunId?: string | null;
  /** The caller's idempotency key, when the launch carried one. */
  requestId?: string | null;
  /** The id this run must publish under, when a launcher pre-minted one.
   *  Absent means mint — see `./launcher` on why a launcher does not. */
  runId?: string;
  /** Injected for tests; production reads the real catalog root. */
  catalogRoot?: string;
  now?: () => number;
}

export interface RunHistory {
  /** The catalog id this run publishes under, or null when no record could be
   *  opened at all. Faces print it, and a retry addresses it. */
  readonly runId: string | null;
  /** Another process took ownership of this run's record. See the header. */
  readonly fenced: boolean;
  roster: (order: readonly string[]) => void;
  phase: (phase: "provisioning" | "lanes" | "no_lanes") => void;
  lane: (
    platform: string,
    state: "claiming" | "leased",
    host: string | null,
  ) => void;
  /** A node reached a status. A terminal one supplies half the seal. */
  nodeStatus: (
    node: string,
    status: NodeStatus,
    outcome: {
      exitCode: number | null;
      durationMs: number | null;
      host: string | null;
    },
  ) => void;
  /** Mirror a node's output into its current attempt's log. */
  log: (node: string, text: string) => void;
  /** This node's log has had its last word — the other half of the seal.
   *  FIRST caller wins: a truncation notice and the lane's own `end` frame
   *  both arrive for one attempt and they disagree by design, since the notice
   *  is written precisely because the `end` never came. */
  logFinalized: (node: string, complete: boolean, reason: string | null) => void;
  /** A lane re-sent this node's buffered tail. NOT a retry: the attempt is the
   *  same attempt, so its bytes are replaced in place. */
  replaceLog: (node: string, text: string) => void;
  /** This node's work is starting over on a new invocation — a resurrection
   *  re-running an interrupted node. Seals the open attempt as superseded so
   *  the bytes that follow land on a NEW ordinal, never on top of the failure
   *  somebody is reading. */
  resetNode: (node: string, reason: string) => void;
  postingDebt: (
    rows: readonly { context: string; lastError: string; attempts: number }[],
  ) => void;
  /**
   * Record that a retry carrying `requestId` was ACCEPTED against this run,
   * before the reset it asked for is performed.
   *
   * This is the coordinator's half of idempotency, and it is written here
   * rather than inferred by the caller because only this process knows the
   * request was accepted. A reconciler that has lost its reply reads this line
   * and replays it; one that does not find it, on a journal it could read
   * whole, has PROOF that nothing was accepted rather than an absence of
   * evidence.
   *
   * BEFORE the mutation, deliberately. The two orderings fail differently and
   * only one of them fails safe: recording after would let a crash in between
   * hide a reset that really happened, and a caller told "nothing happened"
   * repeats it. Recording first can at worst claim an acceptance whose reset
   * did not follow — which costs a caller one redundant retry and never a
   * silent double mutation.
   */
  /** Which attempt this node is on, by the ALLOCATOR that hands ordinals out.
   *  The authority a caller's `expectAttempt` is checked against: a directory
   *  listing can be inflated by a half-written retry, and the journal is what
   *  the schema says decides. `0` for a node that has not started one. */
  currentAttempt: (node: string) => number;
  retryAccepted: (accepted: {
    requestId: string;
    inputDigest: string;
    roots: readonly string[];
    resetDependants: readonly string[];
  }) => boolean;
  /**
   * Resolve an accepted retry: the lane took the reset, or refused it.
   *
   * The half that makes {@link RunHistory.retryAccepted} safe to write early.
   * Acceptance is INTENT — the coordinator can die before the reset, and the
   * lane can decline it — so a reconciler that finds an acceptance with no
   * resolution reports the outcome as unknown rather than as success. Both
   * outcomes are recorded, because a refusal is an answer.
   */
  retryApplied: (resolved: {
    requestId: string;
    node: string;
    applied: boolean;
  }) => void;
  /** Publish the terminal outcome. Safe to call more than once (a `--linger`
   *  run re-finalizes on every drain); it appends a `finalized` line once per
   *  EXECUTION GENERATION — again after a rerun resumed the run, never twice
   *  for one settle. */
  finalize: (verdict: {
    outcome: "passed" | "failed" | "incomplete";
    startedAt: number;
    finishedAt: number;
    failed: readonly string[];
    errored: readonly string[];
    cancelled: readonly string[];
    unposted: readonly { context: string; lastError: string; attempts: number }[];
  }) => void;
  /** Drop the endpoint and stop the heartbeat. The record stays; nothing is
   *  serving it any more. */
  close: () => void;
}

/** The working no-op every failure path collapses to, so no caller branches on
 *  whether history is available. */
export const NO_HISTORY: RunHistory = {
  runId: null,
  fenced: false,
  roster: () => {},
  phase: () => {},
  lane: () => {},
  nodeStatus: () => {},
  log: () => {},
  logFinalized: () => {},
  replaceLog: () => {},
  resetNode: () => {},
  postingDebt: () => {},
  // `false`, not `true`: no history means no durable record, and a caller must
  // be able to tell its reply "the acceptance was not written down" rather
  // than promise a line that will never exist.
  currentAttempt: () => 0,
  retryAccepted: () => false,
  retryApplied: () => {},
  finalize: () => {},
  close: () => {},
};

/** What the two halves of the barrier have said so far about one attempt. */
interface OpenAttempt {
  attempt: number;
  placement: Placement;
  /** Set by a terminal `nodeStatus`. */
  outcome?: { status: NodeStatus; exitCode: number | null };
  /** Set by `logFinalized`, first word only. */
  log?: { complete: boolean; reason: string | null };
}

/**
 * Register this run in the catalog and return the writer for it.
 *
 * Called BEFORE the run executes — before the venue claim, before any lane —
 * so a coordinator that dies in its first second still leaves a run somebody
 * can address. A registration that cannot happen (no writable state root, a
 * live owner on the same id, a full disk) yields {@link NO_HISTORY}: the run
 * proceeds without a catalog record, exactly as every odu before this one did.
 */
export function openRunHistory(init: RunHistoryInit): RunHistory {
  const now = init.now ?? Date.now;
  const opts = init.catalogRoot === undefined ? {} : { root: init.catalogRoot };
  let handle: RunHandle;
  let token: OwnershipToken;
  try {
    const registered = registerRun(
      {
        runId: init.runId ?? mintRunId(now()),
        repo: init.repo,
        sha: init.sha,
        seq: init.seq,
        pipeline: init.pipeline,
        repoRoot: init.repoRoot,
        createdAt: now(),
        scope: init.scope,
        snapshot: {
          mode: init.snapshotMode,
          expectedSha: init.sha,
          dirty: init.dirty,
          // A dirty live tree was never committed, so its inputs cannot be
          // reconstructed from the sha — a finalized retry of it must refuse
          // rather than run something else and call it the same run.
          retryable: init.snapshotMode === "strict" && !init.dirty,
        },
        build: {
          oduVersion: init.oduVersion,
          self: process.env.ODU_SELF ?? null,
          runnerFlake: init.runnerFlake,
        },
        parentRunId: init.parentRunId ?? null,
        requestId: init.requestId ?? null,
      },
      { ...opts, endpoint: init.endpoint, now: now() },
    );
    if (!registered.ok) return NO_HISTORY;
    handle = registered.handle;
    token = registered.token;
  } catch {
    return NO_HISTORY;
  }

  // One journal, held open for the run: the ordinal lives in the writer, so a
  // long run does not re-read its own history once per event. See
  // `openJournal`.
  const journal: JournalWriter = openJournal(handle, token);
  let fenced = false;
  let finalized = false;
  /** Has work resumed since the last terminal line? The writer's half of the
   *  generation rule — see {@link emit}. */
  let resumedSinceFinalized = false;
  const open = new Map<string, OpenAttempt>();
  /** The highest ordinal handed out per node — the allocator. In memory
   *  because this process owns the run for its whole life; a successor
   *  re-derives it from the journal when it takes over. */
  const highest = new Map<string, number>();
  /**
   * What each attempt's producer SAID about its log, keyed `<node>#<attempt>`
   * and kept ACROSS the seal.
   *
   * On `open` alone this would not survive the moment it matters. Where a
   * node's status leads its output — `_ci-setup@<platform>`, whose log the
   * coordinator keeps narrating into long after the lane is done — a
   * truncation stamp seals the attempt immediately, and the end-of-run sweep's
   * `logFinalized(…, true, null)` then arrives at an attempt that is no longer
   * open. Consulting only the open record there would let the sweep dress a
   * stamped-short log in a completion frame, which is the exact outcome this
   * file's header forbids. So first-word-wins is remembered here, where the
   * seal cannot erase it.
   */
  const said = new Map<string, { complete: boolean; reason: string | null }>();
  const attemptKey = (node: string, attempt: number): string =>
    `${node}#${attempt}`;

  /** Every journal write goes through here, so the fence is checked in ONE
   *  place and `fenced` cannot be true for some writers and false for others. */
  const emit = (event: RunEvent): void => {
    if (fenced) return;
    // Work happening after this run was called finished OPENS A NEW
    // GENERATION, and the writer owes that generation its own terminal line.
    // The rule is `isResumptionEvent`, in run-history beside the event union,
    // because the reader draws the other half of this conclusion from exactly
    // the same events — see {@link RunHistory.finalize}.
    if (finalized && isResumptionEvent(event)) resumedSinceFinalized = true;
    try {
      if (journal.append(event, now()) === null) fenced = true;
    } catch {
      // Best-effort: a write that throws is a disk problem, not a fence.
    }
  };

  const placementOf = (node: string, host: string | null): Placement => ({
    platform: splitFanId(node).platform,
    host,
  });

  /** Write the seal. FAIL-CLOSED on completeness: an attempt nobody said was
   *  finished is sealed INCOMPLETE with a reason that says so, because the one
   *  outcome this file must never produce is a short log wearing a completion
   *  frame. */
  const seal = (
    node: string,
    current: OpenAttempt,
    fallbackReason: string | null,
  ): void => {
    open.delete(node);
    if (fenced) return;
    const log = current.log;
    try {
      sealAttempt(handle, token, node, current.attempt, {
        endedAt: now(),
        status: current.outcome?.status ?? null,
        exitCode: current.outcome?.exitCode ?? null,
        // The shell's `128 + N` reading, made once, where the exit code is.
        signal: signalFromExit(current.outcome?.exitCode ?? null),
        logComplete: log?.complete ?? false,
        logTruncationReason:
          log === undefined
            ? (fallbackReason ?? "no producer said this log was finished")
            : log.reason,
      });
    } catch {
      // See the header: evidence is best-effort against the run.
    }
  };

  /** THE BARRIER. Seal only once both halves have arrived. */
  const sealIfComplete = (node: string): void => {
    const current = open.get(node);
    if (current === undefined) return;
    if (current.outcome === undefined || current.log === undefined) return;
    seal(node, current, null);
  };

  const beginAttempt = (node: string, host: string | null): void => {
    if (fenced) return;
    if (open.has(node)) return;
    const attempt = (highest.get(node) ?? 0) + 1;
    const placement = placementOf(node, host);
    try {
      if (
        !startAttempt(handle, token, {
          node,
          attempt,
          placement,
          startedAt: now(),
        })
      ) {
        return;
      }
    } catch {
      return;
    }
    highest.set(node, attempt);
    open.set(node, { attempt, placement });
    emit({ kind: "attempt_started", node, attempt, placement });
  };

  /** A late `logFinalized` — the log's last word arriving after the attempt was
   *  already sealed, from a producer that had not spoken when it was.
   *
   *  Correcting a record that says "nobody said this log was finished" when
   *  somebody since has costs nothing and removes a standing understatement.
   *  Correcting one that says the log is SHORT would be the opposite, so this
   *  is reached only when `said` has no earlier word — see its note. */
  const amendSealedLog = (
    node: string,
    attempt: number,
    complete: boolean,
    reason: string | null,
  ): void => {
    if (fenced) return;
    try {
      const existing = readAttemptRecord(handle, node, attempt);
      if (existing === null) return;
      sealAttempt(handle, token, node, attempt, {
        endedAt: existing.endedAt ?? now(),
        status: existing.status,
        exitCode: existing.exitCode,
        signal: existing.signal,
        logComplete: complete,
        logTruncationReason: reason,
      });
    } catch {
      // Best-effort, like every other write here.
    }
  };

  const heart = setInterval(() => {
    if (fenced) return;
    try {
      if (!heartbeat(token, now())) fenced = true;
    } catch {
      // A heartbeat that cannot be written is not proof of anything; the next
      // one may succeed, and a successor still has to outlive the grace.
    }
  }, HEARTBEAT_INTERVAL_MS);
  // The heartbeat must never be the reason a process stays alive: a run that
  // has finished its work exits, and this timer follows it out.
  heart.unref?.();

  return {
    get runId() {
      return handle.runId;
    },
    get fenced() {
      return fenced;
    },
    roster: (order) => emit({ kind: "roster", order: [...order] }),
    phase: (phase) => emit({ kind: "phase", phase }),
    lane: (platform, state, host) =>
      emit({ kind: "lane", platform, state, host }),
    nodeStatus: (node, status, outcome) => {
      // A node can reach a terminal status without ever having run — `skipped`
      // is the routine case, a lane that died during provisioning the other —
      // and its outcome still needs somewhere to hang. So an attempt is opened
      // for any status that is not merely `pending`.
      if (status !== "pending") beginAttempt(node, outcome.host);
      const current = open.get(node);
      const attempt = current?.attempt ?? highest.get(node) ?? 1;
      emit({
        kind: "node_status",
        node,
        attempt,
        status,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        placement: placementOf(node, outcome.host),
      });
      if (IN_FLIGHT.has(status) || current === undefined) return;
      current.outcome = { status, exitCode: outcome.exitCode };
      sealIfComplete(node);
    },
    log: (node, text) => {
      if (fenced) return;
      // Output before any status — the provisioning narration into
      // `_ci-setup@<platform>` is exactly this. Open attempt 1 lazily rather
      // than dropping bytes nobody else will ever write down.
      if (!open.has(node)) beginAttempt(node, null);
      const attempt = open.get(node)?.attempt;
      if (attempt === undefined) return;
      appendAttemptLog(handle, node, attempt, text);
    },
    logFinalized: (node, complete, reason) => {
      const current = open.get(node);
      const attempt = current?.attempt ?? highest.get(node);
      if (attempt === undefined) return;
      // FIRST WORD WINS, and the check is against `said` rather than against
      // the open record — so it holds whether or not the attempt has been
      // sealed since. A truncation stamp and the end-of-run sweep both reach
      // here for one attempt and disagree by design: the stamp is written
      // precisely because the sweep's `end` never came.
      const key = attemptKey(node, attempt);
      if (said.has(key)) return;
      said.set(key, { complete, reason });
      emit({ kind: "log_finalized", node, attempt, bytes: 0, complete, reason });
      if (current === undefined) {
        // The attempt was sealed before any producer spoke — reachable for a
        // node whose status leads its output. Correct the sidecar rather than
        // dropping the fact.
        amendSealedLog(node, attempt, complete, reason);
        return;
      }
      current.log = { complete, reason };
      sealIfComplete(node);
    },
    replaceLog: (node, text) => {
      if (fenced) return;
      if (!open.has(node)) beginAttempt(node, null);
      const attempt = open.get(node)?.attempt;
      if (attempt === undefined) return;
      writeAttemptLog(handle, node, attempt, text);
    },
    resetNode: (node, reason) => {
      const current = open.get(node);
      if (current === undefined) return;
      seal(node, current, reason);
    },
    postingDebt: (rows) => {
      for (const row of rows) {
        emit({
          kind: "posting_debt",
          context: row.context,
          lastError: row.lastError,
          attempts: row.attempts,
        });
      }
    },
    currentAttempt: (node) => highest.get(node) ?? 0,
    retryAccepted: ({ requestId, inputDigest, roots, resetDependants }) => {
      if (fenced) return false;
      emit({
        kind: "retry_accepted",
        requestId,
        // A live retry acts on THIS run — it resets a node on a coordinator
        // already going, and starts nothing new. The finalized path, which
        // does start a new run, never reaches this method: it has no
        // coordinator to ask.
        effectiveRunId: handle.runId,
        roots: [...roots],
        resetDependants: [...resetDependants],
        inputDigest,
      });
      // `emit` sets `fenced` when the append is refused, so this reports what
      // actually reached the journal rather than what was attempted — which is
      // the whole value of the flag to the caller reconciling later.
      return !fenced;
    },
    retryApplied: ({ requestId, node, applied }) => {
      if (fenced) return;
      emit({ kind: "retry_applied", requestId, node, applied });
    },
    finalize: (verdict) => {
      if (fenced) return;
      // Seal anything still open BEFORE the verdict, so a reader that trusts
      // the terminal line never finds an attempt still claiming to be running.
      for (const [node, current] of [...open.entries()]) {
        seal(
          node,
          current,
          "the run ended before this node's output was complete",
        );
      }
      try {
        writeVerdict(handle, token, {
          runId: handle.runId,
          outcome: verdict.outcome,
          startedAt: verdict.startedAt,
          finishedAt: verdict.finishedAt,
          failed: [...verdict.failed],
          errored: [...verdict.errored],
          cancelled: [...verdict.cancelled],
          unposted: verdict.unposted.map((u) => ({ ...u })),
        });
      } catch {
        // Best-effort, like every other write here.
      }
      // ONE terminal line PER GENERATION, not one per run.
      //
      // A `--linger` run calls this on every drain, and repeating the same
      // terminal line each time would be two claims about how one execution
      // ended — so a drain that follows no new work is silent. But a run that
      // FINISHED, took a rerun, and finished again really did end twice, and
      // those are two facts, not a contradiction. Suppressing the second was
      // the inverse of the premature-settlement bug: `resumed` is cleared by a
      // `finalized` line, so a writer that never emitted one left every
      // retried run permanently unsettled, and a caller waiting on the retry
      // could not observe it finish.
      //
      // The condition is the writer's half of the shared rule in `emit`.
      if (!finalized || resumedSinceFinalized) {
        finalized = true;
        resumedSinceFinalized = false;
        emit({ kind: "finalized", outcome: verdict.outcome });
      }
    },
    close: () => {
      clearInterval(heart);
      if (fenced) return;
      try {
        releaseOwnership(token, now());
      } catch {
        // Nothing depends on a clean release: a reader that finds a stale
        // endpoint dials it, gets nothing, and falls back to the record.
      }
    },
  };
}
