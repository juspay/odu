/**
 * `@odu/run-client/surface` — `oduSurface`, the typed contract a live odu run
 * serves on `<checkout>/.ci/odu.sock`:
 *
 *   surface.nodes.get({})          — the whole pipeline, then deltas
 *   surface.nodeLog.get({ id })    — buffered snapshot frame, then appends
 *   surface.header.get({})         — the run environment: lane roster, commit
 *                                    link, start clock
 *   surface.node.rerun({ id })     — reset a node + its dependents
 *   surface.node.cancel({ id })    — stop one unit of work
 *   surface.lane.cancel({ … })     — drop one platform mid-run
 *   surface.run.cancel({})         — tell the coordinator to tear the run down
 *
 * Node ids are `<namepath>@<platform>` — see `./nodeId`.
 */

import { buildSurfaceFace } from "@kolu/surface/client";
import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { Schema } from "effect";
import { LogStreamSchema, NodeIdSchema } from "./nodeId";

/** On this surface `.optional()` maps to `Schema.optionalKey`, which rejects a
 *  present-but-`undefined` key on decode and on encode: every producer of
 *  `seq` / `posting` omits the key. The encoded bytes of `PipelineState` and
 *  `NodeLogMessage` cross the unix socket, the stdio wire to the lane agent,
 *  and the on-disk ledger. */
export const NodeStatusSchema = Schema.Literals([
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
  /** Infrastructure death; maps to GitHub state `error` and `--progress json`
   *  status `errored`. */
  "errored",
  /** Operator intent: a deliberate per-node / per-lane cancel; not red
   *  (juspay/odu#68). */
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

/** The semantic colour of a status, named by meaning rather than by medium. */
export type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

/** The single projection of a `NodeStatus` onto its external-facing
 *  representations: TUI glyph, GitHub state, `--progress json` status, whether
 *  the status counts as "red" in the verdict, and its semantic hue. */
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
  // context pending (juspay/odu#68).
  cancelled: {
    glyph: "◼",
    github: "success",
    progress: "cancelled",
    isRed: false,
    hue: "grey",
  },
};

/**
 * A node's push, as its own step: `pushing`, then `pushed` (with counts) or
 * `failed`. The node's own `status` reads the recipe's verdict; a failed push
 * turns it red.
 */
export const NodePushSchema = Schema.Union([
  /** The recipe exited 0 and the closure is on its way. */
  Schema.Struct({ state: Schema.Literal("pushing") }),
  Schema.Struct({
    state: Schema.Literal("pushed"),
    /** Store paths this node UPLOADED. */
    stored: Schema.Int,
    /** Store paths of this node's closure the bucket ALREADY served. */
    present: Schema.Int,
    /** NAR bytes this node's uploads sent — the size of `stored`. */
    bytes: Schema.Int,
    /** How long the push took, separate from the node's own `durationMs`. */
    durationMs: Schema.Int,
  }),
  /** The closure did not land, and WHY — the push client's own sentence. */
  Schema.Struct({
    state: Schema.Literal("failed"),
    message: Schema.String,
    durationMs: Schema.Int,
  }),
]);
export type NodePush = typeof NodePushSchema.Type;

/** What a run put on its bucket, over every node. `stored` and `present` are
 *  summed apart, and `bytes` belongs to `stored` alone. Only pushes that
 *  landed count; failed ones are named in `failedOn`. */
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
   * What this node's push is doing — set by the lane runner the moment a
   * recipe exits 0, and replaced when the push ends. Absent means this node
   * has no push step.
   */
  push: Schema.optionalKey(NodePushSchema),
});
export type NodeState = typeof NodeStateSchema.Type;

/** A fresh node: the caller supplies identity + dependencies; the four
 *  terminal/timing fields start at their `pending` defaults. */
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

