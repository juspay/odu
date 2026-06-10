import { afterEach, describe, expect, it } from "vitest";
import { pendingNode, type PipelineState } from "../common/surface";
import { logUri, NODES_URI, parseLogUri, ResourcePusher } from "./resources";
import { serveTestSurface, type TestSurface } from "./serveForTest";

function state(
  rows: [string, PipelineState["nodes"][string]["status"]][],
): PipelineState {
  const order = rows.map(([id]) => id);
  const nodes: Record<string, PipelineState["nodes"][string]> = {};
  for (const [id, status] of rows) {
    nodes[id] = {
      ...pendingNode({ id, name: id, command: "echo", needs: [] }),
      status,
    };
  }
  return { name: "test", order, nodes };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const open: TestSurface[] = [];
const pushers: ResourcePusher[] = [];
afterEach(() => {
  for (const p of pushers.splice(0)) p.stop();
  for (const s of open.splice(0)) s.close();
});

describe("uri helpers", () => {
  it("round-trips a log uri", () => {
    expect(parseLogUri(logUri("ci::e2e@x86_64-linux"))).toBe(
      "ci::e2e@x86_64-linux",
    );
    expect(parseLogUri(NODES_URI)).toBeNull();
    expect(parseLogUri("file:///etc/passwd")).toBeNull();
  });
});

describe("ResourcePusher", () => {
  it("pushes an updated notification on a node transition", async () => {
    const s = await serveTestSurface(state([["ci::e2e@x86_64-linux", "running"]]));
    open.push(s);
    const notified: string[] = [];
    const pusher = new ResourcePusher({
      socketPath: s.socketPath,
      notify: (uri) => notified.push(uri),
      retryMs: 50,
    });
    pushers.push(pusher);

    const nodeNotifies = (): number =>
      notified.filter((u) => u === NODES_URI).length;
    pusher.subscribe(NODES_URI);
    // Wait for the initial snapshot's notification so the subscription is
    // provably live before we mutate — otherwise setState can coalesce into
    // the snapshot frame and there's only one push.
    await waitFor(() => nodeNotifies() >= 1);
    const before = nodeNotifies();
    s.setState(state([["ci::e2e@x86_64-linux", "failed"]]));
    await waitFor(() => nodeNotifies() > before);
  });

  it("pushes a log updated notification as output appends", async () => {
    const s = await serveTestSurface(state([["ci::e2e@x86_64-linux", "running"]]));
    open.push(s);
    const notified: string[] = [];
    const pusher = new ResourcePusher({
      socketPath: s.socketPath,
      notify: (uri) => notified.push(uri),
      retryMs: 50,
      logDebounceMs: 10,
    });
    pushers.push(pusher);

    pusher.subscribe(logUri("ci::e2e@x86_64-linux"));
    await waitFor(() => pusher.attached);
    s.appendLog("ci::e2e@x86_64-linux", "scenario failed\n");
    await waitFor(() => notified.includes(logUri("ci::e2e@x86_64-linux")));
  });

  it("detaches when the last subscriber leaves", async () => {
    const s = await serveTestSurface(state([["ci::nix@x86_64-linux", "running"]]));
    open.push(s);
    const pusher = new ResourcePusher({
      socketPath: s.socketPath,
      notify: () => {},
      retryMs: 50,
    });
    pushers.push(pusher);

    pusher.subscribe(NODES_URI);
    await waitFor(() => pusher.attached);
    pusher.unsubscribe(NODES_URI);
    expect(pusher.attached).toBe(false);
  });
});
