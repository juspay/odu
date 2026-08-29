/**
 * `@odu/run-client/surface` — `oduSurface`, the typed contract a live odu run
 * serves on `<checkout>/.ci/odu.sock`, and the whole state vocabulary it
 * speaks.
 *
 * The coordinator fans every lane in and serves THIS surface; `odu status` /
 * `logs` / `attach`, the `odu mcp` agent face, and an out-of-repo consumer that
 * hydrates this package alone are all the same kind of client of it. The lane
 * primitives, the fan-in-only `header` cell, and the mutations:
 *
 *   surface.nodes.get({})          — the whole pipeline, then deltas
 *   surface.nodeLog.get({ id })    — buffered snapshot frame, then appends
 *   surface.header.get({})         — the run ENVIRONMENT: lane roster, commit
 *                                    link, start clock
 *   surface.node.rerun({ id })     — reset a node + its dependents
 *   surface.node.cancel({ id })    — stop one unit of work
 *   surface.lane.cancel({ … })     — drop one platform mid-run
 *   surface.run.cancel({})         — tell the coordinator to tear the run down
 *
 * Node ids are `<namepath>@<platform>` — see `./nodeId`, which owns that
 * format and the folds a reader performs on it.
 *
 * The coordinator serves this BEFORE it claims a machine (juspay/odu#84), so
 * `header` changes during a run and every reader FOLLOWS the cell rather than
 * latching its first frame.
 */

import { buildSurfaceFace } from "@kolu/surface/client";
import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { Schema } from "effect";
import { NodeIdSchema } from "./nodeId";

/** The zod→Effect Schema mapping is LAW on this surface (kolu PLAN #17), and
 *  every field below is wire-bearing:
 *
 *    - `.optional()` → `Schema.optionalKey`, never `Schema.optional`. Absent
 *      means ABSENT; `optional` round-trips an explicit `undefined` through
 *      `null` and would put a `null` where a key used to be missing.
 *    - `optionalKey` REJECTS a present-but-`undefined` key on decode AND on
 *      encode. Every producer of `seq` / `posting` must omit the key rather
 *      than spell it `undefined`; odu's byte-parity suite pins both
 *      directions.
 *
 *  The encoded bytes of `PipelineState` and `NodeLogMessage` are frozen: they
 *  cross the unix socket, the stdio wire to the lane agent, and the on-disk
 *  ledger odu projects them into. */
export const NodeStatusSchema = Schema.Literals([
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
  /** Infrastructure death (lane link drop, interrupted coordinator) — never
   *  emitted by the runner itself; overlaid by the coordinator. Maps to
   *  GitHub state `error` and `--progress json` status `errored`. */
  "errored",
  /** Operator intent: a deliberate per-node / per-lane cancel (juspay/odu#68).
   *  Not red — distinct from failed/errored so wait_for_settle and the ledger
   *  record cancel rather than a test or infra failure. */
  "cancelled",
]);
export type NodeStatus = typeof NodeStatusSchema.Type;

/** GitHub commit-status state (the `state` field of the statuses API). */
export type GithubState = "pending" | "success" | "failure" | "error";

/** `--progress json` status — the external wording for a node transition. */
export type ProgressStatus =
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "errored"
  | "cancelled";

/** The semantic colour of a status, named by meaning rather than by medium.
 *  Each face maps it to its own encoding — an ansi wrapper for a stream, a hex
 *  cell attribute for a grid renderer — so the assignment ("errored is violet")
 *  is made once and rendered many times. */
export type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

/** The single projection of a `NodeStatus` onto its external-facing
 *  representations: TUI glyph, GitHub state, `--progress json` status, whether
 *  the status counts as "red" in the verdict, and its semantic hue. Adding a
 *  `NodeStatus` is a single edit here that the compiler enforces at every
 *  consumer, in this tree and downstream. What a status IS on the wire and what
 *  it MEANS to a reader are the same fact, so no face keeps a second table.
 *  What is not here is wording: justci's byte-parity commit-status
 *  descriptions stay with the poster that emits them — a different
 *  volatility. */
export const STATUS_META: Record<
  NodeStatus,
  {
    glyph: string;
    github: GithubState | null;
    progress: ProgressStatus | null;
    isRed: boolean;
    hue: StatusHue;
  }
