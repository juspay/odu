/**
 * The odu surfaces — the typed contracts every face attaches to.
 *
 * Two surfaces share one state vocabulary:
 *
 *   - `laneSurface` — served by `odu-runner --stdio` on each platform's host.
 *     mini-ci's three primitives (`nodes` cell, `nodeLog` stream,
 *     `node.rerun`) plus `run.configure` (pipeline recipe) and `lease.*`
 *     (venue flock on the agent — claim/probe/release). The runner spawns
 *     idle (HostSession argv is fixed to `--stdio`); the coordinator dials
 *     it over surface-remote for both pool lease and the CI lane.
 *
 *   - `oduSurface` — the fan-in the coordinator serves on `.ci/odu.sock` for
 *     `odu status` / `logs` / `attach`. The lane's three primitives plus one
 *     fan-in-only cell, `header` (the run *environment*: lane→host map + the
 *     lanes still being claimed + commit link + start clock; commit identity
 *     lives on the `nodes` state), which `attach` reads to paint the same matrix
 *     `run` does; node ids are `<namepath>@<platform>`. The coordinator serves
 *     this before it claims a machine (juspay/odu#84), so `header` changes
 *     during a run and every reader FOLLOWS the cell rather than latching its
 *     first frame.
 *
 * Call shapes (idiomatic):
 *   surface.nodes.get({})          — snapshot of the whole pipeline, then deltas
 *   surface.nodeLog.get({ id })    — buffered snapshot frame, then appends
 *   surface.header.get({})         — run env: lanes + commit link (oduSurface only; fan-in)
 *   surface.node.rerun({ id })     — the only mutation: reset id + dependents
 *   surface.run.configure({ … })   — lane only; idempotence: second call errors
 */

import { buildSurfaceFace } from "@kolu/surface/client";
import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { Schema } from "effect";
import { TaskIdSchema, TaskSpecSchema } from "./spec";

/** The zod→Effect Schema mapping is LAW on both surfaces (kolu PLAN #17), and
 *  every field below is wire-bearing:
 *
 *    - `.optional()` → `Schema.optionalKey`, never `Schema.optional`. Absent
 *      means ABSENT; `optional` round-trips an explicit `undefined` through
 *      `null` and would put a `null` where a key used to be missing.
 *    - `optionalKey` REJECTS a present-but-`undefined` key on decode AND on
 *      encode. Every producer of `seq` / `posting` / `unposted` must omit the
 *      key rather than spell it `undefined` — see `surface.bytes.test.ts`,
 *      which pins both directions.
 *
 *  The encoded bytes of `PipelineState`, `NodeLogMessage` and both lease output
 *  unions are frozen: they cross the unix socket, the stdio wire to
 *  `odu-runner`, and (via `runRecord`) the on-disk ledger. */
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

/** The single projection of a `NodeStatus` onto its external-facing
 *  representations: TUI glyph, GitHub state, `--progress json` status, and
 *  whether the status counts as "red" in the verdict. `github`/`progress` of
 *  `null` mean "post/emit nothing" for that status. Adding a `NodeStatus` is a
 *  single edit here that the compiler enforces across every consumer
 *  (render's glyph table, run's progress + verdict, statuses' state). The
 *  byte-parity wording (justci's `Running:`/`Succeeded`/… descriptions) stays
 *  with the poster — it encodes a different volatility. */
/** The semantic colour of a status, named by meaning rather than by medium.
 *  Each face maps it to its own encoding — `render.ts` to an ansi wrapper for a
 *  stream, and to a hex cell attribute for the live view's renderer — so the
 *  assignment ("errored is violet") is made once and rendered twice. */
export type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

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
  id: TaskIdSchema,
  name: Schema.String,
  command: Schema.String,
  needs: Schema.Array(TaskIdSchema),
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

/** One GitHub context still owed a confirmed post (live surface + agent face).
 *  Degraded posting is derived from `owed.length > 0` — no separate state flag. */
