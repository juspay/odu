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
    "ci::install@aarch64-darwin": node("ci::install@aarch64-darwin", "ok", 52_000),
    "ci::e2e@x86_64-linux": node("ci::e2e@x86_64-linux", "failed", 76_000),
    "ci::e2e@aarch64-darwin": node("ci::e2e@aarch64-darwin", "running", null, 940_000),
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

const LOG = "alpha line\nassert failed here\nbeta\nassert again\ngamma\n";

async function mount(setup: TestRendererSetup) {
  const view = new LiveView({
    interactive: true,
    hookStderr: false,
    openLog: () => snapshot(LOG),
    rerun: () => {},
    onQuit: () => {},
    createRenderer: async () => setup.renderer,
  });
  view.start(state, header);
  await setup.flush();
  await new Promise((r) => setTimeout(r, 30));
  await setup.flush();
  return view;
}

async function settle(setup: TestRendererSetup) {
  await setup.flush();
  await new Promise((r) => setTimeout(r, 20));
  await setup.flush();
}

function statusLine(f: string): string {
  return f.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "";
}

describe("probe: search + focus", () => {
  it("A) while searching, k and digits are QUERY TEXT, not focus moves", async () => {
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = await mount(setup);
    const markedRow = (f: string) =>
      f.split("\n").find((l) => l.includes("›")) ?? "";
    const beforeMark = markedRow(setup.captureCharFrame());

    setup.mockInput.pressKey("/");
    await settle(setup);
    for (const c of "assert") setup.mockInput.pressKey(c);
    await settle(setup);
    console.log("STATUS after /assert :", JSON.stringify(statusLine(setup.captureCharFrame())));

    setup.mockInput.pressKey("k");
    await settle(setup);
    console.log("STATUS after k       :", JSON.stringify(statusLine(setup.captureCharFrame())));
    console.log("MARK before          :", JSON.stringify(beforeMark));
    console.log("MARK after k         :", JSON.stringify(markedRow(setup.captureCharFrame())));

    setup.mockInput.pressKey("1");
    await settle(setup);
    console.log("STATUS after 1       :", JSON.stringify(statusLine(setup.captureCharFrame())));
    console.log("MARK after 1         :", JSON.stringify(markedRow(setup.captureCharFrame())));
    view.stop();
  });

  it("B) after Enter, the status bar leaves search mode entirely", async () => {
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = await mount(setup);
    const peek = (label: string) => {
      const v = view as unknown as { query: string; searching: boolean; log?: { search: string } };
      console.log(
        label,
        "| LiveView.query=", JSON.stringify(v.query),
        "| searching=", v.searching,
        "| LogView.query=", JSON.stringify(v.log?.search),
        "| status=", JSON.stringify(statusLine(setup.captureCharFrame()).trimEnd()),
      );
    };
    setup.mockInput.pressKey("/");
    for (const c of "assert") setup.mockInput.pressKey(c);
    await settle(setup);
    peek("after /assert  ");
    setup.mockInput.pressEnter();
    await settle(setup);
    peek("after Enter    ");
    setup.mockInput.pressKey("k");
    await settle(setup);
    peek("after Enter+k  ");
    setup.mockInput.pressKey("n");
    await settle(setup);
    peek("after n        ");
    view.stop();
  });

  it("C) escape clears both copies", async () => {
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = await mount(setup);
    const v = view as unknown as { query: string; searching: boolean; log?: { search: string } };
    setup.mockInput.pressKey("/");
    for (const c of "assert") setup.mockInput.pressKey(c);
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);
    console.log("after esc: LiveView.query=", JSON.stringify(v.query), "LogView.query=", JSON.stringify(v.log?.search));
    // re-entering search resets both
    setup.mockInput.pressKey("/");
    await settle(setup);
    console.log("after re-/: LiveView.query=", JSON.stringify(v.query), "LogView.query=", JSON.stringify(v.log?.search));
    view.stop();
  });
});

describe("probe: auto-follow during typing", () => {
  it("D) focus auto-follow mid-typing, and whether the next keystroke heals it", async () => {
    const setup = await createTestRenderer({ width: 96, height: 30 });
    const view = await mount(setup);
    const v = view as unknown as { query: string; searching: boolean; focusedId?: string; log?: { search: string } };
    const peek = (label: string) =>
      console.log(label, "| focus=", v.focusedId, "| LiveView.query=", JSON.stringify(v.query),
        "| LogView.query=", JSON.stringify(v.log?.search),
        "| status=", JSON.stringify(statusLine(setup.captureCharFrame()).trimEnd()));

    setup.mockInput.pressKey("/");
    for (const c of "asse") setup.mockInput.pressKey(c);
    await settle(setup);
    peek("mid-typing     ");

    // the running node finishes; another starts -> defaultAttachId moves
    const next: PipelineState = {
      ...state,
      nodes: {
        ...state.nodes,
        "ci::e2e@aarch64-darwin": node("ci::e2e@aarch64-darwin", "ok", 90_000),
        "ci::install@x86_64-linux": node("ci::install@x86_64-linux", "running", null, 940_000),
      },
    };
    view.update(next);
    await settle(setup);
    peek("after autofollow");

    for (const c of "rt") setup.mockInput.pressKey(c);
    await settle(setup);
    peek("after 2 more ch ");
    view.stop();
  });
});
