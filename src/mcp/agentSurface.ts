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
 *   - cell `nodes` (PipelineState) → cell `nodes` ({ run, pipeline, nodes[] })
 *     via `deriveCell`: every A frame is flattened to agent rows (id/status/
 *     exit/duration + the `red` verdict bit).
 *   - stream `nodeLog` ({ id }) → collection `logs` keyed by node id: one
 *     node's output as a `{ node, source, text }` record. The collection read
 *     pulls the live `nodeLog` first frame (the buffered snapshot), falling
 *     back to the durable `.ci/<sha7>/<platform>/<node>.log` when no run is
 *     live — the 64KB clamp + the path-traversal guard live in this handler.
 *   - procedure `node.rerun` → `node.rerun` (pass-through to A).
 *
 * `header` and `run.configure` are absent by construction: `header` isn't
 * mapped (it carries no agent value the `nodes` rows don't), and
 * `run.configure` lives on `laneSurface`, never on A — so neither can leak.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { deriveCell, projectSurface } from "@kolu/surface/project";
import { inMemoryChannelByName } from "@kolu/surface/server";
import { z } from "zod";
import { rowsOf } from "../cli/render";
import { splitFanId } from "../common/nodeId";
import {
  MAX_LOG_CHARS,
  type oduSurface,
  type PipelineState,
} from "../common/surface";
import { gitTopLevel, headSha7 } from "../common/git";
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

/** The agent `nodes` cell: the pipeline flattened to rows the agent triages.
 *  `run: false` (with a null pipeline and no rows) is the pre-run / no-run
 *  value, mirroring the old `get_nodes` tool's `NodesResult`. */
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
  nodes: z.array(NodeRowSchema),
});
export type AgentNodes = z.infer<typeof AgentNodesSchema>;

