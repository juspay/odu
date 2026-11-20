/**
 * `@odu/run-client/surface` — `oduSurface`, the typed contract a live odu run
 * serves on `<checkout>/.ci/odu.sock`, and the whole state vocabulary it
 * speaks.
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
 * The coordinator serves this BEFORE it claims a machine, so `header` changes
 * during a run and every reader FOLLOWS the cell rather than latching its
 * first frame.
 */

import { buildSurfaceFace } from "@kolu/surface/client";
import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { Schema } from "effect";
import { LogStreamSchema, NodeIdSchema } from "./nodeId";

/** The zod→Effect Schema mapping is LAW on this surface, and every field below
 *  is wire-bearing:
 *
 *    - `.optional()` → `Schema.optionalKey`, never `Schema.optional`. Absent
 *      means ABSENT.
 *    - `optionalKey` REJECTS a present-but-`undefined` key on decode AND on
 *      encode. Every producer of `seq` / `posting` must omit the key rather
 *      than spell it `undefined`.
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
  /** Operator intent: a deliberate per-node / per-lane cancel. Not red —
   *  distinct from failed/errored so wait_for_settle and the ledger record
   *  cancel rather than a test or infra failure. */
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
 *  Each face maps it to its own encoding, so the assignment ("errored is
 *  violet") is made once and rendered many times. */
export type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

/** The single projection of a `NodeStatus` onto its external-facing
 *  representations: TUI glyph, GitHub state, `--progress json` status, whether
 *  the status counts as "red" in the verdict, and its semantic hue. Adding a
 *  `NodeStatus` is a single edit here that the compiler enforces at every
 *  consumer. What is not here is wording: commit-status descriptions stay with
 *  the poster that emits them. */
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

/**
 * A NODE'S PUSH, AS ITS OWN STEP.
 *
 * Three states, because a push is work with a beginning: the recipe exits 0,
 * the lane starts sending the closure, and a minute later it has landed or it
 * has not. `pushing` has to be observable while it is happening.
 *
 * A UNION rather than one struct with nullable counts: only `pushed` has
 * counts to give, and `stored: 0` on a push still running would be a claim
 * about the bucket that nobody made.
 *
 * The node's own `status` reads the RECIPE's verdict throughout; a failed push
 * is what turns it red.
 */
export const NodePushSchema = Schema.Union([
  /** The recipe exited 0 and the closure is on its way. */
  Schema.Struct({ state: Schema.Literal("pushing") }),
  Schema.Struct({
    state: Schema.Literal("pushed"),
    /** Store paths this node UPLOADED — what the bucket did not have and now
     *  has because of this node. */
    stored: Schema.Int,
    /** Store paths of this node's closure the bucket ALREADY served. Told
     *  apart from `stored`: one is work this run did, the other is work it was
     *  spared. */
    present: Schema.Int,
    /** NAR bytes this node's uploads sent — the size of `stored`, not of the
     *  closure the bucket serves. */
    bytes: Schema.Int,
    /** How long the push took, SEPARATE from the node's own `durationMs`,
     *  which stays the recipe's time. */
    durationMs: Schema.Int,
  }),
  /** The closure did not land, and WHY — the push client's own sentence, as
   *  the lane had it when it stamped the cell. The whole of the client's
   *  output stays in the node's push log. */
  Schema.Struct({
    state: Schema.Literal("failed"),
    message: Schema.String,
    durationMs: Schema.Int,
  }),
]);
export type NodePush = typeof NodePushSchema.Type;

/** WHAT A RUN PUT ON ITS BUCKET, over every node — the one fold of this
 *  union, living with the union it folds.
 *
 *  THREE SUMS, SEPARATELY. `stored` and `present` are added apart all the way
 *  up, because collapsing them claims this run sent closures it found already
 *  there. `bytes` belongs to `stored` alone: it is what went over the wire.
 *
 *  Only pushes that LANDED count toward any of the three; the ones that failed
 *  are named instead. `landed` is the count of pushes that completed, which is
 *  NOT `stored > 0`.
 *
 *  ENTRIES rather than a `ReadonlyMap`, because the two callers hold different
 *  maps; both are iterable of `[node, push]`, and that is all this reads. */
export function pushTotals(
  push: Iterable<readonly [string, NodePush]>,
): {
  stored: number;
  present: number;
  bytes: number;
  landed: number;
  failedOn: readonly string[];
} {
  let stored = 0;
  let present = 0;
  let bytes = 0;
  let landed = 0;
  const failedOn: string[] = [];
  for (const [node, one] of push) {
    if (one.state === "pushed") {
      stored += one.stored;
      present += one.present;
      bytes += one.bytes;
      landed += 1;
    } else if (one.state === "failed") {
      failedOn.push(node);
    }
  }
  return { stored, present, bytes, landed, failedOn };
}

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
  /**
   * WHAT THIS NODE'S PUSH IS DOING — set by the lane runner the moment a
   * recipe exits 0, and replaced when the push ends.
   *
   * `optionalKey` and absent by default: a run with no push target, a recipe
   * that built no `result`, and a node that only re-pushed paths an earlier
   * node in this run already sent all mean "this node has no push step".
   */
  push: Schema.optionalKey(NodePushSchema),
});
export type NodeState = typeof NodeStateSchema.Type;

