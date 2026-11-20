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
import { readAttention } from "@odu/run-history/query";
import {
  openRunHistory,
  type RunHistory,
  type RunHistoryInit,
} from "./history";

const T0 = 1_700_000_000_000;
const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const NODE = "ci::e2e@x86_64-linux";
const SETUP = "_ci-setup@x86_64-linux";

const dirs: string[] = [];
const opened: RunHistory[] = [];

afterEach(() => {
  for (const history of opened.splice(0)) history.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
    hostPins: [],
    hostsFile: "",
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

function handleOf(history: RunHistory, root: string): RunHandle {
  const runId = history.runId;
  if (runId === null) throw new Error("history did not register");
  return handleFor(runId, { root });
}

function started(over: Partial<RunHistoryInit> = {}): {
  root: string;
  history: RunHistory;
  handle: RunHandle;
} {
  const root = tmpCatalog();
  const history = openHistory(root, over);
  return { root, history, handle: handleOf(history, root) };
}

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

    const manifest = readManifest(handle);
    expect(manifest?.runId).toBe(handle.runId);
    expect(manifest?.repo).toBe("juspay/odu");
    expect(manifest?.sha).toBe(SHA);
    expect(manifest?.seq).toBe(7);
    expect(manifest?.pipeline).toBe("ci");
    expect(manifest?.repoRoot).toBe("/checkouts/odu");
    expect(manifest?.createdAt).toBe(T0);
    expect(manifest?.scope).toEqual({
      selectors: ["e2e"],
      platforms: [],
      noDeps: false,
    });
    expect(manifest?.build.oduVersion).toBe("0.1.0");
    expect(manifest?.parentRunId).toBeNull();
    expect(manifest?.requestId).toBeNull();

    expect(manifest?.registeredBy.epoch).toBe(1);
    expect(manifest?.registeredBy.endpoint).toBe("/checkouts/odu/.ci/odu.sock");

    const journal = readJournal(handle);
    expect(journal.unreadable).toBe(0);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]?.seq).toBe(1);
    expect(journal.entries[0]?.event).toEqual({
      kind: "registered",
      scope: { selectors: ["e2e"], platforms: [], noDeps: false },
    });

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

  it("records WHO started the run, and omits the field when nobody said", () => {
    expect(readManifest(started({ actor: "srid" }).handle)?.actor).toBe("srid");
    expect(readManifest(started({ actor: "@local" }).handle)?.actor).toBe("@local");
    expect(readManifest(started().handle)?.actor).toBeUndefined();
  });

  it("mints a run id, and publishes under an explicit one verbatim", () => {
    const minted = started().history.runId;
    expect(minted).not.toBeNull();
    expect(isRunId(minted ?? "")).toBe(true);

    const { history, handle } = started({ runId: "0000000a-0001" });
    expect(history.runId).toBe("0000000a-0001");
    expect(readManifest(handle)?.runId).toBe("0000000a-0001");
  });

  it("marks only a clean strict snapshot retryable", () => {
    expect(readManifest(started().handle)?.snapshot).toEqual({
      mode: "strict",
      expectedSha: SHA,
      dirty: false,
      retryable: true,
    });

    const live = started({ snapshotMode: "live" });
    expect(readManifest(live.handle)?.snapshot.mode).toBe("live");
    expect(readManifest(live.handle)?.snapshot.retryable).toBe(false);

    const dirty = started({ dirty: true });
    expect(readManifest(dirty.handle)?.snapshot.dirty).toBe(true);
    expect(readManifest(dirty.handle)?.snapshot.retryable).toBe(false);
  });

  it("collapses to the working no-op when the catalog cannot be created", () => {
    const blocker = join(tmpCatalog(), "not-a-directory");
    writeFileSync(blocker, "");
    const history = openHistory(join(blocker, "runs"));

    expect(history.runId).toBeNull();
    expect(history.fenced).toBe(false);
    expect(() => {
      history.roster([NODE]);
      history.phase("lanes");
      history.lane("x86_64-linux", "leased", "builder-1", [], "/etc/odu/hosts.json");
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
    expect(record?.logBytes).toBe(Buffer.byteLength("compiling…\nok\n"));

    expect(kinds(handle)).toEqual([
      "registered",
      "attempt_started",
      "node_status",
      "node_status",
      "log_finalized",
    ]);
  });

  it("replaces a RE-SYNC in place rather than allocating a ghost attempt", () => {
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.replaceLog(NODE, "the tail, re-sent\n");
    history.log(NODE, " and then more\n");

    expect(attemptsFor(handle, NODE)).toEqual([1]);
    expect(logText(handle, NODE, 1)).toBe("the tail, re-sent\n and then more\n");
  });

  it("does not let a re-sent TAIL delete the beginning of a log", async () => {
    const { history, handle } = started();
    history.nodeStatus(NODE, "running", running);

    const early = Array.from(
      { length: 2_000 },
      (_, i) => `line ${String(i).padStart(6, "0")}\n`,
    ).join("");
    history.log(NODE, early);
    const resent = early.slice(early.length - 4_000);
    history.replaceLog(NODE, resent);
    history.log(NODE, "and then the rest\n");

    const written = logText(handle, NODE, 1) ?? "";
    expect(written.startsWith("line 000000\n")).toBe(true);
    expect(written.split("\n").filter((l) => l.startsWith("line ")).length).toBe(2_000);
    expect(written.endsWith("and then the rest\n")).toBe(true);
    expect(written).toBe(`${early}and then the rest\n`);
  });

  it("catches up when the re-sent tail continues where the file stops", () => {
    const { history, handle } = started();
    history.nodeStatus(NODE, "running", running);

    history.log(NODE, "aaa bbb ");
    history.replaceLog(NODE, "bbb ccc ddd");

    expect(logText(handle, NODE, 1)).toBe("aaa bbb ccc ddd");
  });

  it("says so when a re-sent tail does not meet the file at all", () => {
    const { history, handle } = started();
    history.nodeStatus(NODE, "running", running);

    history.log(NODE, "the beginning\n");
    history.replaceLog(NODE, "something else entirely\n");

    const written = logText(handle, NODE, 1) ?? "";
    expect(written).toContain("[odu] log truncated");
    expect(written).toContain("does not continue what precedes it");
    expect(written.endsWith("something else entirely\n")).toBe(true);
  });

  it("seals the open attempt on a RESTART, so the next bytes land on a NEW ordinal", () => {
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "first go\n");
    history.resetNode(NODE, "the lane running this node died");
    history.log(NODE, "second go\n");

    expect(attemptsFor(handle, NODE)).toEqual([1, 2]);
    expect(logText(handle, NODE, 1)).toBe("first go\n");
    expect(logText(handle, NODE, 2)).toBe("second go\n");

    expect(readAttemptRecord(handle, NODE, 1)?.endedAt).toBe(T0);
    expect(logMode(handle, NODE, 1)).toBe(0o444);
    expect(readAttemptRecord(handle, NODE, 1)?.logComplete).toBe(false);
    expect(readAttemptRecord(handle, NODE, 1)?.logTruncationReason).toBe(
      "the lane running this node died",
    );
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
    const { history, handle } = started();

    history.log(SETUP, "claiming a lane…\n");
    history.log(SETUP, "leased builder-1\n");

    expect(attemptsFor(handle, SETUP)).toEqual([1]);
    expect(logText(handle, SETUP, 1)).toBe("claiming a lane…\nleased builder-1\n");
    expect(readAttemptRecord(handle, SETUP, 1)?.placement).toEqual({
      platform: "x86_64-linux",
      host: null,
    });
    expect(kinds(handle)).toEqual(["registered", "attempt_started"]);
  });

  it("gives a node that never ran an attempt anyway, so its outcome has somewhere to hang", () => {
    const { history, handle } = started();

    history.nodeStatus(NODE, "pending", { exitCode: null, durationMs: null, host: null });
    expect(attemptsFor(handle, NODE)).toEqual([]);

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
    const { history, handle } = started();

    history.nodeStatus(SETUP, "running", running);
    history.log(SETUP, "provisioning\n");
    history.nodeStatus(SETUP, "ok", passed);

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
    const { history, handle } = started();

    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "tests passed\n");
    history.logFinalized(NODE, true, null);

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
    expect(logMode(handle, NODE, 1)).toBe(0o444);
  });

  it("amends the sidecar when the log's last word arrives after the seal", () => {
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
    expect(record?.status).toBe("ok");
    expect(record?.exitCode).toBe(0);
    expect(record?.endedAt).toBe(T0);
    expect(attemptsFor(handle, SETUP)).toEqual([1]);
  });
});

