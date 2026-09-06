/**
 * The seam between what a caller TYPED and the run it meant — and the bounded
 * wait that decides when there is something worth reporting.
 *
 * Both halves fail quietly when they are wrong. A prefix that resolves to the
 * first match addresses somebody else's commit, and the caller finds out after
 * acting on it. A cursor kept across a finalized retry is a token for the
 * parent run, and resuming it against the child truthfully reports "nothing
 * new" about a run that has done everything — so a wrong-run cursor must be a
 * REFUSAL carrying a resync route, never a silent restart. And the wait must
 * come back `still_running` at its deadline rather than inventing a verdict:
 * "not yet" and "it passed" are different answers to the same question.
 *
 * These run against the real store on a temp catalog — the resolution rules are
 * about files on disk, and a stubbed store would not be testing them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { formatCursor, mintRunId } from "./ids";
import type { Placement, RunManifest } from "./schema";
import {
  appendAttemptLog,
  appendEvent,
  handleFor,
  type RunHandle,
  registerRun,
  startAttempt,
  writeVerdict,
} from "./store";
import type { OwnershipToken } from "./owner";
import { readAttention, resolveCursor, resolveRun, waitForAttention } from "./query";

const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const NODE = "ci::unit@x86_64-linux";
const LINUX: Placement = { platform: "x86_64-linux", host: "builder-1" };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A catalog of this test's own — never the developer's real one. */
function catalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-query-"));
  dirs.push(dir);
  return dir;
}

interface Registered {
  handle: RunHandle;
  token: OwnershipToken;
  runId: string;
}

function register(
  root: string,
  over: Partial<Pick<RunManifest, "runId" | "sha" | "seq" | "repoRoot">> = {},
): Registered {
  const runId = over.runId ?? mintRunId();
  const sha = over.sha ?? SHA;
  const result = registerRun(
    {
      runId,
      repo: "juspay/odu",
      sha,
      seq: over.seq ?? 1,
      pipeline: "ci",
      repoRoot: over.repoRoot ?? "/checkouts/odu",
      createdAt: 1_000,
      scope: { selectors: [], platforms: [], noDeps: false },
      snapshot: { mode: "strict", expectedSha: sha, dirty: false, retryable: true },
      build: { oduVersion: "test", self: null, runnerFlake: null },
      parentRunId: null,
      requestId: null,
    },
    { root, endpoint: null },
  );
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.kind}`);
  return { handle: result.handle, token: result.token, runId };
}

/** Drive one node to red, with its log written and sealed — the shape a
 *  bounded wait is meant to return on. */
function failOneNode(run: Registered, text: string): void {
  appendEvent(run.handle, run.token, { kind: "roster", order: [NODE] });
  appendEvent(run.handle, run.token, {
    kind: "attempt_started",
    node: NODE,
    attempt: 1,
    placement: LINUX,
  });
  startAttempt(run.handle, run.token, {
    node: NODE,
    attempt: 1,
    placement: LINUX,
    startedAt: 1_000,
  });
  appendAttemptLog(run.handle, NODE, 1, text);
  appendEvent(run.handle, run.token, {
    kind: "node_status",
    node: NODE,
    attempt: 1,
    status: "failed",
    exitCode: 1,
    durationMs: 12,
    placement: LINUX,
  });
  appendEvent(run.handle, run.token, {
    kind: "log_finalized",
    node: NODE,
    attempt: 1,
    bytes: text.length,
    complete: true,
    reason: null,
  });
}

describe("resolveRun", () => {
  it("resolves `latest` to the newest run in the catalog", () => {
    const root = catalog();
    register(root, { runId: mintRunId(1_700_000_000_000) });
    const newest = register(root, { runId: mintRunId(1_700_000_900_000) });
    const found = resolveRun("latest", { root });
    expect(found.ok).toBe(true);
    expect(found.ok && found.handle.runId).toBe(newest.runId);
  });

  it("refuses `latest` with a message when the catalog is empty", () => {
    const found = resolveRun("latest", { root: catalog() });
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.message).toContain("no runs in the catalog");
  });

  it("resolves an exact run id", () => {
    const root = catalog();
    const run = register(root);
    const found = resolveRun(run.runId, { root });
    expect(found.ok && found.handle.runId).toBe(run.runId);
  });

  it("resolves a unique prefix of a run id", () => {
    const root = catalog();
    const run = register(root, { runId: mintRunId(1_700_000_000_000) });
    const found = resolveRun(run.runId.slice(0, 10), { root });
    expect(found.ok && found.handle.runId).toBe(run.runId);
  });

  it("REFUSES an ambiguous prefix, naming how many it matched", () => {
    // Two runs started in the same millisecond share the id's time half, so a
    // prefix of it names both. Picking the first would address the wrong
    // commit's evidence, silently.
    const root = catalog();
    const at = 1_700_000_000_000;
    const a = register(root, { runId: mintRunId(at, () => 0.11) });
    const b = register(root, { runId: mintRunId(at, () => 0.87) });
    const prefix = a.runId.slice(0, 9);
    expect(b.runId.startsWith(prefix)).toBe(true);

    const found = resolveRun(prefix, { root });
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.message).toContain("matches 2 runs");
    expect(found.ok === false && found.message).toContain("give more of the id");
  });

  it("resolves a `<sha7>#<seq>` display ref", () => {
    const root = catalog();
    register(root, { runId: mintRunId(1_700_000_000_000), seq: 1 });
    const third = register(root, { runId: mintRunId(1_700_000_100_000), seq: 3 });
    const found = resolveRun("26d2c2d#3", { root });
    expect(found.ok && found.handle.runId).toBe(third.runId);
  });

  it("refuses a ref no run published, and points at the listing", () => {
    const root = catalog();
    register(root);
    const found = resolveRun("26d2c2d#9", { root });
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.message).toContain("26d2c2d#9");
    expect(found.ok === false && found.message).toContain("odu runs");
  });

  it("refuses junk with the three forms it accepts — a message, never a throw", () => {
    const root = catalog();
    for (const token of ["", "  ", "not a run!", "??", "/etc/passwd"]) {
      // Reaching the assertion at all is half the point: an unparseable token
      // comes back as a refusal, it does not throw past the caller.
      expect(resolveRun(token, { root }).ok).toBe(false);
    }
    const answer = resolveRun("not-a-run!", { root });
    expect(answer.ok === false && answer.message).toContain("is not a run");
  });

  it("refuses a well-formed id that names nothing", () => {
    const root = catalog();
    const found = resolveRun(mintRunId(1_700_000_000_000), { root });
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.message).toContain("no run");
  });
});