> = {
  pending: { glyph: "◦", github: null, progress: null, isRed: false, hue: "grey" },
  running: {
    glyph: "▶",
    github: "pending",
    progress: "running",
    isRed: false,
    hue: "amber",
  },
  ok: {
    glyph: "✔",
    github: "success",
    progress: "success",
    isRed: false,
    hue: "green",
  },
  failed: {
    glyph: "✗",
    github: "failure",
    progress: "failed",
    isRed: true,
    hue: "red",
  },
  skipped: {
    glyph: "⊘",
    github: null,
    progress: "skipped",
    isRed: false,
    hue: "grey",
  },
  errored: {
    glyph: "⚠",
    github: "error",
    progress: "errored",
    isRed: true,
    hue: "violet",
  },
  // Success on GitHub so a deliberate lane drop does not leave a required
  // context pending or post a spurious failure/error (juspay/odu#68).
  cancelled: {
    glyph: "◼",
    github: "success",
    progress: "cancelled",
    isRed: false,
    hue: "grey",
  },
};

export const NodeStateSchema = Schema.Struct({
  id: NodeIdSchema,
  name: Schema.String,
  command: Schema.String,
  needs: Schema.Array(NodeIdSchema),
  status: NodeStatusSchema,
  /** Process exit code once terminal; `null` while pending/running or when
   *  the process never spawned (a spawn failure is `failed` + `null`). */
  exitCode: Schema.NullOr(Schema.Int),
  /** `Date.now()` when the node started running; `null` until then. */
  startedAt: Schema.NullOr(Schema.Number),
  /** Wall-clock run time in ms once terminal; `null` otherwise. */
  durationMs: Schema.NullOr(Schema.Number),
});
export type NodeState = typeof NodeStateSchema.Type;

/** A fresh node: the caller supplies identity + dependencies; the four
 *  terminal/timing fields start at their `pending` defaults.
 *
 *  The zero of `NodeState`, beside {@link EMPTY_STATE} and {@link EMPTY_HEADER}
 *  — the three wire types' three zero values, in the module that owns the three
 *  shapes. One place owns what an unstarted node looks like, so adding a
 *  `NodeState` field cannot drift between the coordinator's seed site, the
 *  runner's, and a reader painting a row it has no frame for. */
export function pendingNode(seed: {
  id: string;
  name: string;
  command: string;
  needs: string[];
}): NodeState {
  return {
    ...seed,
    status: "pending",
    exitCode: null,
    startedAt: null,
    durationMs: null,
  };
}

/** One GitHub context still owed a confirmed post. Degraded posting is derived
 *  from `owed.length > 0` — no separate state flag. */
export const OwedStatusSchema = Schema.Struct({
  context: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OwedStatus = typeof OwedStatusSchema.Type;

/** GitHub status-posting health for a live run. Empty `owed` when every post
 *  is confirmed (or posting disabled). Every face (`status` / `attach` / MCP)
 *  reads this so a reporting divergence is never silent (juspay/odu#61). */
export const PostingHealthSchema = Schema.Struct({
  owed: Schema.Array(OwedStatusSchema),
});
export type PostingHealth = typeof PostingHealthSchema.Type;

export const EMPTY_POSTING: PostingHealth = { owed: [] };

export const PipelineStateSchema = Schema.Struct({
  name: Schema.String,
  /** The run's commit, 7 hex chars — `odu run` stamps it from HEAD onto the
   *  fan-in surface so a face renders the durable log path (`.ci/<sha7>/…`)
   *  and the sha label from surface state instead of re-deriving the sha from
   *  git and drifting. Empty in the pre-run {@link EMPTY_STATE}. */
  sha7: Schema.String,
  /** The run's working tree had uncommitted changes — the verdict is about
   *  that tree, not the commit. Drives the `+dirty` sha label every face
   *  shows. Authoritative only on the coordinator's fan-in (the lane copy is
   *  advisory). */
  dirty: Schema.Boolean,
  /** This run's ordinal among runs of the same `sha7` in this checkout (1-based
   *  — the ledger's `seq`, rendered `<sha7>#<seq>`). Completes the
   *  run's identity on the surface so a verdict says WHICH run it describes, not
   *  just which commit — the fix for the agent face's stale/no-run ambiguity
   *  (juspay/odu#49). Absent (not a fake `0`) when no ordinal was reserved: the
   *  pre-run EMPTY_STATE, the advisory lane copy, or the rare case the
   *  coordinator couldn't durably reserve a seq (then the run claims `sha7` but
   *  no unique `<sha7>#<seq>`). Authoritative only on the coordinator's fan-in,
   *  like `dirty`. */
  seq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Node ids in scheduling order — the row order dashboards paint. */
  order: Schema.Array(NodeIdSchema),
  nodes: Schema.Record(NodeIdSchema, NodeStateSchema),
  /** GitHub commit-status posting health (juspay/odu#61). Fan-in only; absent
   *  or empty `owed` means nothing owed. Lane copies omit it. */
  posting: Schema.optionalKey(PostingHealthSchema),
});
export type PipelineState = typeof PipelineStateSchema.Type;

/** Posting health on a state, defaulting to healthy when absent. */
export function postingOf(state: Pick<PipelineState, "posting">): PostingHealth {
  return state.posting ?? EMPTY_POSTING;
}

export const EMPTY_STATE: PipelineState = {
  name: "pipeline",
  sha7: "",
  dirty: false,
  order: [],
  nodes: {},
  posting: EMPTY_POSTING,
};

/** `Schema.Union`, not `Schema.TaggedUnion` — the discriminant is `kind`, not
 *  `_tag`, and these bytes are frozen (they cross both the stdio wire and the
 *  fan-in socket).
 *
 *  FROZEN means no arm is ever removed or reshaped. ADDING one — as `end` was
 *  added — is a ONE-WAY compatibility step. A client of this socket is
 *  routinely a DIFFERENT BUILD from the coordinator serving it, so a reader
 *  older than the server fails to decode `{"kind":"end"}` and there is no
 *  handshake to catch it. A fourth arm needs a reason, not just a use.
 *
 *  Three frames, because a node's log is FINITE and the stream must be able to
 *  say so. `snapshot` seeds a subscriber, `append` extends, and `end` is the
 *  terminal: this node has produced all the output it ever will (its process
 *  closed its stdio, or it reached a terminal status without running). It
 *  carries no `text` — there is nothing left to say — so every consumer is
 *  forced by the compiler to decide what completion means to it.
 *
 *  Without `end` the log stream has no terminal, and "the lane is still sending
 *  me this node's output" is unobservable — so the coordinator tore its
 *  subscriptions down at settle and silently dropped whatever was still in
 *  flight, which is precisely how a recipe's final summary went missing
 *  (juspay/odu#87). */
export const NodeLogMessageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("append"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("end") }),
]);
export type NodeLogMessage = typeof NodeLogMessageSchema.Type;