describe("recording who asked for a retry", () => {
  it("writes the request id against the run, and says it did", () => {
    const { history, handle } = started();

    expect(
      history.retryAccepted({
        requestId: "agent.fix-1",
        inputDigest: "abc1234",
        roots: [NODE],
        resetDependants: [],
      }),
    ).toBe(true);

    const recorded = readJournal(handle).entries.at(-1)?.event;
    expect(recorded).toEqual({
      kind: "retry_accepted",
      requestId: "agent.fix-1",
      effectiveRunId: handle.runId,
      roots: [NODE],
      resetDependants: [],
      inputDigest: "abc1234",
    });
  });

  it("reports FALSE once fenced, so no caller promises a line that was refused", () => {
    const { history, handle } = started();
    takeOver(handle);

    expect(
      history.retryAccepted({
        requestId: "agent.fix-2",
        inputDigest: "abc1234",
        roots: [NODE],
        resetDependants: [],
      }),
    ).toBe(false);
    expect(kinds(handle)).not.toContain("retry_accepted");
  });
});

describe("recording what a node warmed", () => {
  it("writes every field of the push, the duration included", () => {
    const { history, handle } = started();

    history.pushed({
      node: NODE,
      bucket: "kolu-r2",
      paths: 12,
      present: 4,
      bytes: 4_194_304,
      durationMs: 2_500,
    });

    expect(readJournal(handle).entries.at(-1)?.event).toEqual({
      kind: "pushed",
      node: NODE,
      bucket: "kolu-r2",
      paths: 12,
      present: 4,
      bytes: 4_194_304,
      durationMs: 2_500,
    });
  });

  it("writes the push's BEGINNING and its failure, which a red status cannot say", () => {
    const { history, handle } = started();

    history.pushing({ node: NODE, bucket: "kolu-r2" });
    history.pushFailed({
      node: NODE,
      bucket: "kolu-r2",
      message: "odu: 1 path could not be pushed to kolu-r2 — 413 too large",
      durationMs: 900,
    });

    const written = readJournal(handle).entries.slice(-2).map((entry) => entry.event);
    expect(written).toEqual([
      { kind: "pushing", node: NODE, bucket: "kolu-r2" },
      {
        kind: "push_failed",
        node: NODE,
        bucket: "kolu-r2",
        message: "odu: 1 path could not be pushed to kolu-r2 — 413 too large",
        durationMs: 900,
      },
    ]);
  });
});

