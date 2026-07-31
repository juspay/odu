import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { NodeLogFrame, PipelineState, RunHeader } from "../common/surface";
import { postingWarning } from "../coordinator/statuses";
import { postingOf } from "../common/surface";
import { LiveView } from "./liveView";

async function* snap(): AsyncGenerator<NodeLogFrame> {
  yield { kind: "snapshot", text: "waiting\n" };
}

const base: PipelineState = {
  name: "ci::default",
  sha7: "3cbac86",
  dirty: false,
  order: ["ci::e2e@x86_64-linux"],
  nodes: {
    "ci::e2e@x86_64-linux": {
      id: "ci::e2e@x86_64-linux",
      name: "ci::e2e",
      command: "just e2e",
      needs: [],
      status: "running",
      exitCode: null,
      startedAt: 940_000,
      durationMs: null,
    },
  },
  posting: { owed: [] },
};

const header: RunHeader = {
  commitUrl: "https://github.com/juspay/odu/commit/3cbac86",
  lanes: [{ platform: "x86_64-linux", host: "builder-01" }],
  hostsSource: "~/.config/odu/hosts.json",
  startedAt: 940_000,
};

const owed = {
  owed: [
    {
      context: "odu/ci::e2e@x86_64-linux",
      state: "failure" as const,
      description: "failed",
      attempts: 3,
      lastError: "HTTP 403 rate limited",
    },
  ],
};

describe("probe", () => {
  it("frame with posting debt", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = new LiveView({
      interactive: true,
      hookStderr: false,
      openLog: () => snap(),
      rerun: () => {},
      onQuit: () => {},
      createRenderer: async () => setup.renderer,
    });
    view.start(base, header);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 30));
    view.update({ ...base, posting: owed } as PipelineState);
    await setup.flush();
    const f = setup.captureCharFrame();
    console.log("=== WARNING TEXT ===", postingWarning(postingOf({ posting: owed } as PipelineState)));
    console.log("=== FRAME ===\n" + f);
    console.log("contains github?", f.includes("github"));

    // now the poster's onLine path
    view.info("[odu] status post failed for odu/ci::e2e@x86_64-linux (attempt 3): HTTP 403");
    await setup.flush();
    const f2 = setup.captureCharFrame();
    console.log("=== FRAME AFTER info() ===\n" + f2);
    console.log("contains failure line?", f2.includes("status post failed"));
    view.stop();
    expect(true).toBe(true);
  });
});
