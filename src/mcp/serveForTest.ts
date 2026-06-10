/**
 * A controllable in-process `oduSurface` served on a real unix socket — the
 * test harness for the MCP/agent face and the introspection commands. Mirrors
 * the coordinator's serve wiring (src/coordinator/run.ts) so consumers are
 * exercised over the same transport they hit in production; the test drives
 * node states and log appends directly. Not a test file (no vitest import), so
 * it isn't collected as a suite — it's imported by the *.test.ts harnesses.
 */

import { mkdtempSync, rmSync } from "node:fs";
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
import {
  EMPTY_HEADER,
  oduSurface,
  type PipelineState,
  type RunHeader,
} from "../common/surface";

export interface TestSurface {
  socketPath: string;
  setState: (state: PipelineState) => void;
  setHeader: (header: RunHeader) => void;
  appendLog: (id: string, text: string) => void;
  resetLog: (id: string, text: string) => void;
  reruns: string[];
  close: () => void;
}

export async function serveTestSurface(
  initial: PipelineState,
  initialHeader: RunHeader = EMPTY_HEADER,
): Promise<TestSurface> {
  const store = inMemoryStore<PipelineState>(initial);
  const headerStore = inMemoryStore<RunHeader>(initialHeader);
  const tail = createLogTail();
  const reruns: string[] = [];

  const fragment = implementSurface(oduSurface, {
    channel: inMemoryChannelByName(),
    cells: { nodes: { store }, header: { store: headerStore } },
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
  const closeListener = await serveSocket(router, socketPath);

  return {
    socketPath,
    setState: (state) => fragment.ctx.cells.nodes.set(state),
    setHeader: (header) => fragment.ctx.cells.header.set(header),
    appendLog: (id, text) => tail.append(id, text),
    resetLog: (id, text) => tail.reset(id, text),
    reruns,
    // Close the listener AND remove the temp dir/socket, so repeated runs don't
    // leak `odu-mcp-test-*` directories under the system tmpdir.
    close: () => {
      closeListener();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
