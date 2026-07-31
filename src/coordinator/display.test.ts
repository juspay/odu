import { describe, expect, it } from "bun:test";
import type {
  NodeLogFrame,
  NodeState,
  PipelineState,
} from "../common/surface";
import {
  clampLine,
  createDisplay,
  progressEvent,
  renderRunFrame,
  stepFocus,
} from "./display";

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
  commitUrl: "https://github.com/juspay/kolu/commit/3cbac86f",
  lanes: [
    { platform: "x86_64-linux", host: "kolu-ci-5" },
    { platform: "aarch64-darwin", host: "rasam" },
  ],
  hostsSource: "~/.config/odu/hosts.json",
  startedAt: 940_000,
};

// ANSI is auto-disabled off-TTY (bun test), so frames are plain strings here.
describe("renderRunFrame", () => {
  const frame = renderRunFrame({
    state,
    header,
    tick: 4,
    startedAt: 940_000,
    now: 1_540_000,
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

  it("summarizes counts (the busiest-node footer is gone — the log pane replaces it)", () => {
    expect(frame).toContain("3 ok");
    expect(frame).toContain("1 running");
    expect(frame).toContain("1 failed");
    // The matrix frame no longer carries a tail line; the focused log pane (a
    // separate render, openLog-fed) is the live view's log surface now.
    expect(frame).not.toContain("Scenario: canvas maximize");
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

  it("marks the focused cell per platform, not the whole recipe row", () => {
    // Same recipe, two platforms — the focus marker must land on the focused
    // lane's cell only, so `r`'s target is unambiguous in a matrix run.
    const linux = renderRunFrame({
      state,
      header,
      tick: 0,
      startedAt: 940_000,
      now: 1_540_000,
      columns: 100,
      focusedId: "ci::e2e@x86_64-linux",
    });
    const darwin = renderRunFrame({
      state,
      header,
      tick: 0,
      startedAt: 940_000,
      now: 1_540_000,
      columns: 100,
      focusedId: "ci::e2e@aarch64-darwin",
    });
    // The e2e row's two renderings differ — the cell marker moves with the
    // focused platform, so they are not byte-identical (the old per-recipe bug).
    const e2eRow = (f: string): string =>
      f.split("\n").find((l) => /^› e2e\s/.test(l)) ?? "";
    expect(e2eRow(linux)).not.toBe(e2eRow(darwin));
    expect(e2eRow(linux)).not.toBe("");
    expect(e2eRow(darwin)).not.toBe("");
  });

  it("names the commit, marking a dirty live-tree run loudly", () => {
    expect(frame.split("\n")[0]).toContain("@ 3cbac86");
    const dirtyFrame = renderRunFrame({
      state: { ...state, dirty: true },
      header,
      tick: 0,
      startedAt: 940_000,
      now: 1_540_000,
      columns: 100,
    });
    expect(dirtyFrame.split("\n")[0]).toContain("@ 3cbac86+dirty");
  });
});

// The shared interactive `live` view: state is push-fed (`update`), the focused
// node's log is pull-fed via the injected `openLog`. Raw-mode key handling isn't
// unit-tested (it needs a real TTY stdin); this locks down that the openLog
// snapshot lands in the painted log pane below the matrix.
describe("LiveDisplay — focused log pane", () => {
  async function* snapshotOnly(text: string): AsyncGenerator<NodeLogFrame> {
    yield { kind: "snapshot", text };
  }

  /** Capture process.stdout while `fn` runs. */
  async function capturing(fn: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("");
  }

  it("paints the focused node's log pane (openLog snapshot) below the matrix", async () => {
    const out = await capturing(async () => {
      const view = createDisplay("live", {
        interactive: false, // off-TTY unit env: no raw mode, no key wiring
        hookStderr: false,
        openLog: (id) =>
          snapshotOnly(`log of ${id}\nScenario: canvas maximize`),
        rerun: () => {},
        onQuit: () => {},
      });
      view.start(state, header);
      view.update(state); // seeds focus → opens the focused log
      await new Promise((r) => setTimeout(r, 0)); // let openLog yield + repaint
      view.stop(state);
    });
    // The first running node is the default focus (`ci::e2e@x86_64-linux`); its
    // log pane (rule + command + the openLog snapshot) is in the painted frame.
    expect(out).toContain("ci::e2e@x86_64-linux");
    expect(out).toContain("Scenario: canvas maximize");
  });

  // F2: a `run` starts on an all-pending snapshot, so the default focus is the
  // first pending node (`_ci-setup@…`). Focus must auto-follow the run onto the
  // node that goes running, not stay pinned to setup forever.
  it("auto-follows focus onto the running node as lanes go live", async () => {
    const allPending: PipelineState = {
      ...state,
      nodes: Object.fromEntries(
        state.order.map((id) => [id, node(id, "pending")]),
      ),
    };
    const running: PipelineState = {
      ...allPending,
      nodes: {
        ...allPending.nodes,
        "_ci-setup@x86_64-linux": node("_ci-setup@x86_64-linux", "ok", 41_000),
        "ci::install@x86_64-linux": node(
          "ci::install@x86_64-linux",
          "running",
          null,
          1_000_000,
        ),
      },
    };
    const out = await capturing(async () => {
      const view = createDisplay("live", {
        interactive: false,
        hookStderr: false,
        openLog: (id) => snapshotOnly(`LOGPANE for ${id}`),
        rerun: () => {},
        onQuit: () => {},
      });
      view.start(allPending, header); // seeds focus → _ci-setup@x86_64-linux
      await new Promise((r) => setTimeout(r, 0));
      view.update(running); // a node goes live → focus must follow
      await new Promise((r) => setTimeout(r, 0));
      view.stop(running);
    });
    // The final pane is the now-running node's, not the startup setup node's.
    expect(out).toContain("LOGPANE for ci::install@x86_64-linux");
  });

  // F1: a superseded subscription that yields one more frame after focus has
  // moved on (a lagging socket stream) must not write its bytes under the new
  // focus's header. The first node's stream parks on the abort signal, then
  // emits a late frame; it must be dropped, not applied.
  it("drops late frames from a superseded log subscription", async () => {
    async function* lateAfterAbort(
      id: string,
      signal: AbortSignal,
    ): AsyncGenerator<NodeLogFrame> {
      yield { kind: "snapshot", text: `INITIAL ${id}` };
      // Park until this subscription is aborted (focus moved away), then leak
      // one more frame the way a buffered socket stream would.
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { kind: "snapshot", text: `STALE ${id}` };
    }
    const out = await capturing(async () => {
      const view = createDisplay("live", {
        interactive: false,
        hookStderr: false,
        openLog: (id, sig) => lateAfterAbort(id, sig),
        rerun: () => {},
        onQuit: () => {},
      });
      view.start(state, header); // focus → ci::e2e@x86_64-linux
      await new Promise((r) => setTimeout(r, 0));
      // Re-focus by re-seeding onto a different default: a state whose only
      // running node is install moves auto-follow there, aborting e2e's stream.
      view.update({
        ...state,
        nodes: {
          ...state.nodes,
          "ci::e2e@x86_64-linux": node("ci::e2e@x86_64-linux", "ok", 5_000),
          "ci::install@x86_64-linux": node(
            "ci::install@x86_64-linux",
            "running",
            null,
            1_000_000,
          ),
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      view.stop();
    });
    // The new focus's snapshot is shown; the aborted e2e stream's late frame is
    // not (no STALE bytes leak into install's pane).
    expect(out).toContain("INITIAL ci::install@x86_64-linux");
    expect(out).not.toContain("STALE ci::e2e@x86_64-linux");
  });
});

describe("clampLine", () => {
  it("passes a within-budget line through byte-for-byte (links survive)", () => {
    const link = "\x1b]8;;https://x/commit/abc\x1b\\abc\x1b]8;;\x1b\\";
    expect(clampLine(link, 80)).toBe(link);
    expect(clampLine("short", 80)).toBe("short");
  });

  it("truncates to visible width and resets trailing style", () => {
    expect(clampLine("abcdefghij", 4)).toBe("abcd\x1b[0m");
    // ANSI styling doesn't count toward the width budget.
    const styled = "\x1b[31mabcdefghij\x1b[39m";
    const clamped = clampLine(styled, 4);
    expect(clamped.startsWith("\x1b[31mabcd")).toBe(true);
    expect(clamped.endsWith("\x1b[0m")).toBe(true);
    // Width is measured on the visible glyphs only.
    expect(clamped.replace(/\x1b\[[0-9;]*m/g, "")).toBe("abcd");
  });

  it("counts only visible glyphs, not a hyperlink's URL bytes", () => {
    // A short visible label behind a long commit URL: the URL must not push the
    // line over budget (stripAnsi leaves OSC bytes in, so this used to truncate
    // a header that visibly fits).
    const longUrl = `https://example.com/owner/repo/commit/${"a".repeat(60)}`;
    const link = `\x1b]8;;${longUrl}\x1b\\abc\x1b]8;;\x1b\\`;
    expect(clampLine(link, 10)).toBe(link);
  });

  it("closes an OSC 8 link when truncation lands mid-hyperlink", () => {
    // Visible text "abcdefghij" wrapped in an OSC 8 link; clamp to 4 cuts inside
    // the link, so the OSC 8 close must precede the SGR reset (a reset alone
    // does NOT close a hyperlink — it would bleed onto the next row).
    const link = "\x1b]8;;https://x/c\x1b\\abcdefghij\x1b]8;;\x1b\\";
    const clamped = clampLine(link, 4);
    expect(clamped).toBe("\x1b]8;;https://x/c\x1b\\abcd\x1b]8;;\x1b\\\x1b[0m");
    // No dangling open link: the only OSC 8 left is the empty-URI close.
    expect(clamped.endsWith("\x1b]8;;\x1b\\\x1b[0m")).toBe(true);
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
