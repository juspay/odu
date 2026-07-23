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
import { z } from "zod";
import { rowsOf } from "../cli/render";
import { splitFanId } from "../common/nodeId";
import {
  clampLog,
  EMPTY_STATE,
  MAX_LOG_CHARS,
  type oduSurface,
  OwedStatusSchema,
  type PipelineState,
  postingOf,
} from "../common/surface";
import { logPathFor } from "../coordinator/statuses";
import { TaskIdSchema } from "../common/spec";

/**
 * The slice of the live A-client (`oduSurface`) the projection actually uses.
 *
 * Spelled by hand rather than as `SurfaceClientOf<typeof oduSurface.spec>`:
 * the full per-spec client union for `oduSurface` (whose `run.configure` input
 * carries the deeply-nested `TaskSpecSchema`) overflows TS's union budget
 * (TS2590) when materialized inside `projectSurface`'s `deps` position. We only
 * call three leaves, so a minimal structural client is both sufficient and
 * cheap, and the projection's `deps` is cast onto the package's signature (the
 * same union-budget dodge the package itself documents in project.ts). */
interface OduSurfaceClient {
  surface: {
    nodes: {
      get: (
        input: Record<string, never>,
        opts?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<PipelineState>>;
    };
    nodeLog: {
      get: (
        input: { id: string },
        opts?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<{ kind: string; text: string }>>;
    };
    node: {
      rerun: (input: { id: string }) => Promise<{ ok: boolean }>;
    };
  };
}

// ── B's spec ──────────────────────────────────────────────────────────────

/** The agent `nodes` snapshot: the pipeline flattened to rows the agent
 *  triages. `run: false` (with a null pipeline and no rows) is the pre-run /
 *  no-run value, mirroring the old `get_nodes` tool's `NodesResult`. */
const NodeRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  exit_code: z.number().nullable(),
  duration_ms: z.number().nullable(),
  red: z.boolean(),
});

