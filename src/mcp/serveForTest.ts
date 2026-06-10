/**
 * A controllable in-process `oduSurface` served on a real unix socket — the
 * test harness for the MCP face. Mirrors the coordinator's serve wiring
 * (src/coordinator/run.ts) so the MCP tools/resources are exercised over the
 * same transport they hit in production; the test drives node states and log
 * appends directly. Not a test file (no vitest import), so it isn't collected
 * as a suite — it's imported by tools.test.ts / resources.test.ts.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  implementSurface,
  inMemoryChannelByName,
  inMemoryStore,
} from "@kolu/surface/server";
import { implement } from "@orpc/server";
import { createLogTail } from "../common/logTail";
import { serveSocket } from "../coordinator/socket";
import { oduSurface, type PipelineState } from "../common/surface";

export interface TestSurface {
  socketPath: string;
  setState: (state: PipelineState) => void;
  appendLog: (id: string, text: string) => void;
  resetLog: (id: string, text: string) => void;
  reruns: string[];
  close: () => void;
}

export async function serveTestSurface(
  initial: PipelineState,
): Promise<TestSurface> {
  const store = inMemoryStore<PipelineState>(initial);
  const tail = createLogTail();
  const reruns: string[] = [];

  const fragment = implementSurface(oduSurface, {
    channel: inMemoryChannelByName(),
    cells: { nodes: { store } },
    streams: { nodeLog: { source: tail.streamSource } },
    procedures: {
      node: {
        rerun: async ({ input }) => {
          reruns.push(input.id);
          return { ok: true };
        },
      },
    },
  });
  const router = implement(oduSurface.contract).router({ ...fragment.router });

  const dir = mkdtempSync(join(tmpdir(), "odu-mcp-test-"));
  const socketPath = join(dir, "odu.sock");
  // Reuse the coordinator's serve (mkdir + 0700 chmod + outcome handling); it
  // types `router` as `any`, the same oRPC-spread workaround run.ts uses.
  const close = await serveSocket(router, socketPath);

  return {
    socketPath,
    setState: (state) => fragment.ctx.cells.nodes.set(state),
    appendLog: (id, text) => tail.append(id, text),
    resetLog: (id, text) => tail.reset(id, text),
    reruns,
    close,
  };
}
