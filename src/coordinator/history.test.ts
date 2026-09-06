/**
 * The coordinator's adapter onto the run catalog — the three rules its header
 * states, each falsifiable on its own.
 *
 *   - HISTORY IS NEVER A GATE. A catalog that cannot be opened yields the
 *     working no-op, not an exception, because a run must not die of its own
 *     bookkeeping.
 *   - BEING FENCED IS A GATE. The one failure this adapter refuses to swallow:
 *     once another process owns the record, it writes NOTHING further — a
 *     second writer on one journal is the unrecoverable case.
 *   - AN ATTEMPT IS SEALED BY THE LOG BARRIER, NOT BY THE STATUS. The outcome
 *     and the output arrive separately and in either order, so an attempt
 *     closes when BOTH have. This is the easy thing to get wrong in both
 *     directions: sealing on the status alone freezes a `_ci-setup` log
 *     half-written, and sealing on the log alone seals an attempt with no
 *     outcome. Sealing wrongly is unrecoverable — the log is chmod'd read-only
 *     and the ordinal is never named again.
 *
 * Around that sits the ALLOCATOR, which is the same property from the other
 * side: a retry gets the NEXT ordinal, so it cannot write over the failure
 * somebody is reading. And the completeness stamp is FAIL-CLOSED — a short log
 * must never wear a completion frame.
 *
 * Every test builds its own catalog root under `tmpdir()` and injects a fixed
 * clock: a suite that wrote into the developer's real `~/.local/state/odu`, or
 * that read the wall clock, is a suite nobody can run twice.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { encodeNodeKey, isRunId } from "@odu/run-history/ids";
import { claimOwnership, OWNERSHIP_GRACE_MS } from "@odu/run-history/owner";
import { ATTEMPT_FILES, attemptDir } from "@odu/run-history/paths";
import {
  attemptsFor,
  handleFor,
  readAttemptLog,
  readAttemptRecord,
  readJournal,
  readManifest,
  readVerdict,
  type RunHandle,
} from "@odu/run-history/store";
import {
  openRunHistory,
  type RunHistory,
  type RunHistoryInit,
} from "./history";

const T0 = 1_700_000_000_000;
const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const NODE = "ci::e2e@x86_64-linux";
/** The coordinator's own bookkeeping node — the one whose status LEADS its
 *  output, which is what half the barrier tests below are about. */
const SETUP = "_ci-setup@x86_64-linux";

const dirs: string[] = [];
const opened: RunHistory[] = [];

afterEach(() => {
  // Close first: the heartbeat timer is unref'd, but a suite that left one per
  // test running would still be holding an epoch it has stopped speaking for.
  for (const history of opened.splice(0)) history.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A catalog root of our own. Never the real one. */
function tmpCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-history-"));
  dirs.push(dir);
  return dir;
}

function init(root: string, over: Partial<RunHistoryInit> = {}): RunHistoryInit {
  return {
    repoRoot: "/checkouts/odu",
    repo: "juspay/odu",
    sha: SHA,
    seq: 7,
    pipeline: "ci",
    scope: { selectors: ["e2e"], platforms: [], noDeps: false },
    snapshotMode: "strict",
    dirty: false,
    runnerFlake: null,
    oduVersion: "0.1.0",
    endpoint: "/checkouts/odu/.ci/odu.sock",
    catalogRoot: root,
    now: () => T0,
    ...over,
  };
}

function openHistory(root: string, over: Partial<RunHistoryInit> = {}): RunHistory {
  const history = openRunHistory(init(root, over));
  opened.push(history);
  return history;
}

/** The store-side handle for a registered run, so every assertion reads the
 *  records back through the store's own readers rather than through the
 *  adapter's memory. */
function handleOf(history: RunHistory, root: string): RunHandle {
  const runId = history.runId;
  if (runId === null) throw new Error("history did not register");
  return handleFor(runId, { root });
}

/** A registered run, and the handle onto what it writes. */
function started(over: Partial<RunHistoryInit> = {}): {
  root: string;
  history: RunHistory;
  handle: RunHandle;
} {
  const root = tmpCatalog();
  const history = openHistory(root, over);
  return { root, history, handle: handleOf(history, root) };
}

/** Take the run over the way a successor does: a heartbeat older than the
 *  grace, and an incumbent pid that is gone. (The incumbent here is US, and our
 *  pid is very much alive, so the liveness probe is injected.) */
function takeOver(handle: RunHandle): void {
  const claim = claimOwnership({
    runId: handle.runId,
    dir: handle.dir,
    endpoint: null,
    now: T0 + OWNERSHIP_GRACE_MS + 1,
    isAlive: () => false,
  });
  if (!claim.ok) throw new Error(`takeover refused: ${claim.refusal.reason}`);
}

function logText(handle: RunHandle, node: string, attempt: number): string | undefined {
  return readAttemptLog(handle, node, attempt)?.text;
}

/** The permission bits on an attempt's log — 0444 once the attempt is sealed. */
function logMode(handle: RunHandle, node: string, attempt: number): number {
  const path = join(
    attemptDir(handle.dir, encodeNodeKey(node), attempt),
    ATTEMPT_FILES.log,
  );
  return statSync(path).mode & 0o777;
}

function kinds(handle: RunHandle): string[] {
  return readJournal(handle).entries.map((entry) => entry.event.kind);
}

type Verdict = Parameters<RunHistory["finalize"]>[0];

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    outcome: "passed",
    startedAt: T0,
    finishedAt: T0 + 1_000,
    failed: [],
    errored: [],
    cancelled: [],
    unposted: [],
    ...over,
  };
}

