/**
 * Frame-level tests for the live view. These assert what the terminal actually
 * shows — opentui's test renderer gives us the rendered cells as text — rather
 * than the shape of a string the old renderer happened to build. That is the
 * point: the defects being fixed here (a frame that outgrew its region, a log
 * pane pinned to twelve rows, a resize that smeared) were all invisible to
 * string-equality tests and obvious in a captured frame.
 */

import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import type {
  NodeLogFrame,
  NodeState,
  PipelineState,
  RunHeader,
} from "../common/surface";
import { LiveView } from "./liveView";

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
    exitCode: status === "failed" ? 1 : null,
    startedAt,
    durationMs,
  };
}

const state: PipelineState = {
  name: "ci::default",
  sha7: "3cbac86",
  dirty: false,
  order: [
    "ci::install@x86_64-linux",
    "ci::install@aarch64-darwin",
    "ci::e2e@x86_64-linux",
    "ci::e2e@aarch64-darwin",
  ],
  nodes: {
    "ci::install@x86_64-linux": node("ci::install@x86_64-linux", "ok", 41_000),
    "ci::install@aarch64-darwin": node(
      "ci::install@aarch64-darwin",
      "ok",
      52_000,
    ),
    "ci::e2e@x86_64-linux": node("ci::e2e@x86_64-linux", "failed", 76_000),
    "ci::e2e@aarch64-darwin": node(
      "ci::e2e@aarch64-darwin",
      "running",
      null,
      940_000,
    ),
  },
  posting: { owed: [] },
};

const header: RunHeader = {
  commitUrl: null,
  lanes: [
    { platform: "x86_64-linux", host: "builder-01" },
    { platform: "aarch64-darwin", host: "mac-mini" },
  ],
  hostsSource: "~/.config/odu/hosts.json",
  startedAt: 940_000,
};

async function* snapshot(text: string): AsyncGenerator<NodeLogFrame> {
  yield { kind: "snapshot", text };
}

interface Mounted {
  view: LiveView;
  setup: TestRendererSetup;
  frame: () => string;
}

/** Mount the view against opentui's test renderer at a given terminal size. */
async function mount(
  width: number,
  height: number,
  over: Partial<Parameters<typeof makeOpts>[0]> = {},
): Promise<Mounted> {
  const setup = await createTestRenderer({ width, height });
  const view = new LiveView(makeOpts({ setup, ...over }));
  view.start(state, header);
  // start() is synchronous and mounts in the background; give it a turn.
  await setup.flush();
  await new Promise((r) => setTimeout(r, 20));
  await setup.flush();
  return { view, setup, frame: () => setup.captureCharFrame() };
}

function makeOpts(o: {
  setup: TestRendererSetup;
  log?: string;
  rerun?: (id: string) => void;
  onQuit?: () => void;
  interactive?: boolean;
}) {
  return {
    interactive: o.interactive ?? true,
    hookStderr: false,
    openLog: () => snapshot(o.log ?? "waiting for output\n"),
    rerun: o.rerun ?? (() => {}),
    onQuit: o.onQuit ?? (() => {}),
    createRenderer: async () => o.setup.renderer,
  };
}

describe("LiveView — the frame", () => {
  it("draws one matrix row per recipe and a column per lane", async () => {
    const { view, frame } = await mount(96, 30);
    const f = frame();
    expect(f).toContain("x86_64-linux");
    expect(f).toContain("aarch64-darwin");
    // `ci::` is stripped in the matrix — the columns carry the platform.
    expect(f).toMatch(/^\s*›?\s*install\s/m);
    expect(f).toMatch(/^\s*›?\s*e2e\s/m);
    view.stop();
  });

  it("shows durations for terminal cells and a ticking clock for running ones", async () => {
    const { view, frame } = await mount(96, 30);
    const f = frame();
    expect(f).toContain("41s");
    expect(f).toContain("1m16s");
    view.stop();
  });

  it("names the commit, marking a dirty tree loudly", async () => {
    const { view, frame } = await mount(96, 30);
    expect(frame()).toContain("@ 3cbac86");
    view.stop();

    const dirty = await mount(96, 30);
    dirty.view.update({ ...state, dirty: true });
    await dirty.setup.flush();
    expect(dirty.frame()).toContain("@ 3cbac86+dirty");
    dirty.view.stop();
  });

  it("paints the focused node's log inside the pane", async () => {
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(
      makeOpts({ setup, log: "Scenario: canvas maximize\nassertion failed\n" }),
    );
    view.start(state, header);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 30));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Scenario: canvas maximize");
    view.stop();
  });

  it("keeps the whole frame inside the terminal — nothing overflows", async () => {
    const { view, setup } = await mount(80, 24);
    const rows = setup.captureCharFrame().split("\n").filter((r) => r !== "");
    expect(rows.length).toBeLessThanOrEqual(24);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(80);
    view.stop();
  });
});