/** The bound on a `snapshot` frame: a server keeps at most this much of a
 *  node's log in memory for late subscribers, and the full log is durable
 *  elsewhere (the coordinator streams every `append` into
 *  `.ci/<sha>/<platform>/<node>.log` as it arrives).
 *
 *  It is a promise the WIRE makes — a subscriber's first frame is a tail, not a
 *  beginning — so a face that re-assembles and re-clamps a log applies THIS
 *  bound rather than a second one beside it. */
export const MAX_LOG_CHARS = 64 * 1024;
export function clampLog(buffer: string): string {
  return buffer.length > MAX_LOG_CHARS
    ? buffer.slice(buffer.length - MAX_LOG_CHARS)
    : buffer;
}

/** One platform's place in the run's lane roster — ONE concept with two
 *  states, not two parallel lists:
 *
 *  - `claiming` — the venue lease has not resolved yet, and `pool` is the set
 *    of machines it may land on. A run carrying any of these is still
 *    provisioning (see {@link runPhase}).
 *  - `leased` — the lease resolved and `host` is the machine the lane runs on.
 *
 *  A discriminated union rather than `lanes` + `claiming` arrays: a platform is
 *  in exactly one state, and two arrays let the type express a platform in both
 *  (or neither) — an invariant every reader would then have to re-join by hand,
 *  in whatever order it happened to traverse them. */
export const RunLaneSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("claiming"),
    platform: Schema.String,
    pool: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("leased"),
    platform: Schema.String,
    host: Schema.String,
  }),
]);
export type RunLane = typeof RunLaneSchema.Type;
export type LeasedLane = Extract<RunLane, { state: "leased" }>;
export type ClaimingLane = Extract<RunLane, { state: "claiming" }>;

/** The leased half of a roster, IN ROSTER ORDER — for the readers that can only
 *  speak about lanes that have a machine (odu's durable run record, the
 *  `plat=host` projections). */
export function leasedLanes(header: Pick<RunHeader, "lanes">): LeasedLane[] {
  return header.lanes.filter((l): l is LeasedLane => l.state === "leased");
}

/** The claiming half of a roster, in roster order. */
export function claimingLanes(header: Pick<RunHeader, "lanes">): ClaimingLane[] {
  return header.lanes.filter((l): l is ClaimingLane => l.state === "claiming");
}

