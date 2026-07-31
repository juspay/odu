import { describe, expect, it } from "bun:test";
import { LogView } from "./logView";

/** Feed raw bytes the way the live view does when a surface frame lands: a
 *  `snapshot` frame resets the buffer first, an `append` just writes. */
async function feed(view: LogView, text: string, kind: "snapshot" | "append" = "append") {
  if (kind === "snapshot") view.reset();
  await view.write(text);
}

const visible = (view: LogView): string[] =>
  view.rows().map((r) => r.text).filter((t) => t !== "");

describe("LogView — a terminal, not a string buffer", () => {
  it("overwrites in place on a carriage return instead of piling up lines", async () => {
    const view = new LogView(60, 6);
    // What `nix build` actually emits: one progress line, redrawn.
    for (let pct = 0; pct <= 100; pct += 10) {
      await feed(view, `\rbuilding [${"#".repeat(pct / 10).padEnd(10)}] ${pct}%`);
    }
    const rows = visible(view);
    // The old renderer split on \n and showed eleven lines of stale progress;
    // the emulator collapses them to the one line the producer intended.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("100%");
    view.dispose();
  });

  it("measures a wide glyph as two cells (the code-point count was wrong)", async () => {
    const view = new LogView(10, 4);
    await feed(view, "東京東京東京\r\n");
    // Six double-width glyphs in ten columns wrap after five — a code-point
    // count would have said they all fit.
    expect(view.total).toBeGreaterThan(1);
    view.dispose();
  });

  it("resets on a snapshot frame and appends on a delta", async () => {
    const view = new LogView(40, 6);
    await feed(view, "first\r\n");
    await feed(view, "second\r\n");
    expect(visible(view).join("\n")).toContain("first");
    await feed(view, "fresh\r\n", "snapshot");
    const rows = visible(view).join("\n");
    expect(rows).toContain("fresh");
    expect(rows).not.toContain("first");
    view.dispose();
  });

  it("pads the window so pane geometry never depends on how much was logged", async () => {
    const view = new LogView(40, 8);
    await feed(view, "one\r\n");
    expect(view.rows()).toHaveLength(8);
    view.dispose();
  });
});

describe("LogView — disposal", () => {
  it("a write in flight when the view is disposed touches nothing", async () => {
    // xterm defers its write callback, and a focus change disposes the old view
    // synchronously — so the continuation lands after dispose() and reads a
    // disposed buffer. xterm reports that by printing a stack trace, which is
    // raw library chatter on the operator's terminal: the exact failure this
    // view exists to prevent. Note it goes through console.error, NOT
    // process.stderr.write — a stderr spy sees nothing and passes either way.
    const shouted: string[] = [];
    const realError = console.error;
    const realWarn = console.warn;
    console.error = (...a: unknown[]) => shouted.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => shouted.push(a.map(String).join(" "));
    try {
      const view = new LogView(60, 6);
      const inFlight: Promise<void>[] = [];
      for (let i = 0; i < 200; i++) inFlight.push(view.write(`line ${i}\r\n`));
      view.dispose(); // focus moved on while those were still in flight
      await Promise.allSettled(inFlight);
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      console.error = realError;
      console.warn = realWarn;
    }
    expect(shouted.join("")).not.toContain("DisposableStore");
  });
});

describe("LogView — reflow", () => {
  it("still shows the log after the pane is widened", async () => {
    // Widening rejoins wrapped lines, so the written extent SHRINKS. A
    // high-water mark that survives the reflow points the window past the end
    // of the content and the pane paints blank — on a settled node it never
    // self-heals, because no further write pushes the extent back up. That is
    // exactly the node an operator widens their terminal to read.
    const view = new LogView(20, 5);
    for (let i = 0; i < 4; i++) await feed(view, `line ${i} with enough text to wrap at twenty columns\r\n`);
    expect(visible(view).length).toBeGreaterThan(0);
    view.resize(80, 5);
    expect(visible(view).length).toBeGreaterThan(0);
    expect(visible(view).join("\n")).toContain("line 3");
    view.dispose();
  });
});

describe("LogView — line endings", () => {
  it("starts each line at column 0, even after a bare newline", async () => {
    // odu captures a child's stdout through a PIPE, so the tty never
    // translated \n to \r\n. A terminal moves down and keeps the column, which
    // made every line after a progress bar start where the previous one ended.
    const view = new LogView(60, 6);
    await feed(view, "building [####] 100%");
    await feed(view, "\n  ✓ done\n");
    const rows = view.rows().map((r) => r.text).filter((t) => t !== "");
    const done = rows.find((t) => t.includes("done"));
    expect(done).toBeDefined();
    // Two leading spaces from the producer, not thirty from the cursor.
    expect(done?.startsWith("  ✓")).toBe(true);
    view.dispose();
  });
});

