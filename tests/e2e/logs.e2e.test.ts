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
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { buildOduBinary, cleanup, makeFixture, oduRun } from "./harness";

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
 *  agent would: resolve the commit dir from the fixture's own HEAD. */
function noisyLog(dir: string): string {
  const sha7 = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], {
    cwd: dir,
  })
    .stdout.toString()
    .trim();
  const platform = Bun.spawnSync(
    ["nix", "eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
    { cwd: dir },
  )
    .stdout.toString()
    .trim();
  return readFileSync(join(dir, ".ci", sha7, platform, "noisy.log"), "utf-8");
}

describe("durable node logs", () => {
  it(
    "captures a noisy recipe's output to its very last line",
    () => {
      const dir = fixture("noisy");
      const { status } = oduRun(oduBin, dir);
      expect(status).toBe(0);

      const log = noisyLog(dir);
      // The summary is the point. A log that stops mid-recipe is worse than no
      // log: it looks complete, and it is the reason a red node used to be
      // undiagnosable from its own log.
      expect(log).toContain("NOISY SUMMARY: 200000 lines emitted");
      expect(log.trimEnd().endsWith("__ODU_NOISY_END__")).toBe(true);
      // Every line, not just the ends — a drain that dropped a middle chunk
      // and still landed the tail would satisfy the two assertions above.
      expect(log.match(/^noisy line \d+ /gm)?.length).toBe(200000);
      // Truncation, if it ever happens again, says so in the log itself.
      expect(log).not.toContain("[odu] log truncated");
    },
    RUN_TIMEOUT,
  );

  it(
    "holds one run's output, not every run of that commit concatenated",
    () => {
      const dir = fixture("noisy");
      expect(oduRun(oduBin, dir).status).toBe(0);
      const first = noisyLog(dir);

      // Same fixture, same HEAD — so the same log path. The second run OWNS
      // that file: it must read as one recipe's output, not two.
      expect(oduRun(oduBin, dir).status).toBe(0);
      const second = noisyLog(dir);

      expect(second.match(/^noisy line 1 /gm)?.length).toBe(1);
      expect(second.match(/NOISY SUMMARY/g)?.length).toBe(1);
      expect(second.length).toBe(first.length);
    },
    RUN_TIMEOUT * 2,
  );
});
