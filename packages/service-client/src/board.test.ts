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
  checkoutRoots,
  isActive,
  isFailing,
  newestFirst,
  runStatus,
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
