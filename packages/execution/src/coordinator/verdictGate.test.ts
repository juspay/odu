import { describe, expect, it } from "bun:test";
import type { NodeState, NodeStatus } from "@odu/run-client/surface";
import { createVerdictGate, type VerdictGate } from "./verdictGate";

function harness(ids: string[]): {
  gate: VerdictGate;
  published: Array<[string, Partial<NodeState>]>;
  statusOf: (id: string) => NodeStatus | undefined;
  endLog: (id: string) => void;
  finishDrain: () => void;
  drains: number;
} {
  const published: Array<[string, Partial<NodeState>]> = [];
  const statuses = new Map<string, NodeStatus>(ids.map((id) => [id, "pending"]));
  const ended = new Set<string>();
  let releaseDrain: () => void = () => {};
  const state = {
    drains: 0,
    gate: undefined as unknown as VerdictGate,
    published,
    statusOf: (id: string) => statuses.get(id),
    endLog: (id: string) => ended.add(id),
    finishDrain: () => releaseDrain(),
  };
  state.gate = createVerdictGate({
    isLogEnded: (id) => ended.has(id),
    publishedStatus: (id) => statuses.get(id),
    nodeIds: () => ids,
    publish: (id, patch) => {
      published.push([id, patch]);
      if (patch.status !== undefined) statuses.set(id, patch.status);
    },
    drainLogs: () => {
      state.drains += 1;
      return new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    },
  });
  return state;
}

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the verdict gate", () => {
  it("withholds a terminal verdict until that node's log has ended", () => {
    const h = harness(["a", "b"]);
    h.gate.offer("a", { status: "running" });
    expect(h.statusOf("a")).toBe("running");

    h.gate.offer("a", { status: "ok", exitCode: 0 });
    expect(h.statusOf("a")).toBe("running");

    h.endLog("a");
    h.gate.release("a");
    expect(h.statusOf("a")).toBe("ok");
    expect(h.published.at(-1)).toEqual(["a", { status: "ok", exitCode: 0 }]);
  });

  it("publishes at once when the log already ended", () => {
    const h = harness(["a"]);
    h.endLog("a");
    h.gate.offer("a", { status: "failed", exitCode: 1 });
    expect(h.statusOf("a")).toBe("failed");
  });

  it("drops a held verdict when the node starts over", () => {
    const h = harness(["a"]);
    h.gate.offer("a", { status: "running" });
    h.gate.offer("a", { status: "failed", exitCode: 1 });
    h.gate.offer("a", { status: "pending", exitCode: null });
    expect(h.statusOf("a")).toBe("pending");
    h.endLog("a");
    h.gate.release("a");
    expect(h.statusOf("a")).toBe("pending");
  });

  it("does not re-hold a verdict it has already published", () => {
    const h = harness(["a"]);
    h.gate.offer("a", { status: "running" });
    h.gate.offer("a", { status: "ok", exitCode: 0 });
    h.gate.releaseAll();
    expect(h.statusOf("a")).toBe("ok");
    h.gate.offer("a", { status: "ok", exitCode: 0 });
    expect(h.statusOf("a")).toBe("ok");
  });

  it("bounds the hold once the DAG is done and only output is outstanding", async () => {
    const h = harness(["a", "b"]);
    h.gate.offer("a", { status: "running" });
    h.gate.offer("b", { status: "running" });

    h.gate.offer("a", { status: "ok", exitCode: 0 });
    expect(h.drains).toBe(0);

    h.gate.offer("b", { status: "ok", exitCode: 0 });
    expect(h.drains).toBe(1);
    h.gate.boundIfOnlyLogsOutstanding();
    expect(h.drains).toBe(1);
    expect(h.statusOf("a")).toBe("running");

    h.finishDrain();
    await turn();
    expect(h.statusOf("a")).toBe("ok");
    expect(h.statusOf("b")).toBe("ok");
  });

  it("releases only the nodes a predicate admits", () => {
    const h = harness(["a@x", "b@y"]);
    h.gate.offer("a@x", { status: "running" });
    h.gate.offer("b@y", { status: "running" });
    h.gate.offer("a@x", { status: "ok", exitCode: 0 });
    h.gate.offer("b@y", { status: "ok", exitCode: 0 });

    h.gate.releaseAll((id) => id.endsWith("@x"));
    expect(h.statusOf("a@x")).toBe("ok");
    expect(h.statusOf("b@y")).toBe("running");
  });
});
