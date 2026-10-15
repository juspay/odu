/**
 * The board's readings, as readings — the words and the folds every face shares.
 *
 * Four claims are worth executing here rather than asserting in a docstring.
 *
 * The first is `runStatus`'s PRECEDENCE: a run that was cancelled or whose
 * coordinator was interrupted settles `passed: false` with `outcome:
 * "incomplete"`, and a face that read the state first would call it `failed` and
 * send somebody looking for a test that broke.
 *
 * The second is that a scope is what a run COVERED. A selection is not a
 * pipeline: `selectors: ["ci::unit"]` is one recipe and its dependencies, so the
 * handful of lanes behind it says nothing about the rest of the DAG. A qualifier
 * therefore has to be about the whole pipeline (nothing to say, `null`) or name
 * the selection — and the one reader that cannot say nothing is a board row,
 * where an empty cell would read as a run that tested nothing.
 *
 * The third is that a run's duration STOPS AT ITS VERDICT. Every face reads it
 * through `runElapsedMs`, and a settled row that counted against `now` would
 * report how long ago somebody last looked at the board.
 *
 * The fourth is the lane TIMELINE's geometry: a bar says where a lane sat in
 * its run, measured against the run's own elapsed — so a live run's track stays
 * full as it grows, and a lane that never started has no bar at all rather than
 * a sliver at the origin.
 */

import { describe, expect, it } from "bun:test";
import {
  boardTally,
  checkoutRoots,
  duration,
  isActive,
  isFailing,
  laneSpan,
  newestFirst,
  runElapsedMs,
  runStatus,
  scopeLabel,
  scopeSuffix,
  timelineTicks,
} from "./board";
import type { RunRow } from "./surface";

/** A row is the wire's own shape, so a reading is exercised against what a
 *  service actually sends rather than against a narrowed stand-in. Only the
 *  fields a reading touches carry meaning; the rest are the wire's defaults. */
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
    // The precedence, in the one shape that makes it matter: the outcome wins
    // over the settled state, so a cancelled run reads as what it is.
    expect(
      runStatus(row({ runId: "a", state: "settled", outcome: "incomplete" })),
    ).toEqual({ label: "incomplete", hue: "amber" });
  });
});

