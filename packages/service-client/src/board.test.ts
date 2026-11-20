import { describe, expect, it } from "bun:test";
import {
  boardOrder,
  boardTally,
  duration,
  isActive,
  isFailing,
  laneSpan,
  newestFirst,
  pushSpan,
  runElapsedMs,
  runStatus,
  scopeLabel,
  scopeSuffix,
  timelineTicks,
} from "./board";
import type { RunNode, RunRow } from "./surface";

function row(over: Partial<RunRow> & Pick<RunRow, "runId">): RunRow {
  return {
    repo: null,
    repoRoot: "/home/dev/kolu",
    branch: "master",
    sha: "0".repeat(40),
    dirty: false,
    seq: 1,
    pipeline: "ci",
    createdAt: 0,
    finishedAt: null,
    state: "settled",
    settled: true,
    passed: true,
    outcome: "passed",
    actionable: false,
    unresolvedFailures: 0,
    scope: { selectors: [], platforms: [], noDeps: false },
    reportingDebt: 0,
    endpoint: null,
    parentRunId: null,
    cursor: "c0",
    ...over,
  };
}

describe("what a run is called", () => {
  it("reads the verdict once there is one", () => {
    expect(runStatus(row({ runId: "a", state: "settled", outcome: "passed" })))
      .toEqual({ label: "passed", hue: "green" });
    expect(runStatus(row({ runId: "a", state: "settled", outcome: "failed" })))
      .toEqual({ label: "failed", hue: "red" });
  });

  it("reads the board state while a run has no verdict", () => {
    expect(runStatus(row({ runId: "a", state: "running", outcome: null })))
      .toEqual({ label: "running", hue: "amber" });
    expect(
      runStatus(row({ runId: "a", state: "owner_lost", outcome: null })),
    ).toEqual({ label: "owner lost", hue: "violet" });
  });

  it("does NOT call a torn-down run failed", () => {
    expect(
      runStatus(row({ runId: "a", state: "settled", outcome: "incomplete" })),
    ).toEqual({ label: "incomplete", hue: "amber" });
  });
});

describe("a run's scope", () => {
  const scope = (
    over: Partial<RunRow["scope"]> = {},
  ): RunRow["scope"] => ({
    selectors: [],
    platforms: [],
    noDeps: false,
    ...over,
  });

  it("says nothing when the run covered the whole pipeline", () => {
    expect(scopeSuffix(scope())).toBeNull();
  });

  it("names the selection, which is not the whole pipeline", () => {
    expect(scopeSuffix(scope({ selectors: ["ci::unit"] }))).toBe("ci::unit");
    expect(
      scopeSuffix(scope({ selectors: ["ci::fmt", "ci::nix"] })),
    ).toBe("ci::fmt ci::nix");
  });

  it("names a platform slice and --no-deps, alone or together", () => {
    expect(scopeSuffix(scope({ platforms: ["x86_64-linux"] }))).toBe(
      "x86_64-linux",
    );
    expect(scopeSuffix(scope({ noDeps: true }))).toBe("no deps");
    expect(
      scopeSuffix(
        scope({ selectors: ["ci::unit"], platforms: ["x86_64-linux"], noDeps: true }),
      ),
    ).toBe("ci::unit · x86_64-linux · no deps");
  });

  it("names a --root, which is a scoped run like any other", () => {
    expect(scopeSuffix(scope({ root: "ci::install" }))).toBe(
      "under ci::install",
    );
    expect(scopeSuffix(scope({ root: "ci::install", noDeps: true }))).toBe(
      "under ci::install · no deps",
    );
  });

  it("a board row never renders an empty scope cell", () => {
    expect(scopeLabel(scope())).toBe("whole pipeline");
    expect(scopeLabel(scope({ platforms: ["x86_64-linux"] }))).toBe(
      "whole pipeline · x86_64-linux",
    );
    expect(scopeLabel(scope({ noDeps: true }))).toBe("whole pipeline · no deps");
    expect(scopeLabel(scope({ root: "ci::install" }))).toBe(
      "under ci::install",
    );
    expect(scopeLabel(scope({ root: "ci::install", noDeps: true }))).toBe(
      "under ci::install · no deps",
    );
  });

  it("the row and the qualifier agree once a SELECTION names the run", () => {
    for (const scoped of [
      scope({ selectors: ["ci::unit"] }),
      scope({ selectors: ["ci::unit"], platforms: ["x86_64-linux"] }),
      scope({ selectors: ["ci::unit"], noDeps: true }),
    ]) {
      expect(scopeLabel(scoped)).toBe(scopeSuffix(scoped) as string);
    }
  });
});

