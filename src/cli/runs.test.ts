import { describe, expect, it } from "bun:test";
import type { RunRecord } from "../common/runRecord";
import { RUN_RECORD_VERSION } from "../common/runRecord";
import { formatAgo, renderRuns } from "./runs";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    repo: "juspay/kolu",
    sha: "26d2c2dabc",
    seq: 1,
    dirty: false,
    pipeline: "pipeline",
    outcome: "passed",
    startedAt: 1000,
    finishedAt: 2000,
    lanes: [{ platform: "x86_64-linux", host: "localhost" }],
    nodes: [],
    ...over,
  };
}

describe("formatAgo", () => {
  it("buckets at human resolution", () => {
    expect(formatAgo(5_000)).toBe("just now");
    expect(formatAgo(90_000)).toBe("1m ago");
    expect(formatAgo(2 * 3_600_000)).toBe("2h ago");
    expect(formatAgo(3 * 86_400_000)).toBe("3d ago");
  });
});

describe("renderRuns", () => {
  const now = 10_000_000;

  it("says so when the ledger is empty", () => {
    expect(renderRuns([], now)).toContain("no runs recorded");
  });

  it("shows the ref, verdict, lane count and age, newest first as given", () => {
    const out = renderRuns(
      [
        record({ seq: 2, sha: "26d2c2dabc", outcome: "passed", finishedAt: now - 7_200_000 }),
        record({
          seq: 1,
          sha: "53c0889abc",
          outcome: "failed",
          finishedAt: now - 18_000_000,
          lanes: [
            { platform: "x86_64-linux", host: "localhost" },
            { platform: "aarch64-darwin", host: "mac" },
          ],
        }),
      ],
      now,
    );
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toContain("26d2c2d#2");
    expect(lines[0]).toContain("✔ passed");
    expect(lines[0]).toContain("1 lane");
    expect(lines[0]).toContain("2h ago");
    expect(lines[1]).toContain("53c0889#1");
    expect(lines[1]).toContain("✗ failed");
    expect(lines[1]).toContain("2 lanes");
    expect(lines[1]).toContain("5h ago");
  });

  it("distinguishes an incomplete run from a completed failure", () => {
    const out = renderRuns([record({ outcome: "incomplete" })], now);
    expect(out).toContain("✗ incomplete");
  });

  it("flags a dirty-tree run's sha", () => {
    const out = renderRuns([record({ dirty: true })], now);
    expect(out).toContain("26d2c2d+dirty");
  });

  it("surfaces unposted GitHub statuses on the verdict line", () => {
    const out = renderRuns(
      [
        record({
          unposted: [
            { context: "ci::unit@x86_64-linux", lastError: "403" },
          ],
        }),
      ],
      now,
    );
    expect(out).toContain("✔ passed, 1 status never reached GitHub");
  });
});
