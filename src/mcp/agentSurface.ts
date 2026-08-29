/**
 * The agent projection — `oduAgentSurface`, surface B derived from the live
 * coordinator surface A (`oduSurface`) via `@kolu/surface`'s `projectSurface`.
 *
 * A (`oduSurface`, served on `.ci/odu.sock`) speaks the coordinator's raw
 * vocabulary: a `nodes` cell of the whole `PipelineState`, a `nodeLog`
 * input-bearing stream, a fan-in-only `header` cell, and the `node.rerun`
 * procedure. B is the *agent* face: the flattened pieces an agent triaging a
 * run actually wants, exposed through `@kolu/surface-mcp` as default-deny MCP
 * resources + tools. The mapping:
 *
 *   - cell `nodes` (PipelineState) → stream `nodes` ({ run, pipeline, nodes[] })
 *     via `deriveStream`: every A frame is flattened to agent rows (id/status/
 *     exit/duration + the `red` verdict bit). A stream (not a cell) so a
 *     one-shot `resources/read` awaits A's real first frame instead of seeing
 *     the empty pre-snapshot default a derived cell starts at.
 *   - stream `nodeLog` ({ id }) → collection `logs` keyed by node id: one
 *     node's output as a `{ node, source, text }` record. The collection read
 *     pulls the live `nodeLog` first frame (the buffered snapshot), falling
 *     back to the durable `.ci/<sha7>/<platform>/<node>.log` when no run is
 *     live — the 64KB clamp + the path-traversal guard live in this handler.
 *   - procedure `node.rerun` → `node.rerun` (pass-through to A).
 *   - procedure `node.cancel` → `node.cancel` (one fan-in node).
 *   - procedure `lane.cancel` → `lane.cancel` (drop a whole platform lane).
 *
 * `nodes` is live-only by design — when the coordinator socket is gone `nodes`
 * reports `{ run: false }` rather than a finished run's verdict, so within a run
 * an agent reads the verdict from `wait_for_settle`'s return value (captured
 * while the socket was live), not from a post-coordinator `nodes` read. The
 * *durable* history of finished runs lives in the on-disk ledger and is reached
 * through the `runs` bespoke tool (src/mcp/runsTool.ts), not this live
 * projection — the same split the CLI draws between `attach`/`status` (live) and
 * `runs` (durable).
 *
 * `header` and `run.configure` are absent by construction: `header` isn't
 * mapped (it carries no agent value the `nodes` rows don't), and
 * `run.configure` lives on `laneSurface`, never on A — so neither can leak.
 *
 * Lifecycle: the projection is wired once over a *re-dialing* A-client
 * (`redialingAClient`) that opens a fresh `.ci/odu.sock` for every upstream
 * call. So the face tracks the coordinator across its whole lifetime — a run
 * that starts, ends, or restarts on the same path after the server booted is
 * observed by the next read/poll/subscribe, and a no-socket state reads as the
 * `{ run: false }` / durable-file no-run value rather than stale data or an
 * error. (The surface-mcp adapter memoizes one read/tool connection and only
 * re-dials on a thrown call; the re-dialing client moves freshness a layer down
 * so a silently-closed-and-rebound socket can't pin a previous run's snapshot.)
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { deriveStream, projectSurface } from "@kolu/surface/project";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { Effect, Schema, Stream } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { subscribe } from "../common/effectEdge";
import { rowsOf } from "../cli/render";
import { NodeIdSchema, splitFanId } from "@odu/run-client/nodeId";
import {
  clampLog,
  EMPTY_STATE,
  MAX_LOG_CHARS,
  type NodeLogFrame,
  type OduClient,
  type oduSurface,
  OwedStatusSchema,
  type PipelineState,
  postingOf,
} from "@odu/run-client/surface";
import { logPathFor } from "../coordinator/statuses";

/**
 * The slice of the live A-client (`oduSurface`) this projection consumes.
 *
 * This used to be a hand-SPELLED four-member interface — a structural mirror of
 * A written out by hand, because materializing the full per-spec oRPC client
 * union for `oduSurface` (whose `run.configure` input carries the deeply-nested
 * `TaskSpecSchema`) overflowed TS's union budget with TS2590 inside
 * `projectSurface`'s `deps` position.
 *
 * That is no longer true, so the mirror is DERIVED now instead of transcribed:
 * `SurfaceClientOf` resolves to the narrow READ face (one `get` per cell and
 * stream, plus the declared procedures — a projection consumes A, it never
 * mutates it), so the expensive half of the union is never built at all.
 * Re-measured on this surface rather than assumed: `deps` names the real
 * spec-derived type and the `as never` cast that used to hide the overflow is
 * deleted, along with the risk that it was hiding a genuine type error too.
 *
 * It stays a `Pick` of exactly the four members the projection calls, because
 * `redialingAClient` implements exactly those — a type claiming `header.get`
 * over an object that has none would be a lie the compiler helps tell.
 */