describe("the board, narrowed", () => {
  it("orders newest first, and total by runId on a tie", () => {
    const rows = [
      row({ runId: "b", createdAt: 5 }),
      row({ runId: "a", createdAt: 5 }),
      row({ runId: "c", createdAt: 9 }),
    ];
    expect(newestFirst(rows).map((r) => r.runId)).toEqual(["c", "b", "a"]);
  });

  it("names the checkouts on the board, once each, in the rows' order", () => {
    const board = boardOrder([
      row({ runId: "here-old", createdAt: 1 }),
      row({ runId: "elsewhere", createdAt: 2, repoRoot: "/home/dev/other" }),
      row({ runId: "here-new", createdAt: 3 }),
    ]);
    expect(board.rows.map((r) => r.runId)).toEqual(["here-new", "elsewhere", "here-old"]);
    expect(board.roots).toEqual(["/home/dev/kolu", "/home/dev/other"]);
  });

  it("counts the board's two buckets off the run each checkout stands for", () => {
    const tally = boardTally([
      row({ runId: "new-ok", createdAt: 2 }),
      row({
        runId: "moving",
        createdAt: 3,
        repoRoot: "/home/dev/other",
        state: "running",
        settled: false,
        passed: false,
        outcome: null,
      }),
    ]);
    expect(tally).toEqual({ failing: 0, active: 1 });
  });

  it("judges active and failing off the fields that carry them", () => {
    expect(isActive(row({ runId: "a", state: "provisioning" }))).toBe(true);
    expect(isActive(row({ runId: "a", state: "settled" }))).toBe(false);
    expect(isFailing(row({ runId: "a", unresolvedFailures: 1 }))).toBe(true);
    expect(isFailing(row({ runId: "a", unresolvedFailures: 0 }))).toBe(false);
  });
});

describe("how long a run took", () => {
  it("stops at the verdict, so a settled row says the same number forever", () => {
    const settled = row({ runId: "a", createdAt: 1_000, finishedAt: 61_000 });
    expect(runElapsedMs(settled, 61_000)).toBe(60_000);
    expect(runElapsedMs(settled, 61_000 + 7 * 86_400_000)).toBe(60_000);
  });

  it("ticks while the run has not finished", () => {
    const running = row({ runId: "a", createdAt: 1_000, finishedAt: null });
    expect(runElapsedMs(running, 6_000)).toBe(5_000);
    expect(runElapsedMs(running, 11_000)).toBe(10_000);
  });

  it("floors at zero when a lane host's clock ran behind the registrar's", () => {
    expect(runElapsedMs(row({ runId: "a", createdAt: 5_000, finishedAt: 4_000 }), 9_000))
      .toBe(0);
  });

  it("spells one duration the way every face prints it", () => {
    expect(duration(400)).toBe("400ms");
    expect(duration(1_500)).toBe("1.5s");
    expect(duration(67_000)).toBe("1m07s");
    expect(duration(null)).toBe("");
  });
});

describe("where a lane sat in its run", () => {
  const run = row({
    runId: "a",
    createdAt: 1_000_000,
    finishedAt: 1_000_000 + 600_000,
  });
  const lane = (
    status: RunNode["status"],
    startedAt: number | null,
    durationMs: number | null,
  ): Pick<RunNode, "status" | "startedAt" | "durationMs"> => ({
    status,
    startedAt,
    durationMs,
  });

  it("places a settled lane by WHERE it ran, not just how long", () => {
    expect(laneSpan(lane("ok", 1_120_000, 180_000), run, 9e15)).toEqual({
      kind: "settled",
      left: 0.2,
      width: 0.3,
      startedAfterMs: 120_000,
      tookMs: 180_000,
    });
    expect(laneSpan(lane("ok", 1_300_000, 180_000), run, 9e15)?.left).toBe(0.5);
  });

  it("grows a running lane against the clock, inside a track that grows too", () => {
    const live = row({ runId: "a", createdAt: 1_000_000, finishedAt: null });
    const going = lane("running", 1_060_000, null);
    expect(laneSpan(going, live, 1_120_000)).toEqual({
      kind: "running",
      left: 0.5,
      width: 0.5,
      startedAfterMs: 60_000,
      tookMs: 60_000,
    });
    expect(laneSpan(going, live, 1_240_000)?.left).toBe(0.25);
  });

  it("says NOTHING about a lane that has not started", () => {
    expect(laneSpan(lane("pending", null, null), run, 9e15)).toBeNull();
  });

  it("says NOTHING about a lane that stopped without ever running", () => {
    for (const status of ["skipped", "cancelled", "errored", "failed"] as const) {
      expect(laneSpan(lane(status, 1_060_000, null), run, 9e15)).toBeNull();
    }
  });

  it("settles a finished run's open lane at the VERDICT, and stops calling it live", () => {
    const open = laneSpan(lane("running", 1_060_000, null), run, 9e15);
    expect(open).toEqual({
      kind: "settled",
      left: 0.1,
      width: 0.9,
      startedAfterMs: 60_000,
      tookMs: 540_000,
    });
    expect(laneSpan(lane("running", 1_060_000, null), run, 9e15 + 7 * 86_400_000))
      .toEqual(open);
    expect(laneSpan(lane("running", 1_060_000, null), run, 1_120_000)).toEqual(open);
  });

  it("clamps a skewed lane host into the track, ms and fractions alike", () => {
    expect(laneSpan(lane("ok", 900_000, 60_000), run, 9e15)).toEqual({
      kind: "settled",
      left: 0,
      width: 0.1,
      startedAfterMs: 0,
      tookMs: 60_000,
    });
    const over = laneSpan(lane("ok", 1_540_000, 600_000), run, 9e15);
    expect(over?.left).toBe(0.9);
    expect((over?.left ?? 0) + (over?.width ?? 0)).toBeCloseTo(1, 10);
    expect(laneSpan(lane("ok", 9e15, 1_000), run, 9e15)).toEqual({
      kind: "settled",
      left: 1,
      width: 0,
      startedAfterMs: 600_000,
      tookMs: 0,
    });
    expect(
      laneSpan(lane("ok", Number.POSITIVE_INFINITY, 1_000), run, 9e15),
    ).toEqual({
      kind: "settled",
      left: 1,
      width: 0,
      startedAfterMs: 600_000,
      tookMs: 0,
    });
  });

  it("answers zero rather than NaN for a run with no elapsed time yet", () => {
    const instant = row({ runId: "a", createdAt: 5_000, finishedAt: 5_000 });
    expect(laneSpan(lane("ok", 5_000, 0), instant, 5_000)).toEqual({
      kind: "settled",
      left: 0,
      width: 0,
      startedAfterMs: 0,
      tookMs: 0,
    });
  });

  it("marks the axis against the RUN, in whole milliseconds", () => {
    expect(timelineTicks(run, 9e15)).toEqual([
      { at: 0, ms: 0 },
      { at: 1 / 3, ms: 200_000 },
      { at: 2 / 3, ms: 400_000 },
      { at: 1, ms: 600_000 },
    ]);
    const live = row({ runId: "a", createdAt: 1_000, finishedAt: null });
    expect(timelineTicks(live, 3_500).map((tick) => tick.ms)).toEqual([
      0, 833, 1_667, 2_500,
    ]);
  });
});