describe("LogView — colour", () => {
  it("carries the producer's own colours out of the emulator", async () => {
    // translateToString flattens attributes away, which rendered every node's
    // output in one foreground. A failing test's red is information.
    const view = new LogView(60, 4);
    await feed(view, "\u001b[31mFAILED\u001b[0m plain \u001b[32mok\u001b[0m\r\n");
    const row = view.rows().find((r) => r.text.includes("FAILED"));
    expect(row).toBeDefined();
    const coloured = (row?.spans ?? []).filter((sp) => sp.fg !== undefined);
    expect(coloured.length).toBeGreaterThanOrEqual(2);
    expect(coloured.map((sp) => sp.text.trim())).toContain("FAILED");
    expect(coloured.map((sp) => sp.text.trim())).toContain("ok");
    // The two differ — red and green did not collapse to one colour.
    const hues = new Set(coloured.map((sp) => sp.fg));
    expect(hues.size).toBeGreaterThanOrEqual(2);
    view.dispose();
  });

  it("leaves default-coloured text without a hue for the pane to own", async () => {
    const view = new LogView(60, 4);
    await feed(view, "just ordinary output\r\n");
    const row = view.rows().find((r) => r.text.includes("ordinary"));
    expect((row?.spans ?? []).every((sp) => sp.fg === undefined)).toBe(true);
    view.dispose();
  });
});

describe("LogView — anchoring", () => {
  async function scrolled(): Promise<LogView> {
    const view = new LogView(40, 5);
    for (let i = 0; i < 40; i++) await feed(view, `line ${i}\r\n`);
    return view;
  }

  it("follows the tail by default", async () => {
    const view = await scrolled();
    expect(view.following).toBe(true);
    expect(visible(view).join("\n")).toContain("line 39");
    view.dispose();
  });

  it("unpins the tail as soon as you scroll, and G re-pins it", async () => {
    const view = await scrolled();
    view.scrollBy(-10);
    expect(view.following).toBe(false);
    expect(visible(view).join("\n")).not.toContain("line 39");
    view.toBottom();
    expect(view.following).toBe(true);
    expect(visible(view).join("\n")).toContain("line 39");
    view.dispose();
  });

  it("g goes to the first line — the top of a long failure", async () => {
    const view = await scrolled();
    view.toTop();
    expect(visible(view).join("\n")).toContain("line 0");
    view.dispose();
  });

  it("keeps following as new output arrives, but not once pinned", async () => {
    const view = await scrolled();
    await feed(view, "newest\r\n");
    expect(visible(view).join("\n")).toContain("newest");
    view.toggleFollow(); // pin
    await feed(view, "after-pin\r\n");
    expect(visible(view).join("\n")).not.toContain("after-pin");
    view.dispose();
  });
});

describe("LogView — search", () => {
  it("counts matches across the whole buffer, not just the visible window", async () => {
    const view = new LogView(40, 4);
    for (let i = 0; i < 30; i++) {
      await feed(view, i % 10 === 0 ? "AssertionError here\r\n" : `line ${i}\r\n`);
    }
    view.setQuery("assertionerror");
    expect(view.matches).toBe(3);
    view.dispose();
  });

  it("jumps to a match and marks the row for highlighting", async () => {
    const view = new LogView(40, 4);
    for (let i = 0; i < 30; i++) await feed(view, `line ${i}\r\n`);
    await feed(view, "needle\r\n");
    view.setQuery("needle");
    view.next();
    const hit = view.rows().find((r) => r.match);
    expect(hit?.text).toContain("needle");
    view.dispose();
  });

  it("recounts after a \\r redraw that leaves the line count alone", async () => {
    // The memo used to be keyed on the line count, which is precisely the one
    // key a VT invalidates without changing: `\r`/cursor-up redraws rewrite the
    // text in place, and the status bar reported a stale count for the rest of
    // the search.
    const view = new LogView(40, 4);
    await feed(view, "needle\r\n");
    view.setQuery("needle");
    expect(view.matches).toBe(1);
    await view.write("\x1b[1A\rhaystack\r\n");
    expect(view.matches).toBe(0);
    view.dispose();
  });

  it("takes the consumer's query at construction, so a focus change keeps it", async () => {
    const view = new LogView(40, 4, "NEEDLE");
    await feed(view, "a needle here\r\n");
    expect(view.matches).toBe(1);
    view.dispose();
  });

  it("an empty query clears matches", async () => {
    const view = new LogView(40, 4);
    await feed(view, "needle\r\n");
    view.setQuery("needle");
    expect(view.matches).toBe(1);
    view.setQuery("");
    expect(view.matches).toBe(0);
    expect(view.rows().every((r) => !r.match)).toBe(true);
    view.dispose();
  });
});
