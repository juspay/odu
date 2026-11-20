import { streamFromAbortableSource } from "@kolu/surface/server";
import {
  CHECKOUT_RECENT_RUNS,
  type CheckoutFrame,
  type RunRow,
} from "@odu/service-client/surface";
import type { Stream } from "effect";
// The SAME comparison `streams.nodes` publishes on: a reader watching both
// must not be told they moved by one stream and not the other.
import { sameNodes } from "./nodes";
import type { RunRegistry } from "./registry";
import { abortableSleep } from "./sleep";

/** How often a checkout is re-read. It is `./nodes`' cadence, because the two
 *  answer about the same run and a subscriber watching both must not see them
 *  disagree for a quarter of a second at a time. */
export const CHECKOUT_POLL_MS = 250;

export interface CheckoutDeps {
  registry: RunRegistry;
  poll: () => void;
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sameRow(a: RunRow, b: RunRow): boolean {
  return (
    a.runId === b.runId &&
    a.state === b.state &&
    a.settled === b.settled &&
    a.passed === b.passed &&
    a.outcome === b.outcome &&
    a.finishedAt === b.finishedAt &&
    a.actionable === b.actionable &&
    a.unresolvedFailures === b.unresolvedFailures &&
    a.reportingDebt === b.reportingDebt &&
    a.endpoint === b.endpoint &&
    a.dirty === b.dirty &&
    a.sha === b.sha &&
    a.branch === b.branch &&
    a.seq === b.seq &&
    a.cursor === b.cursor
  );
}

function sameRows(a: readonly RunRow[], b: readonly RunRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (!sameRow(x, y)) return false;
  }
  return true;
}

function sameFrame(a: CheckoutFrame, b: CheckoutFrame): boolean {
  if (a.total !== b.total) return false;
  if (!sameRows(a.recent, b.recent)) return false;
  if (a.latest === null || b.latest === null) {
    return a.latest === b.latest;
  }
  return (
    sameRow(a.latest.run, b.latest.run) && sameNodes(a.latest.nodes, b.latest.nodes)
  );
}

function readCheckout(
  registry: RunRegistry,
  repoRoot: string,
): CheckoutFrame {
  const { rows, total } = registry.select({
    checkout: repoRoot,
    limit: CHECKOUT_RECENT_RUNS,
  });
  const latest = rows[0];
  return {
    latest:
      latest === undefined
        ? null
        : // From the SAME pass the row came from, so a frame is one reading of
          // one catalog rather than two that can straddle a poll.
          { run: latest, nodes: registry.nodes(latest.runId) ?? [] },
    recent: rows,
    total,
  };
}

export function checkoutSource(
  deps: CheckoutDeps,
): (input: { repoRoot: string }) => Stream.Stream<CheckoutFrame> {
  const pollMs = deps.pollMs ?? CHECKOUT_POLL_MS;
  const sleep = deps.sleep ?? abortableSleep;
  return ({ repoRoot }) =>
    streamFromAbortableSource<CheckoutFrame>(async function* (signal) {
      let previous: CheckoutFrame | null = null;
      for (;;) {
        deps.poll();
        const frame = readCheckout(deps.registry, repoRoot);
        if (previous === null || !sameFrame(previous, frame)) {
          yield frame;
        }
        previous = frame;
        if (signal.aborted) return;
        await sleep(pollMs, signal);
        if (signal.aborted) return;
      }
    });
}