const running = { exitCode: null, durationMs: null, host: "builder-1" };
const passed = { exitCode: 0, durationMs: 1_200, host: "builder-1" };

describe("registering a run", () => {
  it("publishes the identity it was given, claims the epoch, and opens the journal with `registered`", () => {
    const { root, handle } = started();

    // `handle` is addressed by the id the adapter reports, so a manifest that
    // reads back here is one `runId` can be dialled with.
    const manifest = readManifest(handle);
    expect(manifest?.runId).toBe(handle.runId);
    expect(manifest?.repo).toBe("juspay/odu");
    expect(manifest?.sha).toBe(SHA);
    expect(manifest?.seq).toBe(7);
    expect(manifest?.pipeline).toBe("ci");
    expect(manifest?.repoRoot).toBe("/checkouts/odu");
    // The injected clock, not the wall one — a record whose createdAt drifted
    // would sort against ids that encode the same instant.
    expect(manifest?.createdAt).toBe(T0);
    expect(manifest?.scope).toEqual({
      selectors: ["e2e"],
      platforms: [],
      noDeps: false,
    });
    expect(manifest?.build.oduVersion).toBe("0.1.0");
    expect(manifest?.parentRunId).toBeNull();
    expect(manifest?.requestId).toBeNull();

    // Ownership is claimed as part of registering, and the endpoint is how a
    // catalog reader finds the live run behind the record.
    expect(manifest?.owner.epoch).toBe(1);
    expect(manifest?.owner.endpoint).toBe("/checkouts/odu/.ci/odu.sock");

    // REGISTER BEFORE EXECUTE: the run is addressable before it does anything.
    const journal = readJournal(handle);
    expect(journal.unreadable).toBe(0);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]?.seq).toBe(1);
    expect(journal.entries[0]?.event).toEqual({
      kind: "registered",
      scope: { selectors: ["e2e"], platforms: [], noDeps: false },
    });

    // And it is discoverable at the id the adapter reports, in OUR catalog.
    expect(handle.dir.startsWith(root)).toBe(true);
  });

  it("carries a retry's parentage and the launcher's idempotency key onto the record", () => {
    const { handle } = started({
      parentRunId: "0000000a-0001",
      requestId: "req-42",
    });
    expect(readManifest(handle)?.parentRunId).toBe("0000000a-0001");
    expect(readManifest(handle)?.requestId).toBe("req-42");
  });

  it("mints a run id, and publishes under an explicit one verbatim", () => {
    const minted = started().history.runId;
    expect(minted).not.toBeNull();
    expect(isRunId(minted ?? "")).toBe(true);

    // A launcher that pre-minted an id told its caller that id; registering
    // under a different one would make the receipt address nothing.
    const { history, handle } = started({ runId: "0000000a-0001" });
    expect(history.runId).toBe("0000000a-0001");
    expect(readManifest(handle)?.runId).toBe("0000000a-0001");
  });

  it("marks only a clean strict snapshot retryable", () => {
    // This is the flag a finalized retry refuses on, so all three cases are
    // pinned: a replay needs inputs it can reconstruct from the sha alone.
    expect(readManifest(started().handle)?.snapshot).toEqual({
      mode: "strict",
      expectedSha: SHA,
      dirty: false,
      retryable: true,
    });

    // A live tree ran whatever was on disk; the sha does not describe it.
    const live = started({ snapshotMode: "live" });
    expect(readManifest(live.handle)?.snapshot.mode).toBe("live");
    expect(readManifest(live.handle)?.snapshot.retryable).toBe(false);

    // Uncommitted changes were never committed, so there is nothing to replay.
    const dirty = started({ dirty: true });
    expect(readManifest(dirty.handle)?.snapshot.dirty).toBe(true);
    expect(readManifest(dirty.handle)?.snapshot.retryable).toBe(false);
  });

  it("collapses to the working no-op when the catalog cannot be created", () => {
    // A catalog root whose parent is a FILE: `mkdir -p` cannot succeed, which
    // stands in for every no-writable-state-root case. History is never a gate,
    // so this is a run without a record — not a throw, and not a null a caller
    // has to branch on.
    const blocker = join(tmpCatalog(), "not-a-directory");
    writeFileSync(blocker, "");
    const history = openHistory(join(blocker, "runs"));

    expect(history.runId).toBeNull();
    expect(history.fenced).toBe(false);
    expect(() => {
      history.roster([NODE]);
      history.phase("lanes");
      history.lane("x86_64-linux", "leased", "builder-1");
      history.nodeStatus(NODE, "running", running);
      history.log(NODE, "bytes nobody will keep\n");
      history.logFinalized(NODE, true, null);
      history.resetNode(NODE, "a retry");
      history.postingDebt([{ context: "ci/e2e", lastError: "503", attempts: 3 }]);
      history.finalize(verdict());
      history.close();
    }).not.toThrow();
  });
});

