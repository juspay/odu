/**
 * `streams.nodes` — one run's work, as whole pictures.
 *
 * A stream rather than a per-run collection, because the addressing is by RUN
 * and a collection is addressed by ITEM: a detail view wants "this run's nodes,
 * and tell me when they move", which is one subscription with an input, not a
 * hundred item subscriptions a page would open and close as a roster grows.
 *
 * **A frame goes out only when something MOVED.** The comparison is per field
 * and per node, so a poll that finds nothing changed is a `stat` and a fold and
 * no traffic at all — which is what keeps an idle detail view free rather than
 * a thing that redraws four times a second.
 *
 * **It ENDS.** A run that has settled will publish nothing further, and a
 * stream with no terminal leaves "is this still coming?" unobservable — the
 * exact failure the log wire's `end` frame was added for. Here the terminal
 * rides the last frame (`done`) rather than replacing it, so a consumer holding
 * the latest frame keeps its content at the moment the run finishes.
 */

import { streamFromAbortableSource } from "@kolu/surface/server";
import type { NodesFrame, RunNode } from "@odu/service-client/surface";
import type { Stream } from "effect";
import type { RunRegistry } from "./registry";

/** How often a live run's node list is re-read. The registry's own refresh is
 *  what actually costs anything (a `stat` per run, a fold per changed one);
 *  this only decides how promptly a subscriber sees the result of one. */
export const NODES_POLL_MS = 250;

export interface NodesDeps {
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

/** Two node lists, compared as a subscriber would see them. Cheap enough to run
 *  every tick, and what stops an unchanged run from waking every open view. */
function same(a: readonly RunNode[], b: readonly RunNode[]): boolean {
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

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });

/** In none of these three will anything move again. */
function terminal(state: NodesFrame["state"]): boolean {
  return state === "settled" || state === "expired" || state === "owner_lost";
}

/**
 * The stream source `implementSurface` binds.
 *
 * Cancellation is fiber interruption: the framework's own
 * `streamFromAbortableSource` turns the interrupt into this generator's
 * `signal`, so a browser closing a tab, an agent cancelling a request and a CLI
 * taking a Ctrl-C all end the loop the same way — and none of them touches the
 * run.
 */
export function nodesSource(
  deps: NodesDeps,
): (input: { runId: string }) => Stream.Stream<NodesFrame> {
  const pollMs = deps.pollMs ?? NODES_POLL_MS;
  const sleep = deps.sleep ?? defaultSleep;
  return ({ runId }) =>
    streamFromAbortableSource<NodesFrame>(async function* (signal) {
      let previous: RunNode[] | null = null;
      for (;;) {
        deps.poll();
        const row = deps.registry.row(runId);
        const nodes = deps.registry.nodes(runId) ?? [];
        // A run this registry has never heard of gets an empty, DONE frame:
        // "there is no such run here" is an answer, and a subscription that hung
        // waiting for one to appear would be indistinguishable from a run that
        // is merely quiet.
        if (row === undefined) {
          yield { order: [], nodes: [], state: "expired", done: true };
          return;
        }
        const done = terminal(row.state);
        // The first frame always goes out — a subscriber's opening snapshot is
        // not conditional on anything having changed — and after that only a
        // real move, or the terminal, is news.
        if (previous === null || !same(previous, nodes) || done) {
          yield {
            order: nodes.map((node) => node.id),
            nodes,
            state: row.state,
            done,
          };
        }
        previous = nodes;
        if (done) return;
        if (signal.aborted) return;
        await sleep(pollMs, signal);
        if (signal.aborted) return;
      }
    });
}