/** A fresh node: the caller supplies identity + dependencies; the four
 *  terminal/timing fields start at their `pending` defaults. One place owns
 *  what an unstarted node looks like, beside {@link EMPTY_STATE} and
 *  {@link EMPTY_HEADER}. */
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
  /** The run's commit, 7 hex chars, stamped from HEAD onto the fan-in surface.
   *  Empty in the pre-run {@link EMPTY_STATE}. */
  sha7: Schema.String,
  /** The run's working tree had uncommitted changes — the verdict is about
   *  that tree, not the commit. Drives the `+dirty` sha label every face
   *  shows. Authoritative only on the coordinator's fan-in (the lane copy is
   *  advisory). */
  dirty: Schema.Boolean,
  /** This run's ordinal among runs of the same `sha7` in this checkout
   *  (1-based — the ledger's `seq`, rendered `<sha7>#<seq>`). Absent (not a
   *  fake `0`) when no ordinal was reserved. Authoritative only on the
   *  coordinator's fan-in, like `dirty`. */
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
 *  FROZEN means no arm is ever removed or reshaped. ADDING one is a ONE-WAY
 *  compatibility step: a client of this socket is routinely a DIFFERENT BUILD
 *  from the coordinator serving it, so a reader older than the server fails to
 *  decode a new arm and there is no handshake to catch it.
 *
 *  `snapshot` seeds a subscriber, `append` extends, and `end` is the terminal:
 *  this node has produced all the output it ever will. It carries no `text`. */
export const NodeLogMessageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("append"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("end") }),
]);
export type NodeLogMessage = typeof NodeLogMessageSchema.Type;

/** The bound on a `snapshot` frame: a server keeps at most this much of a
 *  node's log in memory for late subscribers, and the full log is durable
 *  elsewhere (`.ci/<sha>/<platform>/<node>.log`).
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
 */
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
 *  `PipelineState`.
 *
 *  Published TWICE per run, not once: a claiming roster first, the resolved
 *  lane→host map once every lease settles. Every reader of `lanes` must
 *  therefore follow the cell rather than keep its first frame. */
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
  /** The run's start wall-clock (`Date.now()`), set once by `run` — every face
   *  reads this one value. `0` before the run publishes its header. */
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
 *  - `unstarted` — no run ever published this header ({@link EMPTY_HEADER}).
 *  - `provisioning` — the run exists, holds the checkout and its ordinal, and
 *    is claiming a machine for at least one lane.
 *  - `lanes` — every lane has a host.
 *  - `no_lanes` — a run that published a roster whose claim resolved to no
 *    lanes at all.
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
      /** WHICH node, and WHICH of its two logs. `stream` absent is the
       *  recipe's — the subscription every existing reader opens, unchanged. */
      inputSchema: Schema.Struct({
        id: NodeIdSchema,
        stream: Schema.optionalKey(LogStreamSchema),
      }),
      outputSchema: NodeLogMessageSchema,
    },
  },
} as const;