describe("allocating attempts", () => {
  it("gives a node that runs and passes attempt 1, holding the bytes it wrote", () => {
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "compiling…\n");
    history.log(NODE, "ok\n");
    history.nodeStatus(NODE, "ok", passed);
    history.logFinalized(NODE, true, null);

    expect(attemptsFor(handle, NODE)).toEqual([1]);
    expect(logText(handle, NODE, 1)).toBe("compiling…\nok\n");

    const record = readAttemptRecord(handle, NODE, 1);
    expect(record?.attempt).toBe(1);
    expect(record?.status).toBe("ok");
    expect(record?.exitCode).toBe(0);
    expect(record?.placement).toEqual({
      platform: "x86_64-linux",
      host: "builder-1",
    });
    // BYTES, not characters: a resuming reader seeks by this number.
    expect(record?.logBytes).toBe(Buffer.byteLength("compiling…\nok\n"));

    expect(kinds(handle)).toEqual([
      "registered",
      "attempt_started",
      "node_status",
      "node_status",
      "log_finalized",
    ]);
  });

  it("seals the open attempt on a reset, so the next bytes land on a NEW ordinal", () => {
    // The property the whole allocator exists for: a retry cannot write over
    // the failure somebody is reading.
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "first go\n");
    history.resetNode(NODE, "the lane re-sent its snapshot");
    history.log(NODE, "second go\n");

    expect(attemptsFor(handle, NODE)).toEqual([1, 2]);
    expect(logText(handle, NODE, 1)).toBe("first go\n");
    expect(logText(handle, NODE, 2)).toBe("second go\n");

    // Attempt 1 is closed and read-only; nothing that follows can name it.
    expect(readAttemptRecord(handle, NODE, 1)?.endedAt).toBe(T0);
    expect(logMode(handle, NODE, 1)).toBe(0o444);
    // A reset is not a completion, and it says so.
    expect(readAttemptRecord(handle, NODE, 1)?.logComplete).toBe(false);
    expect(readAttemptRecord(handle, NODE, 1)?.logTruncationReason).toBe(
      "the lane re-sent its snapshot",
    );
    // Attempt 2 is still open — a reset supplies neither half of the barrier.
    expect(readAttemptRecord(handle, NODE, 2)?.endedAt).toBeNull();
  });

  it("records a failure and its retry as two attempts with their own outcomes", () => {
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "boom\n");
    history.nodeStatus(NODE, "failed", {
      exitCode: 137,
      durationMs: 900,
      host: "builder-1",
    });
    history.resetNode(NODE, "rerun requested");

    history.nodeStatus(NODE, "running", { ...running, host: "builder-2" });
    history.log(NODE, "fine this time\n");
    history.nodeStatus(NODE, "ok", { ...passed, host: "builder-2" });
    history.logFinalized(NODE, true, null);

    expect(attemptsFor(handle, NODE)).toEqual([1, 2]);

    const first = readAttemptRecord(handle, NODE, 1);
    expect(first?.status).toBe("failed");
    expect(first?.exitCode).toBe(137);
    // The shell's `128 + N` reading, made where the exit code is.
    expect(first?.signal).toBe("SIGKILL");
    expect(first?.placement.host).toBe("builder-1");
    expect(logText(handle, NODE, 1)).toBe("boom\n");

    const second = readAttemptRecord(handle, NODE, 2);
    expect(second?.status).toBe("ok");
    expect(second?.exitCode).toBe(0);
    expect(second?.signal).toBeNull();
    expect(second?.placement.host).toBe("builder-2");
    expect(second?.logComplete).toBe(true);
    expect(logText(handle, NODE, 2)).toBe("fine this time\n");
  });

  it("opens attempt 1 lazily for output that arrives before any status", () => {
    // The provisioning narration into `_ci-setup@<platform>` is exactly this:
    // bytes nobody else will ever write down, arriving before the node has a
    // status to hang them on.
    const { history, handle } = started();

    history.log(SETUP, "claiming a lane…\n");
    history.log(SETUP, "leased builder-1\n");

    expect(attemptsFor(handle, SETUP)).toEqual([1]);
    expect(logText(handle, SETUP, 1)).toBe("claiming a lane…\nleased builder-1\n");
    // The placement is the platform the id names; no host is known yet.
    expect(readAttemptRecord(handle, SETUP, 1)?.placement).toEqual({
      platform: "x86_64-linux",
      host: null,
    });
    expect(kinds(handle)).toEqual(["registered", "attempt_started"]);
  });

  it("gives a node that never ran an attempt anyway, so its outcome has somewhere to hang", () => {
    const { history, handle } = started();

    // `pending` is not work starting, so it allocates nothing.
    history.nodeStatus(NODE, "pending", { exitCode: null, durationMs: null, host: null });
    expect(attemptsFor(handle, NODE)).toEqual([]);

    // `skipped` is a terminal outcome with no run behind it — the routine case
    // for a node whose dependency failed.
    history.nodeStatus(NODE, "skipped", { exitCode: null, durationMs: null, host: null });
    expect(attemptsFor(handle, NODE)).toEqual([1]);

    history.finalize(verdict({ outcome: "failed" }));
    const record = readAttemptRecord(handle, NODE, 1);
    expect(record?.status).toBe("skipped");
    expect(record?.exitCode).toBeNull();
    expect(record?.logBytes).toBe(0);
  });
});

