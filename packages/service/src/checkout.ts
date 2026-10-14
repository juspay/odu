/**
 * `streams.checkout` — one checkout, whole.
 *
 * A board collapses to ONE ROW PER CHECKOUT, because a checkout is what a
 * person works in: "what is my CI doing here" is the question, and its answer
 * is three facts that only make sense together — which run the checkout stands
 * for, what that run's work is up to, and what ran before it.
 *
 * **The assembly belongs to the service.** A consumer folding it from the board
 * has to re-fold on every row delta, and then keep a SECOND subscription (the
 * run's nodes) that it must tear down and reopen every time the latest run
 * swaps under it — a swap it can only notice by doing the fold again. That is
 * the machinery every face grew a copy of, and it is on the catalog's clock,
 * not on any face's. So the fold lives here and the swap is invisible: a
 * subscriber receives one frame, and the run inside it changes.
 *
 * **Never terminal**, unlike `./nodes`. A run settles; a checkout does not —
 * the next run is the whole point of the thing. So this stream has no `done`
 * and simply keeps going until its subscriber lets go.
 *
 * **A frame goes out only when something MOVED.** The comparison is per field,
 * over the rows the frame carries and the latest run's nodes, so a quiet
 * checkout is a fold and no traffic at all.
 */

import { streamFromAbortableSource } from "@kolu/surface/server";
import {
  CHECKOUT_RECENT_RUNS,
  type CheckoutFrame,
  type RunRow,
} from "@odu/service-client/surface";
import type { Stream } from "effect";
// The SAME comparison `streams.nodes` publishes on: the two members carry one
// run's nodes, and a reader watching both must not be told they moved by one
// stream and not the other.
import { sameNodes } from "./nodes";
import type { RunRegistry } from "./registry";
import { abortableSleep } from "./sleep";

/** How often a checkout is re-read. The registry's own refresh is what costs
 *  anything; this only decides how promptly a subscriber sees the result of
 *  one — and it is `./nodes`' cadence, because the two answer about the same
 *  run and a subscriber watching both must not see them disagree for a quarter
 *  of a second at a time. */
export const CHECKOUT_POLL_MS = 250;

export interface CheckoutDeps {
  registry: RunRegistry;
  /** Re-read the catalog. Passed in rather than called on the registry, so a
   *  subscription cannot start a second refresh loop beside the service's own:
   *  in production this does nothing (the poller owns the clock), and in a test
   *  it is the refresh. */
  poll: () => void;
  pollMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Two rows, compared as a subscriber would see them.
 *
 *  Field by field rather than by identity, because the registry re-projects an
 *  entry whenever its fingerprint moves and hands back a NEW object for a row
 *  that says exactly what it said before — so a reference test would republish
 *  the whole frame every time any file under the run changed. */
function sameRow(a: RunRow, b: RunRow): boolean {
  return (
    a.runId === b.runId &&
    a.state === b.state &&
    a.settled === b.settled &&
    a.passed === b.passed &&
    a.outcome === b.outcome &&
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

/** One reading of one checkout, off ONE pass of the projection.
 *
 *  `select` is the registry's own filter — the same one `run.list` answers
 *  from — so "which runs belong to this checkout, newest first" has exactly one
 *  implementation, and the count a board prints is the catalog's own rather
 *  than the length of whatever page happened to be sent. */
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

/**
 * The stream source `implementSurface` binds.
 *
 * A checkout that odu has never run anything in is not an error and not a wait:
 * it opens with the empty frame and holds, so a face subscribing on a path
 * before its first run draws "nothing" immediately and sees the first run
 * arrive in the same subscription.
 *
 * Cancellation is fiber interruption, as everywhere: the framework's
 * `streamFromAbortableSource` turns the interrupt into this generator's
 * `signal`.
 */
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
        // The first frame always goes out — a subscriber's opening snapshot is
        // not conditional on anything having changed — and after that only a
        // real move is news.
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