/** Per-node mutations, shared by the coordinator fan-in and odu's lane runner.
 *  `rerun` resets a node + dependents; `cancel` stops a running/pending node.
 *  Platform/lane drop is fan-in-only ({@link oduSurface}'s `lane.cancel`). */
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

/**
 * The FAN-IN's node group: {@link nodeProcedures}, with `rerun` widened by the
 * identity of the request that asked for it.
 *
 * The id travels, the coordinator writes `retry_accepted` against it BEFORE it
 * mutates anything, and reconciliation reads that exact line. `inputDigest`
 * rides along so the durable record is self-contained.
 *
 * Both are OPTIONAL, and `recorded` on the way back is what says the far end
 * understood them: a coordinator from an older build ignores unknown input
 * keys and answers without it. Lane-side `node.rerun`
 * ({@link nodeProcedures}) is deliberately NOT widened.
 */
const fanInNodeProcedures = {
  ...nodeProcedures,
  rerun: {
    input: Schema.Struct({
      id: NodeIdSchema,
      requestId: Schema.optionalKey(Schema.String),
      inputDigest: Schema.optionalKey(Schema.String),
      /**
       * Refuse unless this node is on exactly this attempt. Validated by the
       * coordinator against its own allocator, in the same step that accepts
       * the reset, so there is no window between the test and the mutation it
       * guards.
       */
      expectAttempt: Schema.optionalKey(Schema.Int),
    }),
    output: Schema.Struct({
      ok: Schema.Boolean,
      /** Present and `true` when this acceptance was written to the run's
       *  journal against `requestId`. Absent means the far end did not record
       *  one — an older coordinator, or a call that carried no id. */
      recorded: Schema.optionalKey(Schema.Boolean),
      /**
       * Why a `false` was a REFUSAL rather than an unroutable id.
       *
       * `stale_attempt` — the node had moved past `expectAttempt`: the request
       * was answered and must not be retried as a new run.
       */
      refusal: Schema.optionalKey(Schema.Literals(["stale_attempt"])),
      /** What the node is actually on, when `stale_attempt` says it moved. */
      attempt: Schema.optionalKey(Schema.Int),
    }),
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
 *  SIGINT takes. Empty input/`ok` output: the caller confirms teardown by the
 *  socket going away, not by this ack (the coordinator may exit before the
 *  reply flushes). */
const cancelProcedure = {
  cancel: {
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** Served by the coordinator on `<checkout>/.ci/odu.sock` — the surface every
 *  face of a live run attaches to: the lane's primitives plus the `header`
 *  cell, `run.cancel` and `lane.cancel`. */
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
    node: fanInNodeProcedures,
    run: cancelProcedure,
    lane: laneCancelProcedure,
  },
});

type OduSF = SurfaceTypes<typeof oduSurface.spec>;
export type NodesSnapshot = OduSF["cells"]["nodes"]["Value"];
export type NodeLogFrame = OduSF["streams"]["nodeLog"]["Output"];

// The typed face, and the one way to build it.
//
// Two shapes every call site sees:
//   - a PROCEDURE returns `Effect<Out>`, and its INPUT is the ENCODED side of
//     the schema — the face decodes at its edge;
//   - a CELL / STREAM member returns a lazy `Stream<Out>` SYNCHRONOUSLY.
//     Subscribing is PULLING: the producer starts on the first pull, not when
//     the value is made. Cancellation is fiber interruption.

/** The coordinator's fan-in face (`.ci/odu.sock`): `nodes`, `nodeLog`,
 *  `header`, plus `node.rerun` / `node.cancel` / `run.cancel` / `lane.cancel`. */
export type OduClient = SurfaceClientOf<typeof oduSurface.spec>;

/** Build the fan-in face over any dispatch. ONE cast, here, so no consumer
 *  writes its own. */
export function oduClientOver(dispatch: SurfaceDispatch): OduClient {
  return buildSurfaceFace(oduSurface, dispatch) as unknown as OduClient;
}