describe("the log barrier", () => {
  it("does not seal on a terminal status alone — later bytes still land in the same attempt", () => {
    // `_ci-setup` reaches `ok` when provisioning finishes and then keeps being
    // narrated into for the rest of the run (lane deaths, operator cancels).
    // Sealing on the status would freeze that log half-written.
    const { history, handle } = started();

    history.nodeStatus(SETUP, "running", running);
    history.log(SETUP, "provisioning\n");
    history.nodeStatus(SETUP, "ok", passed);

    // Still open: one half of the barrier has arrived.
    expect(readAttemptRecord(handle, SETUP, 1)?.endedAt).toBeNull();
    expect(logMode(handle, SETUP, 1)).not.toBe(0o444);

    history.log(SETUP, "lane died: link dropped\n");
    expect(logText(handle, SETUP, 1)).toBe(
      "provisioning\nlane died: link dropped\n",
    );
    expect(attemptsFor(handle, SETUP)).toEqual([1]);
  });

  it("seals once the log has had its last word, and makes the evidence read-only", () => {
    const { history, handle } = started();

    history.nodeStatus(SETUP, "running", running);
    history.log(SETUP, "provisioning\n");
    history.nodeStatus(SETUP, "ok", passed);
    history.logFinalized(SETUP, true, null);

    const record = readAttemptRecord(handle, SETUP, 1);
    expect(record?.endedAt).toBe(T0);
    expect(record?.status).toBe("ok");
    expect(record?.logComplete).toBe(true);
    expect(record?.logTruncationReason).toBeNull();
    expect(record?.logBytes).toBe(Buffer.byteLength("provisioning\n"));
    expect(logMode(handle, SETUP, 1)).toBe(0o444);
  });

  it("seals the same way when the log's last word arrives BEFORE the status", () => {
    // The recipe-node order: the lane's `end` frame is what releases the
    // verdict, so the log lands first. Both orders are real; both must seal.
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "tests passed\n");
    history.logFinalized(NODE, true, null);

    // Half the barrier: no outcome yet, so nothing is sealed.
    expect(readAttemptRecord(handle, NODE, 1)?.endedAt).toBeNull();

    history.nodeStatus(NODE, "ok", passed);

    const record = readAttemptRecord(handle, NODE, 1);
    expect(record?.endedAt).toBe(T0);
    expect(record?.status).toBe("ok");
    expect(record?.exitCode).toBe(0);
    expect(record?.logComplete).toBe(true);
    expect(logMode(handle, NODE, 1)).toBe(0o444);
  });

  it("keeps the FIRST word about a log, so a stamped-short log is never upgraded", () => {
    // The truncation notice and the lane's own `end` frame both arrive for one
    // attempt and they disagree BY DESIGN — the notice is written precisely
    // because the `end` never came. If the second word won, the end-of-run
    // sweep would dress a truncated log in a completion frame.
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "half a line");
    history.logFinalized(NODE, false, "truncated: the lane went silent");
    history.logFinalized(NODE, true, null);
    history.nodeStatus(NODE, "failed", { exitCode: 1, durationMs: 5, host: "builder-1" });

    const record = readAttemptRecord(handle, NODE, 1);
    expect(record?.status).toBe("failed");
    expect(record?.logComplete).toBe(false);
    expect(record?.logTruncationReason).toBe("truncated: the lane went silent");
  });

  it("seals FAIL-CLOSED when nobody ever said the log was finished", () => {
    // The one outcome this adapter must never produce is a short log wearing a
    // completion frame, so silence reads as incomplete — with a reason.
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "output that stops mid-\n");
    history.finalize(verdict({ outcome: "incomplete" }));

    const record = readAttemptRecord(handle, NODE, 1);
    expect(record?.endedAt).toBe(T0);
    expect(record?.logComplete).toBe(false);
    expect(record?.logTruncationReason).not.toBeNull();
    expect(record?.logTruncationReason).toBe(
      "the run ended before this node's output was complete",
    );
    // No attempt is left claiming to be running behind the run's terminal line.
    expect(logMode(handle, NODE, 1)).toBe(0o444);
  });

  it("amends the sidecar when the log's last word arrives after the seal", () => {
    // The status led, the run ended before the log did, and the drain's stamp
    // turns up afterwards. The record is a projection: correcting it costs
    // nothing, and leaving it saying "nobody said" when somebody did would be a
    // standing lie about complete evidence.
    const { history, handle } = started();

    history.nodeStatus(SETUP, "running", running);
    history.log(SETUP, "provisioning\n");
    history.nodeStatus(SETUP, "ok", passed);
    history.finalize(verdict());
    expect(readAttemptRecord(handle, SETUP, 1)?.logComplete).toBe(false);

    history.logFinalized(SETUP, true, null);

    const record = readAttemptRecord(handle, SETUP, 1);
    expect(record?.logComplete).toBe(true);
    expect(record?.logTruncationReason).toBeNull();
    // The outcome the seal recorded survives the amendment.
    expect(record?.status).toBe("ok");
    expect(record?.exitCode).toBe(0);
    expect(record?.endedAt).toBe(T0);
    // And no second ordinal was invented to hold the correction.
    expect(attemptsFor(handle, SETUP)).toEqual([1]);
  });
});