type OduSurfaceClient = {
  surface: Pick<
    OduClient["surface"],
    "nodes" | "nodeLog" | "node" | "lane"
  >;
};

// ── B's spec ──────────────────────────────────────────────────────────────

/** The agent `nodes` snapshot: the pipeline flattened to rows the agent
 *  triages. `run: false` (with a null pipeline and no rows) is the pre-run /
 *  no-run value, mirroring the old `get_nodes` tool's `NodesResult`. */
/** MCP-facing numerics are `Schema.Int`, not `Schema.Number` (kolu PLAN D8,
 *  divergence 2): `Schema.Number` is a codec tolerant of Infinity/NaN, and its
 *  JSON Schema is an `anyOf` that offers a host the literal string `"NaN"` as a
 *  valid value. These are an exit code and a millisecond duration — integers by
 *  construction — so the faithful spelling is also the one that advertises
 *  `{"type":"integer"}`. */
const NodeRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  exit_code: Schema.NullOr(Schema.Int),
  duration_ms: Schema.NullOr(Schema.Int),
  red: Schema.Boolean,
});

const AgentNodesSchema = Schema.Struct({
  run: Schema.Boolean,
  pipeline: Schema.NullOr(Schema.String),
  /** The live run's identity, projected from `PipelineState` so an agent
   *  verdict says WHICH run it describes (juspay/odu#49): `sha7` the 7-char
   *  commit, `seq` its ordinal among runs of that commit (`<sha7>#<seq>`).
   *  Both are the no-run value (`""` / `null`) when `run` is false. */
  sha7: Schema.String,
  seq: Schema.NullOr(Schema.Int),
  nodes: Schema.Array(NodeRowSchema),
  /** Full owed GitHub status rows not yet confirmed (juspay/odu#61).
   *  Empty when posting is healthy or disabled; test verdict stays the truth. */
  unposted: Schema.Array(OwedStatusSchema),
});
export type AgentNodes = typeof AgentNodesSchema.Type;

/**
 * The B-side read slice: the projected agent client's `nodes` stream read
 * (snapshot-then-deltas over `AgentNodes`), spelled once here so the two ends of
 * the projection don't author divergent `{ surface: { nodes: { get } } }`
 * shapes. The input is `void` to match `agentSpec.streams.nodes.inputSchema`
 * (`z.void()`). Permissive (the concrete projected client assigns) so consumers
 * needn't re-materialize the precise client union. Distinct from
 * `OduSurfaceClient`, which is the A-side (`PipelineState`) slice — that
 * projection boundary justifies two shapes, one per side. */
export interface AgentNodesReader {
  surface: {
    nodes: {
      get: (input: void) => Stream.Stream<AgentNodes, unknown>;
    };
  };
}

/** The no-run frame: `run: false`, no pipeline, and the no-run identity
 *  (`sha7: ""`, `seq: null`). Exported so a consumer reading a run's identity
 *  from a missing/absent frame spells the no-run value once, here, rather than
 *  re-authoring the sentinel. */
export const EMPTY_NODES: AgentNodes = {
  run: false,
  pipeline: null,
  sha7: "",
  seq: null,
  nodes: [],
  unposted: [],
};

/** Project a coordinator `PipelineState` onto the agent `nodes` frame — the
 *  same mapping the live projection applies on every A→B delta. Shared so the
 *  CLI `odu wait` path can feed `waitForSettle` without re-deriving rows or
 *  drifting from the MCP face. An empty order is the no-run / pre-run value
 *  (`EMPTY_STATE` when no coordinator is live). */
