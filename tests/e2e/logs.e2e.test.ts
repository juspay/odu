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
  buildOduBinary,
  cleanup,
  currentNixSystem,
  makeFixture,
  oduRun,
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