/** The run's *environment* — what `run` set up that the `nodes` state can't
 *  already tell you: the lane→host map, where it came from, and the forge
 *  commit link. Commit identity (pipeline name + sha7 + dirty) lives on
 *  `PipelineState`, so it isn't duplicated here. `run` has this in-process; a
 *  client reads it from the fan-in `header` cell so its matrix shows the real
 *  lane→host map and commit link, not an observer stub.
 *
 *  Published TWICE per run, not once (juspay/odu#84, see the module header): a
 *  claiming roster first, the resolved lane→host map once every lease settles.
 *  Every reader of `lanes` must therefore follow the cell rather than keep its
 *  first frame. */
export const RunHeaderSchema = Schema.Struct({
  /** Forge page for the commit (GitHub origins); the sha label becomes an
   *  OSC 8 hyperlink where supported. Null elsewhere. */
  commitUrl: Schema.NullOr(Schema.String),
  /** The run's lane roster, one entry per active platform in platform order —
   *  see {@link RunLaneSchema}. Every reader traverses this ONE list, so no two
   *  faces can order the run's platforms differently. Empty only for a run that
   *  has published nothing (or one whose claim got nothing at all). */
  lanes: Schema.Array(RunLaneSchema),
  /** Where the lane→host map came from (`hosts.json`, a pool lease, …);
   *  null before the run publishes its header. */
  hostsSource: Schema.NullOr(Schema.String),
  /** The run's start wall-clock (`Date.now()`), set once by `run` — the matrix
   *  elapsed timer counts from it. Every face reads one value rather than each
   *  deriving its own start, so a piped attach and the live matrix agree. `0`
   *  before the run publishes its header. */
  startedAt: Schema.Number,
});
export type RunHeader = typeof RunHeaderSchema.Type;

/** The pre-run header — what a client reads before the coordinator publishes,
 *  and the cell default. An empty `lanes` collapses a banner's host line. */
export const EMPTY_HEADER: RunHeader = {
  commitUrl: null,
  lanes: [],
  hostsSource: null,
  startedAt: 0,
};

/** Where a run is in its lifecycle, as far as the *environment* is concerned:
 *
 *  - `unstarted` — no run ever published this header: the cell default a client
 *    reads before the coordinator writes, and the stub an observer with no
 *    run-env of its own passes ({@link EMPTY_HEADER}).
 *  - `provisioning` — the run exists, holds the checkout and its ordinal, and is
 *    claiming a machine for at least one lane. On a cold host that is a multi-
 *    minute `nix copy` of the runner closure with no lane behind it yet; before
 *    juspay/odu#84 the window had no socket at all.
 *  - `lanes` — every lane has a host; the run is the lane fanout the rest of the
 *    surface describes.
 *  - `no_lanes` — a run that tried and got nothing: it published a roster and
 *    its claim resolved to no lanes at all. It exists so an empty roster cannot
 *    answer `lanes` for a run that has none — "lanes is the complete map" is
 *    only true once there IS one, and leaving that as a precondition on a
 *    sibling field is exactly the joint-distribution lie a flat product hides.
 *
 *  `unstarted` and `no_lanes` were one value until a lens review: the fact that
 *  separates them is `startedAt`, so a three-valued enum forced every JSON
 *  reader to learn "`no_lanes` with a null elapsed means unstarted" — the same
 *  precondition-on-a-sibling-field this type was introduced to abolish. The
 *  derivation therefore reads `startedAt` itself.
 *
 *  Derived from the roster rather than stored beside it, so the phase and the
 *  reason for it cannot disagree. */
export type RunPhase = "unstarted" | "provisioning" | "lanes" | "no_lanes";

export function runPhase(
  header: Pick<RunHeader, "lanes" | "startedAt">,
): RunPhase {
  if (header.startedAt === 0) return "unstarted";
  if (header.lanes.length === 0) return "no_lanes";
  return header.lanes.some((l) => l.state === "claiming")
    ? "provisioning"
    : "lanes";
}

/** mini-ci's two state primitives — the `nodes` cell and the `nodeLog` stream.
 *  Spread into {@link oduSurface} here and into odu's lane surface there, so
 *  the fan-in serves the same shapes a lane produced. */
export const nodePrimitives = {
  cells: {
    nodes: {
      schema: PipelineStateSchema,
      default: EMPTY_STATE,
    },
  },
  streams: {
    nodeLog: {
      inputSchema: Schema.Struct({ id: NodeIdSchema }),
      outputSchema: NodeLogMessageSchema,
    },
  },
} as const;

