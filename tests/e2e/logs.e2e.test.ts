/**
 * End-to-end: what a run leaves behind in `.ci/<sha7>/<platform>/<node>.log`.
 *
 * A node's log is the only durable account of what a recipe did, and the part
 * that matters most is the END — the summary line that says how many tests ran
 * and which failed. Two ways it used to be wrong (juspay/odu#87), both black-box
 * observable and both asserted here against the real nix-built binary:
 *
 *   1. The end went missing. A node's status and its output travel on different
 *      streams; the status one arrives first, and the run closed its lanes the
 *      instant the DAG settled — discarding whatever output was still in flight.
 *      Worst on exactly the long, noisy recipes whose logs you need.
 *   2. The beginning was someone else's. The log is addressed by COMMIT, not by
 *      run, so a second run of the same SHA appended onto the first with nothing
 *      marking the seam.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  awaitRunSocket,
  buildOduBinary,
  cleanup,
  currentNixSystem,
  makeFixture,
  oduCli,
  oduRun,
  oduRunBackground,
} from "./harness";

let oduBin: string;

/** The noisy fixture emits ~14 MB in about a second and exits; the run then has
 *  to finish streaming it. Generous, because the drain is real work. */
const RUN_TIMEOUT = 300_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000); // nix build, cold cache

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

/** The one log a run of `noisy` writes, read off disk the way a human or an
 *  agent would: resolve the commit dir from the fixture's own HEAD. Spelled out
 *  here rather than imported from `src/` on purpose — this suite is black-box,
 *  so the durable layout is something it asserts, not something it shares. */
function noisyLog(dir: string): string {
  const sha7 = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
  return readFileSync(
    join(dir, ".ci", sha7, currentNixSystem(), "noisy.log"),
    "utf-8",
  );
}

// TWO runs of the fixture, shared by both tests, because the second test's pair
// already subsumes the first's single run — and a run of this fixture is a cold
// `odu run` against a fresh git repo, which is tens of seconds of fixed cost for
// ~1s of actual 14 MB streaming. The volume is nearly free and buys the
// anti-flake margin for a race-shaped bug; the RUN COUNT is the expensive axis,
// so that is the one to spend carefully. The `it`s stay separate: they name two
// different properties, and merging them would cost the diagnosis.
let firstLog = "";
let secondLog = "";

beforeAll(() => {
  const dir = fixture("noisy");
  expect(oduRun(oduBin, dir).status).toBe(0);
  firstLog = noisyLog(dir);
  // Same fixture, same HEAD — so the same log path, deliberately.
  expect(oduRun(oduBin, dir).status).toBe(0);
  secondLog = noisyLog(dir);
}, RUN_TIMEOUT * 2);

describe("durable node logs", () => {
  it("captures a noisy recipe's output to its very last line", () => {
    // The summary is the point. A log that stops mid-recipe is worse than no
    // log: it looks complete, and it is the reason a red node used to be
    // undiagnosable from its own log.
    expect(firstLog).toContain("NOISY SUMMARY: 200000 lines emitted");
    expect(firstLog.trimEnd().endsWith("__ODU_NOISY_END__")).toBe(true);
    // Every line, not just the ends — a drain that dropped a middle chunk and
    // still landed the tail would satisfy the two assertions above.
    expect(firstLog.match(/^noisy line \d+ /gm)?.length).toBe(200000);
    // Truncation, if it ever happens again, says so in the log itself.
    expect(firstLog).not.toContain("[odu] log truncated");
  });

  it("holds one run's output, not every run of that commit concatenated", () => {
    // The second run OWNS the file: one recipe's output, and no less complete
    // than the first. Both halves are asserted directly — appending would show
    // up as a doubled first line and a doubled summary, truncating as a short
    // line count or a missing marker.
    expect(secondLog.match(/^noisy line 1 /gm)?.length).toBe(1);
    expect(secondLog.match(/NOISY SUMMARY/g)?.length).toBe(1);
    expect(secondLog.match(/^noisy line \d+ /gm)?.length).toBe(200000);
    expect(secondLog.trimEnd().endsWith("__ODU_NOISY_END__")).toBe(true);
    expect(secondLog).not.toContain("[odu] log truncated");
    // NOT `secondLog.length === firstLog.length`. That demanded byte-identical
    // output from two independent runs, which is a stronger claim than this
    // feature makes and not one it should be held to: the GitHub macOS runner
    // produced a second log 2 characters longer, on a 13.7 MB file where both
    // runs satisfy every assertion above. Three consecutive local runs are
    // byte-identical and the darwin lane on our own CI host passes, so the
    // delta is environment-specific and remains UNDIAGNOSED — recorded here
    // rather than papered over. What matters is single-run-ness and
    // completeness, and those are now asserted for what they are.
  });
});

