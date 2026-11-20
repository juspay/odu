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
import { type LogStream, logStreamKey } from "@odu/run-client/nodeId";
import { createLogTail } from "../common/logTail";
import { serveSocket, socketLogger } from "./socket";

export interface TestSurface {
  socketPath: string;
  setState: (state: PipelineState) => void;
  setHeader: (header: RunHeader) => void;
  appendLog: (id: string, text: string, stream?: LogStream) => void;
  resetLog: (id: string, text: string, stream?: LogStream) => void;
  reruns: string[];
  nodeCancels: string[];
  laneCancels: string[];
  cancels: () => number;
  close: () => void;
}

export interface ServeTestOptions {
  socketPath?: string;
  onCancel?: (close: () => void) => void;
}

function deferredClose(): {
  arm: (close: () => void) => void;
  close: () => void;
} {
  let armed: (() => void) | null = null;
  return {
    arm: (close) => {
      armed = close;
    },
    close: () => armed?.(),
  };
}

export async function serveTestSurface(
  initial: PipelineState,
  initialHeader: RunHeader = EMPTY_HEADER,
  options: ServeTestOptions = {},
): Promise<TestSurface> {
  const pinnedSocketPath = options.socketPath;
  const store = inMemoryStore<PipelineState>(initial);
  const headerStore = inMemoryStore<RunHeader>(initialHeader);
  const tail = createLogTail();
  const reruns: string[] = [];
  const nodeCancels: string[] = [];
  const laneCancels: string[] = [];
  let cancels = 0;
  const listener = deferredClose();

  const runtime = implementSurface(oduSurface, {
    cells: { nodes: { store }, header: { store: headerStore } },
    streams: {
      nodeLog: {
        source: ({ id, stream }) => tail.streamSource({ id: logStreamKey(id, stream) }),
      },
    },
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
            options.onCancel?.(() => listener.close());
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

  const dir = pinnedSocketPath ? null : mkdtempSync(join(tmpdir(), "odu-mcp-test-"));
  const socketPath = pinnedSocketPath ?? join(dir as string, "odu.sock");
  listener.arm(
    await serveSocket(
      served,
      socketPath,
      socketLogger((line) => process.stderr.write(`${line}\n`)),
    ),
  );

  return {
    socketPath,
    setState: (state) => runtime.ctx.cells.nodes.set(state),
    setHeader: (header) => runtime.ctx.cells.header.set(header),
    appendLog: (id, text, stream) => tail.append(logStreamKey(id, stream), text),
    resetLog: (id, text, stream) => tail.reset(logStreamKey(id, stream), text),
    reruns,
    nodeCancels,
    laneCancels,
    cancels: () => cancels,
    close: () => {
      listener.close();
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    },
  };
}
