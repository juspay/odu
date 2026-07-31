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
  lanes: [{ platform: "x86_64-linux", host: "b1" }],
  hostsSource: "h",
  startedAt: 940_000,
};

async function* snap(): AsyncGenerator<NodeLogFrame> {
  yield { kind: "snapshot", text: "x\n" };
}

describe("verifier-1 probe", () => {
  it("renderer nullability outlives the renderables' — post-stop info() still routes to stdout", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = new LiveView({
      interactive: false,
      hookStderr: false,
      openLog: () => snap(),
      rerun: () => {},
      onQuit: () => {},
      createRenderer: async () => setup.renderer,
    });
    view.start(state, header);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 20));
    await setup.flush();

    const priv = view as unknown as Record<string, unknown>;
    // After the mount, every renderable handle is defined.
    for (const f of [
      "renderer",
      "headLine",
      "laneLine",
      "matrixBox",
      "eventsBox",
      "paneBox",
      "statusLine",
    ]) {
      expect(priv[f]).toBeDefined();
    }
    // The three row arrays are NOT nullable and never were.
    for (const f of ["matrixRows", "eventRows", "paneRows"]) {
      expect(Array.isArray(priv[f])).toBe(true);
    }

    view.stop();

    // stop() clears ONLY the renderer. The six renderables stay defined, so
    // "renderer === undefined" is strictly more than "not mounted yet".
    expect(priv.renderer).toBeUndefined();
    for (const f of [
      "headLine",
      "laneLine",
      "matrixBox",
      "eventsBox",
      "paneBox",
      "statusLine",
    ]) {
      expect(priv[f]).toBeDefined();
    }

    // And that difference is load-bearing: a post-stop info() must reach real
    // stdout, which is decided by the renderer guard alone.
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      written.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      view.info("after stop");
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toContain("after stop");
  });
});
