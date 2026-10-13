/**
 * The board's readings, as readings — the words and the folds every face shares.
 *
 * Two claims are worth executing here rather than asserting in a docstring.
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
 */

import { describe, expect, it } from "bun:test";
import {
  boardTally,
  byCheckout,
  isActive,
  isFailing,
  newestFirst,
  runStatus,
  runsForCheckout,
  scopeLabel,
  scopeSuffix,
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
  it("says nothing when the run covered the whole pipeline", () => {
    expect(
      scopeSuffix({ selectors: [], platforms: [], noDeps: false }),
    ).toBeNull();
  });

  it("names the selection, which is not the whole pipeline", () => {
    expect(
      scopeSuffix({ selectors: ["ci::unit"], platforms: [], noDeps: false }),
    ).toBe("ci::unit");
    expect(
      scopeSuffix({
        selectors: ["ci::fmt", "ci::nix"],
        platforms: [],
        noDeps: false,
      }),
    ).toBe("ci::fmt ci::nix");
  });

  it("names a platform slice and --no-deps, alone or together", () => {
    expect(
      scopeSuffix({
        selectors: [],
        platforms: ["x86_64-linux"],
        noDeps: false,
      }),
    ).toBe("x86_64-linux");
    expect(
      scopeSuffix({ selectors: [], platforms: [], noDeps: true }),
    ).toBe("no deps");
    expect(
      scopeSuffix({
        selectors: ["ci::unit"],
        platforms: ["x86_64-linux"],
        noDeps: true,
      }),
    ).toBe("ci::unit · x86_64-linux · no deps");
  });

  it("a board row never renders an empty scope cell", () => {
    expect(scopeLabel({ selectors: [], platforms: [], noDeps: false })).toBe(
      "whole pipeline",
    );
    // And where the suffix speaks, the label IS the suffix: one spelling of a
    // scope, so a row and a qualifier cannot describe the same run differently.
    for (const scope of [
      { selectors: ["ci::unit"], platforms: [], noDeps: false },
      { selectors: [], platforms: ["aarch64-darwin"], noDeps: false },
      { selectors: [], platforms: [], noDeps: true },
    ]) {
      expect(scopeLabel(scope)).toBe(scopeSuffix(scope) as string);
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
    expect(newestFirst(rows).map((r) => r.runId)).toEqual(["c", "a", "b"]);
  });

  it("keeps one checkout's runs, and only that checkout's", () => {
    const rows = [
      row({ runId: "here-old", createdAt: 1 }),
      row({ runId: "elsewhere", createdAt: 2, repoRoot: "/home/dev/other" }),
      row({ runId: "here-new", createdAt: 3 }),
    ];
    expect(
      runsForCheckout(rows, "/home/dev/kolu").map((r) => r.runId),
    ).toEqual(["here-new", "here-old"]);
  });

  it("collapses a checkout to its newest run and a count", () => {
    const groups = byCheckout([
      row({ runId: "old", createdAt: 1 }),
      row({ runId: "new", createdAt: 2 }),
      row({ runId: "other", createdAt: 3, repoRoot: "/home/dev/other" }),
    ]);
    expect(groups.get("/home/dev/kolu")).toEqual({
      latest: row({ runId: "new", createdAt: 2 }),
      runs: 2,
    });
    expect(groups.size).toBe(2);
  });

  it("counts the board's two buckets off the newest row of each checkout", () => {
    // The old row of a checkout is not what the board shows, so it is not what
    // the summary counts either.
    const tally = boardTally([
      row({ runId: "old-fail", createdAt: 1, unresolvedFailures: 3 }),
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