describe("LiveView — the log pane takes the terminal's height", () => {
  /** Rows between the pane's top border and the status bar. */
  const paneRows = (f: string): number => {
    const lines = f.split("\n");
    const top = lines.findIndex((l) => l.includes("ci::"));
    const bottom = lines.findIndex((l, i) => i > top && l.includes("hjkl move"));
    return bottom - top;
  };

  it("gives the pane more rows on a taller terminal (it was always twelve)", async () => {
    const tall = await mount(96, 40);
    const tallRows = paneRows(tall.frame());
    tall.view.stop();

    const short = await mount(96, 20);
    const shortRows = paneRows(short.frame());
    short.view.stop();

    expect(tallRows).toBeGreaterThan(shortRows);
  });

  it("relayouts on resize instead of smearing the old frame", async () => {
    const { view, setup, frame } = await mount(96, 34);
    const before = frame().split("\n").filter((r) => r !== "").length;
    setup.resize(70, 18);
    await setup.flush();
    const after = frame().split("\n").filter((r) => r !== "");
    expect(after.length).toBeLessThan(before);
    expect(after.length).toBeLessThanOrEqual(18);
    for (const row of after) expect(row.length).toBeLessThanOrEqual(70);
    view.stop();
  });
});

describe("LiveView — keys", () => {
  it("q asks the host to quit; the view never exits the process itself", async () => {
    let quit = 0;
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(makeOpts({ setup, onQuit: () => quit++ }));
    view.start(state, header);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 20));
    setup.mockInput.pressKey("q");
    await setup.flush();
    expect(quit).toBe(1);
    view.stop();
  });

  it("r reruns the focused node", async () => {
    const reran: string[] = [];
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(makeOpts({ setup, rerun: (id) => reran.push(id) }));
    view.start(state, header);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 20));
    setup.mockInput.pressKey("r");
    await setup.flush();
    // Focus auto-follows the run, so `r` targets the running node.
    expect(reran).toEqual(["ci::e2e@aarch64-darwin"]);
    view.stop();
  });

  it("hjkl moves the focus marker between cells", async () => {
    const { view, setup, frame } = await mount(96, 30);
    const markedRow = (f: string) =>
      f.split("\n").find((l) => l.includes("›")) ?? "";
    const before = markedRow(frame());
    setup.mockInput.pressKey("k");
    await setup.flush();
    await new Promise((r) => setTimeout(r, 20));
    await setup.flush();
    expect(markedRow(frame())).not.toBe(before);
    view.stop();
  });
});

describe("LiveView — events land in the frame, never in scrollback", () => {
  it("shows a failed transition inside the frame", async () => {
    const { view, setup, frame } = await mount(96, 30);
    view.transition(
      node("ci::e2e@x86_64-linux", "failed", 76_000),
      ".odu/logs/3cbac86/ci::e2e@x86_64-linux.log",
    );
    await setup.flush();
    const f = frame();
    expect(f).toContain("ci::e2e@x86_64-linux failed");
    expect(f).toContain(".odu/logs/3cbac86");
    view.stop();
  });

  it("an info before the frame exists still reaches the operator", () => {
    // `run` builds the display and calls info() during a venue lease that can
    // block for minutes — long before start(). Pre-mount those must go to real
    // stdout or they are simply lost.
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      written.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const view = new LiveView({
        interactive: false,
        hookStderr: false,
        openLog: () => snapshot(""),
        rerun: () => {},
        onQuit: () => {},
      });
      view.info("leasing x86_64-linux…");
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toContain("leasing x86_64-linux");
  });
});