describe("settle → retry → settle, through the real writer and the real reader", () => {
  it("a run that finished, resumed, and finished again is settled again", () => {
    const { history, handle } = started();

    history.roster([NODE]);
    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "boom\n");
    history.logFinalized(NODE, true, null);
    history.nodeStatus(NODE, "failed", { exitCode: 1, durationMs: 3, host: "builder-1" });
    history.finalize(verdict({ outcome: "failed", failed: [NODE] }));

    const settled = readAttention(handle, {}, T0);
    expect(settled.settled).toBe(true);
    expect(settled.outcome).toBe("failed");

    history.resetNode(NODE, "rerun requested");
    history.nodeStatus(NODE, "running", running);

    const during = readAttention(handle, {}, T0 + 1);
    expect(during.settled).toBe(false);
    expect(during.outcome).toBeNull();

    history.log(NODE, "ok\n");
    history.logFinalized(NODE, true, null);
    history.nodeStatus(NODE, "ok", { exitCode: 0, durationMs: 4, host: "builder-1" });
    history.finalize(verdict({ outcome: "passed" }));

    const again = readAttention(handle, {}, T0 + 2);
    expect(again.settled).toBe(true);
    expect(again.outcome).toBe("passed");

    expect(kinds(handle).filter((kind) => kind === "finalized")).toHaveLength(2);
    expect(kinds(handle).at(-1)).toBe("finalized");
  });

  it("re-finalizing without any work in between still appends nothing", () => {
    const { history, handle } = started();

    history.nodeStatus(NODE, "failed", { exitCode: 1, durationMs: 3, host: "builder-1" });
    history.finalize(verdict({ outcome: "failed", failed: [NODE] }));
    history.finalize(verdict({ outcome: "failed", failed: [NODE] }));
    history.finalize(verdict({ outcome: "failed", failed: [NODE] }));

    expect(kinds(handle).filter((kind) => kind === "finalized")).toHaveLength(1);
    expect(readAttention(handle, {}, T0).settled).toBe(true);
  });
});

