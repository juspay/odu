import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { PipelineState, RunHeader } from "./src/common/surface";
import { LiveView } from "./src/cli/liveView";
import { postingWarning } from "./src/coordinator/statuses";

const base: PipelineState = {
  name: "ci::default",
  sha7: "3cbac86",
  dirty: false,
  order: ["ci::install@x86_64-linux"],
  nodes: {
    "ci::install@x86_64-linux": {
      id: "ci::install@x86_64-linux",
      name: "ci::install@x86_64-linux",
      command: "just --no-deps ci::install",
      needs: [],
      status: "ok",
      exitCode: null,
      startedAt: null,
      durationMs: 41000,
    },
  },
  posting: {
    owed: [
      { context: "odu/ci::install", attempts: 3, lastError: "HTTP 403 rate limited" },
    ],
  },
};

const header: RunHeader = {
  commitUrl: "https://github.com/juspay/odu/commit/3cbac86",
  lanes: [{ platform: "x86_64-linux", host: "builder-01" }],
  hostsSource: "~/.config/odu/hosts.json",
  startedAt: 940000,
};

describe("probe", () => {
  it("live frame vs posting debt", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = new LiveView({
      interactive: false,
      hookStderr: false,
      openLog: async function* () { yield { kind: "snapshot", text: "hi\n" } as any; },
      rerun: () => {},
      onQuit: () => {},
      createRenderer: async () => setup.renderer,
    } as any);
    view.start(base, header);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 20));
    await setup.flush();
    const f = setup.captureCharFrame();
    console.log("WARNING TEXT:", JSON.stringify(postingWarning(base.posting!)));
    console.log("FRAME:\n" + f);
    console.log("contains github?", f.includes("github"));
    console.log("contains commitUrl?", f.includes("juspay/odu/commit"));
    view.stop();
    expect(true).toBe(true);
  });
});