describe("resolveCursor", () => {
  it("resolves an absent cursor to null — a caller may start either way", () => {
    const root = catalog();
    const run = register(root);
    expect(resolveCursor(run.handle, undefined)).toEqual({ ok: true, cursor: null });
    expect(resolveCursor(run.handle, "   ")).toEqual({ ok: true, cursor: null });
  });

  it("passes a cursor this run issued", () => {
    const root = catalog();
    const run = register(root);
    appendEvent(run.handle, run.token, { kind: "phase", phase: "lanes" });
    const resolved = resolveCursor(run.handle, formatCursor({ runId: run.runId, seq: 1 }));
    expect(resolved).toEqual({ ok: true, cursor: { runId: run.runId, seq: 1 } });
  });

  it("REFUSES a cursor belonging to another run, with a resync for THIS one", () => {
    // The finalized-retry trap: the caller kept the parent's cursor. Resuming it
    // here would report "nothing new" about a run that has done everything.
    const root = catalog();
    const parent = register(root, { runId: mintRunId(1_700_000_000_000) });
    const child = register(root, { runId: mintRunId(1_700_000_100_000) });
    appendEvent(child.handle, child.token, { kind: "phase", phase: "lanes" });

    const resolved = resolveCursor(
      child.handle,
      formatCursor({ runId: parent.runId, seq: 1 }),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain(parent.runId);
    expect(resolved.message).toContain(child.runId);
    expect(resolved.resync).toBe(`odu wait --run ${child.runId}`);
  });

  it("REFUSES a cursor ahead of the journal rather than serving nothing", () => {
    const root = catalog();
    const run = register(root);
    appendEvent(run.handle, run.token, { kind: "phase", phase: "lanes" });
    const resolved = resolveCursor(run.handle, formatCursor({ runId: run.runId, seq: 99 }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain("ahead of");
    expect(resolved.resync).toContain(run.runId);
  });

  it("refuses a token this vocabulary never issued", () => {
    const root = catalog();
    const run = register(root);
    const resolved = resolveCursor(run.handle, "seq=4");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.resync).toContain(run.runId);
  });
});

describe("readAttention over a real run", () => {
  it("reflects the journal on disk and reads the attempt's log as the excerpt", () => {
    const root = catalog();
    const run = register(root);
    failOneNode(run, "step 1 ok\nstep 2 BOOM\n");

    const answer = readAttention(run.handle);
    expect(answer.run.id).toBe(run.runId);
    expect(answer.run.sha).toBe(SHA);
    expect(answer.run.sha7).toBe("26d2c2d");
    expect(answer.state).toBe("still_running");
    expect(answer.actionable).toBe(true);
    expect(answer.unresolved_failures).toHaveLength(1);
    const failure = answer.unresolved_failures[0];
    expect(failure?.node).toBe(NODE);
    expect(failure?.excerpt_source).toBe("attempt_log");
    expect(failure?.excerpt).toContain("BOOM");
    expect(failure?.log_key).toBe(`--run ${run.runId} --attempt 1 ${NODE}`);
    // The `registered` line the store wrote at registration is event 1.
    expect(answer.events[0]?.event.kind).toBe("registered");
    expect(answer.cursor).toBe(
      formatCursor({ runId: run.runId, seq: answer.events.length }),
    );
  });

  it("reports a settled run's verdict from the durable files", () => {
    const root = catalog();
    const run = register(root);
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "passed" });
    writeVerdict(run.handle, run.token, {
      runId: run.runId,
      outcome: "passed",
      startedAt: 1_000,
      finishedAt: 2_000,
      failed: [],
      errored: [],
      cancelled: [],
      unposted: [],
    });
    const answer = readAttention(run.handle);
    expect(answer.state).toBe("settled");
    expect(answer.passed).toBe(true);
  });

  it("says unknown_run for an id the catalog has never seen", () => {
    const root = catalog();
    const answer = readAttention(handleFor(mintRunId(1_700_000_000_000), { root }));
    expect(answer.state).toBe("unknown_run");
    expect(answer.passed).toBe(false);
  });
});

