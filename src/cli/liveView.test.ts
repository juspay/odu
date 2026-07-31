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

/** Mount the view against opentui's test renderer at a given terminal size.
 *  `on` overrides the state to start from — `run` starts all-pending, which is
 *  the case the focus rules are actually about. */
async function mount(
  width: number,
  height: number,
  over: Partial<Parameters<typeof makeOpts>[0]> & { on?: PipelineState } = {},
): Promise<Mounted> {
  const { on, ...rest } = over;
  const setup = await createTestRenderer({ width, height });
  const view = new LiveView(makeOpts({ setup, ...rest }));
  view.start(on ?? state, header);
  // start() is synchronous and mounts in the background.
  await settle(setup);
  return { view, setup, frame: () => setup.captureCharFrame() };
}

/** Wait for a condition, flushing as we go — never for a fixed duration.
 *
 *  The mount is async, log frames arrive on their own schedule, and repaints
 *  are coalesced into a 100ms tick, so "sleep a bit then assert" encodes an
 *  assumption about how fast the machine is. It held here and failed on a
 *  loaded CI runner. Polling costs nothing when the condition is already true
 *  and simply waits longer when it is not. */
async function until(
  setup: TestRendererSetup,
  predicate: () => boolean,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    await setup.flush();
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The frame has been painted at least once — the mount landed and a tick ran. */
async function settle(setup: TestRendererSetup): Promise<void> {
  await until(
    setup,
    () => setup.captureCharFrame().trim() !== "",
    "the first frame",
  );
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

  it("keeps the commit URL out of the header text", async () => {
    // The link was once embedded as an OSC 8 escape inside the content string.
    // opentui's cell buffer has no escape parser, so the URL was painted as
    // literal characters: the header showed a 40-char sha and wrapped onto a
    // second row. The URL now rides on the chunk, not in the text.
    const withUrl: RunHeader = {
      ...header,
      commitUrl: "https://github.com/juspay/odu/commit/1c787fbdeadbeef0123456789abcdef012345678",
    };
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(makeOpts({ setup }));
    view.start(state, withUrl);
    await settle(setup);
    const f = setup.captureCharFrame();
    expect(f).toContain("3cbac86");
    expect(f).not.toContain("github.com");
    expect(f).not.toContain("deadbeef");
    view.stop();
  });

  it("paints the focused node's log inside the pane", async () => {
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(
      makeOpts({ setup, log: "Scenario: canvas maximize\nassertion failed\n" }),
    );
    view.start(state, header);
    await until(
      setup,
      () => setup.captureCharFrame().includes("Scenario: canvas maximize"),
      "the focused node's log",
    );
    expect(setup.captureCharFrame()).toContain("Scenario: canvas maximize");
    view.stop();
  });

  it("keeps the chrome on screen on a small terminal", async () => {
    // Asserting rows <= height would be vacuous: captureCharFrame decodes a
    // width x height cell buffer, so an overflowing frame is clipped before the
    // assertion sees it. What overflow actually destroys is the chrome — the
    // status bar is the last thing drawn, so it is the first thing lost.
    const { view, setup } = await mount(80, 24);
    const rows = setup.captureCharFrame().split("\n").filter((r) => r.trim() !== "");
    expect(rows[rows.length - 1]).toContain("hjkl move");
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

  it("wraps the log at the pane's own inner width, not a guessed inset", async () => {
    // The emulator's column count and the width opentui actually draws into
    // must be the same number. They were derived independently
    // (`terminalWidth - 4` against a bordered box's real inner width), so long
    // lines broke mid-word two columns early — visible in a real run as ragged
    // continuation lines.
    const { view, frame } = await mount(96, 30, { log: `${"z".repeat(240)}\n` });
    const lines = frame().split("\n");
    const border = lines.find((l) => l.includes("┌")) ?? "";
    const inner = border.trimEnd().length - 2; // the box's own left/right border
    const zRows = lines
      .filter((l) => l.includes("z"))
      .map((l) => (l.match(/z/g) ?? []).length);
    expect(inner).toBeGreaterThan(0);
    // Every row but the last is a full-width wrap.
    expect(zRows.slice(0, -1)).toEqual(zRows.slice(0, -1).map(() => inner));
    view.stop();
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
    await settle(setup);
    setup.mockInput.pressKey("q");
    await until(setup, () => quit > 0, "the quit callback");
    expect(quit).toBe(1);
    view.stop();
  });

  it("r reruns the focused node", async () => {
    const reran: string[] = [];
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(makeOpts({ setup, rerun: (id) => reran.push(id) }));
    view.start(state, header);
    await settle(setup);
    setup.mockInput.pressKey("r");
    await until(setup, () => reran.length > 0, "the rerun callback");
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
    await until(setup, () => markedRow(frame()) !== before, "focus to move");
    expect(markedRow(frame())).not.toBe(before);
    view.stop();
  });
});

describe("LiveView — mount ordering", () => {
  // Display.start() is synchronous while opentui's mount is async, so every
  // other entry point can run before the renderer exists. These pin the two
  // orderings that broke when that was only half-handled.

  it("a renderer that fails to open degrades instead of killing the run", async () => {
    // An unhandled rejection out of the fire-and-forget mount would pick odu's
    // exit code, and odu owns that.
    const errs: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      errs.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stderr.write;
    let view: LiveView | undefined;
    try {
      view = new LiveView({
        interactive: false,
        hookStderr: true,
        openLog: () => snapshot(""),
        rerun: () => {},
        onQuit: () => {},
        createRenderer: () => Promise.reject(new Error("no tty here")),
      });
      view.start(state, header);
      const deadline = Date.now() + 4000;
      while (!errs.join("").includes("live view unavailable")) {
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      process.stderr.write = original;
    }
    expect(errs.join("")).toContain("live view unavailable");
    expect(errs.join("")).toContain("no tty here");
    view?.stop();
  });

  it("sizes the log pane to the real terminal, not the pre-mount fallback", async () => {
    // Focus (and the emulator) is seeded before the mount, when paneCols() can
    // only answer with the 80x24 fallback. If the mount doesn't push the real
    // geometry, the pane wraps at 76 columns forever on a wide terminal.
    const { view, setup, frame } = await mount(160, 30, {
      log: `${"y".repeat(150)}\n`,
    });
    await until(setup, () => frame().includes("yyy"), "the wide log line");
    const wide = frame().split("\n").find((l) => l.includes("yyy")) ?? "";
    // The line is 150 chars: visible in full only if the emulator knows it has
    // more than the fallback's 76 columns.
    expect(wide.replace(/[^y]/g, "").length).toBeGreaterThan(120);
    view.stop();
  });
});

describe("LiveView — the terminal comes back even when nothing else runs", () => {
  it("destroys the renderer even when stop() lands in start()'s own turn", async () => {
    // `attach` onto a settled run does start() → see done → stop() with no
    // await between, then `process.exit()` — which abandons pending
    // microtasks. In production the window is closed structurally: the renderer
    // is constructed synchronously and only `setupTerminal()` is awaited, so
    // `this.renderer` is assigned before any escape reaches the terminal. Here
    // the test seam is necessarily async, so this pins the other half — that
    // the teardown completes and destroys, whichever side gets there first.
    const setup = await createTestRenderer({ width: 96, height: 30 });
    let destroyed = 0;
    const realDestroy = setup.renderer.destroy.bind(setup.renderer);
    setup.renderer.destroy = () => {
      destroyed++;
      realDestroy();
    };
    const view = new LiveView(makeOpts({ setup }));
    view.start(state, header);
    view.stop(state); // same synchronous turn
    await until(setup, () => destroyed > 0, "the renderer to be destroyed");
    expect(destroyed).toBeGreaterThan(0);
  });

  it("replays a diagnostic that scrolled out of the two-row events lane", async () => {
    // The events lane is a 2-row display ring, so a fatal line followed by any
    // two others has already been shifted out by teardown. Replaying the ring
    // could therefore never surface the message the replay exists for.
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const errs: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      errs.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stderr.write;
    // Constructed inside the capture: the view binds its writers up front.
    const view = new LiveView(makeOpts({ setup }));
    try {
      view.start(state, header);
      await settle(setup);
      view.info("FATAL: venue lock lost");
      view.info("noise one");
      view.info("noise two");
      // A run that did not end clean — the case the replay is for.
      view.stop(state);
    } finally {
      process.stderr.write = original;
    }
    expect(errs.join("")).toContain("FATAL: venue lock lost");
  });

  it("stays quiet on a clean run instead of re-printing the chatter", async () => {
    const clean: PipelineState = {
      ...state,
      nodes: {
        ...state.nodes,
        "ci::e2e@x86_64-linux": node("ci::e2e@x86_64-linux", "ok", 76_000),
        "ci::e2e@aarch64-darwin": node("ci::e2e@aarch64-darwin", "ok", 80_000),
      },
    };
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const errs: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      errs.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stderr.write;
    const view = new LiveView(makeOpts({ setup }));
    try {
      view.start(clean, header);
      await settle(setup);
      view.info("provisioning chatter");
      view.stop(clean);
    } finally {
      process.stderr.write = original;
    }
    expect(errs.join("")).not.toContain("provisioning chatter");
  });

  it("does not leak an exit listener when the mount failed", async () => {
    const before = process.listenerCount("exit");
    const view = new LiveView({
      interactive: false,
      hookStderr: false,
      openLog: () => snapshot(""),
      rerun: () => {},
      onQuit: () => {},
      createRenderer: () => Promise.reject(new Error("no tty")),
    });
    view.start(state, header);
    // The mount must have settled (and failed) before stop(), or this asserts
    // the wrong branch.
    const settled = Date.now() + 4000;
    while (process.listenerCount("exit") === before) {
      if (Date.now() > settled) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    view.stop(state);
    const gone = Date.now() + 4000;
    while (process.listenerCount("exit") !== before) {
      if (Date.now() > gone) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // stop() after a settled-but-failed mount must complete the teardown; the
    // listener is only removed there.
    expect(process.listenerCount("exit")).toBe(before);
  });
});

describe("LiveView — focus and the log subscription", () => {
  /** What `odu run` actually starts from: nothing has been scheduled yet. */
  const allPending: PipelineState = {
    ...state,
    nodes: Object.fromEntries(
      state.order.map((id) => [id, node(id, "pending")]),
    ),
  };

  /** …and what it looks like once a lane picks a node up. */
  const oneRunning: PipelineState = {
    ...allPending,
    nodes: {
      ...allPending.nodes,
      "ci::e2e@aarch64-darwin": node(
        "ci::e2e@aarch64-darwin",
        "running",
        null,
        940_000,
      ),
    },
  };

  it("auto-follows focus onto the running node as lanes go live", async () => {
    // `run` start()s on an all-pending snapshot and update()s as lanes come up,
    // so focus must walk off the startup node onto the running one. The pane
    // title is the readout: it names the focused node.
    const { view, setup, frame } = await mount(96, 30, { on: allPending });
    expect(frame()).toContain("ci::install@x86_64-linux");
    expect(frame()).not.toContain("ci::e2e@aarch64-darwin");

    view.update(oneRunning);
    await setup.flush();
    await settle(setup);

    expect(frame()).toContain("ci::e2e@aarch64-darwin");
    expect(frame()).not.toContain("ci::install@x86_64-linux");
    view.stop();
  });

  it("stops auto-following once a key picks a node by hand", async () => {
    // The other half of the same rule: `focusLocked`. An operator reading a
    // node must not have the pane yanked away by the next state push.
    const { view, setup, frame } = await mount(96, 30, { on: allPending });
    setup.mockInput.pressKey("j"); // install → e2e, same platform column
    await setup.flush();
    await settle(setup);
    expect(frame()).toContain("ci::e2e@x86_64-linux");

    view.update(oneRunning);
    await setup.flush();
    await settle(setup);

    expect(frame()).toContain("ci::e2e@x86_64-linux");
    expect(frame()).not.toContain("ci::e2e@aarch64-darwin");
    view.stop();
  });

  it("marks the focused CELL per platform, not the whole recipe row", async () => {
    // A past bug marked every cell of the focused recipe. Focus starts on
    // e2e@aarch64-darwin; `h` steps to the other platform on the SAME row, so
    // the row marker must stay put while the cell marker moves.
    const { view, setup, frame } = await mount(96, 30);
    const e2eRow = (f: string) =>
      f.split("\n").find((l) => l.includes("e2e")) ?? "";
    const before = e2eRow(frame());
    setup.mockInput.pressKey("h");
    await setup.flush();
    await settle(setup);
    const after = e2eRow(frame());

    expect(before.indexOf("›")).toBe(after.indexOf("›"));
    expect(before.indexOf("▸")).toBeGreaterThanOrEqual(0);
    expect(after.indexOf("▸")).not.toBe(before.indexOf("▸"));
    view.stop();
  });

  it("carries the search query onto the newly focused node's log", async () => {
    // The query lived in two objects, and a focus change built a fresh buffer
    // with an empty one: `n` silently did nothing. `n` finding a hit unpins the
    // tail, which the pane title reports.
    const lines = Array.from({ length: 40 }, (_, i) =>
      i === 0 ? "needle here" : `line ${i}`,
    ).join("\n");
    const { view, setup, frame } = await mount(96, 30, { log: `${lines}\n` });
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("needle");
    setup.mockInput.pressEnter();
    await setup.flush();
    await settle(setup);

    setup.mockInput.pressKey("j"); // focus a different node — new LogView
    await setup.flush();
    await settle(setup);
    expect(frame()).toContain("‹follow›");

    setup.mockInput.pressKey("n");
    await setup.flush();
    await settle(setup);
    expect(frame()).toContain("‹pinned›");
    view.stop();
  });

  it("drops late frames from a superseded log subscription", async () => {
    // F1: a fast focus switch can leave the previous stream yielding after
    // focus moved on. Applying it would paint one node's bytes under another's
    // header.
    let releaseStale: (() => void) | undefined;
    const opts = {
      interactive: true,
      hookStderr: false,
      openLog: (id: string): AsyncIterable<NodeLogFrame> => {
        if (id === "ci::install@x86_64-linux") {
          return {
            async *[Symbol.asyncIterator]() {
              yield { kind: "snapshot" as const, text: "INITIAL-A\n" };
              await new Promise<void>((r) => {
                releaseStale = r;
              });
              yield { kind: "append" as const, text: "STALE-FROM-A\n" };
            },
          };
        }
        return snapshot("FRESH-FROM-B\n");
      },
      rerun: () => {},
      onQuit: () => {},
    };
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView({
      ...opts,
      createRenderer: async () => setup.renderer,
    });
    view.start(state, header);
    await settle(setup);
    // Move focus, then let the superseded stream yield.
    setup.mockInput.pressKey("1");
    await setup.flush();
    setup.mockInput.pressKey("j");
    await until(
      setup,
      () => setup.captureCharFrame().includes("FRESH-FROM-B"),
      "the new focus's log",
    );
    releaseStale?.();
    // The stale frame, if it were going to leak, would arrive on the next few
    // ticks — give it every chance to before asserting it did not.
    for (let i = 0; i < 20; i++) {
      await setup.flush();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(setup.captureCharFrame()).not.toContain("STALE-FROM-A");
    view.stop();
  });
});

describe("LiveView — keys", () => {
  it("Ctrl-C quits even with the search prompt open", async () => {
    // Raw mode means no SIGINT, and the renderer is configured not to exit on
    // its own — so if the search prompt swallows Ctrl-C the operator is stuck
    // on the alternate screen with no way out but guessing esc.
    let quit = 0;
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = new LiveView(makeOpts({ setup, onQuit: () => quit++ }));
    view.start(state, header);
    await settle(setup);
    setup.mockInput.pressKey("/"); // open the search prompt
    await setup.flush();
    setup.mockInput.pressKey("c", { ctrl: true });
    await until(setup, () => quit > 0, "quit from the search prompt");
    expect(quit).toBe(1);
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

  it("stop() prints nothing — verdict-on-exit is the host's policy", async () => {
    // `run` ends with its own printVerdict. A recap from the view too meant the
    // same information twice on every run; the host asks for verdict() instead.
    const { view } = await mount(96, 30);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      written.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      view.stop();
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toBe("");
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
