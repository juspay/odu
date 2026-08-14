import { describe, expect, it } from "bun:test";
import type {
  NodeState,
  PipelineState,
  RunHeader,
} from "../common/surface";
import { createDisplay, progressEvent } from "./display";
import { stepFocus } from "../cli/render";

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

const header: RunHeader = {
  commitUrl: "https://github.com/juspay/kolu/commit/3cbac86f",
  lanes: [
    { state: "leased", platform: "x86_64-linux", host: "kolu-ci-5" },
    { state: "leased", platform: "aarch64-darwin", host: "rasam" },
  ],
  hostsSource: "~/.config/odu/hosts.json",
  startedAt: 940_000,
};

const claimingHeader: RunHeader = {
  ...header,
  lanes: [
    {
      state: "claiming",
      platform: "x86_64-linux",
      pool: ["kolu-ci-5", "kolu-ci-6"],
    },
  ],
};

function capturingStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
    return chunks.join("");
  } finally {
    process.stdout.write = original;
  }
}

/** `setHeader` is the ONE way a run environment reaches a face — `start` takes
 *  state alone — so a display can never be handed two headers to arbitrate
 *  between. These pin the two consequences on the plain face. */
describe("PlainDisplay — the run environment arrives through setHeader", () => {
  it("banners the header delivered before start", () => {
    const display = createDisplay("plain");
    const out = capturingStdout(() => {
      display.setHeader(claimingHeader);
      display.start(state);
      display.stop();
    });
    expect(out).toContain("odu · ci::default @ 3cbac86");
    expect(out).toContain("claiming x86_64-linux from kolu-ci-5, kolu-ci-6");
  });

  it("announces the end of provisioning whichever way it ends", () => {
    // The old rule diffed the rendered lane string and refused to announce an
    // EMPTY one, so the claim-failure republish (a roster that resolved to no
    // lanes at all) was silently swallowed and a captured CI log got no line
    // marking the transition out of provisioning.
    const failed = createDisplay("plain");
    const outFailed = capturingStdout(() => {
      failed.setHeader(claimingHeader);
      failed.start(state);
      failed.setHeader({ ...claimingHeader, lanes: [] });
      failed.stop();
    });
    // In the face's own words — `no_lanes` is the JSON contract's enum, not a
    // sentence to print at an operator.
    expect(outFailed).toContain("odu · no lanes — the run got no machine");
    expect(outFailed).not.toContain("no_lanes");

    const resolved = createDisplay("plain");
    const outResolved = capturingStdout(() => {
      resolved.setHeader(claimingHeader);
      resolved.start(state);
      resolved.setHeader(header);
      resolved.stop();
    });
    expect(outResolved).toContain(
      "odu · lanes x86_64-linux=kolu-ci-5 · aarch64-darwin=rasam",
    );
  });

  it("says nothing for a republish that does not change the phase", () => {
    const display = createDisplay("plain");
    const out = capturingStdout(() => {
      display.setHeader(header);
      display.start(state);
      display.setHeader({ ...header, hostsSource: "elsewhere" });
      display.stop();
    });
    expect(out.split("\n").filter((l) => l !== "")).toHaveLength(1);
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

// `stepFocus` is the matrix's hjkl navigation: `j`/`k` move down/up a platform
// column (recipe rows), `h`/`l` left/right a recipe row (platform columns). It
// reads only the node-id `order`, so it's exercised here without a live TTY.
describe("stepFocus — hjkl matrix navigation", () => {
  // The shared `state` fixture is a full 3×2 matrix: rows
  // [_ci-setup, ci::install, ci::e2e] × columns [x86_64-linux, aarch64-darwin].
  const full = state.order;

  it("lands on the first node when nothing is focused yet", () => {
    expect(stepFocus(full, undefined, "j")).toBe("_ci-setup@x86_64-linux");
    expect(stepFocus(full, undefined, "l")).toBe("_ci-setup@x86_64-linux");
  });

  it("j/k walk recipe rows within the focused platform column", () => {
    expect(stepFocus(full, "_ci-setup@x86_64-linux", "j")).toBe(
      "ci::install@x86_64-linux",
    );
    expect(stepFocus(full, "ci::install@x86_64-linux", "k")).toBe(
      "_ci-setup@x86_64-linux",
    );
  });

  it("h/l walk platform columns within the focused recipe row", () => {
    expect(stepFocus(full, "ci::install@x86_64-linux", "l")).toBe(
      "ci::install@aarch64-darwin",
    );
    expect(stepFocus(full, "ci::install@aarch64-darwin", "h")).toBe(
      "ci::install@x86_64-linux",
    );
  });

  it("wraps around each axis", () => {
    // k off the top recipe wraps to the bottom of the same column.
    expect(stepFocus(full, "_ci-setup@x86_64-linux", "k")).toBe(
      "ci::e2e@x86_64-linux",
    );
    // j off the bottom recipe wraps back to the top.
    expect(stepFocus(full, "ci::e2e@x86_64-linux", "j")).toBe(
      "_ci-setup@x86_64-linux",
    );
    // With two columns, h and l from a row both reach the other column.
    expect(stepFocus(full, "_ci-setup@x86_64-linux", "h")).toBe(
      "_ci-setup@aarch64-darwin",
    );
  });

  // A recipe (`linux-only`) that runs on just one platform leaves a `°` gap in
  // the darwin column — navigation must skip those holes, never focusing a cell
  // with no node behind it.
  const sparse = [
    "a@x86_64-linux",
    "linux-only@x86_64-linux",
    "c@x86_64-linux",
    "a@aarch64-darwin",
    "c@aarch64-darwin",
  ];

  it("skips missing cells when stepping down a column", () => {
    // j from a@darwin skips the absent linux-only@darwin to land on c@darwin.
    expect(stepFocus(sparse, "a@aarch64-darwin", "j")).toBe("c@aarch64-darwin");
  });

  it("returns undefined when no other cell exists along the axis", () => {
    // linux-only has no darwin cell, so l/h off it find nothing.
    expect(stepFocus(sparse, "linux-only@x86_64-linux", "l")).toBeUndefined();
    expect(stepFocus(sparse, "linux-only@x86_64-linux", "h")).toBeUndefined();
  });

  it("returns undefined for a single-cell matrix (no move possible)", () => {
    expect(stepFocus(["solo@x86_64-linux"], "solo@x86_64-linux", "j")).toBe(
      undefined,
    );
  });

  it("returns the original id for lane-local ids without an `@`", () => {
    // A bare id splits to the `unknown` platform sentinel; stepping must return
    // the stored id verbatim, not a reconstructed `b@unknown`.
    expect(stepFocus(["a", "b"], "a", "j")).toBe("b");
    expect(stepFocus(["a", "b"], "b", "k")).toBe("a");
  });
});