/** One GitHub context still owed a confirmed post. */
export const OwedStatusSchema = Schema.Struct({
  context: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OwedStatus = typeof OwedStatusSchema.Type;

/** GitHub status-posting health for a live run. Empty `owed` when every post
 *  is confirmed (or posting disabled). */
export const PostingHealthSchema = Schema.Struct({
  owed: Schema.Array(OwedStatusSchema),
});
export type PostingHealth = typeof PostingHealthSchema.Type;

export const EMPTY_POSTING: PostingHealth = { owed: [] };

export const PipelineStateSchema = Schema.Struct({
  name: Schema.String,
  /** The run's commit, 7 hex chars. Empty in the pre-run
   *  {@link EMPTY_STATE}. */
  sha7: Schema.String,
  /** The run's working tree had uncommitted changes. Authoritative only on the
   *  coordinator's fan-in. */
  dirty: Schema.Boolean,
  /** This run's ordinal among runs of the same `sha7` in this checkout
   *  (1-based, rendered `<sha7>#<seq>`). Absent when no ordinal was reserved.
   *  Authoritative only on the coordinator's fan-in. */
  seq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Node ids in scheduling order — the row order dashboards paint. */
  order: Schema.Array(NodeIdSchema),
  nodes: Schema.Record(NodeIdSchema, NodeStateSchema),
  /** GitHub commit-status posting health. Fan-in only; absent or empty `owed`
   *  means nothing owed. */
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

/** `Schema.Union`, not `Schema.TaggedUnion` — the discriminant is `kind`, and
 *  these bytes are frozen (they cross both the stdio wire and the fan-in
 *  socket). `snapshot` seeds a subscriber, `append` extends, and `end` is the
 *  terminal and carries no `text`. */
export const NodeLogMessageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("append"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("end") }),
]);
export type NodeLogMessage = typeof NodeLogMessageSchema.Type;

/** The bound on a `snapshot` frame: a server keeps at most this much of a
 *  node's log in memory for late subscribers. */
export const MAX_LOG_CHARS = 64 * 1024;
export function clampLog(buffer: string): string {
  return buffer.length > MAX_LOG_CHARS
    ? buffer.slice(buffer.length - MAX_LOG_CHARS)
    : buffer;
}

/** One platform's place in the run's lane roster:
 *
 *  - `claiming` — the venue lease has not resolved yet, and `pool` is the set
 *    of machines it may land on.
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

/** The leased half of a roster, in roster order. */
export function leasedLanes(header: Pick<RunHeader, "lanes">): LeasedLane[] {
  return header.lanes.filter((l): l is LeasedLane => l.state === "leased");
}

/** The claiming half of a roster, in roster order. */
export function claimingLanes(header: Pick<RunHeader, "lanes">): ClaimingLane[] {
  return header.lanes.filter((l): l is ClaimingLane => l.state === "claiming");
}

/** The run's environment: the lane→host map, where it came from, and the forge
 *  commit link. Published twice per run — a claiming roster first, the
 *  resolved lane→host map once every lease settles. */
export const RunHeaderSchema = Schema.Struct({
  /** Forge page for the commit (GitHub origins); the sha label becomes an
   *  OSC 8 hyperlink where supported. Null elsewhere. */
  commitUrl: Schema.NullOr(Schema.String),
  /** The run's lane roster, one entry per active platform in platform order.
   *  Empty for a run that has published nothing. */
  lanes: Schema.Array(RunLaneSchema),
  /** Where the lane→host map came from (`hosts.json`, a pool lease, …);
   *  null before the run publishes its header. */
  hostsSource: Schema.NullOr(Schema.String),
  /** The run's start wall-clock (`Date.now()`); `0` before the run publishes
   *  its header. */
  startedAt: Schema.Number,
});
export type RunHeader = typeof RunHeaderSchema.Type;

/** The pre-run header, and the cell default. */
export const EMPTY_HEADER: RunHeader = {
  commitUrl: null,
  lanes: [],
  hostsSource: null,
  startedAt: 0,
};

/** Where a run is in its lifecycle, as far as the environment is concerned:
 *
 *  - `unstarted` — no run ever published this header.
 *  - `provisioning` — the run is claiming a machine for at least one lane.
 *  - `lanes` — every lane has a host.
 *  - `no_lanes` — the run's claim resolved to no lanes at all. */
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

/** The `nodes` cell and the `nodeLog` stream. */
export const nodePrimitives = {
  cells: {
    nodes: {
      schema: PipelineStateSchema,
      default: EMPTY_STATE,
    },
  },
  streams: {
    nodeLog: {
      /** Which node, and which of its two logs; `stream` absent is the
       *  recipe's. */
      inputSchema: Schema.Struct({
        id: NodeIdSchema,
        stream: Schema.optionalKey(LogStreamSchema),
      }),
      outputSchema: NodeLogMessageSchema,
    },
  },
} as const;

/** Per-node mutations, shared by the coordinator fan-in and odu's lane runner.
 *  `rerun` resets a node + dependents; `cancel` stops a running/pending node. */
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
 * The FAN-IN's node group: {@link nodeProcedures}, with `rerun` widened by
 * `requestId` / `inputDigest`. Both are OPTIONAL, and `recorded` on the way
 * back says the far end understood them.
 */
const fanInNodeProcedures = {
  ...nodeProcedures,
  rerun: {
    input: Schema.Struct({
      id: NodeIdSchema,
      requestId: Schema.optionalKey(Schema.String),
      inputDigest: Schema.optionalKey(Schema.String),
      /** Refuse unless this node is on exactly this attempt. */
      expectAttempt: Schema.optionalKey(Schema.Int),
    }),
    output: Schema.Struct({
      ok: Schema.Boolean,
      /** Present and `true` when this acceptance was written to the run's
       *  journal against `requestId`. */
      recorded: Schema.optionalKey(Schema.Boolean),
      /**
       * Why a `false` was a REFUSAL rather than an unroutable id.
       * `stale_attempt` — the node had moved past `expectAttempt`.
       */
      refusal: Schema.optionalKey(Schema.Literals(["stale_attempt"])),
      /** What the node is actually on, when `stale_attempt` says it moved. */
      attempt: Schema.optionalKey(Schema.Int),
    }),
  },
} as const;

/** Fan-in-only: drop one platform lane mid-run. */
const laneCancelProcedure = {
  cancel: {
    input: Schema.Struct({
      platform: Schema.String.check(Schema.isMinLength(1)),
    }),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** `run.cancel` tells the live coordinator to stop. Empty input, `ok` output;
 *  the caller confirms teardown by the socket going away, not by this ack. */
const cancelProcedure = {
  cancel: {
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** Served by the coordinator on `<checkout>/.ci/odu.sock` — the surface every
 *  face of a live run attaches to. */
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

/** The coordinator's fan-in face (`.ci/odu.sock`): `nodes`, `nodeLog`,
 *  `header`, plus `node.rerun` / `node.cancel` / `run.cancel` / `lane.cancel`. */
export type OduClient = SurfaceClientOf<typeof oduSurface.spec>;

/** Build the fan-in face over any dispatch. */
export function oduClientOver(dispatch: SurfaceDispatch): OduClient {
  return buildSurfaceFace(oduSurface, dispatch) as OduClient;
}
