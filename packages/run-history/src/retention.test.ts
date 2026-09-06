/**
 * What retention is allowed to throw away, and what it must leave behind.
 *
 * Two rules, and both are about the run whose evidence is worth MOST. A run
 * with no verdict never finalized — its journal and its logs are the only
 * account of how it ended — so age is not a licence to delete it, whether its
 * owner is still breathing or provably gone. And expiry is a TOMBSTONE, not an
 * `rm -rf`: an agent holding a month-old run id must be told the run existed
 * and what it ended as, which is a different answer from the one a typo gets.
 *
 * The clock is injected on every call here (`now` + `retentionMs`, with run ids
 * minted at controlled instants), because a retention test that waits for a
 * real window to pass is a test nobody runs.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { mintRunId } from "./ids";
import { RUN_FILES } from "./paths";
import type { Placement, RunManifest, RunVerdict } from "./schema";
import type { OwnershipToken } from "./owner";
import { pruneCatalog } from "./retention";
import {
  appendAttemptLog,
  appendEvent,
  readExpiry,
  readJournal,
  readManifest,
  readVerdict,
  registerRun,
  type RunHandle,
  startAttempt,
  writeVerdict,
} from "./store";

/** The instant every case below prunes AT. */
const NOW = 1_700_000_000_000;
const WINDOW = 60_000;
const OLD = NOW - 30 * WINDOW;
const NODE = "ci::unit@x86_64-linux";
const LINUX: Placement = { platform: "x86_64-linux", host: "builder-1" };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function catalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-retention-"));
  dirs.push(dir);
  return dir;
}

interface Registered {
  handle: RunHandle;
  token: OwnershipToken;
  runId: string;
}

/** A run that started at `startedAt` (the id carries the instant retention
 *  selects on) and left real evidence behind. */