describe("finalizing", () => {
  it("writes the verdict, seals what is open, and appends exactly ONE terminal", () => {
    // A `--linger` run re-finalizes on every drain. The verdict file is a
    // projection and may be rewritten; the journal is a history, and two
    // `finalized` lines would be two claims about how the run ended.
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "boom\n");
    history.nodeStatus(NODE, "failed", { exitCode: 1, durationMs: 3, host: "builder-1" });

    history.finalize(verdict({ outcome: "failed", failed: [NODE] }));
    history.finalize(
      verdict({
        outcome: "failed",
        failed: [NODE],
        finishedAt: T0 + 9_000,
        unposted: [{ context: "ci/e2e", lastError: "503 from GitHub", attempts: 4 }],
      }),
    );

    // The projection carries the LATEST drain…
    const written = readVerdict(handle);
    expect(written?.outcome).toBe("failed");
    expect(written?.failed).toEqual([NODE]);
    expect(written?.finishedAt).toBe(T0 + 9_000);
    expect(written?.unposted).toEqual([
      { context: "ci/e2e", lastError: "503 from GitHub", attempts: 4 },
    ]);

    // …and the history carries one terminal.
    expect(kinds(handle).filter((kind) => kind === "finalized")).toHaveLength(1);
    expect(kinds(handle).at(-1)).toBe("finalized");
    // The open attempt was sealed BEFORE the verdict, so a reader that trusts
    // the terminal line never finds a node still claiming to be running.
    expect(readAttemptRecord(handle, NODE, 1)?.status).toBe("failed");
    expect(readAttemptRecord(handle, NODE, 1)?.endedAt).toBe(T0);
  });

  it("records reporting debt without letting it touch the verdict", () => {
    const { history, handle } = started();
    history.postingDebt([
      { context: "ci/e2e", lastError: "503", attempts: 2 },
      { context: "ci/unit", lastError: "timeout", attempts: 5 },
    ]);
    history.finalize(verdict());

    expect(kinds(handle).filter((kind) => kind === "posting_debt")).toHaveLength(2);
    // Debt is not a verdict: statuses that did not land say nothing about
    // whether the run passed on its own merits.
    expect(readVerdict(handle)?.outcome).toBe("passed");
  });
});

