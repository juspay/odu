/**
 * How a face READS a live run — the re-dialing client, and the settle wait's
 * reader over it.
 *
 * Engine-side, and the reason is the one the settle core already argues at
 * length: a client over a single already-dialed link makes every subscription
 * it mints a subscription to THAT link, so once the link dies the reader is a
 * corpse and there is nothing left to re-subscribe to. `waitForSettle` survives
 * a link that dies under a run that is still going ONLY because the reader it
 * is handed re-dials, and a core whose repair depends on a property of its
 * argument has to be able to hand out the argument itself.
 *
 * It lived next to the MCP projection, which needed the same dial. That made
 * the settle wait import an agent face to get a reader — the one edge that
 * would have made the engine and the faces mutually dependent. The projection
 * still uses this; the direction is now cli → execution, like everything else.
 */

import { Effect, Stream } from "effect";
import { dialRun } from "@odu/run-client/dial";
import {
  EMPTY_STATE,
  type NodeLogFrame,
  type OduClient,
  type PipelineState,
} from "@odu/run-client/surface";
import {
  type AgentNodesReader,
  toAgentNodes,
} from "../common/agentNodes";

/**
 * The slice of the live A-client (`oduSurface`) a reader consumes.
 *
 * A `Pick` of exactly the members that are called, because
 * {@link redialingAClient} implements exactly those — a type claiming
 * `header.get` over an object that has none would be a lie the compiler helps
 * tell.
 */
export type OduSurfaceClient = {
  surface: Pick<OduClient["surface"], "nodes" | "nodeLog" | "node" | "lane">;
};

/** Wrap an A-client (`PipelineState` cell) as the `AgentNodesReader`
 *  `waitForSettle` expects — map every frame with `toAgentNodes`.
 *
 *  DELIBERATELY NOT EXPORTED, which is the whole safety property of this file's
 *  reader half. What this is HANDED decides what a wait built on it can
 *  survive: a client over a single already-dialed link makes every subscription
 *  it mints a subscription to THAT link, so once the link dies the reader is a
 *  corpse and there is nothing left to re-subscribe TO.
 *
 *  Say that precisely, because it is easy to say backwards. Handing this a
 *  captured link was never what made `odu wait --settle` lie — the lie was the
 *  settle core answering a dead link as a finished run, and it belonged to both
 *  faces equally. What a captured link does is DISARM the repair: the core now
 *  re-subscribes on a transport-loss end, and a re-subscribe over a captured
 *  link reaches the same corpse, so the fix would have been silently inert on
 *  the face that had one. That is why the shape is closed off rather than
 *  merely audited for. The only exported way to build a reader over a live
 *  checkout is {@link agentReaderForSocket}, which pairs this mapping with
 *  {@link redialingAClient} — the one shape whose subscriptions outlive their
 *  own link.
 *
 *  (A TEST still injects whatever `AgentNodesReader` it likes: the interface is
 *  structural, and a stub that fails on purpose is exactly how the recovery is
 *  measured. What is closed off is the plausible-looking WRONG construction
 *  over a real socket, not the ability to fake one.)
 *
 *  A `Stream` maps with `Stream.map`, so there is no hand-rolled async
 *  generator here and no `{ signal }` to thread: the wait's cancellation
 *  travels as fiber interruption when `subscribe` closes the subscription
 *  (kolu PLAN D10/#18), not as a per-call option. */
function agentReaderFromA(client: {
  surface: Pick<OduClient["surface"], "nodes">;
}): AgentNodesReader {
  return {
    surface: {
      nodes: {
        get: (_input: void) =>
          Stream.map(client.surface.nodes.get(undefined), toAgentNodes),
      },
    },
  };
}

// ── The re-dialing A-client ──────────────────────────────────────────────────

/** Dial the coordinator socket, or `null` when no run is live. Injectable so
 *  the tests drive a controllable surface; {@link dialAFor} is the real
 *  unix-socket dial both faces pass. */