function register(
  root: string,
  startedAt: number,
  over: Partial<Pick<RunManifest, "seq">> = {},
): Registered {
  const runId = mintRunId(startedAt);
  const result = registerRun(
    {
      runId,
      repo: "juspay/odu",
      sha: "26d2c2dabcdef0123456789012345678901234ab",
      seq: over.seq ?? 1,
      pipeline: "ci",
      repoRoot: "/checkouts/odu",
      createdAt: startedAt,
      scope: { selectors: [], platforms: [], noDeps: false },
      snapshot: {
        mode: "strict",
        expectedSha: "26d2c2dabcdef0123456789012345678901234ab",
        dirty: false,
        retryable: true,
      },
      build: { oduVersion: "test", self: null, runnerFlake: null },
      parentRunId: null,
      requestId: null,
    },
    // The owner's heartbeat is stamped with this clock: a run registered just
    // before `NOW` still looks alive when the prune asks.
    { root, endpoint: null, now: NOW - 1_000 },
  );
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.kind}`);
  appendEvent(result.handle, result.token, { kind: "roster", order: [NODE] }, startedAt);
  startAttempt(result.handle, result.token, {
    node: NODE,
    attempt: 1,
    placement: LINUX,
    startedAt,
  });
  appendAttemptLog(result.handle, NODE, 1, "the only account of what happened\n");
  return { handle: result.handle, token: result.token, runId };
}

function finalize(run: Registered, outcome: RunVerdict["outcome"]): void {
  appendEvent(run.handle, run.token, { kind: "finalized", outcome });
  writeVerdict(run.handle, run.token, {
    runId: run.runId,
    outcome,
    startedAt: 1_000,
    finishedAt: 2_000,
    failed: outcome === "failed" ? [NODE] : [],
    errored: [],
    cancelled: [],
    unposted: [],
  });
}

/** Stand the coordinator down for real: republish the owner as one from a
 *  machine that is gone — a stale heartbeat AND a host whose pids we cannot
 *  check, which is the only evidence the fence accepts as death. The state a
 *  finished run is in once the process that made it has exited. */
function coordinatorGone(run: Registered): void {
  writeFileSync(
    join(run.handle.dir, RUN_FILES.owner),
    `${JSON.stringify({
      epoch: 1,
      pid: 4242,
      host: "a-laptop-that-left",
      claimedAt: OLD,
      heartbeatAt: OLD,
      endpoint: null,
    })}\n`,
  );
}

const prune = (root: string, over: { dryRun?: boolean } = {}): ReturnType<typeof pruneCatalog> =>
  pruneCatalog({ root, now: NOW, retentionMs: WINDOW, ...over });

describe("a finished run older than the window", () => {
  it("keeps its manifest and verdict, and drops the journal and the attempts", () => {
    const root = catalog();
    const run = register(root, OLD);
    finalize(run, "failed");
    coordinatorGone(run);
    expect(readJournal(run.handle).entries.length).toBeGreaterThan(0);

    const report = prune(root);
    expect(report.expired).toEqual([run.runId]);
    expect(report.kept).toEqual([]);

    // A tombstone, not a deletion: the run still answers, and still says what
    // it ended as.
    const expiry = readExpiry(run.handle);
    expect(expiry?.runId).toBe(run.runId);
    expect(expiry?.expiredAt).toBe(NOW);
    expect(expiry?.outcome).toBe("failed");
    expect(readManifest(run.handle)?.runId).toBe(run.runId);
    expect(readVerdict(run.handle)?.outcome).toBe("failed");

    // The bulk is gone.
    expect(readJournal(run.handle).entries).toEqual([]);
    expect(existsSync(join(run.handle.dir, RUN_FILES.events))).toBe(false);
    expect(existsSync(join(run.handle.dir, RUN_FILES.attempts))).toBe(false);
  });
});

describe("a run inside the window", () => {
  it("is untouched, however finished it is", () => {
    const root = catalog();
    const run = register(root, NOW - 1_000);
    finalize(run, "passed");
    coordinatorGone(run);

    const report = prune(root);
    expect(report.expired).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(readExpiry(run.handle)).toBeNull();
    expect(readJournal(run.handle).entries.length).toBeGreaterThan(0);
    expect(existsSync(join(run.handle.dir, RUN_FILES.attempts))).toBe(true);
  });
});

describe("a run with no verdict is kept, whatever its age", () => {
  it("says `still running` when its owner is alive", () => {
    const root = catalog();
    const run = register(root, OLD); // ancient, but never finalized

    const report = prune(root);
    expect(report.expired).toEqual([]);
    expect(report.kept).toEqual([{ runId: run.runId, reason: "still running" }]);
    expect(readExpiry(run.handle)).toBeNull();
    expect(readJournal(run.handle).entries.length).toBeGreaterThan(0);
  });

  it("keeps it just as hard when the owner is provably gone", () => {
    // The case the rule exists for: nobody will ever write a verdict for this
    // run, so its journal and logs are the ONLY account of how it ended.
    const root = catalog();
    const run = register(root, OLD);
    coordinatorGone(run);

    const report = prune(root);
    expect(report.expired).toEqual([]);
    expect(report.kept).toHaveLength(1);
    expect(report.kept[0]?.runId).toBe(run.runId);
    expect(report.kept[0]?.reason).toContain("never finalized");
    expect(readExpiry(run.handle)).toBeNull();
    expect(existsSync(join(run.handle.dir, RUN_FILES.attempts))).toBe(true);
  });
});

describe("a finished run whose owner is still alive", () => {
  it("keeps its evidence — a janitor never deletes what somebody is writing", () => {
    // Retention holds no ownership epoch, so it cannot fence a live writer; the
    // guard is the liveness question instead. A coordinator that finalized and
    // is still holding the run would otherwise find its journal deleted out
    // from under it and keep appending to a history that restarts mid-way.
    const root = catalog();
    const run = register(root, OLD);
    finalize(run, "passed");

    const report = prune(root);
    expect(report.expired).toEqual([]);
    expect(report.kept).toEqual([
      { runId: run.runId, reason: "still owned by a live coordinator" },
    ]);
    expect(readExpiry(run.handle)).toBeNull();
    expect(readJournal(run.handle).entries.length).toBeGreaterThan(0);
    expect(existsSync(join(run.handle.dir, RUN_FILES.attempts))).toBe(true);
  });
});

describe("dryRun", () => {
  it("reports exactly what a real pass would, and changes nothing", () => {
    const root = catalog();
    const expiring = register(root, OLD);
    finalize(expiring, "passed");
    coordinatorGone(expiring);
    const unfinished = register(root, OLD - 1_000);

    const dry = prune(root, { dryRun: true });
    expect(dry.expired).toEqual([expiring.runId]);
    expect(dry.kept.map((k) => k.runId)).toEqual([unfinished.runId]);
    // Nothing moved.
    expect(readExpiry(expiring.handle)).toBeNull();
    expect(readJournal(expiring.handle).entries.length).toBeGreaterThan(0);
    expect(existsSync(join(expiring.handle.dir, RUN_FILES.attempts))).toBe(true);

    const wet = prune(root);
    expect(wet.expired).toEqual(dry.expired);
    expect(wet.kept).toEqual(dry.kept);
    expect(readExpiry(expiring.handle)).not.toBeNull();
  });
});

describe("running it twice", () => {
  it("is idempotent — the second pass reports nothing new and rewrites no timestamp", () => {
    const root = catalog();
    const run = register(root, OLD);
    finalize(run, "passed");
    coordinatorGone(run);

    const first = prune(root);
    expect(first.expired).toEqual([run.runId]);

    const second = pruneCatalog({ root, now: NOW + 1_000, retentionMs: WINDOW });
    expect(second.expired).toEqual([]);
    expect(second.kept).toEqual([]);
    // The instant a reader may already be quoting is not moved.
    expect(readExpiry(run.handle)?.expiredAt).toBe(NOW);
  });
});