const AgentNodesSchema = z.object({
  run: z.boolean(),
  pipeline: z.string().nullable(),
  /** The live run's identity, projected from `PipelineState` so an agent
   *  verdict says WHICH run it describes (juspay/odu#49): `sha7` the 7-char
   *  commit, `seq` its ordinal among runs of that commit (`<sha7>#<seq>`).
   *  Both are the no-run value (`""` / `null`) when `run` is false. */
  sha7: z.string(),
  seq: z.number().nullable(),
  nodes: z.array(NodeRowSchema),
  /** Full owed GitHub status rows not yet confirmed (juspay/odu#61).
   *  Empty when posting is healthy or disabled; test verdict stays the truth. */
  unposted: z.array(OwedStatusSchema),
});
export type AgentNodes = z.infer<typeof AgentNodesSchema>;

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
      get: (
        input: void,
        opts: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<AgentNodes>>;
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

/**
 * The node-id identity axis as a *collection key*: `TaskIdSchema` minus the
 * `.min(1)` the surface-mcp URI decoder's empty-string probe can't tolerate.
 *
 * The same "what is a valid node id" contract `TaskIdSchema` (`z.string()
 * .min(1)`) spells everywhere else in the surface (node.rerun's input, A's
 * primitives) is deliberately relaxed here for the `logs` collection key:
 * `@kolu/surface-mcp`'s collection-item URI decoder classifies a key as
 * "string-typed" via `keySchema.safeParse("").success`, which a `.min(1)`
 * string rejects — it would then try `JSON.parse` on the id segment and fail to
 * address any real node id. A node id is never empty in practice, so dropping
 * just the lower bound is safe and makes `logs/{id}` addressable.
 *
 * This is the same base string type as `TaskIdSchema` with only the lower
 * bound dropped — named here so the divergence between the two id contracts is
 * a single, intentional, documented difference rather than two independent
 * literals that could silently drift. Should the id ever grow a *format*
 * constraint (a regex/brand beyond the min), tighten it on `TaskIdSchema` and
 * mirror it here, keeping this the lone deliberate relaxation.
 */
const NodeIdKeySchema = z.string();

/** One node's log, keyed by node id in the `logs` collection. `source` says
 *  where the text came from: "live" (the running coordinator's buffered
 *  snapshot), "file" (the durable per-SHA log after the run process exited),
 *  or "missing" (neither). */
const LogEntrySchema = z.object({
  node: z.string(),
  source: z.enum(["live", "file", "missing"]),
  text: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

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
      inputSchema: z.void(),
      outputSchema: AgentNodesSchema,
    },
  },
  collections: {
    // `NodeIdKeySchema` is `TaskIdSchema` minus the `.min(1)` the surface-mcp
    // URI decoder's empty-string probe can't tolerate (see its definition): the
    // node-id contract is named once and the `.min(1)` divergence is the single
    // intentional difference, not two hand-divergent literals.
    logs: { keySchema: NodeIdKeySchema, schema: LogEntrySchema },
  },
  procedures: {
    node: {
      rerun: {
        input: z.object({ id: TaskIdSchema }),
        output: z.object({ ok: z.boolean() }),
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
        const stream = await client.surface.nodeLog.get({ id });
        let text = "";
        for await (const frame of stream) {
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
  close: () => void;
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
 *   - `node.rerun` — dial, call, close; no socket → `{ ok: false }`.
 */
export function redialingAClient(dial: DialA): OduSurfaceClient {
  // Dial fresh, stream the chosen upstream, and close the socket when iteration
  // ends (consumer return/abort, or A closing the stream). `onNoRun` supplies
  // the frames to yield when no coordinator is live.
  async function* streamFresh<F>(
    pick: (a: OduSurfaceClient) => Promise<AsyncIterable<F>>,
    onNoRun: () => AsyncIterable<F>,
  ): AsyncGenerator<F> {
    const dialed = await dial();
    if (dialed === null) {
      yield* onNoRun();
      return;
    }
    try {
      yield* await pick(dialed.client);
    } finally {
      dialed.close();
    }
  }

  async function* one<F>(value: F): AsyncIterable<F> {
    yield value;
  }
  // biome-ignore lint/correctness/useYield: an empty stream — no frames.
  async function* none<F>(): AsyncIterable<F> {
    return;
  }

  return {
    surface: {
      nodes: {
        get: (_input, opts) =>
          Promise.resolve(
            streamFresh<PipelineState>(
              (a) => a.surface.nodes.get({}, opts),
              () => one(EMPTY_STATE),
            ),
          ),
      },
      nodeLog: {
        get: (input, opts) =>
          Promise.resolve(
            streamFresh<{ kind: string; text: string }>(
              (a) => a.surface.nodeLog.get(input, opts),
              () => none(),
            ),
          ),
      },
      node: {
        rerun: async (input) => {
          const dialed = await dial();
          if (dialed === null) return { ok: false };
          try {
            return await dialed.client.surface.node.rerun(input);
          } finally {
            dialed.close();
          }
        },
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
        (_input: void, opts: { signal?: AbortSignal }) =>
          a.surface.nodes.get({}, opts),
        (state: PipelineState): AgentNodes =>
          // An empty pipeline (no nodes) is the no-run / pre-run value the
          // re-dialing A-client yields when no coordinator is live (EMPTY_STATE)
          // — map it to `{ run: false }`, mirroring the old `get_nodes`. A live
          // run always has at least one node.
          state.order.length === 0
            ? EMPTY_NODES
            : {
                run: true,
                pipeline: state.name,
                sha7: state.sha7,
                seq: state.seq ?? null,
                nodes: rowsOf(state),
                unposted: [...postingOf(state).owed],
              },
      ),
    },
    collections: {
      logs,
    },
    procedures: {
      node: {
        rerun: ({ input }: { input: { id: string } }) =>
          a.surface.node.rerun(input),
      },
    },
  };
}

/** B's projected surface plus an `implement` that wires the logs store's
 *  broadcasting publish from the implemented ctx. */
export interface AgentProjection {
  surface: ReturnType<typeof projectSurface>["surface"];
  implement: (client: { surface: Record<string, unknown> }) => {
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's router is opaque (its surface walk is dynamic).
    router: any;
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
    // `deps` is cast (`as never`): its declared param is
    // `SurfaceClientOf<typeof oduSurface.spec>`, materializing which here
    // overflows TS's union budget (TS2590). `A` is still inferred from
    // `source` and `B` from `spec`, so the return type stays precise.
    deps: ((client: OduSurfaceClient) =>
      agentDeps(client, resolveRunContext, (store) => {
        pendingStore = store;
      })) as never,
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
      return { router: implemented.router };
    },
  };
}
