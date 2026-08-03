/**
 * Frame-level tests for the live view. These assert what the terminal actually
 * shows — opentui's test renderer gives us the rendered cells as text — rather
 * than the shape of a string the old renderer happened to build. That is the
 * point: the defects being fixed here (a frame that outgrew its region, a log
 * pane pinned to twelve rows, a resize that smeared) were all invisible to
 * string-equality tests and obvious in a captured frame.
 */

import { Stream } from "effect";
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

/** A one-frame log stream — the shape `openLog` hands the view now that both
 *  its producers (the runner.s in-memory tail, a socket `nodeLog.get`) return a
 *  lazy `Stream`. */
function snapshot(text: string): Stream.Stream<NodeLogFrame> {
  return Stream.make({ kind: "snapshot" as const, text });
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
    // The line is 150 chars. On a terminal this wide the matrix sits beside
    // the pane, so the pane is not the full 150 — but it is far past the
    // fallback's 76 columns, which is the whole point of the assertion.
    expect(wide.replace(/[^y]/g, "").length).toBeGreaterThan(100);
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
    // Anchored to the start of the line: the pane's border title also contains
    // "e2e" (it names the focused node) AND a `›` from its ‹follow› marker, so
    // a bare `includes` reads the title's geometry instead of the matrix's.
    const e2eRow = (f: string) =>
      f.split("\n").find((l) => /^[›\s]\s*e2e\s/.test(l)) ?? "";
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
      openLog: (id: string): Stream.Stream<NodeLogFrame> => {
        if (id === "ci::install@x86_64-linux") {
          // Emits, then PARKS until released — the superseded subscription this
          // test is about. Built from an async generator so the park is
          // expressible; `Stream.fromAsyncIterable` is the bridge.
          return Stream.fromAsyncIterable(
            (async function* (): AsyncGenerator<NodeLogFrame> {
              yield { kind: "snapshot" as const, text: "INITIAL-A\n" };
              await new Promise<void>((r) => {
                releaseStale = r;
              });
              yield { kind: "append" as const, text: "STALE-FROM-A\n" };
            })(),
            (e) => e,
          ) as Stream.Stream<NodeLogFrame>;
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

describe("LiveView — the log scrollbar", () => {
  const longLog = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`;
  /** The gutter column: the last cell of each row inside the pane border. */
  const thumbRows = (frame: string): number[] => {
    const out: number[] = [];
    frame.split("\n").forEach((l, i) => {
      if (l.includes("█")) out.push(i);
    });
    return out;
  };

  it("shows a thumb once the log outgrows the pane", async () => {
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");
    expect(thumbRows(frame()).length).toBeGreaterThan(0);
    view.stop();
  });

  it("stays blank while everything fits", async () => {
    // A scrollbar that is always full is noise, not information.
    const { view, setup, frame } = await mount(96, 30, { log: "one\ntwo\n" });
    await until(setup, () => frame().includes("two"), "the short log");
    expect(thumbRows(frame())).toEqual([]);
    view.stop();
  });

  it("moves the thumb up as you scroll back", async () => {
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");
    const atTail = thumbRows(frame());
    expect(atTail.length).toBeGreaterThan(0);
    view.withLog((l) => l.toTop());
    await until(
      setup,
      () => thumbRows(frame())[0] !== atTail[0],
      "the thumb to move",
    );
    const atTop = thumbRows(frame());
    // Scrolled to the top of the buffer, the thumb sits above where it was.
    expect(atTop[0]).toBeLessThan(atTail[0] ?? 0);
    view.stop();
  });
});

describe("LiveView — mouse", () => {
  /** The terminal row a matrix recipe was drawn on. */
  const rowOf = (frame: string, recipe: string): number =>
    frame.split("\n").findIndex((l) => l.includes(recipe));

  it("clicking a matrix row focuses that node", async () => {
    const { view, setup, frame } = await mount(96, 30);
    const y = rowOf(frame(), "install");
    expect(y).toBeGreaterThan(0);
    await setup.mockMouse.click(4, y);
    await until(
      setup,
      () => frame().includes("ci::install@"),
      "the pane to follow the click",
    );
    // The pane title names the clicked node, so focus really moved.
    expect(frame()).toContain("ci::install@");
    view.stop();
  });

  it("clicking the second platform's cell focuses THAT platform", async () => {
    // The matrix is 2D and a click specifies a cell, not a row. Resolving only
    // the row and keeping the previously-focused platform sent every click to
    // the first lane — clicking the second host focused the first host's node.
    const { view, setup, frame } = await mount(96, 30);
    const rows = frame().split("\n");
    const y = rows.findIndex((l) => l.includes("install"));
    const header = rows[y - 1] ?? ""; // the matrix column header
    const firstColumn = header.indexOf("x86_64-linux");
    const secondColumn = header.indexOf("aarch64-darwin");
    expect(secondColumn).toBeGreaterThan(0);
    // Start on the FIRST lane, or "keep the current platform" would land on
    // darwin by accident and the test would pass against the bug.
    await setup.mockMouse.click(firstColumn + 1, y);
    await until(
      setup,
      () => frame().includes("ci::install@x86_64-linux"),
      "focus on the first lane",
    );
    await setup.mockMouse.click(secondColumn + 1, y);
    await until(
      setup,
      () => frame().includes("ci::install@aarch64-darwin"),
      "the second lane's node",
    );
    expect(frame()).toContain("ci::install@aarch64-darwin");
    expect(frame()).not.toContain("ci::install@x86_64-linux —");
    view.stop();
  });

  it("clicking the first platform's cell focuses THAT platform", async () => {
    const { view, setup, frame } = await mount(96, 30);
    const rows = frame().split("\n");
    const y = rows.findIndex((l) => l.includes("install"));
    const header = rows[y - 1] ?? ""; // the matrix column header
    const firstColumn = header.indexOf("x86_64-linux");
    await setup.mockMouse.click(firstColumn + 1, y);
    await until(
      setup,
      () => frame().includes("ci::install@x86_64-linux"),
      "the first lane's node",
    );
    expect(frame()).toContain("ci::install@x86_64-linux");
    view.stop();
  });

  it("clicking a gap cell does nothing rather than guessing", async () => {
    // `typecheck` runs only on linux in this fixture, so its darwin cell is a
    // gap. Snapping to a neighbour would focus a node the operator never
    // pointed at.
    const gapped: PipelineState = {
      ...state,
      order: [...state.order, "ci::typecheck@x86_64-linux"],
      nodes: {
        ...state.nodes,
        "ci::typecheck@x86_64-linux": node("ci::typecheck@x86_64-linux", "ok", 9000),
      },
    };
    const { view, setup, frame } = await mount(96, 30, { on: gapped });
    const before = frame().split("\n").find((l) => l.includes("‹")) ?? "";
    const rows = frame().split("\n");
    const y = rows.findIndex((l) => l.includes("typecheck"));
    const header = rows[y - 1] ?? ""; // the matrix column header
    await setup.mockMouse.click(header.indexOf("aarch64-darwin") + 1, y);
    await setup.flush();
    // Focus did not move to some neighbouring node.
    expect(frame().split("\n").find((l) => l.includes("‹")) ?? "").toBe(before);
    view.stop();
  });

  it("clicking a matrix row pins focus, as hjkl does", async () => {
    // Auto-follow must stop, or the next state push would yank the operator
    // back to whatever is running.
    const { view, setup, frame } = await mount(96, 30);
    const y = rowOf(frame(), "install");
    await setup.mockMouse.click(4, y);
    await until(setup, () => frame().includes("ci::install@"), "the click");
    view.update(state); // a push that would re-seed focus if it were unlocked
    await setup.flush();
    expect(frame()).toContain("ci::install@");
    view.stop();
  });

  it("the wheel scrolls the log and unpins the tail", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const { view, setup, frame } = await mount(96, 30, { log: `${lines}\n` });
    await until(setup, () => frame().includes("line 79"), "the log tail");
    expect(frame()).toContain("‹follow›");
    const shown = frame().split("\n");
    const paneY = shown.findIndex((l) => l.includes("‹follow›")) + 4;
    // The matrix sits beside the pane on a terminal this wide, so a column
    // picked near the left edge is over the matrix and the wheel never
    // reaches the log. Aim inside the pane's own border.
    const paneX = (shown[2] ?? "").indexOf("┌") + 5;
    await setup.mockMouse.scroll(paneX, paneY, "up");
    await until(setup, () => frame().includes("‹pinned›"), "the tail to unpin");
    // Scrolling up moved away from the newest line.
    expect(frame()).not.toContain("line 79");
    view.stop();
  });

  it("clicking a status hint runs it", async () => {
    // The bar says `r rerun`; clicking it should rerun, through the same
    // BINDINGS entry the key uses.
    const reran: string[] = [];
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const view = new LiveView(makeOpts({ setup, rerun: (id) => reran.push(id) }));
    view.start(state, header);
    await settle(setup);
    const frame = () => setup.captureCharFrame();
    const rows = frame().split("\n");
    const barY = rows.findIndex((l) => l.includes("r rerun"));
    expect(barY).toBeGreaterThan(0);
    const barX = (rows[barY] ?? "").indexOf("r rerun");
    await setup.mockMouse.click(barX + 1, barY);
    await until(setup, () => reran.length > 0, "the rerun hint");
    expect(reran).toEqual(["ci::e2e@aarch64-darwin"]);
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

/** A pipeline of `n` recipes across two platforms — the shape that reduced the
 *  log pane to a single row, because the matrix was sized to its content and
 *  the pane took whatever was left. */
function manyRecipes(n: number): PipelineState {
  const platforms = ["x86_64-linux", "aarch64-darwin"];
  const order: string[] = [];
  const nodes: Record<string, NodeState> = {};
  for (let i = 0; i < n; i++) {
    for (const platform of platforms) {
      const id = `ci::recipe-${String(i).padStart(2, "0")}@${platform}`;
      order.push(id);
      nodes[id] = node(id, "ok", 1_000 + i);
    }
  }
  return {
    name: "ci::default",
    sha7: "3cbac86",
    dirty: false,
    order,
    nodes,
    posting: { owed: [] },
  };
}

const logLines = (n: number): string =>
  `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
/** Rows of actual log on screen — the number the layout exists to protect. */
const logRowCount = (f: string): number =>
  f.split("\n").filter((l) => /line \d+/.test(l)).length;

describe("LiveView — the frame has two layouts", () => {
  const big = manyRecipes(25);

  it("sits the matrix beside the log when the terminal is wide enough", async () => {
    // 25 recipes on a 33-row terminal left the pane exactly one row: the
    // matrix is sized to its content and the pane took the remainder. Across
    // instead of down, the pane's height stops depending on the recipe count.
    const { view, setup, frame } = await mount(130, 33, {
      on: big,
      log: logLines(120),
    });
    await until(setup, () => logRowCount(frame()) > 0, "the log");
    const rows = frame().split("\n");
    // The proof of "beside": one line holds a matrix row AND the pane's border.
    const shared = rows.find((l) => /recipe-00/.test(l));
    expect(shared).toBeDefined();
    expect(shared).toContain("│");
    expect(logRowCount(frame())).toBeGreaterThanOrEqual(20);
    // Every recipe is still there — the log's height cost the matrix nothing.
    expect(frame()).toContain("recipe-24");
    view.stop();
  });

  it("keeps the log a floor of rows when it has to stack", async () => {
    // Too narrow to sit side by side, so the matrix yields height instead —
    // the case that used to produce a one-row pane.
    const { view, setup, frame } = await mount(70, 33, {
      on: big,
      log: logLines(120),
    });
    await until(setup, () => logRowCount(frame()) > 0, "the log");
    expect(logRowCount(frame())).toBeGreaterThanOrEqual(8);
    view.stop();
  });

  it("says how many recipes it is holding back rather than just stopping", async () => {
    // A matrix that ends at the terminal's edge reads as a shorter pipeline.
    const { view, setup, frame } = await mount(70, 33, {
      on: big,
      log: logLines(120),
    });
    await until(setup, () => /⋯ \d+ more/.test(frame()), "the held-back count");
    expect(frame()).toMatch(/⋯ \d+ more/);
    view.stop();
  });

  it("clicks the recipe under the pointer once the matrix has scrolled", async () => {
    // The window offset has to be part of resolving a click. Without it a
    // click reads the unwindowed list and focuses whatever recipe WOULD have
    // been at that row — the same defect as a click resolving only the row.
    const { view, setup, frame } = await mount(70, 33, {
      on: big,
      log: logLines(10),
    });
    await until(setup, () => /⋯ \d+ more/.test(frame()), "a windowed matrix");
    // Drive focus down until the window has scrolled off the first recipe.
    for (let i = 0; i < 24; i++) setup.mockInput.pressKey("j");
    await until(
      setup,
      () => !frame().includes("recipe-00"),
      "the matrix to scroll",
    );

    // Read a recipe's name straight off the screen, click that line, and the
    // pane must end up showing that same recipe.
    const rows = frame().split("\n");
    const y = rows.findIndex((l) => /^[›\s]\s*recipe-\d\d\s/.test(l));
    const name = (rows[y] ?? "").match(/recipe-\d\d/)?.[0] ?? "";
    expect(name).not.toBe("");
    await setup.mockMouse.click(4, y);
    await until(
      setup,
      () => frame().includes(`ci::${name}@`),
      `the pane to show ${name}`,
    );
    view.stop();
  });

  it("still names the focused node when the pane is narrower than the terminal", async () => {
    // opentui draws a border title only when it fits ENTIRELY, so a title
    // built for the full terminal width is dropped outright beside the matrix
    // — taking with it the one place the frame names what you are reading.
    const { view, setup, frame } = await mount(90, 30);
    await until(
      setup,
      () => frame().includes("ci::e2e@aarch64-darwin"),
      "the pane title",
    );
    expect(frame()).toContain("‹follow›");
    view.stop();
  });
});

/**
 * Every affordance the frame presents, exercised once.
 *
 * The failure this guards against is shipping the DRAWN half of a feature
 * without the WIRED half: mouse reporting enabled with no listener, a scrollbar
 * that renders but cannot be grabbed, an events lane that names a node but does
 * nothing when clicked. Each of those shipped, and each was found by a human
 * looking at the screen rather than by a test.
 *
 * A new interactive region belongs here on the day it is added.
 */
/** Real terminal sequences. `pressKey("pageup")` types the LETTERS p-a-g-e-u-p,
 *  whose `g` means "jump to top" — so a test written that way exercises a
 *  different binding and reports success. `KeyCodes` has no paging entries. */
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const ESCAPE = "\u001b";
const HOME = "\u001b[H";
const END = "\u001b[F";

describe("LiveView — every affordance is wired", () => {
  const longLog = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`;

  it("drag the scrollbar thumb to move through the log", async () => {
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");
    const rows = () => frame().split("\n");
    // len-1 is the pane border; the gutter sits just inside it.
    const gutterX = (rows()[6] ?? "").length - 2;
    const thumbY = rows().findIndex((l) => l.includes("█"));
    expect(thumbY).toBeGreaterThan(0);
    // Grab the thumb and drag it up.
    await setup.mockMouse.pressDown(gutterX, thumbY);
    await setup.mockMouse.drag(gutterX, thumbY, gutterX, thumbY - 5);
    await until(
      setup,
      () => !frame().includes("line 199"),
      "the drag to move the window",
    );
    expect(frame()).toContain("‹pinned›");
    view.stop();
  });

  it("click the scrollbar track to jump there", async () => {
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");
    const rows = () => frame().split("\n");
    // len-1 is the pane border; the gutter sits just inside it.
    const gutterX = (rows()[6] ?? "").length - 2;
    // The first gutter row, i.e. immediately below the pane title. It maps to
    // window start 0 — a click further down maps proportionally, not to the top.
    const firstGutterRow = rows().findIndex((l) => l.includes("‹follow›")) + 1;
    await setup.mockMouse.click(gutterX, firstGutterRow);
    await until(setup, () => frame().includes("line 0"), "a jump to the top");
    expect(frame()).toContain("line 0");
    expect(frame()).toContain("‹pinned›");
    view.stop();
  });

  it("drag the scrollbar without leaving a selection behind", async () => {
    // opentui runs its own mouse text-selection, so a drag painted a highlight
    // across every cell it crossed and left it there — visible residue on the
    // gutter after every scrollbar drag, with no copy behind it to justify it.
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");
    const rows = () => frame().split("\n");
    const gutterX = (rows()[6] ?? "").length - 2;
    const thumbY = rows().findIndex((l) => l.includes("█"));
    expect(thumbY).toBeGreaterThan(0);
    // A bare drag, NOT pressDown-then-drag: `drag` ends with a release, and a
    // release finishes an empty one-column selection by discarding it. Asserted
    // after that sequence the residue is already gone and the assertion holds
    // whether or not the rows are selectable — which is how the first version
    // of this test passed against the unfixed code.
    await setup.mockMouse.drag(gutterX, thumbY, gutterX, thumbY - 6);
    await setup.flush();
    expect(setup.renderer.hasSelection).toBe(false);
    view.stop();
  });

  it("End jumps to the tail and Home to the top", async () => {
    // The keys someone reaches for when the wheel is not getting them to the
    // end of a long log. `g`/`G` did this already, and neither is guessable.
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");
    setup.mockInput.pressKey(HOME);
    await until(setup, () => frame().includes("line 0"), "Home");
    expect(frame()).toContain("‹pinned›");
    setup.mockInput.pressKey(END);
    await until(setup, () => frame().includes("line 199"), "End");
    // End is "follow the tail again", not merely "scroll there once".
    expect(frame()).toContain("‹follow›");
    view.stop();
  });

  it("click an events-lane entry to read that node's log", async () => {
    const { view, setup, frame } = await mount(96, 30);
    view.transition(
      node("ci::install@x86_64-linux", "failed", 41_000),
      ".odu/logs/x/install.log",
    );
    await until(
      setup,
      () => frame().includes("ci::install@x86_64-linux failed"),
      "the event",
    );
    const y = frame()
      .split("\n")
      .findIndex((l) => l.includes("ci::install@x86_64-linux failed"));
    await setup.mockMouse.click(4, y);
    await until(
      setup,
      () => frame().includes("ci::install@x86_64-linux —"),
      "the pane to follow the event",
    );
    view.stop();
  });

  it("every keyboard binding does something observable", async () => {
    // Not a behaviour test for each key — those exist above. This asserts the
    // dispatch table is wired end to end, so a binding cannot be listed in the
    // status bar and the docs while doing nothing.
    const { view, setup, frame } = await mount(96, 30, { log: longLog });
    await until(setup, () => frame().includes("line 199"), "the log tail");

    setup.mockInput.pressKey("f"); // follow -> pinned
    await until(setup, () => frame().includes("‹pinned›"), "f");
    setup.mockInput.pressKey("g"); // top
    await until(setup, () => frame().includes("line 0"), "g");
    setup.mockInput.pressKey("G"); // tail
    await until(setup, () => frame().includes("line 199"), "G");
    setup.mockInput.pressKey(PAGE_UP);
    await until(setup, () => !frame().includes("line 199"), "PgUp");
    setup.mockInput.pressKey(PAGE_DOWN);
    await until(setup, () => frame().includes("line 199"), "PgDn");
    setup.mockInput.pressKey("/"); // search prompt
    await until(setup, () => frame().includes("esc cancel"), "/");
    setup.mockInput.pressKey(ESCAPE);
    await until(setup, () => !frame().includes("esc cancel"), "escape");
    view.stop();
  });
});
