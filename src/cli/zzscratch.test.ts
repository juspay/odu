import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { NodeLogFrame, PipelineState, RunHeader } from "../common/surface";
import { LiveView } from "./liveView";

const state: PipelineState = {
  name: "ci::default",
  sha7: "3cbac86",
  dirty: false,
  order: ["ci::install@x86_64-linux"],
  nodes: {
    "ci::install@x86_64-linux": {
      id: "ci::install@x86_64-linux",
      name: "i",
      command: "c",
      needs: [],
      status: "ok",
      exitCode: 0,
      startedAt: 1,
      durationMs: 41_000,
    },
  },
  posting: { owed: [] },
};

const header: RunHeader = {
  commitUrl: null,
  lanes: [{ platform: "x86_64-linux", host: "builder-01" }],
  hostsSource: null,
  startedAt: 940_000,
};

async function* snap(): AsyncGenerator<NodeLogFrame> {
  yield { kind: "snapshot", text: "hi\n" };
}

describe("scratch: settled attach", () => {
  it("start()+stop() in one tick", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = new LiveView({
      interactive: true,
      hookStderr: false,
      openLog: () => snap(),
      rerun: () => {},
      onQuit: () => {},
      createRenderer: async () => setup.renderer,
    });
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    let err: unknown;
    try {
      view.start(state, header);
      view.stop(state);
    } catch (e) {
      err = e;
    } finally {
      process.stdout.write = orig;
    }
    console.log("threw:", err);
    console.log("chunks:", JSON.stringify(chunks));
    console.log("destroyed right after stop:", setup.renderer.isDestroyed);
    await new Promise((r) => setTimeout(r, 30));
    console.log("destroyed after mount settles:", setup.renderer.isDestroyed);
    expect(true).toBe(true);
  });
});
