import { afterEach, describe, expect, it } from "bun:test";
import { pendingNode, type PipelineState } from "@odu/run-client/surface";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import { cancelNodeOrPlatform, cancelRun } from "./cancel";

function state(): PipelineState {
  return {
    name: "test",
    sha7: "abc1234",
    dirty: false,
    order: ["ci::e2e@x86_64-linux"],
    nodes: {
      "ci::e2e@x86_64-linux": {
        ...pendingNode({
          id: "ci::e2e@x86_64-linux",
          name: "ci::e2e",
          command: "just e2e",
          needs: [],
        }),
        status: "running",
      },
    },
  };
}

const open: TestSurface[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
async function serve(onCancel?: (close: () => void) => void): Promise<TestSurface> {
  const s = await serveTestSurface(state(), undefined, { onCancel });
  open.push(s);
  return s;
}

describe("cancelRun", () => {
  it("is a clean no-op when no run is live (no socket)", async () => {
    const result = await cancelRun("/no/such/odu.sock", {
      settleTimeoutMs: 200,
      pollMs: 20,
    });
    expect(result).toEqual({ cancelled: false, confirmed: true });
  });

  it("cancels a live run and confirms its socket is gone", async () => {
    const s = await serve((close) => close());
    const result = await cancelRun(s.socketPath, {
      settleTimeoutMs: 2_000,
      pollMs: 20,
    });
    expect(s.cancels()).toBe(1);
    expect(result).toEqual({ cancelled: true, confirmed: true });
  });

  it("reports unconfirmed when the run is asked to stop but doesn't tear down", async () => {
    const s = await serve();
    const result = await cancelRun(s.socketPath, {
      settleTimeoutMs: 150,
      pollMs: 30,
    });
    expect(s.cancels()).toBe(1);
    expect(result).toEqual({ cancelled: true, confirmed: false });
  });
});

describe("cancelNodeOrPlatform", () => {
  it("is a no-op delivery when no run is live", async () => {
    const result = await cancelNodeOrPlatform(
      "ci::e2e@x86_64-linux",
      "/no/such/odu.sock",
    );
    expect(result).toEqual({ kind: "no_run" });
  });

  it("rejects a bare @ as a bad target (not no_run)", async () => {
    const result = await cancelNodeOrPlatform("@", "/no/such/odu.sock");
    expect(result).toEqual({ kind: "bad_target" });
  });

  it("delivers node.cancel for a fan-in node id", async () => {
    const s = await serve();
    const result = await cancelNodeOrPlatform(
      "ci::e2e@x86_64-linux",
      s.socketPath,
    );
    expect(result).toEqual({ kind: "delivered", ok: true });
    expect(s.nodeCancels).toEqual(["ci::e2e@x86_64-linux"]);
    expect(s.laneCancels).toEqual([]);
    expect(s.cancels()).toBe(0);
  });

  it("delivers lane.cancel for @platform sugar", async () => {
    const s = await serve();
    const result = await cancelNodeOrPlatform("@aarch64-darwin", s.socketPath);
    expect(result).toEqual({ kind: "delivered", ok: true });
    expect(s.laneCancels).toEqual(["aarch64-darwin"]);
    expect(s.nodeCancels).toEqual([]);
    expect(s.cancels()).toBe(0);
  });
});