export function toAgentNodes(state: PipelineState): AgentNodes {
  return state.order.length === 0
    ? EMPTY_NODES
    : {
        run: true,
        pipeline: state.name,
        sha7: state.sha7,
        seq: state.seq ?? null,
        nodes: rowsOf(state),
        unposted: [...postingOf(state).owed],
      };
}

/** Wrap a live A-client (`PipelineState` cell) as the `AgentNodesReader`
 *  `waitForSettle` expects — map every frame with `toAgentNodes`. One
 *  subscription held for the wait, same as the MCP tool's single dial.
 *
 *  A `Stream` maps with `Stream.map`, so there is no hand-rolled async
 *  generator here and no `{ signal }` to thread: the wait's cancellation
 *  travels as fiber interruption when `subscribe` closes the subscription
 *  (kolu PLAN D10/#18), not as a per-call option. */
export function agentReaderFromA(client: {
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


/** One node's log, keyed by node id in the `logs` collection. `source` says
 *  where the text came from: "live" (the running coordinator's buffered
 *  snapshot), "file" (the durable per-SHA log after the run process exited),
 *  or "missing" (neither). */
const LogEntrySchema = Schema.Struct({
  node: Schema.String,
  source: Schema.Literals(["live", "file", "missing"]),
  text: Schema.String,
});
export type LogEntry = typeof LogEntrySchema.Type;

const agentSpec = {
  streams: {
    // `nodes` is a *stream*, not a cell. A derived cell fills its snapshot
    // asynchronously (the upstream subscription lands a tick after connect),
    // so a one-shot `resources/read` could return the empty pre-snapshot value
    // even with a run live — the old `get_nodes` tool awaited A's first frame
    // and never had that gap. A stream's snapshot read (`firstFrame` in
    // surface-mcp) awaits the upstream's first mapped frame, so a single read
    // after connect returns the live pipeline without polling, and each read
    // re-subscribes upstream (no cell state cached across coordinator
    // lifetimes). `inputSchema` accepts `undefined` so it exposes as the
    // no-input static resource `surface://streams/nodes`.
    nodes: {
      inputSchema: Schema.Void,
      outputSchema: AgentNodesSchema,
    },
  },
  collections: {
    // ONE node-id contract now — `NodeIdSchema`, the same `.min(1)` string the
    // rest of the surface spells. The deliberate relaxation that used to live
    // here is DELETED, and its reason with it: surface-mcp's old collection-item
    // URI decoder classified a key as "string-typed" by probing
    // `keySchema.safeParse("")`, which a `.min(1)` string rejects, so it fell
    // through to `JSON.parse` and could not address any real node id. The Effect
    // decoder tries the id VERBATIM first and only falls back to `JSON.parse`
    // for numeric/boolean keys, so a min-length string key addresses correctly.
    // Re-verified against the real decoder, not assumed — see
    // `agentSurface.keys.test.ts`.
    logs: { keySchema: NodeIdSchema, schema: LogEntrySchema },
  },
  procedures: {
    node: {
      rerun: {
        input: Schema.Struct({ id: NodeIdSchema }),
        output: Schema.Struct({ ok: Schema.Boolean }),
      },
      cancel: {
        input: Schema.Struct({ id: NodeIdSchema }),
        output: Schema.Struct({ ok: Schema.Boolean }),
      },
    },
    lane: {
      cancel: {
        input: Schema.Struct({
          platform: Schema.String.check(Schema.isMinLength(1)),
        }),
        output: Schema.Struct({ ok: Schema.Boolean }),
      },
    },
  },
} as const;

// ── Durable-log fallback (ported from the old src/mcp/tools.ts) ─────────────

/** The durable log path for a node id, but only when it provably stays under
 *  `.ci/<sha7>/`. The token is untrusted MCP input and `logPathFor` splices
 *  the namepath straight into a relative path, so a crafted id
 *  (`../../etc/x@plat`, an absolute path, a separator in the platform) could
 *  otherwise escape the run's log dir. Returns `null` for any id that doesn't
 *  resolve to a `.log` file inside the per-SHA directory. */
function durableLogPath(
  repoRoot: string,
  sha7: string,
  token: string,
): string | null {
  const { namepath, platform } = splitFanId(token);
  if (namepath === "" || platform === "" || platform === "unknown") return null;
  const base = resolve(repoRoot, ".ci", sha7);
  const file = resolve(repoRoot, logPathFor(sha7, token));
  const rel = relative(base, file);
  // Must stay under `base` (no `..` escape, not an absolute sibling).
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`${sep}`)) {
    return null;
  }
  return file;
}

