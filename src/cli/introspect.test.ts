/**
 * `odu monitor`'s non-interactive stream, exercised over a real unix socket
 * (the same harness the MCP face uses). The point of juspay/odu#4: a piped
 * `monitor` must emit the *same* json/plain contract as a piped `run`, not a
 * drifted re-implementation. These dial a served surface, run the stream, and
 * assert the json carries `recipe`/`platform`/`log` and the plain lines use
 * `run`'s glyph + ProgressStatus wording.
 */

import { afterEach, describe, expect, it } from "vitest";
import { pendingNode, type PipelineState } from "../common/surface";
import { dialSocket } from "../coordinator/socket";
import { serveTestSurface, type TestSurface } from "../mcp/serveForTest";
import { monitorStream, statusCommand } from "./introspect";

type Row = [
  id: string,
  status: PipelineState["nodes"][string]["status"],
  exitCode?: number,
];

// A settled pipeline: monitorStream's first snapshot is already done, so it
// emits one transition per terminal node and returns.
function doneState(rows: Row[]): PipelineState {
  const order = rows.map(([id]) => id);
  const nodes: Record<string, PipelineState["nodes"][string]> = {};
  for (const [id, status, exitCode] of rows) {
    nodes[id] = {
      ...pendingNode({ id, name: id, command: "echo", needs: [] }),
      status,
      exitCode: exitCode ?? null,
      durationMs: 1_000,
    };
  }
  return { name: "ci::default", sha7: "3cbac86", dirty: false, order, nodes };
}

const open: TestSurface[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** Run `fn` with process.stdout captured; returns what it wrote + fn's result. */
async function capturingStdout<T>(
  fn: () => Promise<T>,
): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out: chunks.join(""), result };
  } finally {
    process.stdout.write = original;
  }
}

async function served(state: PipelineState): Promise<TestSurface> {
  const surface = await serveTestSurface(state);
  open.push(surface);
  return surface;
}

/** Serve `state`, run the stream against it, capture stdout. */
async function streamOf(
  state: PipelineState,
  json: boolean,
): Promise<{ out: string; code: number }> {
  const surface = await served(state);
  const { client, close } = await dialSocket(surface.socketPath);
  const { out, result } = await capturingStdout(() =>
    monitorStream(client, close, json),
  );
  return { out, code: result };
}

describe("monitorStream — json", () => {
  it("emits the full ProgressEvent contract, not a node-status-only shape", async () => {
    const { out, code } = await streamOf(
      doneState([
        ["ci::install@x86_64-linux", "ok", 0],
        ["ci::e2e@x86_64-linux", "failed", 2],
      ]),
      true,
    );
    const events = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(events).toContainEqual({
      node: "ci::install@x86_64-linux",
      recipe: "ci::install",
      platform: "x86_64-linux",
      status: "success",
      exit_code: 0,
      log: ".ci/3cbac86/x86_64-linux/ci::install.log",
    });
    expect(events).toContainEqual({
      node: "ci::e2e@x86_64-linux",
      recipe: "ci::e2e",
      platform: "x86_64-linux",
      status: "failed",
      exit_code: 2,
      log: ".ci/3cbac86/x86_64-linux/ci::e2e.log",
    });
    // The fan-in red verdict propagates to the exit code, as `run` does.
    expect(code).toBe(1);
  });
});

describe("monitorStream — plain", () => {
  it("uses run's glyph + ProgressStatus wording and a log ref on failure", async () => {
    const { out } = await streamOf(
      doneState([["ci::e2e@x86_64-linux", "failed", 2]]),
      false,
    );
    // Banner collapses to pipeline @ sha for an observer (no lanes / hosts).
    expect(out).toContain("odu · ci::default @ 3cbac86");
    expect(out).not.toContain("(hosts:");
    // `✗ failed  …` (ProgressStatus wording) — not the old `failed   <id>`
    // NodeStatus line, and never the raw `ok` wording for green nodes.
    expect(out).toMatch(/✗ failed\s+ci::e2e@x86_64-linux/);
    expect(out).toContain("→ .ci/3cbac86/x86_64-linux/ci::e2e.log");
  });

  it("renders green nodes as success, the wording the old monitor got wrong", async () => {
    const { out } = await streamOf(
      doneState([["ci::install@x86_64-linux", "ok", 0]]),
      false,
    );
    expect(out).toMatch(/✔ success\s+ci::install@x86_64-linux/);
  });
});

// `odu status` is the third plain face onto the same fan-in state; it must use
// the same ProgressStatus wording as run/monitor (lens hickey-2), not the raw
// NodeStatus (`ok`).
describe("statusCommand — plain", () => {
  it("renders the snapshot with run/monitor's wording (success, not ok)", async () => {
    const surface = await served(
      doneState([
        ["ci::install@x86_64-linux", "ok", 0],
        ["ci::e2e@x86_64-linux", "failed", 2],
      ]),
    );
    const { out, result } = await capturingStdout(() =>
      statusCommand(false, surface.socketPath),
    );
    expect(out).toMatch(/✔ success\s+ci::install@x86_64-linux/);
    expect(out).toMatch(/✗ failed\s+ci::e2e@x86_64-linux/);
    expect(out).not.toMatch(/\bok\b/); // the old NodeStatus wording is gone
    expect(result).toBe(1);
  });
});