describe("finalizing", () => {
  it("writes the verdict, seals what is open, and appends exactly ONE terminal", () => {
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

    const written = readVerdict(handle);
    expect(written?.outcome).toBe("failed");
    expect(written?.failed).toEqual([NODE]);
    expect(written?.finishedAt).toBe(T0 + 9_000);
    expect(written?.unposted).toEqual([
      { context: "ci/e2e", lastError: "503 from GitHub", attempts: 4 },
    ]);

    expect(kinds(handle).filter((kind) => kind === "finalized")).toHaveLength(1);
    expect(kinds(handle).at(-1)).toBe("finalized");
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

    history.roster([NODE, SETUP]);
    expect(history.fenced).toBe(true);

    history.phase("no_lanes");
    history.lane("x86_64-linux", "leased", "builder-9", [], "/etc/odu/hosts.json");
    history.nodeStatus(NODE, "running", running);
    history.log(NODE, "bytes from a coordinator nobody is listening to\n");
    history.logFinalized(NODE, true, null);
    history.resetNode(NODE, "a retry");
    history.postingDebt([{ context: "ci/e2e", lastError: "503", attempts: 1 }]);

    expect(readJournal(handle).entries).toEqual(before);
    expect(attemptsFor(handle, NODE)).toEqual([]);
  });

  it("publishes no verdict once fenced", () => {
    const { history, handle } = started();
    takeOver(handle);
    history.roster([NODE]);
    expect(history.fenced).toBe(true);

    history.finalize(verdict({ outcome: "passed" }));

    expect(readVerdict(handle)).toBeNull();
    expect(kinds(handle)).toEqual(["registered"]);
  });
});

it("fills log-first placement without truncating logs or changing the attempt ordinal", () => {
  const { history, handle } = started();
  history.log(NODE, "early output\n");
  history.nodeStatus(NODE, "running", { exitCode: null, durationMs: null, host: "burst-two" });
  expect(readAttemptRecord(handle, NODE, 1)?.placement.host).toBe("burst-two");
  expect(readAttemptLog(handle, NODE, 1)?.text).toBe("early output\n");
  history.nodeStatus(NODE, "failed", { exitCode: 1, durationMs: 5, host: "burst-two" });
  history.logFinalized(NODE, true, null);
  expect(readAttention(handle, {}).unresolved_failures[0]?.placement.host).toBe("burst-two");
  history.resetNode(NODE, "retry");
  history.replaceLog(NODE, "new worker\n", "burst-three");
  history.nodeStatus(NODE, "ok", { exitCode: 0, durationMs: 3, host: "burst-three" });
  history.logFinalized(NODE, true, null);
  expect(readAttemptRecord(handle, NODE, 1)?.placement.host).toBe("burst-two");
  expect(readAttemptRecord(handle, NODE, 2)?.placement.host).toBe("burst-three");
  expect(readAttemptLog(handle, NODE, 1)?.text).toBe("early output\n");
});