/** Read at most the last `maxBytes` bytes of a file, matching the cap the live
 *  in-memory tail enforces — a durable CI log can be arbitrarily large, and
 *  returning it whole would block the server and blow up the MCP payload. */
function tailFile(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** The durable-file fallback for a node id when no live frame is cached: read
 *  `.ci/<sha7>/<platform>/<node>.log`, bounded to `MAX_LOG_CHARS`, with the
 *  path-traversal guard. The `repoRoot`/`sha7` identity arrives as arguments —
 *  resolved through the same injection seam (`resolveRunContext`) as the socket
 *  — so this stays a pure A→B mapping and doesn't probe the process's git.
 *  Best-effort: any failure (no file, an escaping id) reads "missing". */
export function durableLog(token: string, repoRoot: string, sha7: string): LogEntry {
  const file = durableLogPath(repoRoot, sha7, token);
  if (file === null) return { node: token, source: "missing", text: "" };
  try {
    return { node: token, source: "file", text: tailFile(file, MAX_LOG_CHARS) };
  } catch {
    return { node: token, source: "missing", text: "" };
  }
}

/** Where am I checked out and at what SHA — the durable-log identity, resolved
 *  through the same injection boundary as the socket. Returns `null` when the
 *  cwd isn't a git checkout (or HEAD is unreadable), in which case a no-live
 *  log read reports "missing". Defaults to git (`gitTopLevel`/`headSha7`) in
 *  `mcp.ts`; tests pass a stub so the projection stays a pure A→B mapping with
 *  one injected view of the world. */
export type ResolveRunContext = () => { repoRoot: string; sha7: string } | null;

// ── The logs collection's read store ────────────────────────────────────────

/** A logs store with a late-bound publish hook. `publish` is the framework's
 *  *wrapped* collection upsert (`ctx.collections.logs.upsert`), which both
 *  persists the value and broadcasts it on the collection's per-key + key-set
 *  buses — the surface-mcp pusher turns that broadcast into a
 *  `notifications/resources/updated`. It's settable because the wrapped upsert
 *  only exists *after* `implementSurface` has wired this store, so the store is
 *  built first and handed its publisher once `implement` returns. */
export interface LogsStore {
  readAll: () => Map<string, LogEntry>;
  readOne: (id: string) => LogEntry | undefined;
  upsert: (id: string, value: LogEntry) => void;
  remove: (id: string) => void;
  /** Wire the framework's broadcasting upsert (after `implement`). */
  setPublish: (publish: (id: string, value: LogEntry) => void) => void;
}

/**
 * Back the `logs` collection with a live-following cache.
 *
 * `@kolu/surface`'s collection contract reads each item synchronously
 * (`collectionHandlers.get` yields `readOne(key)` as the snapshot's first
 * frame — it can't await), but the live frames of `a.surface.nodeLog.get` are
 * genuinely async. So this store:
 *
 *   - serves `readOne(id)` from an in-memory cache, falling back to the
 *     durable-file read (with all guards) on a miss — so a read always returns
 *     a value;
 *   - on a miss, opens a *following* live subscription to `nodeLog` (snapshot,
 *     then appends) and pushes every accumulated frame through the framework's
 *     broadcasting `upsert` (the `publish` hook). That broadcast drives the
 *     per-key bus a `resources/subscribe` on `surface://collections/logs/{id}`
 *     watches, so a subscriber is notified for the live snapshot *and* for each
 *     later append — not just on a key-set delta re-read.
 *
 * The clamp: the durable read clamps to 64KB; the live buffer is already
 * clamped by the coordinator's in-memory tail, and `clampLog` re-clamps the
 * accumulation so a long-lived follow can't grow the cached entry unbounded.
 */
function makeLogsStore(
  client: OduSurfaceClient,
  resolveRunContext: ResolveRunContext,
): LogsStore {
  const cache = new Map<string, LogEntry>();
  const following = new Set<string>();
  // Defaults to a bare cache write until `setPublish` wires the framework's
  // broadcasting upsert; after that, every write also notifies subscribers.
  let publish = (id: string, value: LogEntry): void => {
    cache.set(id, value);
  };

  // Follow the live `nodeLog` stream for `id`: the first frame is the buffered
  // snapshot, later frames are appends. Accumulate and publish each so a
  // subscriber sees the snapshot and every append. Stays open until the stream
  // ends (run done / link drop); a failure leaves the durable fallback in
  // place. One follow per id (`following` guards re-entry).
  const follow = (id: string): void => {
    if (following.has(id)) return;
    following.add(id);
    void (async () => {
      try {
        let text = "";
        for await (const frame of subscribe(client.surface.nodeLog.get({ id }))) {
          // `end` adds no bytes and republishing the unchanged text would only
          // wake every subscriber for nothing. Stay on the stream: a rerun
          // re-opens this node's log with a fresh snapshot.
          if (frame.kind === "end") continue;
          text =
            frame.kind === "append"
              ? clampLog(text + frame.text)
              : clampLog(frame.text);
          publish(id, { node: id, source: "live", text });
        }
      } catch {
        // No live frame / link drop — leave the durable fallback in place.
      } finally {
        following.delete(id);
      }
    })();
  };

  const readOne = (id: string): LogEntry => {
    const live = cache.get(id);
    if (live !== undefined) return live;
    // Cache miss: start following so future frames notify, return the durable
    // fallback now so the read never blocks and never returns undefined (a
    // collection's `get` errors on an undefined first snapshot). The git
    // identity arrives through the injection seam, not a probe inside the read.
    follow(id);
    const ctx = resolveRunContext();
    if (ctx === null) return { node: id, source: "missing", text: "" };
    return durableLog(id, ctx.repoRoot, ctx.sha7);
  };

  return {
    readAll: () => new Map(cache),
    readOne,
    upsert: (id, value) => {
      cache.set(id, value);
    },
    remove: (id) => {
      cache.delete(id);
    },
    setPublish: (p) => {
      publish = p;
    },
  };
}

// ── The re-dialing A-client ──────────────────────────────────────────────────

/** Dial the coordinator socket, or `null` when no run is live. Injectable so
 *  the tests drive a controllable surface; defaults to the real unix-socket
 *  dial in `mcp.ts`. */
export type DialA = () => Promise<{
  client: OduSurfaceClient;
  close: () => Promise<void>;
} | null>;

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
   * awaited from there anyway. `Stream.unwrapScoped` over an `acquireRelease`
   * makes the DIAL a scoped resource of the stream: the release is part of the
   * stream's own teardown, an interruption runs it, and it is an `Effect` so
   * the now-async `close()` is genuinely awaited before the scope closes.
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
  const NO_RUN_ACK = { ok: false } as const;

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

// ── The projection ──────────────────────────────────────────────────────────

/** B's server impl deps, given a live A-client. `onStore` receives the logs
 *  store this call built so `implement`'s wrapper can wire its broadcasting
 *  `publish` from the ctx the package returns. Typed against the minimal
 *  `OduSurfaceClient` (see its note) so the heavy per-spec client union is
 *  never materialized; cast onto the package's `deps` signature below. */
function agentDeps(
  a: OduSurfaceClient,
  resolveRunContext: ResolveRunContext,
  onStore: (store: LogsStore) => void,
) {
  const logs = makeLogsStore(a, resolveRunContext);
  onStore(logs);
  return {
    streams: {
      // Map A's `nodes` cell (snapshot-then-deltas) onto B's `nodes` stream.
      // `deriveStream` preserves snapshot-then-deltas, so B's first frame is
      // A's current snapshot mapped — a one-shot read awaits the real upstream
      // value, and a subscriber gets deltas on every transition.
      nodes: deriveStream(
        (_input: void) => a.surface.nodes.get(undefined),
        // An empty pipeline is the no-run / pre-run value (EMPTY_STATE when no
        // coordinator is live) — `toAgentNodes` maps it to `{ run: false }`.
        // A live run always has at least one node.
        (state: PipelineState): AgentNodes => toAgentNodes(state),
      ),
    },
    collections: {
      logs,
    },
    // A forwarded procedure is JUST the upstream call now. Both sides are
    // Effects, so the `Effect.promise` lift these carried is gone — that is the
    // "forwarder suppliers get simpler" row, and it removes a real hazard with
    // it: `Effect.promise` over a value that is ALREADY an Effect would have
    // succeeded with the Effect object rather than the result.
    //
    // `orDie` is the disposition, and it is the same one `deriveStream` takes
    // for an upstream stream failure. B.s spec declares no procedure error, so
    // a `SurfaceCallFailure` from A — the coordinator socket dying mid-call —
    // is by definition UNDECLARED on this surface. D4 says an undeclared
    // failure is a defect, and a defect is what an agent must see: laundering a
    // dropped link into a `{ ok: false }` would tell it the rerun was refused
    // when nobody was there to refuse it.
    procedures: {
      node: {
        rerun: ({ input }: { input: { id: string } }) =>
          Effect.orDie(a.surface.node.rerun(input)),
        cancel: ({ input }: { input: { id: string } }) =>
          Effect.orDie(a.surface.node.cancel(input)),
      },
      lane: {
        cancel: ({ input }: { input: { platform: string } }) =>
          Effect.orDie(a.surface.lane.cancel(input)),
      },
    },
  };
}

/** B's projected surface plus an `implement` that wires the logs store's
 *  broadcasting publish from the implemented ctx. */
export interface AgentProjection {
  surface: ReturnType<typeof projectSurface>["surface"];
  /** The served pair a host mounts: the flat group B advertises and the
   *  tag-keyed handlers bound to it. The `any`-typed oRPC router this returned
   *  is gone — a tag carries its own route, so there is nothing opaque left. */
  implement: (client: { surface: Record<string, unknown> }) => {
    group: RpcGroup.RpcGroup<Rpc.Any>;
    handlers: SurfaceHandlers;
  };
}

/** Build `oduAgentSurface` (B) as a projection of `oduSurface` (A). Pass the
 *  source surface so `projectSurface` pins A's spec, and `resolveRunContext` —
 *  the durable-log identity (repo root + SHA) — so that input arrives through
 *  the same injection boundary as the socket rather than the projection probing
 *  git itself. `mcp.ts` passes a git-backed resolver; tests pass a stub.
 *
 *  `implement` wraps the package's: after wiring B's server it hands the logs
 *  store the framework's *broadcasting* upsert (`ctx.collections.logs.upsert`)
 *  via `setPublish`, so a live `nodeLog` frame published into the store reaches
 *  the collection's per-key bus — which is what a `resources/subscribe` on a
 *  log item watches. Without this the store would only ever write its private
 *  cache and a subscriber would never be notified.
 *
 *  `agentDeps` is cast onto `projectSurface`'s `deps` parameter: its declared
 *  type wants `SurfaceClientOf<typeof oduSurface.spec>`, which overflows TS's
 *  union budget for this surface (TS2590). The runtime client only ever has
 *  `.surface.nodes/.nodeLog/.node` read, which `OduSurfaceClient` covers — the
 *  same union-budget dodge the package documents for its own `implement`. */
export function buildAgentProjection(
  source: typeof oduSurface,
  resolveRunContext: ResolveRunContext,
): AgentProjection {
  let pendingStore: LogsStore | null = null;
  const projection = projectSurface(source, {
    spec: agentSpec,
    // No cast. `deps`'s declared param is `SurfaceClientOf<typeof
    // oduSurface.spec>` — the narrow READ face — which this now names directly;
    // the `as never` that used to hide a TS2590 overflow is deleted, and with it
    // the risk that a genuine type error was being hidden alongside it.
    deps: (client) =>
      agentDeps(client, resolveRunContext, (store) => {
        pendingStore = store;
      }),
  });
  return {
    surface: projection.surface,
    implement: (client) => {
      const implemented = projection.implement(client);
      // The store `agentDeps` just built (captured during `implement`) gets the
      // framework's wrapped upsert, which persists *and* broadcasts.
      const store = pendingStore;
      pendingStore = null;
      const ctx = implemented.ctx as {
        collections: { logs: { upsert: (k: string, v: LogEntry) => void } };
      };
      store?.setPublish((id, value) => ctx.collections.logs.upsert(id, value));
      return { group: implemented.group, handlers: implemented.handlers };
    },
  };
}
