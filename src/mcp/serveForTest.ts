/**
 * A controllable in-process `oduSurface` served on a real unix socket — the
 * test harness for the MCP/agent face and the introspection commands. Mirrors
 * the coordinator's serve wiring (src/coordinator/run.ts) so consumers are
 * exercised over the same transport they hit in production; the test drives
 * node states and log appends directly. Not a test file (no `bun:test` import,
 * and the name misses the `*.test.ts` glob), so it isn't collected as a suite —
 * it's imported by the *.test.ts harnesses.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementSurface, inMemoryStore } from "@kolu/surface/server";
import { Effect } from "effect";
import {
  EMPTY_HEADER,
  oduSurface,
  type PipelineState,
  type RunHeader,
} from "@odu/run-client/surface";
import { createLogTail } from "../common/logTail";
import { serveSocket, socketLogger } from "../coordinator/socket";

export interface TestSurface {
  socketPath: string;
  setState: (state: PipelineState) => void;
  setHeader: (header: RunHeader) => void;
  appendLog: (id: string, text: string) => void;
  resetLog: (id: string, text: string) => void;
  reruns: string[];
  /** Node ids passed to `node.cancel` over the socket. */
  nodeCancels: string[];
  /** Platforms passed to `lane.cancel` over the socket. */
  laneCancels: string[];
  /** How many times `run.cancel` was called over the socket. */
  cancels: () => number;
  close: () => void;
}

export interface ServeTestOptions {
  /** Pin the socket to a caller-owned path (the coordinator-restart regression
   *  serves two surfaces at the same path in turn). Defaults to a fresh temp
   *  socket the harness owns and removes on `close`. */
  socketPath?: string;
  /** Invoked on a `run.cancel` call. The real coordinator tears down and exits
   *  in response, so a test exercising `cancelRun`'s wait-for-gone closes the
   *  listener here (via the passed `close`) to make the socket disappear. */
  onCancel?: (close: () => void) => void;
}

export async function serveTestSurface(
  initial: PipelineState,
  initialHeader: RunHeader = EMPTY_HEADER,
  /** A bare string is the legacy pinned-socket-path arg; the object form adds
   *  the `onCancel` teardown hook. */
  opts: string | ServeTestOptions = {},
): Promise<TestSurface> {
  const options: ServeTestOptions =
    typeof opts === "string" ? { socketPath: opts } : opts;
  const pinnedSocketPath = options.socketPath;
  const store = inMemoryStore<PipelineState>(initial);
  const headerStore = inMemoryStore<RunHeader>(initialHeader);
  const tail = createLogTail();
  const reruns: string[] = [];
  const nodeCancels: string[] = [];
  const laneCancels: string[] = [];
  let cancels = 0;
  // Forward declaration: the cancel handler can close the listener via the
  // caller's hook, but `closeListener` is only bound after `serveSocket`.
  let closeListener: () => void = () => {};

  const runtime = implementSurface(oduSurface, {
    cells: { nodes: { store }, header: { store: headerStore } },
    streams: { nodeLog: { source: tail.streamSource } },
    procedures: {
      node: {
        rerun: ({ input }) =>
          Effect.sync(() => {
            reruns.push(input.id);
            return { ok: true };
          }),
        cancel: ({ input }) =>
          Effect.sync(() => {
            nodeCancels.push(input.id);
            return { ok: true };
          }),
      },
      run: {
        cancel: () =>
          Effect.sync(() => {
            cancels += 1;
            options.onCancel?.(() => closeListener());
            return { ok: true };
          }),
      },
      lane: {
        cancel: ({ input }) =>
          Effect.sync(() => {
            laneCancels.push(input.platform);
            return { ok: true };
          }),
      },
    },
  });
  const served = { group: runtime.group, handlers: runtime.handlers };

  // A pinned path is caller-owned (the caller removes it); otherwise the harness
  // owns a fresh temp dir + socket and removes them on `close`.
  const dir = pinnedSocketPath ? null : mkdtempSync(join(tmpdir(), "odu-mcp-test-"));
  const socketPath = pinnedSocketPath ?? join(dir as string, "odu.sock");
  // Reuse the coordinator.s serve (mkdir + 0700 chmod + outcome handling) over
  // the same typed { group, handlers } pair run.ts serves.
  // A harness has no operator feed, so listener faults go to stderr — a socket
  // that dies under a test is a bug in the thing under test, never noise.
  closeListener = await serveSocket(
    served,
    socketPath,
    socketLogger((line) => process.stderr.write(`${line}\n`)),
  );

  return {
    socketPath,
    setState: (state) => runtime.ctx.cells.nodes.set(state),
    setHeader: (header) => runtime.ctx.cells.header.set(header),
    appendLog: (id, text) => tail.append(id, text),
    resetLog: (id, text) => tail.reset(id, text),
    reruns,
    nodeCancels,
    laneCancels,
    cancels: () => cancels,
    // Close the listener AND, when the harness owns the dir, remove it so
    // repeated runs don't leak `odu-mcp-test-*` dirs under the system tmpdir.
    close: () => {
      closeListener();
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    },
  };
}