export const OwedStatusSchema = Schema.Struct({
  context: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OwedStatus = typeof OwedStatusSchema.Type;

/** Final unconfirmed debt stamped into the durable run record: a live
 *  {@link OwedStatus} with `lastError` required at write. `attempts` is
 *  optional ONLY so records written before it existed still parse — a reader
 *  that finds it absent knows the count wasn't recorded, rather than being
 *  handed a fabricated `0` it can't tell apart from "no retries yet". */
export const UnpostedEntrySchema = Schema.Struct({
  context: Schema.String,
  lastError: Schema.String,
  attempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type UnpostedEntry = typeof UnpostedEntrySchema.Type;

/** Project live owed rows into durable unposted entries (juspay/odu#61). The
 *  only narrowing left is `lastError`: a row that never reported one is written
 *  as "not posted" so the durable shape can require it. */
export function projectUnposted(
  owed: readonly OwedStatus[],
): UnpostedEntry[] {
  return owed.map((o) => ({
    context: o.context,
    lastError: o.lastError ?? "not posted",
    attempts: o.attempts,
  }));
}

/** Lift durable unposted entries back to live owed rows — the inverse of
 *  {@link projectUnposted}, and its neighbour so a field added to either type
 *  updates one place instead of whichever consumer needed the reverse first.
 *  A record written before `attempts` was persisted reports 0. */
export function liftUnposted(
  entries: readonly UnpostedEntry[],
): OwedStatus[] {
  return entries.map((e) => ({
    context: e.context,
    lastError: e.lastError,
    attempts: e.attempts ?? 0,
  }));
}

/** GitHub status-posting health for a live run. Empty `owed` when every post
 *  is confirmed (or posting disabled). Surfaces (`status` / `attach` / MCP)
 *  read this so a reporting divergence is never silent (juspay/odu#61). */
export const PostingHealthSchema = Schema.Struct({
  owed: Schema.Array(OwedStatusSchema),
});
export type PostingHealth = typeof PostingHealthSchema.Type;

export const EMPTY_POSTING: PostingHealth = { owed: [] };

/** A fresh node: the caller supplies identity + dependencies; the four
 *  terminal/timing fields start at their `pending` defaults. One place owns
 *  what an unstarted node looks like, so adding a `NodeState` field can't drift
 *  across the coordinator and runner seed sites. */
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

export const PipelineStateSchema = Schema.Struct({
  name: Schema.String,
  /** The run's commit, 7 hex chars — `odu run` stamps it from HEAD onto the
   *  fan-in surface so `attach` renders the durable log path (`.ci/<sha7>/…`)
   *  and the sha label from surface state: its banner (via `commitLabel`) and
   *  the per-transition `log` field (via `progressEvent`→`logPathFor`), instead
   *  of re-deriving the sha from git and drifting. The MCP agent `logs`
   *  resource's durable-file fallback derives the sha from git HEAD instead —
   *  no live socket exists in that branch — so this field is `attach`'s, not
   *  the agent face's. Empty in the pre-run EMPTY_STATE. */
  sha7: Schema.String,
  /** The run's working tree had uncommitted changes — the verdict is about
   *  that tree, not the commit. Drives the `+dirty` sha label every face
   *  shows. Authoritative only on the coordinator's fan-in (the lane copy is
   *  advisory; see runner.ts). */
  dirty: Schema.Boolean,
  /** This run's ordinal among runs of the same `sha7` in this checkout (1-based
   *  — the ledger's `seq`, `<sha7>#<seq>` = `formatRunRef`). Completes the run's
   *  identity on the surface so a verdict says WHICH run it describes, not just
   *  which commit — the fix for the agent face's stale/no-run ambiguity
   *  (juspay/odu#49). Absent (not a fake `0`) when no ordinal was reserved: the
   *  pre-run EMPTY_STATE, the advisory lane copy, or the rare case the
   *  coordinator couldn't durably reserve a seq (then the run claims `sha7` but
   *  no unique `<sha7>#<seq>`). Authoritative only on the coordinator's fan-in,
   *  like `dirty`. */
  seq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Node ids in scheduling order — the row order dashboards paint. */
  order: Schema.Array(TaskIdSchema),
  nodes: Schema.Record(TaskIdSchema, NodeStateSchema),
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
 *  fan-in socket). */
export const NodeLogMessageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("append"), text: Schema.String }),
]);
export type NodeLogMessage = typeof NodeLogMessageSchema.Type;

/** In-memory log tail kept per node for late subscribers. The full log is
 *  durable elsewhere: the coordinator streams every `append` into
 *  `.ci/<sha>/<platform>/<node>.log` as it arrives. */
export const MAX_LOG_CHARS = 64 * 1024;
export function clampLog(buffer: string): string {
  return buffer.length > MAX_LOG_CHARS
    ? buffer.slice(buffer.length - MAX_LOG_CHARS)
    : buffer;
}

/** `run.configure` input: either `workspace` (a checkout the runner can use
 *  as-is — the coordinator's HEAD snapshot on a localhost lane) or
 *  `origin` + `sha` (the runner fetches the pushed SHA into a per-SHA
 *  worktree under ~/.cache/odu). */
export const ConfigureInputSchema = Schema.Struct({
  name: Schema.String,
  origin: Schema.NullOr(Schema.String),
  sha: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  tasks: Schema.Array(TaskSpecSchema).check(Schema.isMinLength(1)),
});
export type ConfigureInput = typeof ConfigureInputSchema.Type;

export const ConfigureOutputSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type ConfigureOutput = typeof ConfigureOutputSchema.Type;

/** One platform whose venue lease has not resolved yet, and the pool it is
 *  claiming a machine from. A run carrying any of these is still
 *  PROVISIONING — it holds the checkout and is claiming/booting a box (on a
 *  cold host, `nix copy`ing the runner closure over ssh-ng), which is minutes
 *  of live work with no lane behind it yet. */
export const ClaimingLaneSchema = Schema.Struct({
  platform: Schema.String,
  pool: Schema.Array(Schema.String),
});
export type ClaimingLane = typeof ClaimingLaneSchema.Type;

/** The run's *environment* — what `run` set up that the `nodes`/`header`
 *  state can't already tell you: the lane→host map, where it came from, and
 *  the forge commit link. Commit identity (pipeline name + sha7 + dirty) lives
 *  on `PipelineState`, so it isn't duplicated here. `run` has this in-process;
 *  an `attach`-er reads it from the fan-in `header` cell so its matrix shows the
 *  real lane→host map and commit link, not an observer stub.
 *
 *  Published TWICE per run, not once: the coordinator serves the socket before
 *  it claims a venue (juspay/odu#84), so the first header describes a run whose
 *  lanes don't exist yet (`claiming` non-empty, `lanes` holding only the
 *  agent-held platforms that needed no claim), and the second — once every
 *  lease resolves — is the full lane→host map with `claiming` empty. Every
 *  reader of `lanes` must therefore follow the cell rather than keep its first
 *  frame. */
export const RunHeaderSchema = Schema.Struct({
  /** Forge page for the commit (GitHub origins); the sha label becomes an
   *  OSC 8 hyperlink where supported. Null elsewhere. */
  commitUrl: Schema.NullOr(Schema.String),
  /** The platforms whose venue lease HAS resolved, and the machine each got.
   *  Empty while a run is still claiming its first box. */
  lanes: Schema.Array(
    Schema.Struct({ platform: Schema.String, host: Schema.String }),
  ),
  /** The platforms still being claimed — see {@link ClaimingLaneSchema}. Empty
   *  once every lane has a host, which is what {@link runPhase} reads. */
  claiming: Schema.Array(ClaimingLaneSchema),
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

/** The pre-run header — `attach` before the coordinator publishes, and the
 *  cell default. An empty `lanes` collapses the banner's host line. */
export const EMPTY_HEADER: RunHeader = {
  commitUrl: null,
  lanes: [],
  claiming: [],
  hostsSource: null,
  startedAt: 0,
};

/** Where a run is in its lifecycle, as far as the *environment* is concerned:
 *
 *  - `provisioning` — the run exists, holds the checkout and its ordinal, and is
 *    claiming a machine for at least one lane. On a cold host that is a multi-
 *    minute `nix copy` of the runner closure with no lane behind it yet. Before
 *    juspay/odu#84 this window had no socket at all, so `status` / `attach` /
 *    `logs` / `wait` all answered "no run in progress" — the same words they use
 *    for a run that died or never started.
 *  - `lanes` — every lane has a host; the run is the lane fanout the rest of the
 *    surface describes.
 *
 *  Derived from `claiming` rather than stored beside it, so the phase and the
 *  reason for it cannot disagree. */
export type RunPhase = "provisioning" | "lanes";

export function runPhase(header: Pick<RunHeader, "claiming">): RunPhase {
  return header.claiming.length > 0 ? "provisioning" : "lanes";
}

const primitives = {
  cells: {
    nodes: {
      schema: PipelineStateSchema,
      default: EMPTY_STATE,
    },
  },
  streams: {
    nodeLog: {
      inputSchema: Schema.Struct({ id: TaskIdSchema }),
      outputSchema: NodeLogMessageSchema,
    },
  },
} as const;

/** Per-node mutations shared by the lane runner and the coordinator fan-in.
 *  `rerun` resets a node + dependents; `cancel` stops a running/pending node.
 *  Platform/lane drop is fan-in-only (`lane.cancel` below) — not smuggled into
 *  the node id (juspay/odu#68). */
const nodeProcedures = {
  rerun: {
    input: Schema.Struct({ id: TaskIdSchema }),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
  cancel: {
    input: Schema.Struct({ id: TaskIdSchema }),
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

/** Who holds a venue lock (`holder|run|sinceMs` on the agent). Shared by the
 *  lane's `lease.*` procedures and the coordinator's `odu hosts` rendering. */
export const LeaseHolderSchema = Schema.Struct({
  holder: Schema.String,
  run: Schema.NullOr(Schema.String),
  sinceMs: Schema.Number,
});
export type LeaseHolder = typeof LeaseHolderSchema.Type;

/** Default remote venue lock path; override via claim/probe input or
 *  `ODU_LEASE_LOCK` on the agent. */
export const DEFAULT_LEASE_LOCK = "/tmp/odu.lease";

const LeaseClaimInputSchema = Schema.Struct({
  holder: Schema.String.check(Schema.isMinLength(1)),
  run: Schema.NullOr(Schema.String),
  /** Absolute path on the agent host. Omit → agent default (`ODU_LEASE_LOCK`
   *  or {@link DEFAULT_LEASE_LOCK}). `optionalKey`, so a caller with no override
   *  must OMIT the key — spelling it `undefined` is a decode failure. */
  lockPath: Schema.optionalKey(Schema.String),
});

/** Discriminated on `status`, not `_tag` — `Schema.Union` keeps the frozen
 *  bytes; `TaggedUnion` would rename the discriminant. */
export const LeaseClaimOutputSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("held") }),
  Schema.Struct({
    status: Schema.Literal("busy"),
    heldBy: Schema.NullOr(LeaseHolderSchema),
  }),
  Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
]);
export type LeaseClaimOutput = typeof LeaseClaimOutputSchema.Type;

const LeaseProbeInputSchema = Schema.Struct({
  lockPath: Schema.optionalKey(Schema.String),
});

/** Discriminated on `state` — same reasoning as {@link LeaseClaimOutputSchema}. */
export const LeaseProbeOutputSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("free"), heldBy: Schema.Null }),
  Schema.Struct({
    state: Schema.Literal("busy"),
    heldBy: Schema.NullOr(LeaseHolderSchema),
  }),
  Schema.Struct({ state: Schema.Literal("error"), error: Schema.String }),
]);
export type LeaseProbeOutput = typeof LeaseProbeOutputSchema.Type;