describe("the ownership fence", () => {
  it("stops writing entirely once another process takes the epoch", () => {
    const { history, handle } = started();
    history.roster([NODE]);
    history.phase("lanes");
    const before = readJournal(handle).entries;
    expect(before.length).toBe(3);
    expect(history.fenced).toBe(false);

    takeOver(handle);

    // The next journal write is where a superseded coordinator finds out.
    history.roster([NODE, SETUP]);
    expect(history.fenced).toBe(true);

    // And from there it stops claiming to be the author of this run's history:
    // nothing further is appended, no attempt is allocated, no bytes are
    // mirrored. Two writers on one journal is the unrecoverable case.
    history.phase("no_lanes");
    history.lane("x86_64-linux", "leased", "builder-9");
    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "bytes from a coordinator nobody is listening to\n");
    history.logFinalized(NODE, true, null);
    history.resetNode(NODE, "a retry");
    history.postingDebt([{ context: "ci/e2e", lastError: "503", attempts: 1 }]);

    expect(readJournal(handle).entries).toEqual(before);
    expect(attemptsFor(handle, NODE)).toEqual([]);
  });

  it("publishes no verdict once fenced", () => {
    // The successor owns the terminal outcome now. A fabricated `finalized`
    // from the process that was replaced cannot be un-said.
    const { history, handle } = started();
    takeOver(handle);
    history.roster([NODE]);
    expect(history.fenced).toBe(true);

    history.finalize(verdict({ outcome: "passed" }));

    expect(readVerdict(handle)).toBeNull();
    expect(kinds(handle)).toEqual(["registered"]);
  });
});
