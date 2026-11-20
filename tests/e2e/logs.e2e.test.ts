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

const RUN_TIMEOUT = 300_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

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

let firstLog = "";
let secondLog = "";

beforeAll(() => {
  const dir = fixture("noisy");
  expect(oduRun(oduBin, dir).status).toBe(0);
  firstLog = noisyLog(dir);
  expect(oduRun(oduBin, dir).status).toBe(0);
  secondLog = noisyLog(dir);
}, RUN_TIMEOUT * 2);

describe("durable node logs", () => {
  it("captures a noisy recipe's output to its very last line", () => {
    expect(firstLog).toContain("NOISY SUMMARY: 200000 lines emitted");
    expect(firstLog.trimEnd().endsWith("__ODU_NOISY_END__")).toBe(true);
    expect(firstLog.match(/^noisy line \d+ /gm)?.length).toBe(200000);
    expect(firstLog).not.toContain("[odu] log truncated");
  });

  it("holds one run's output, not every run of that commit concatenated", () => {
    expect(secondLog.match(/^noisy line 1 /gm)?.length).toBe(1);
    expect(secondLog.match(/NOISY SUMMARY/g)?.length).toBe(1);
    expect(secondLog.match(/^noisy line \d+ /gm)?.length).toBe(200000);
    expect(secondLog.trimEnd().endsWith("__ODU_NOISY_END__")).toBe(true);
    expect(secondLog).not.toContain("[odu] log truncated");
  });
});

describe("a settled run's log", () => {
  it("is whole the moment the run reports itself settled", async () => {
    const dir = fixture("noisy");
    const { exited } = oduRunBackground(oduBin, dir, [
      "--no-strict",
      "--linger",
      "--progress",
      "json",
    ]);
    try {
      await awaitRunSocket(dir);
      const wait = oduCli(oduBin, dir, [
        "ci",
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

      const log = noisyLog(dir);
      expect({
        lines: log.match(/^noisy line \d+ /gm)?.length ?? 0,
        summary: log.includes("NOISY SUMMARY: 200000 lines emitted"),
        endsAtRecipeEnd: log.trimEnd().endsWith("__ODU_NOISY_END__"),
        truncationNotice: log.includes("[odu] log truncated"),
      }).toEqual({
        lines: 200000,
        summary: true,
        endsAtRecipeEnd: true,
        truncationNotice: false,
      });
    } finally {
      oduCli(oduBin, dir, ["ci", "cancel"]);
      await exited;
    }
  }, RUN_TIMEOUT);
});