/** Venue lock on the lane agent — non-blocking claim/probe/release.
 *  Flock is local to the agent process (util-linux on odu-runner's Nix PATH);
 *  the coordinator dials this surface over surface-remote, never a bash
 *  claim script. Hold lifetime = agent session: release RPC or process death
 *  frees the lock. */
const leaseProcedures = {
  claim: {
    input: LeaseClaimInputSchema,
    output: LeaseClaimOutputSchema,
  },
  probe: {
    input: LeaseProbeInputSchema,
    output: LeaseProbeOutputSchema,
  },
  release: {
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

/** Served by `odu-runner --stdio` on each lane host. */
export const laneSurface = defineSurface({
  ...primitives,
  procedures: {
    node: nodeProcedures,
    run: {
      configure: {
        input: ConfigureInputSchema,
        output: ConfigureOutputSchema,
      },
    },
    lease: leaseProcedures,
  },
});

/** Served by the coordinator on `.ci/odu.sock`; consumed by
 *  `odu status` / `logs` / `attach` / `cancel`. Adds the `header` cell (the run
 *  environment: lane→host map + commit link) the lane surface has no business
 *  knowing, so an attached face renders the same matrix `run` does, and the
 *  `run.cancel` lifecycle mutation a second process drives teardown through.
 *  (`run.cancel` is fan-in-only — a lane has no run to cancel; it's the
 *  coordinator that owns the run and the lanes.) `lane.cancel` drops one
 *  platform mid-run; `node.cancel` stops one fan-in node. */
export const oduSurface = defineSurface({
  ...primitives,
  cells: {
    ...primitives.cells,
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

type LaneSF = SurfaceTypes<typeof laneSurface.spec>;
export type NodesSnapshot = LaneSF["cells"]["nodes"]["Value"];
export type NodeLogFrame = LaneSF["streams"]["nodeLog"]["Output"];

// ── The two typed faces, and the one way to build each ──────────────────
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
// consumer — the fan-in socket dial, the ssh lane dial, the lease dial, the
// in-process MCP projection — holds the SAME type and reaches members the same
// way, and a schema edit is a compile error at every call site.
//
// Two shape changes every call site sees:
//   - a PROCEDURE still returns `Promise<Out>`, but its INPUT is the ENCODED
//     side of the schema (D2/#13) — the face decodes at its edge, exactly where
//     zod's `.parse`-at-input used to run;
//   - a CELL / STREAM member returns a lazy `Stream<Out>` SYNCHRONOUSLY (was
//     `Promise<AsyncIterable<Out>>` plus an `AbortSignal` call option).
//     Subscribing is PULLING: the producer starts on the first pull, not when
//     the value is made. Cancellation is fiber interruption (D10/#18).
//
// `SurfaceReadFace` declines to spell cell MUTATION verbs, which costs these two
// surfaces nothing: every writer is in-process (`ctx.cells.nodes.set`), and no
// remote caller has ever written a cell.

/** The coordinator's fan-in face (`.ci/odu.sock`): `nodes`, `nodeLog`, `header`,
 *  plus `node.rerun` / `node.cancel` / `run.cancel` / `lane.cancel`. */
export type OduClient = SurfaceClientOf<typeof oduSurface.spec>;

/** The lane agent's face (`odu-runner --stdio`): `nodes`, `nodeLog`, plus
 *  `node.*`, `run.configure` and `lease.*`. */
export type LaneClient = SurfaceClientOf<typeof laneSurface.spec>;

/** Build the fan-in face over any dispatch. ONE cast, here, so no consumer
 *  writes its own: the runtime object carries every member the type names
 *  (minted by `defineSurface`'s own tag algebra); the cast only tells the
 *  compiler which projection of that walk it is looking at. */
export function oduClientOver(dispatch: SurfaceDispatch): OduClient {
  return buildSurfaceFace(oduSurface, dispatch) as unknown as OduClient;
}

/** Build the lane face over any dispatch — see {@link oduClientOver}. */
export function laneClientOver(dispatch: SurfaceDispatch): LaneClient {
  return buildSurfaceFace(laneSurface, dispatch) as unknown as LaneClient;
}
