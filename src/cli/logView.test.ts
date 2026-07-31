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