describe("a run's scope", () => {
  /** A scope the way the wire carries one: the optional `--root` absent. */
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
    // A run rooted at a NAMEPATH expanded the DAG under it, so its lanes say
    // nothing about the rest of the pipeline either — the same misreading a
    // selection would cause, and the reason the qualifier reads `root` too.
    expect(scopeSuffix(scope({ root: "ci::install" }))).toBe(
      "under ci::install",
    );
    expect(scopeSuffix(scope({ root: "ci::install", noDeps: true }))).toBe(
      "under ci::install · no deps",
    );
  });

  it("a board row never renders an empty scope cell", () => {
    // The row has nothing else to say about what the run covered, so an empty
    // selector is the WHOLE pipeline and says so — "" would read as a run that
    // tested nothing.
    expect(scopeLabel(scope())).toBe("whole pipeline");
    // And it leads with that even when the rest of the scope is named, which is
    // where the row and the qualifier deliberately differ.
    expect(scopeLabel(scope({ platforms: ["x86_64-linux"] }))).toBe(
      "whole pipeline · x86_64-linux",
    );
    expect(scopeLabel(scope({ noDeps: true }))).toBe("whole pipeline · no deps");
    // A `--root` narrows what RAN, so the cell names the root alone — this is
    // not a whole-pipeline run with a qualifier, it is a run of a subgraph.
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
    // The tie runs the catalog's way — later id first — so a board and the
    // catalog under it never disagree about which of two same-millisecond runs
    // comes first.
    expect(newestFirst(rows).map((r) => r.runId)).toEqual(["c", "b", "a"]);
  });

  it("names the checkouts on the board, once each, in the rows' order", () => {
    const rows = newestFirst([
      row({ runId: "here-old", createdAt: 1 }),
      row({ runId: "elsewhere", createdAt: 2, repoRoot: "/home/dev/other" }),
      row({ runId: "here-new", createdAt: 3 }),
    ]);
    expect(checkoutRoots(rows)).toEqual(["/home/dev/kolu", "/home/dev/other"]);
  });

  it("counts the board's two buckets off the run each checkout stands for", () => {
    // What the board SHOWS is what the summary counts: it is handed the runs
    // the checkouts stand for, so an older failing run of a checkout that is
    // green now cannot reach it.
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
    // A week later, the same answer. This is the whole reason the finish
    // instant rides the row: a duration read against `now` would tell a reader
    // how long ago they last looked.
    expect(runElapsedMs(settled, 61_000 + 7 * 86_400_000)).toBe(60_000);
  });

  it("ticks while the run has not finished", () => {
    const running = row({ runId: "a", createdAt: 1_000, finishedAt: null });
    expect(runElapsedMs(running, 6_000)).toBe(5_000);
    expect(runElapsedMs(running, 11_000)).toBe(10_000);
  });

  it("floors at zero when a lane host's clock ran behind the registrar's", () => {
    // A verdict stamped before the run was registered is clock skew, not a
    // negative duration — and a negative duration is not a fact about anything.
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
  /** A ten-minute run, settled — the fixture every span below is read against,
   *  so a fraction in an assertion is legible as a clock time. */
  const run = row({
    runId: "a",
    createdAt: 1_000_000,
    finishedAt: 1_000_000 + 600_000,
  });

  it("places a settled lane by WHERE it ran, not just how long", () => {
    // Started two minutes in, took three: a fifth across, three tenths wide.
    expect(
      laneSpan({ startedAt: 1_120_000, durationMs: 180_000 }, run, 9e15),
    ).toEqual({ left: 0.2, width: 0.3 });
    // Same LENGTH, later start — the whole point of a Gantt over a bar chart.
    expect(
      laneSpan({ startedAt: 1_300_000, durationMs: 180_000 }, run, 9e15),
    ).toEqual({ left: 0.5, width: 0.3 });
  });

  it("grows a running lane against the clock, inside a track that grows too", () => {
    const live = row({ runId: "a", createdAt: 1_000_000, finishedAt: null });
    const lane = { startedAt: 1_060_000, durationMs: null };
    // Two minutes in: the lane has been going for one of them, and the track
    // is two minutes long — so it occupies the second half of the run.
    expect(laneSpan(lane, live, 1_120_000)).toEqual({ left: 0.5, width: 0.5 });
    // Four minutes in, the same lane still going: it started a quarter of the
    // way through what the run has now become.
    expect(laneSpan(lane, live, 1_240_000)).toEqual({ left: 0.25, width: 0.75 });
  });

  it("says NOTHING about a lane that has not started", () => {
    // Not a zero-width bar at the origin: a lane waiting for a machine has no
    // place on the timeline, and an empty track is the signal.
    expect(laneSpan({ startedAt: null, durationMs: null }, run, 9e15)).toBeNull();
  });

  it("clamps a skewed lane host into the track", () => {
    // A box whose clock is behind the registrar's reports a start before the
    // run began. That is skew, not a negative offset.
    expect(
      laneSpan({ startedAt: 900_000, durationMs: 60_000 }, run, 9e15),
    ).toEqual({ left: 0, width: 0.1 });
    // And one that overruns the run's own end stops at the edge rather than
    // painting past it: whatever the arithmetic, `left + width` reaches 1 and
    // goes no further.
    const over = laneSpan({ startedAt: 1_540_000, durationMs: 600_000 }, run, 9e15);
    expect(over?.left).toBe(0.9);
    expect((over?.left ?? 0) + (over?.width ?? 0)).toBeCloseTo(1, 10);
  });

  it("answers zero rather than NaN for a run with no elapsed time yet", () => {
    const instant = row({ runId: "a", createdAt: 5_000, finishedAt: 5_000 });
    expect(laneSpan({ startedAt: 5_000, durationMs: 0 }, instant, 5_000)).toEqual({
      left: 0,
      width: 0,
    });
  });

  it("ticks the axis at the track's own thirds, labelled in run time", () => {
    expect(timelineTicks(600_000)).toEqual([
      { at: 0, label: "0ms" },
      { at: 1 / 3, label: "3m20s" },
      { at: 2 / 3, label: "6m40s" },
      { at: 1, label: "10m00s" },
    ]);
  });
});