/**
 * The residual #88 left behind: a run is observably SETTLED before its logs
 * have joined, so the agent loop `wait_for_settle` was built for — settle, then
 * drill into the node's log — still reads a file that stops mid-recipe, with
 * nothing saying so.
 *
 * #88 joined the two streams at TEARDOWN: `runCommand` awaits `drainLaneLogs`
 * before closing its lanes. But the settle every consumer acts on is derived
 * from node STATUSES on the coordinator's socket, and those are published the
 * instant the DAG settles — ahead of the drain, and in `--linger` (where the
 * coordinator parks instead of tearing down) ahead of a drain that never runs
 * at all. So the join protects the run's own exit and nothing else.
 *
 * Field forensics (olai's CI, 2026-08-21, post-#88): three characterized
 * occurrences, `settled: true` in all three, node logs of 11,469 / 9,959 /
 * 10,469 bytes against a recipe that emits thousands of lines — no summary in
 * any of them, and no `[odu] log truncated` marker in any of them either.
 */
describe("a settled run's log", () => {
  it("is whole the moment the run reports itself settled", async () => {
    const dir = fixture("noisy");
    // `--linger` is the agent's own run shape (MCP `run` → `wait_for_settle` →
    // read the log), and the one the field hit twice: the coordinator parks at
    // settle instead of exiting, so nothing about this test depends on winning a
    // race against a teardown. What it observes is the settle SIGNAL, which is
    // what every consumer of a run acts on.
    const { exited } = oduRunBackground(oduBin, dir, [
      "--no-strict",
      "--linger",
      "--progress",
      "json",
    ]);
    try {
      await awaitRunSocket(dir);
      const wait = oduCli(oduBin, dir, [
        "wait",
        "--settle",
        "--timeout-ms",
        String(RUN_TIMEOUT),
      ]);
      const verdict = JSON.parse(wait.stdout) as {
        settled: boolean;
        passed: boolean;
      };
      expect(verdict.settled).toBe(true);
      expect(verdict.passed).toBe(true);

      // Read at once, the way an agent handed a settled verdict does. Anything
      // this misses is something the run told the world it was finished with.
      const log = noisyLog(dir);
      // Asserted as ONE object rather than four `expect`s: the failure is then a
      // four-field diff naming exactly where the bytes stopped, instead of bun
      // printing a multi-megabyte `toContain` receipt into the CI log — which is
      // its own small version of this bug's lesson about unreadable evidence.
      expect({
        lines: log.match(/^noisy line \d+ /gm)?.length ?? 0,
        summary: log.includes("NOISY SUMMARY: 200000 lines emitted"),
        endsAtRecipeEnd: log.trimEnd().endsWith("__ODU_NOISY_END__"),
        // Either the log is complete, or it says it isn't. Silent loss is the
        // one forbidden outcome — and nothing was actually lost here, so the
        // log is whole and the notice is absent.
        truncationNotice: log.includes("[odu] log truncated"),
      }).toEqual({
        lines: 200000,
        summary: true,
        endsAtRecipeEnd: true,
        truncationNotice: false,
      });
    } finally {
      oduCli(oduBin, dir, ["cancel"]);
      await exited;
    }
  }, RUN_TIMEOUT);
});
