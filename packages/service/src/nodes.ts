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
import {
  type NodesFrame,
  type RunEnv,
  type RunNode,
  UNKNOWN_ENV,
} from "@odu/service-client/surface";
import type { Stream } from "effect";
import type { RunRegistry } from "./registry";

/** How often a live run's node list is re-read. The registry's own refresh is
 *  what actually costs anything (a `stat` per run, a fold per changed one);
 *  this only decides how promptly a subscriber sees the result of one. */
export const NODES_POLL_MS = 250;

export interface NodesDeps {
  registry: RunRegistry;
  /** Does a run with this id EXIST, whatever the registry currently holds?
   *
   *  The registry is a projection refreshed on a clock; the catalog is the
   *  authority. A run accepted a moment ago is real and indexed shortly after,
   *  and only this can tell that apart from an id that names nothing. Injected
   *  rather than read here so this module keeps knowing nothing about where a
   *  catalog lives. */
  exists: (runId: string) => boolean;
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

/** Two candidate lists, element by element. Not a join-and-compare: a host
 *  address containing whatever separator was chosen would make two different
 *  pools compare equal, which is the quiet half of a coalesced frame. */
function samePool(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Two environments, compared as a subscriber would see them.
 *
 * **`elapsedMs` is deliberately NOT compared.** It moves on every tick of the
 * clock with nothing about the run having changed, so counting it as news would
 * turn this stream into the four-frames-a-second redraw the whole `same()`
 * comparison exists to prevent. A consumer that wants a ticking clock has the
 * frame's `elapsedMs` and its own `Date.now()`; what it cannot derive locally,
 * and what this therefore treats as news, is a phase changing or a lane landing
 * on a box.
 *
 * That last one is the failure this function is here for: without it, a frame
 * stream that coalesced a lane transition would leave a browser painting
 * "claiming" over a lane that has been running for a minute.
 */
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
    // The two arms carry different facts, which is why they are two arms — a
    // pool that gained a candidate and a lane that landed are both moves.
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
    // `attempts` too: a debt that is being retried and still failing is a run
    // getting further from posting its status, and a reader watching the badge
    // never appear deserves to see the count climb.
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

/**
 * How long to wait for the registry to index a run the CATALOG already has.
 *
 * `run.start` answers with a run id the moment the coordinator publishes its
 * manifest, and a caller subscribes with it immediately — before the next
 * refresh has seen it. Generous enough to cover a refresh on a busy service,
 * and short enough that a run the projection genuinely cannot see is reported
 * rather than waited on.
 */
const INDEX_GRACE_MS = 30_000;

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
      let previous: { nodes: RunNode[]; env: RunEnv } | null = null;
      // How long a run that EXISTS is allowed to be missing from the registry
      // before this reports it absent — see the `row === undefined` branch.
      const indexBy = Date.now() + INDEX_GRACE_MS;
      for (;;) {
        deps.poll();
        const row = deps.registry.row(runId);
        const nodes = deps.registry.nodes(runId) ?? [];
        // A run this registry has never heard of gets an empty, DONE frame:
        // "there is no such run here" is an answer, and a subscription that hung
        // waiting for one to appear would be indistinguishable from a run that
        // is merely quiet.
        //
        // BUT "never heard of" and "not yet" are different, and the registry
        // alone cannot tell them apart. `run.start` answers with a run id the
        // moment the coordinator publishes its manifest, and a caller subscribes
        // with that id immediately — before the next refresh has indexed it. The
        // empty done frame then told `odu run` its own run had expired: no
        // progress events at all, and a verdict computed from zero nodes.
        //
        // The catalog is the authority on existence, so it is what gets asked.
        // A run that EXISTS is merely not indexed yet; the loop waits for the
        // refresh that will index it.
        if (row === undefined) {
          // BOUNDED, because "the projection will catch up" is a belief and a
          // subscription that holds it forever is a hang. The window only has
          // to cover a refresh; past it, a run the registry still cannot see is
          // reported as absent whatever the catalog says, which is the answer
          // this branch existed to give in the first place.
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
        // From the SAME registry entry the nodes came from, so a frame is one
        // reading of one journal rather than two that can straddle a poll.
        const env = deps.registry.env(runId) ?? UNKNOWN_ENV;
        const done = terminal(row.state);
        // The first frame always goes out — a subscriber's opening snapshot is
        // not conditional on anything having changed — and after that only a
        // real move, or the terminal, is news.
        if (
          previous === null ||
          !same(previous.nodes, nodes) ||
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