/** Per-node mutations, shared by the coordinator fan-in and odu's lane runner.
 *  `rerun` resets a node + dependents; `cancel` stops a running/pending node.
 *  Platform/lane drop is fan-in-only ({@link oduSurface}'s `lane.cancel`) — not
 *  smuggled into the node id (juspay/odu#68). */
export const nodeProcedures = {
  rerun: {
    input: Schema.Struct({ id: NodeIdSchema }),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
  cancel: {
    input: Schema.Struct({ id: NodeIdSchema }),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** Fan-in-only: drop one platform lane mid-run without tearing down the
 *  coordinator. Distinct from `node.cancel` (one unit of work) and `run.cancel`
 *  (whole-run teardown). */
const laneCancelProcedure = {
  cancel: {
    input: Schema.Struct({
      platform: Schema.String.check(Schema.isMinLength(1)),
    }),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** The fan-in-only run-lifecycle mutation: `run.cancel` tells the live
 *  coordinator to stop — it routes the call into the same teardown path a
 *  SIGINT takes (finalize posted statuses, close lanes, drop the socket,
 *  exit), so a *second* process (`odu cancel`, the MCP `cancel` tool, or a
 *  `--supersede` run) can call off a run it doesn't own without pkill-ing the
 *  coordinator pid. Empty input/`ok` output: cancellation has no parameters,
 *  and the caller confirms teardown by the socket going away, not by this
 *  ack (the coordinator may exit before the reply flushes). */
const cancelProcedure = {
  cancel: {
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** Served by the coordinator on `<checkout>/.ci/odu.sock` — the surface every
 *  face of a live run attaches to. The lane's primitives plus the `header` cell
 *  (the run environment: lane→host map + commit link) a lane has no business
 *  knowing, the `run.cancel` lifecycle mutation a second process drives
 *  teardown through, and `lane.cancel` for dropping one platform mid-run. */
export const oduSurface = defineSurface({
  ...nodePrimitives,
  cells: {
    ...nodePrimitives.cells,
    header: {
      schema: RunHeaderSchema,
      default: EMPTY_HEADER,
    },
  },
  procedures: {
    node: nodeProcedures,
    run: cancelProcedure,
    lane: laneCancelProcedure,
  },
});

type OduSF = SurfaceTypes<typeof oduSurface.spec>;
export type NodesSnapshot = OduSF["cells"]["nodes"]["Value"];
export type NodeLogFrame = OduSF["streams"]["nodeLog"]["Output"];

// ── The typed face, and the one way to build it ─────────────────────────
//
// The surface framework splits a client in two (kolu PLAN D2): a
// transport-neutral, tag-keyed `SurfaceDispatch` that a LINK produces
// (`unixSocketLink`, `stdioLink`, `directDispatch`, an ssh dial), and a nested
// member FACE built over it. `buildSurfaceFace` returns the deliberately
// STRUCTURAL `SurfaceFace` — per-member precision is spec-derived and lives one
// layer up, because a second precise mapped type in the same evaluation pass is
// the union-budget blowup D2 exists to avoid.
//
// So the projection is pinned HERE, once, beside the surface it projects. Every
// consumer — a socket dial, an in-process projection, an out-of-repo reader
// over a hydrated copy of this package — holds the SAME type and reaches
// members the same way, and a schema edit is a compile error at every call
// site.
//
// Two shapes every call site sees:
//   - a PROCEDURE returns `Effect<Out>`, and its INPUT is the ENCODED side of
//     the schema (D2/#13) — the face decodes at its edge;
//   - a CELL / STREAM member returns a lazy `Stream<Out>` SYNCHRONOUSLY.
//     Subscribing is PULLING: the producer starts on the first pull, not when
//     the value is made. Cancellation is fiber interruption (D10/#18).
//
// `SurfaceReadFace` declines to spell cell MUTATION verbs, which costs this
// surface nothing: every writer is in-process (`ctx.cells.nodes.set`), and no
// remote caller has ever written a cell.

/** The coordinator's fan-in face (`.ci/odu.sock`): `nodes`, `nodeLog`,
 *  `header`, plus `node.rerun` / `node.cancel` / `run.cancel` / `lane.cancel`. */
export type OduClient = SurfaceClientOf<typeof oduSurface.spec>;

/** Build the fan-in face over any dispatch. ONE cast, here, so no consumer
 *  writes its own: the runtime object carries every member the type names
 *  (minted by `defineSurface`'s own tag algebra); the cast only tells the
 *  compiler which projection of that walk it is looking at. */
export function oduClientOver(dispatch: SurfaceDispatch): OduClient {
  return buildSurfaceFace(oduSurface, dispatch) as unknown as OduClient;
}
