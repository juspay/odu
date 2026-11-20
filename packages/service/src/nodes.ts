import { streamFromAbortableSource } from "@kolu/surface/server";
import {
  type NodesFrame,
  type RunEnv,
  type RunNode,
  UNKNOWN_ENV,
} from "@odu/service-client/surface";
import type { Stream } from "effect";
import type { RunRegistry } from "./registry";
import { abortableSleep } from "./sleep";

export const NODES_POLL_MS = 250;

export interface NodesDeps {
  registry: RunRegistry;
  exists: (runId: string) => boolean;
  poll: () => void;
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function sameNodes(
  a: readonly RunNode[],
  b: readonly RunNode[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.attempt !== y.attempt ||
      x.exitCode !== y.exitCode ||
      x.startedAt !== y.startedAt ||
      x.durationMs !== y.durationMs ||
      x.host !== y.host
    ) {
      return false;
    }
  }
  return true;
}

function samePool(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameEnv(a: RunEnv, b: RunEnv): boolean {
  if (
    a.phase !== b.phase ||
    a.hostsSource !== b.hostsSource ||
    a.commitUrl !== b.commitUrl ||
    a.lanes.length !== b.lanes.length ||
    a.owed.length !== b.owed.length
  ) {
    return false;
  }
  for (let i = 0; i < a.lanes.length; i += 1) {
    const x = a.lanes[i];
    const y = b.lanes[i];
    if (x === undefined || y === undefined) return false;
    if (x.state !== y.state || x.platform !== y.platform) return false;
    if (x.state === "leased" && y.state === "leased" && x.host !== y.host) {
      return false;
    }
    if (x.state === "claiming" && y.state === "claiming" && !samePool(x.pool, y.pool)) {
      return false;
    }
  }
  for (let i = 0; i < a.owed.length; i += 1) {
    const x = a.owed[i];
    const y = b.owed[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.context !== y.context ||
      x.lastError !== y.lastError ||
      x.attempts !== y.attempts
    ) {
      return false;
    }
  }
  return true;
}

const INDEX_GRACE_MS = 30_000;

function terminal(state: NodesFrame["state"]): boolean {
  return state === "settled" || state === "expired" || state === "owner_lost";
}

export function nodesSource(
  deps: NodesDeps,
): (input: { runId: string }) => Stream.Stream<NodesFrame> {
  const pollMs = deps.pollMs ?? NODES_POLL_MS;
  const sleep = deps.sleep ?? abortableSleep;
  return ({ runId }) =>
    streamFromAbortableSource<NodesFrame>(async function* (signal) {
      let previous: { nodes: RunNode[]; env: RunEnv } | null = null;
      const indexBy = Date.now() + INDEX_GRACE_MS;
      for (;;) {
        deps.poll();
        const row = deps.registry.row(runId);
        const nodes = deps.registry.nodes(runId) ?? [];
        if (row === undefined) {
          if (deps.exists(runId) && Date.now() < indexBy) {
            if (signal.aborted) return;
            await sleep(pollMs, signal);
            if (signal.aborted) return;
            continue;
          }
          yield {
            order: [],
            nodes: [],
            state: "expired",
            env: UNKNOWN_ENV,
            done: true,
          };
          return;
        }
        const env = deps.registry.env(runId) ?? UNKNOWN_ENV;
        const done = terminal(row.state);
        if (
          previous === null ||
          !sameNodes(previous.nodes, nodes) ||
          !sameEnv(previous.env, env) ||
          done
        ) {
          yield {
            order: nodes.map((node) => node.id),
            nodes,
            state: row.state,
            env,
            done,
          };
        }
        previous = { nodes, env };
        if (done) return;
        if (signal.aborted) return;
        await sleep(pollMs, signal);
        if (signal.aborted) return;
      }
    });
}