export type DialA = () => Promise<{
  client: OduSurfaceClient;
  close: () => Promise<void>;
} | null>;

/** The real dial, at a checkout's socket path: `@odu/run-client`'s `dialRun`
 *  in the shape {@link redialingAClient} takes. `null` (nobody serving) travels
 *  through as `null` — that is the package's contract and the no-run value
 *  every face above turns into its own refusal.
 *
 *  Spelled ONCE because both faces pass it: `mcp.ts` for the projection's
 *  upstream, and {@link agentReaderForSocket} for the settle wait. */
export function dialAFor(socketPath: string): DialA {
  return async () => {
    const dialed = await dialRun(socketPath);
    return dialed === null
      ? null
      : { client: dialed.client, close: dialed.close };
  };
}

/** The `nodes` reader `waitForSettle` takes, for the run live at `socketPath` —
 *  and the ONLY exported way to build one over a live checkout, so no caller
 *  can reintroduce the captured-link reader by writing a plausible line of its
 *  own.
 *
 *  WHAT THE TWO FACES ACTUALLY SHARE, stated once here because it is easy to
 *  round up to "one reader" and that is not true. `odu wait` hands this in.
 *  `odu mcp` does NOT: `mcpCommand` hands the tool handler the adapter's
 *  projected B-client (`buildSurfaceFace ∘ directDispatch` over the
 *  projection). So the shared parts are the ones that decide a verdict — the
 *  settle core, the `toAgentNodes` row mapping, and the SAME
 *  {@link redialingAClient} over the same {@link dialAFor}, which is what lets
 *  either face ride out a link that dies under a run still running. The part
 *  that differs is the error channel: this reader maps with `Stream.map` and
 *  keeps the upstream failure, while the projection's `deriveStream` `orDie`s
 *  it, so a transport death reaches the core as a defect on that side.
 *  `isDeadTransportError` recognises it either way — measured in
 *  `server.test.ts`, not assumed.
 *
 *  It is a pairing, and both halves are load-bearing: {@link redialingAClient}
 *  so the dial is a scoped acquire of the stream (re-subscribing re-DIALS), and
 *  `agentReaderFromA` so the rows are the agent rows, by the same mapping the
 *  projection applies. Nothing is dialed here: the reader is a lazy
 *  description, and the socket is reached when the wait pulls. */
export function agentReaderForSocket(socketPath: string): AgentNodesReader {
  return agentReaderFromA(redialingAClient(dialAFor(socketPath)));
}

/**
 * An A-client that dials a *fresh* coordinator socket for every streaming call
 * and closes it when the consumer stops iterating.
 *
 * This is what makes the agent face track the coordinator's lifecycle. The
 * surface-mcp adapter memoizes one read/tool connection for the whole server
 * lifetime and only re-dials after a thrown call — but a coordinator socket
 * that closed and was re-bound by the *next* run (same `.ci/odu.sock` path)
 * doesn't make a pending read throw; the old projection would keep serving the
 * previous run's snapshot. Re-dialing per call sidesteps that entirely: each
 * `nodes` read and log follow re-subscribe (re-dial) afresh, so they see the
 * run that's live *now*, and fall back to the no-run value the instant there's
 * no socket. `wait_for_settle` holds ONE subscription dialed at call time, so it
 * observes the coordinator live when it subscribes, not one that starts later —
 * the run → wait_for_settle agent loop is safe because `run` blocks until the
 * socket is live before returning.
 *
 *   - `nodes.get`  — dial, stream A's `nodes` (snapshot-then-deltas) until the
 *                    consumer aborts/returns or A closes; no socket → one
 *                    `EMPTY_STATE`-shaped frame (mapped to `{ run: false }`).
 *   - `nodeLog.get`— dial, stream A's `nodeLog`; no socket → end immediately so
 *                    the logs store falls back to the durable file.
 *   - `node.rerun` / `node.cancel` / `lane.cancel` — dial, call, close; no socket → `{ ok: false }`.
 */
