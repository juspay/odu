import { describe, expect, it } from "vitest";
import type { NodeState, PipelineState } from "../common/surface";
import { progressEvent, renderRunFrame } from "./display";

function node(
  id: string,
  status: NodeState["status"],
  durationMs: number | null = null,
  startedAt: number | null = null,
): NodeState {
  return {
    id,
    name: id,
    command: `just --no-deps ${id}`,
    needs: [],
    status,
    exitCode: null,
    startedAt,
    durationMs,
  };
}

const state: PipelineState = {
  name: "ci::default",
  sha7: "3cbac86",
  dirty: false,
  order: [
    "_ci-setup@x86_64-linux",
    "ci::install@x86_64-linux",
    "ci::e2e@x86_64-linux",
    "_ci-setup@aarch64-darwin",
    "ci::install@aarch64-darwin",
    "ci::e2e@aarch64-darwin",
  ],
  nodes: {
    "_ci-setup@x86_64-linux": node("_ci-setup@x86_64-linux", "ok", 41_000),
    "ci::install@x86_64-linux": node("ci::install@x86_64-linux", "ok", 11_000),
    "ci::e2e@x86_64-linux": node(
      "ci::e2e@x86_64-linux",
      "running",
      null,
      1_000_000,
    ),
    "_ci-setup@aarch64-darwin": node("_ci-setup@aarch64-darwin", "ok", 44_000),
    "ci::install@aarch64-darwin": node(
      "ci::install@aarch64-darwin",
      "failed",
      76_000,
    ),
    "ci::e2e@aarch64-darwin": node("ci::e2e@aarch64-darwin", "pending"),
  },
};

const header = {
  pipeline: "ci::default",
  sha7: "3cbac86",
  dirty: false,
  commitUrl: "https://github.com/juspay/kolu/commit/3cbac86f",
  lanes: [
    { platform: "x86_64-linux", host: "kolu-ci-5" },
    { platform: "aarch64-darwin", host: "rasam" },
  ],
  hostsSource: "~/.config/odu/hosts.json",
};

// ANSI is auto-disabled off-TTY (vitest), so frames are plain strings here.
describe("renderRunFrame", () => {
  const frame = renderRunFrame({
    state,
    header,
    tick: 4,
    startedAt: 940_000,
    now: 1_540_000,
    lastLog: { id: "ci::e2e@x86_64-linux", text: "Scenario: canvas maximize" },
    columns: 100,
  });

  it("renders one row per recipe with a cell per lane", () => {
    expect(frame).toContain("x86_64-linux");
    expect(frame).toContain("aarch64-darwin");
    // ci:: prefix is stripped in the matrix; lanes carry the platform.
    expect(frame).toMatch(/^ {2}e2e\s/m);
    expect(frame).toMatch(/^ {2}install\s/m);
    expect(frame).toContain("_ci-setup");
  });

  it("shows ticking elapsed for running cells, durations for terminal ones", () => {
    expect(frame).toContain("✔ 41s");
    expect(frame).toContain("✗ 1m16s");
    expect(frame).toContain("9m0s"); // running e2e: now - startedAt
  });

  it("summarizes counts and tails the busiest node's log", () => {
    expect(frame).toContain("3 ok");
    expect(frame).toContain("1 running");
    expect(frame).toContain("1 failed");
    expect(frame).toContain("› ci::e2e@x86_64-linux");
    expect(frame).toContain("Scenario: canvas maximize");
  });

  it("ends the header with the run's elapsed wall clock", () => {
    expect(frame.split("\n")[0]).toContain("10m0s");
  });

  it("marks the focused node's recipe row for attach (run passes none)", () => {
    const focused = renderRunFrame({
      state,
      header,
      tick: 0,
      startedAt: 940_000,
      now: 1_540_000,
      columns: 100,
      focusedId: "ci::e2e@x86_64-linux",
    });
    expect(focused).toMatch(/^› e2e\s/m); // focused recipe row carries the marker
    expect(focused).toMatch(/^ {2}install\s/m); // others keep the two-space indent
    // No focusedId (run's path) → no marker, every row two-space indented.
    expect(frame).toMatch(/^ {2}e2e\s/m);
  });

  it("names the commit, marking a dirty live-tree run loudly", () => {
    expect(frame.split("\n")[0]).toContain("@ 3cbac86");
    const dirtyFrame = renderRunFrame({
      state,
      header: { ...header, dirty: true },
      tick: 0,
      startedAt: 940_000,
      now: 1_540_000,
      columns: 100,
    });
    expect(dirtyFrame.split("\n")[0]).toContain("@ 3cbac86+dirty");
  });
});

// The single projection `run` and `attach` share so their json/plain faces
// can't drift (juspay/odu#4). The fields a node-status-only emitter used to
// drop — recipe, platform, log — are what these lock down.
describe("progressEvent", () => {
  it("carries recipe, platform, and the durable per-SHA log path", () => {
    const event = progressEvent(
      "3cbac86",
      "ci::e2e@x86_64-linux",
      node("ci::e2e@x86_64-linux", "running"),
    );
    expect(event).toEqual({
      node: "ci::e2e@x86_64-linux",
      recipe: "ci::e2e",
      platform: "x86_64-linux",
      status: "running",
      log: ".ci/3cbac86/x86_64-linux/ci::e2e.log",
    });
  });

  it("maps NodeStatus to the external ProgressStatus wording", () => {
    const status = (s: NodeState["status"]): string | undefined =>
      progressEvent("3cbac86", `n@p`, node("n@p", s))?.status;
    // `ok` surfaces as `success`, the wording a face that emitted the raw
    // NodeStatus got wrong (issue #4, divergence #2/#3).
    expect(status("ok")).toBe("success");
    expect(status("failed")).toBe("failed");
    expect(status("errored")).toBe("errored");
    expect(status("skipped")).toBe("skipped");
    expect(status("running")).toBe("running");
  });

  it("emits exit_code only once a node carries one", () => {
    const running = progressEvent("abc", "n@p", node("n@p", "running"));
    expect(running && "exit_code" in running).toBe(false);
    const failed = progressEvent("abc", "n@p", {
      ...node("n@p", "failed", 1_000),
      exitCode: 2,
    });
    expect(failed?.exit_code).toBe(2);
  });

  it("returns null for pending — nothing to emit", () => {
    expect(progressEvent("abc", "n@p", node("n@p", "pending"))).toBeNull();
  });
});