const EMPTY_NODES: AgentNodes = { run: false, pipeline: null, nodes: [] };

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
  cells: {
    nodes: { schema: AgentNodesSchema, default: EMPTY_NODES },
  },
  collections: {
    // A plain `z.string()` key, NOT `TaskIdSchema` (`z.string().min(1)`):
    // `@kolu/surface-mcp`'s collection-item URI decoder classifies a key as
    // "string-typed" via `keySchema.safeParse("").success`, which a `.min(1)`
    // string rejects — it would then try `JSON.parse` on the id segment and
    // fail to address any real node id. A node id is never empty in practice,
    // so the looser key schema is safe and makes `logs/{id}` addressable.
    logs: { keySchema: z.string(), schema: LogEntrySchema },
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
    const size = statSync(path).size;
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
 *  `.ci/<sha7>/<platform>/<node>.log` (sha from git HEAD — no live socket in
 *  this branch), bounded to `MAX_LOG_CHARS`, with the path-traversal guard.
 *  Best-effort: any failure (no git, no file, an escaping id) reads "missing".
 *  Exported for the guard tests (path-traversal + 64KB clamp). */
export function durableLog(token: string): LogEntry {
  const repoRoot = gitTopLevel();
  const sha7 = headSha7(repoRoot);
  if (repoRoot === null || sha7 === null) {
    return { node: token, source: "missing", text: "" };
  }
  const file = durableLogPath(repoRoot, sha7, token);
  if (file === null) return { node: token, source: "missing", text: "" };
  try {
    return { node: token, source: "file", text: tailFile(file, MAX_LOG_CHARS) };
  } catch {
    return { node: token, source: "missing", text: "" };
  }
}

// ── The logs collection's read store ────────────────────────────────────────

/**
 * Back the `logs` collection's synchronous read with a live-then-file cache.
 *
 * `@kolu/surface`'s collection contract reads each item synchronously
 * (`collectionHandlers.get` yields `readOne(key)` as the snapshot's first
 * frame — it can't await). The live first frame of `a.surface.nodeLog.get`,
 * though, is genuinely async. So this store:
 *
 *   - serves `readOne(id)` from an in-memory cache, falling back to the
 *     durable-file read (with all guards) on a miss — so a read always
 *     returns a value;
 *   - on a miss, kicks off a one-shot live subscription that pulls the
 *     `nodeLog` buffered snapshot and writes it into the cache, so the *next*
 *     read of that id returns the live text. The MCP `logs/<id>` resource is
 *     subscribable: the surface-mcp pusher re-reads on every key-set delta,
 *     which upgrades the file/empty snapshot to the live value once it lands.
 *
 * This is the one place that bridges A's async log stream onto B's sync
 * collection read; the 64KB clamp rides the durable read, and the live frame
 * is already clamped by the coordinator's in-memory tail.
 */
function makeLogsStore(client: OduSurfaceClient): {
  readAll: () => Map<string, LogEntry>;
  readOne: (id: string) => LogEntry | undefined;
  upsert: (id: string, value: LogEntry) => void;
  remove: (id: string) => void;
} {
  const cache = new Map<string, LogEntry>();
  const priming = new Set<string>();

  // Pull the live buffered snapshot for `id` and cache it. One-shot: the
  // `nodeLog` stream's first frame is the whole current buffer. A failure
  // (invalid id, no live run, link drop) leaves the cache as-is so the next
  // read falls back to the durable file.
  const primeLive = (id: string): void => {
    if (priming.has(id)) return;
    priming.add(id);
    void (async () => {
      try {
        const stream = await client.surface.nodeLog.get({ id });
        for await (const frame of stream) {
          cache.set(id, { node: id, source: "live", text: frame.text });
          break; // buffered snapshot only — non-follow
        }
      } catch {
        // No live frame — leave the durable fallback in place.
      } finally {
        priming.delete(id);
      }
    })();
  };

  const readOne = (id: string): LogEntry => {
    const live = cache.get(id);
    if (live !== undefined) return live;
    // Cache miss: kick off the live pull for next time, return the durable
    // fallback now so the read never blocks and never returns undefined (a
    // collection's `get` errors on an undefined first snapshot).
    primeLive(id);
    return durableLog(id);
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
  };
}

// ── The projection ──────────────────────────────────────────────────────────

/** B's server impl deps, given a live A-client. Typed against the minimal
 *  `OduSurfaceClient` (see its note) so the heavy per-spec client union is
 *  never materialized; cast onto the package's `deps` signature below. */
function agentDeps(a: OduSurfaceClient) {
  return {
    channel: inMemoryChannelByName(),
    cells: {
      nodes: deriveCell(
        (opts) => a.surface.nodes.get({}, opts),
        (state: PipelineState): AgentNodes => ({
          run: true,
          pipeline: state.name,
          nodes: rowsOf(state),
        }),
        EMPTY_NODES,
      ),
    },
    collections: {
      logs: makeLogsStore(a),
    },
    procedures: {
      node: {
        rerun: ({ input }: { input: { id: string } }) =>
          a.surface.node.rerun(input),
      },
    },
  };
}

/** Build `oduAgentSurface` (B) as a projection of `oduSurface` (A). Pass the
 *  source surface so `projectSurface` pins A's spec.
 *
 *  `agentDeps` is cast onto `projectSurface`'s `deps` parameter: its declared
 *  type wants `SurfaceClientOf<typeof oduSurface.spec>`, which overflows TS's
 *  union budget for this surface (TS2590). The runtime client only ever has
 *  `.surface.nodes/.nodeLog/.node` read, which `OduSurfaceClient` covers — the
 *  same union-budget dodge the package documents for its own `implement`. */
export function buildAgentProjection(source: typeof oduSurface) {
  return projectSurface(source, {
    spec: agentSpec,
    // `deps` is cast (`as never`): its declared param is
    // `SurfaceClientOf<typeof oduSurface.spec>`, materializing which here
    // overflows TS's union budget (TS2590). `A` is still inferred from
    // `source` and `B` from `spec`, so the return type stays precise.
    deps: agentDeps as never,
  });
}