describe("where a node's PUSH sat in its run", () => {
  const run = row({
    runId: "a",
    createdAt: 1_000_000,
    finishedAt: 1_000_000 + 600_000,
  });
  const node = (
    over: Partial<Pick<RunNode, "status" | "startedAt" | "durationMs" | "push">>,
  ): Pick<RunNode, "status" | "startedAt" | "durationMs" | "push"> => ({
    status: "ok",
    startedAt: 1_120_000,
    durationMs: 180_000,
    ...over,
  });

  it("says NOTHING about a node that pushed nothing", () => {
    expect(pushSpan(node({}), run, 9e15)).toBeNull();
  });

  it("starts a settled push exactly where the recipe's bar ENDS", () => {
    const recipe = laneSpan(node({}), run, 9e15);
    const push = pushSpan(
      node({ push: { state: "pushed", stored: 4, present: 0, bytes: 2_097_152, durationMs: 60_000 } }),
      run,
      9e15,
    );
    expect(push).toEqual({
      kind: "settled",
      left: 0.5,
      width: 0.1,
      startedAfterMs: 300_000,
      tookMs: 60_000,
    });
    expect(push?.left).toBe((recipe?.left ?? 0) + (recipe?.width ?? 0));
  });

  it("draws a FAILED push as its own settled segment, not as a gap", () => {
    expect(
      pushSpan(
        node({ status: "failed", push: { state: "failed", message: "413 too large", durationMs: 30_000 } }),
        run,
        9e15,
      ),
    ).toEqual({
      kind: "settled",
      left: 0.5,
      width: 0.05,
      startedAfterMs: 300_000,
      tookMs: 30_000,
    });
  });

  it("runs a push IN FLIGHT to the end of a live track, hatched", () => {
    const live = row({ runId: "a", createdAt: 1_000_000, finishedAt: null });
    const uploading = node({
      status: "running",
      startedAt: 1_060_000,
      durationMs: 120_000,
      push: { state: "pushing" },
    });
    expect(laneSpan(uploading, live, 1_240_000)).toEqual({
      kind: "settled",
      left: 0.25,
      width: 0.5,
      startedAfterMs: 60_000,
      tookMs: 120_000,
    });
    expect(pushSpan(uploading, live, 1_240_000)).toEqual({
      kind: "running",
      left: 0.75,
      width: 0.25,
      startedAfterMs: 180_000,
      tookMs: 60_000,
    });
    expect(pushSpan(uploading, live, 1_360_000)).toEqual({
      kind: "running",
      left: 0.5,
      width: 0.5,
      startedAfterMs: 180_000,
      tookMs: 180_000,
    });
  });

  it("says NOTHING when the recipe has not published its duration yet", () => {
    const live = row({ runId: "a", createdAt: 1_000_000, finishedAt: null });
    expect(
      pushSpan(
        node({
          status: "running",
          startedAt: 1_060_000,
          durationMs: null,
          push: { state: "pushing" },
        }),
        live,
        1_240_000,
      ),
    ).toBeNull();
  });

  it("clamps a push that outran its own run into the track", () => {
    const over = pushSpan(
      node({ push: { state: "pushed", stored: 1, present: 0, bytes: 10, durationMs: 9_000_000 } }),
      run,
      9e15,
    );
    expect(over).toEqual({
      kind: "settled",
      left: 0.5,
      width: 0.5,
      startedAfterMs: 300_000,
      tookMs: 300_000,
    });
  });
});