export function redialingAClient(dial: DialA): OduSurfaceClient {
  /**
   * Dial fresh, stream the chosen upstream, and close the socket when the
   * subscription ends — for ANY reason, including the consumer walking away.
   *
   * This is the shape that got honest under Effect. The old version was an
   * async generator whose `finally { dialed.close() }` ran only if the consumer
   * resumed it, and whose `close()` was synchronous and could not have been
   * awaited from there anyway. `Stream.unwrap` over an `acquireRelease` makes
   * the DIAL a scoped resource of the stream: the release is part of the
   * stream's own teardown, an interruption runs it, and it is an `Effect` so
   * the now-async `close()` is genuinely awaited before the scope closes.
   * (`unwrap`, not the `unwrapScoped` this said for a while — Effect 4 exports
   * no such function, and `Stream.unwrap`'s `R` already `Exclude`s `Scope`. A
   * stale name beside the load-bearing acquire is the one comment here that
   * could send a reader looking for machinery that does not exist.)
   *
   * The laziness is load-bearing and is the reason the re-dial-per-call
   * contract still holds: nothing is dialled when the stream VALUE is made,
   * only when a consumer pulls. So each `nodes` read and each log follow still
   * sees the run that is live at subscribe time, never one cached from before.
   */
  function streamFresh<F>(
    pick: (a: OduSurfaceClient) => Stream.Stream<F, unknown>,
    onNoRun: Stream.Stream<F>,
  ): Stream.Stream<F, unknown> {
    return Stream.unwrap(
      Effect.map(
        Effect.acquireRelease(
          Effect.promise(() => dial()),
          (dialed) =>
            dialed === null
              ? Effect.void
              : Effect.promise(() => dialed.close()),
        ),
        (dialed) => (dialed === null ? onNoRun : pick(dialed.client)),
      ),
    );
  }

  /** Dial, call, close — the unary half, and an `Effect` now, because a unary
   *  member call is one. No socket is `{ ok: false }`, which is the "there is no
   *  run to mutate" answer, not an error.
   *
   *  `acquireUseRelease` rather than a `try/finally`: the release runs on
   *  INTERRUPTION too, so a `tools/call` the MCP host cancels mid-flight still
   *  closes the socket it opened. A `finally` around an `await` could not
   *  promise that. */
  function callFresh<A extends { readonly ok: boolean }, E>(
    pick: (a: OduSurfaceClient) => Effect.Effect<A, E>,
    onNoRun: A,
  ): Effect.Effect<A, E> {
    return Effect.acquireUseRelease(
      Effect.promise(() => dial()),
      (dialed) => (dialed === null ? Effect.succeed(onNoRun) : pick(dialed.client)),
      (dialed) =>
        dialed === null ? Effect.void : Effect.promise(() => dialed.close()),
    );
  }

  /** The no-run answer for every forwarded mutation: there is no live run to
   *  rerun or cancel, which is a `false` ack, not a failure. */
  const NO_RUN_ACK: { ok: boolean; recorded?: boolean } = { ok: false };

  return {
    surface: {
      nodes: {
        get: () =>
          streamFresh<PipelineState>(
            (a) => a.surface.nodes.get(undefined),
            Stream.make(EMPTY_STATE),
          ),
      },
      nodeLog: {
        get: (input) =>
          streamFresh<NodeLogFrame>(
            (a) => a.surface.nodeLog.get(input),
            Stream.empty,
          ),
      },
      node: {
        rerun: (input) =>
          callFresh((a) => a.surface.node.rerun(input), NO_RUN_ACK),
        cancel: (input) =>
          callFresh((a) => a.surface.node.cancel(input), NO_RUN_ACK),
      },
      lane: {
        cancel: (input) =>
          callFresh((a) => a.surface.lane.cancel(input), NO_RUN_ACK),
      },
    },
  };
}
