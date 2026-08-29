/**
 * The rules the verdict gate follows, each one falsifiable on its own.
 *
 * The defect these exist for needs a 14 MB recipe, a real socket and a real ssh
 * lane to show end-to-end (`tests/e2e/logs.e2e.test.ts`); what it is MADE of is
 * five small rules about when a node's outcome may be told to the world, and
 * every one of them is a few lines here. The e2e proves the bug is gone; these
 * prove which rule would have to break for it to come back.
 */

import { describe, expect, it } from "bun:test";
import type { NodeState, NodeStatus } from "../common/surface";
import { createVerdictGate, type VerdictGate } from "./verdictGate";

/** A run of `ids`, with the gate wired to a recording fan-in. The doubles are
 *  the two facts the gate reads — what this run has PUBLISHED for a node, and
 *  whether that node's log has ended — and the drain it bounds a hold with. */
function harness(ids: string[]): {
  gate: VerdictGate;
  /** Everything the gate put on the fan-in, in order. */
  published: Array<[string, Partial<NodeState>]>;
  /** The status a reader of the fan-in would see. */
  statusOf: (id: string) => NodeStatus | undefined;
  endLog: (id: string) => void;
  /** Resolve the pending drain, the way a lane going silent (and stamping)
   *  ends one for real. */
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

/** The gate's own async work (the bound) settles on the microtask queue; give
 *  it a turn before asking what the fan-in has seen. */
const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the verdict gate", () => {
  it("withholds a terminal verdict until that node's log has ended", () => {
    const h = harness(["a", "b"]);
    h.gate.offer("a", { status: "running" });
    expect(h.statusOf("a")).toBe("running");

    // The recipe finished. Its output has not arrived.
    h.gate.offer("a", { status: "ok", exitCode: 0 });
    expect(h.statusOf("a")).toBe("running");

    // …and now it has. The verdict follows the bytes, never precedes them.
    h.endLog("a");
    h.gate.release("a");
    expect(h.statusOf("a")).toBe("ok");
    expect(h.published.at(-1)).toEqual(["a", { status: "ok", exitCode: 0 }]);
  });

  it("publishes at once when the log already ended", () => {
    const h = harness(["a"]);
    h.endLog("a");
    h.gate.offer("a", { status: "failed", exitCode: 1 });
    // Nothing to wait for: the log said its last word first. A gate that held
    // anyway would cost every fast node a drain it does not need.
    expect(h.statusOf("a")).toBe("failed");
  });

  it("drops a held verdict when the node starts over", () => {
    const h = harness(["a"]);
    h.gate.offer("a", { status: "running" });
    h.gate.offer("a", { status: "failed", exitCode: 1 });
    // A rerun: the runner re-opens the log with a fresh snapshot, so the
    // verdict being held describes an invocation that no longer exists.
    h.gate.offer("a", { status: "pending", exitCode: null });
    expect(h.statusOf("a")).toBe("pending");
    h.endLog("a");
    h.gate.release("a");
    // Nothing resurrected: `release` publishes what is held, and the rerun
    // withdrew it.
    expect(h.statusOf("a")).toBe("pending");
  });

  it("does not re-hold a verdict it has already published", () => {
    const h = harness(["a"]);
    h.gate.offer("a", { status: "running" });
    h.gate.offer("a", { status: "ok", exitCode: 0 });
    // Released against a log that never ended — the truncated case, where the
    // `end` frame is never coming.
    h.gate.releaseAll();
    expect(h.statusOf("a")).toBe("ok");
    // A lane repeats its whole state on every frame. A gate that held this one
    // again would take a settled node back off the fan-in and hang the run on
    // a terminal that will never arrive.
    h.gate.offer("a", { status: "ok", exitCode: 0 });
    expect(h.statusOf("a")).toBe("ok");
  });

  it("bounds the hold once the DAG is done and only output is outstanding", async () => {
    const h = harness(["a", "b"]);
    h.gate.offer("a", { status: "running" });
    h.gate.offer("b", { status: "running" });

    h.gate.offer("a", { status: "ok", exitCode: 0 });
    // `b` is still running: the run is nowhere near settling, so nothing is
    // waiting on `a`'s log yet and there is nothing to bound.
    expect(h.drains).toBe(0);

    h.gate.offer("b", { status: "ok", exitCode: 0 });
    // Now the DAG is done and two verdicts are held. A hold with no bound is
    // an un-settleable run, so the drain arms — exactly once, however many
    // frames arrive while it runs.
    expect(h.drains).toBe(1);
    h.gate.boundIfOnlyLogsOutstanding();
    expect(h.drains).toBe(1);
    expect(h.statusOf("a")).toBe("running");

    // The drain gives up (it has stamped the truncation into each log by now).
    // The verdicts go out regardless: a log that says it is short is the
    // honest end of a bad case; a verdict held forever is not an end at all.
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

    // One lane dies; its held verdicts are the truth about nodes that already
    // finished, and must be published before that lane's nodes are
    // terminalized. The other lane is still streaming and keeps its hold.
    h.gate.releaseAll((id) => id.endsWith("@x"));
    expect(h.statusOf("a@x")).toBe("ok");
    expect(h.statusOf("b@y")).toBe("running");
  });
});