describe("waitForAttention", () => {
  it("returns at once for a run that has already settled", async () => {
    const root = catalog();
    const run = register(root);
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "failed" });

    const started = Date.now();
    const answer = await waitForAttention(run.handle, {
      deadlineMs: 2_000,
      pollMs: 10,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(answer.state).toBe("settled");
    expect(answer.passed).toBe(false);
  });

  it("returns still_running at the deadline for a run that is going nowhere", async () => {
    const root = catalog();
    const run = register(root);

    const started = Date.now();
    const answer = await waitForAttention(run.handle, {
      deadlineMs: 200,
      pollMs: 10,
    });
    // The deadline is a FACT, not an error, and it is neither half of a verdict.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(answer.state).toBe("still_running");
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("with `settle: true`, does NOT return on an actionable red that has not settled", async () => {
    const root = catalog();
    const run = register(root);
    failOneNode(run, "expected 1 to be 2\n");

    const started = Date.now();
    const answer = await waitForAttention(run.handle, {
      deadlineMs: 200,
      pollMs: 10,
      settle: true,
    });
    // It waited out the whole deadline despite having red to report…
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(answer.actionable).toBe(true);
    // …and still answered "not finished", not "failed".
    expect(answer.state).toBe("still_running");
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("without `settle`, returns as soon as the red log has had its last word", async () => {
    const root = catalog();
    const run = register(root);
    failOneNode(run, "expected 1 to be 2\n");

    const started = Date.now();
    const answer = await waitForAttention(run.handle, { deadlineMs: 2_000, pollMs: 10 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(answer.actionable).toBe(true);
    expect(answer.settled).toBe(false);
    expect(answer.unresolved_failures).toHaveLength(1);
  });
});
