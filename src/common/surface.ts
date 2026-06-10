/**
 * The odu surfaces — the typed contracts every face attaches to.
 *
 * Two surfaces share one state vocabulary:
 *
 *   - `laneSurface` — served by `odu-runner --stdio` on each platform's host.
 *     mini-ci's three primitives (`nodes` cell, `nodeLog` stream,
 *     `node.rerun`) plus `run.configure`, the one lane-only procedure: the
 *     runner spawns idle (HostSession argv is fixed to `--stdio`), and the
 *     coordinator sends the pipeline + workspace recipe over the surface.
 *
 *   - `oduSurface` — the fan-in the coordinator serves on `.ci/odu.sock` for
 *     `odu status` / `logs` / `attach`. The lane's three primitives plus one
 *     fan-in-only cell, `header` (the run *environment*: lane→host map +
 *     commit link + start clock; commit identity lives on the `nodes` state),
 *     which `attach` reads to paint the same matrix `run` does; node ids are
 *     `<namepath>@<platform>`.
 *
 * Call shapes (idiomatic):
 *   surface.nodes.get({})          — snapshot of the whole pipeline, then deltas
 *   surface.nodeLog.get({ id })    — buffered snapshot frame, then appends
 *   surface.header.get({})         — run env: lanes + commit link (oduSurface only; fan-in)
 *   surface.node.rerun({ id })     — the only mutation: reset id + dependents
 *   surface.run.configure({ … })   — lane only; idempotence: second call errors
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import { z } from "zod";
import { TaskIdSchema, TaskSpecSchema } from "./spec";

export const NodeStatusSchema = z.enum([
	"pending",
	"running",
	"ok",
	"failed",
	"skipped",
	/** Infrastructure death (lane link drop, interrupted coordinator) — never
	 *  emitted by the runner itself; overlaid by the coordinator. Maps to
	 *  GitHub state `error` and `--progress json` status `errored`. */
	"errored",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/** GitHub commit-status state (the `state` field of the statuses API). */
export type GithubState = "pending" | "success" | "failure" | "error";

/** `--progress json` status — the external wording for a node transition. */
export type ProgressStatus =
	| "running"
	| "success"
	| "failed"
	| "skipped"
	| "errored";

/** The single projection of a `NodeStatus` onto its external-facing
 *  representations: TUI glyph, GitHub state, `--progress json` status, and
 *  whether the status counts as "red" in the verdict. `github`/`progress` of
 *  `null` mean "post/emit nothing" for that status. Adding a `NodeStatus` is a
 *  single edit here that the compiler enforces across every consumer
 *  (render's glyph table, run's progress + verdict, statuses' state). The
 *  byte-parity wording (justci's `Running:`/`Succeeded`/… descriptions) stays
 *  with the poster — it encodes a different volatility. */
export const STATUS_META: Record<
	NodeStatus,
	{
		glyph: string;
		github: GithubState | null;
		progress: ProgressStatus | null;
		isRed: boolean;
	}
> = {
	pending: { glyph: "◦", github: null, progress: null, isRed: false },
	running: { glyph: "▶", github: "pending", progress: "running", isRed: false },
	ok: { glyph: "✔", github: "success", progress: "success", isRed: false },
	failed: { glyph: "✗", github: "failure", progress: "failed", isRed: true },
	skipped: { glyph: "⊘", github: null, progress: "skipped", isRed: false },
	errored: { glyph: "⚠", github: "error", progress: "errored", isRed: true },
};

export const NodeStateSchema = z.object({
	id: TaskIdSchema,
	name: z.string(),
	command: z.string(),
	needs: z.array(TaskIdSchema),
	status: NodeStatusSchema,
	/** Process exit code once terminal; `null` while pending/running or when
	 *  the process never spawned (a spawn failure is `failed` + `null`). */
	exitCode: z.number().int().nullable(),
	/** `Date.now()` when the node started running; `null` until then. */
	startedAt: z.number().nullable(),
	/** Wall-clock run time in ms once terminal; `null` otherwise. */
	durationMs: z.number().nullable(),
});
export type NodeState = z.infer<typeof NodeStateSchema>;

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

export const PipelineStateSchema = z.object({
	name: z.string(),
	/** The run's commit, 7 hex chars — `odu run` stamps it from HEAD onto the
	 *  fan-in surface so `attach` renders the durable log path (`.ci/<sha7>/…`)
	 *  and the sha label from surface state: its banner (via `commitLabel`) and
	 *  the per-transition `log` field (via `progressEvent`→`logPathFor`), instead
	 *  of re-deriving the sha from git and drifting. The MCP `tail_log`
	 *  durable-file fallback derives the sha from git HEAD instead — no live
	 *  socket exists in that branch — so this field is `attach`'s, not the MCP
	 *  tools'. Empty in the pre-run EMPTY_STATE. */
	sha7: z.string(),
	/** The run's working tree had uncommitted changes — the verdict is about
	 *  that tree, not the commit. Drives the `+dirty` sha label every face
	 *  shows. Authoritative only on the coordinator's fan-in (the lane copy is
	 *  advisory; see runner.ts). */
	dirty: z.boolean(),
	/** Node ids in scheduling order — the row order dashboards paint. */
	order: z.array(TaskIdSchema),
	nodes: z.record(TaskIdSchema, NodeStateSchema),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const EMPTY_STATE: PipelineState = {
	name: "pipeline",
	sha7: "",
	dirty: false,
	order: [],
	nodes: {},
};

export const NodeLogMessageSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("snapshot"), text: z.string() }),
	z.object({ kind: z.literal("append"), text: z.string() }),
]);
export type NodeLogMessage = z.infer<typeof NodeLogMessageSchema>;

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
export const ConfigureInputSchema = z.object({
	name: z.string(),
	origin: z.string().nullable(),
	sha: z.string().nullable(),
	workspace: z.string().nullable(),
	tasks: z.array(TaskSpecSchema).min(1),
});
export type ConfigureInput = z.infer<typeof ConfigureInputSchema>;

export const ConfigureOutputSchema = z.object({
	ok: z.boolean(),
	error: z.string().nullable(),
});
export type ConfigureOutput = z.infer<typeof ConfigureOutputSchema>;

/** The run's *environment* — what `run` set up that the `nodes`/`header`
 *  state can't already tell you: the lane→host map, where it came from, and
 *  the forge commit link. Commit identity (pipeline name + sha7 + dirty) lives
 *  on `PipelineState`, so it isn't duplicated here. `run` has this in-process;
 *  an `attach`-er reads it from the fan-in `header` cell so its matrix shows the
 *  real lane→host map and commit link, not an observer stub. Static for a run. */
export const RunHeaderSchema = z.object({
	/** Forge page for the commit (GitHub origins); the sha label becomes an
	 *  OSC 8 hyperlink where supported. Null elsewhere. */
	commitUrl: z.string().nullable(),
	lanes: z.array(z.object({ platform: z.string(), host: z.string() })),
	/** Where the lane→host map came from (`hosts.json`, a pool lease, …);
	 *  null before the run publishes its header. */
	hostsSource: z.string().nullable(),
	/** The run's start wall-clock (`Date.now()`), set once by `run` — the matrix
	 *  elapsed timer counts from it. Every face reads one value rather than each
	 *  deriving its own start, so a piped attach and the live matrix agree. `0`
	 *  before the run publishes its header. */
	startedAt: z.number(),
});
export type RunHeader = z.infer<typeof RunHeaderSchema>;

/** The pre-run header — `attach` before the coordinator publishes, and the
 *  cell default. An empty `lanes` collapses the banner's host line. */
export const EMPTY_HEADER: RunHeader = {
	commitUrl: null,
	lanes: [],
	hostsSource: null,
	startedAt: 0,
};

const primitives = {
	cells: {
		nodes: {
			schema: PipelineStateSchema,
			default: EMPTY_STATE,
		},
	},
	streams: {
		nodeLog: {
			inputSchema: z.object({ id: TaskIdSchema }),
			outputSchema: NodeLogMessageSchema,
		},
	},
} as const;

const rerunProcedure = {
	rerun: {
		input: z.object({ id: TaskIdSchema }),
		output: z.object({ ok: z.boolean() }),
	},
} as const;

/** Served by `odu-runner --stdio` on each lane host. */
export const laneSurface = defineSurface({
	...primitives,
	procedures: {
		node: rerunProcedure,
		run: {
			configure: {
				input: ConfigureInputSchema,
				output: ConfigureOutputSchema,
			},
		},
	},
});

/** Served by the coordinator on `.ci/odu.sock`; consumed by
 *  `odu status` / `logs` / `attach`. Adds the `header` cell (the run
 *  environment: lane→host map + commit link) the lane surface has no business
 *  knowing, so an attached face renders the same matrix `run` does. */
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
		node: rerunProcedure,
	},
});

type LaneSF = SurfaceTypes<typeof laneSurface.spec>;
export type NodesSnapshot = LaneSF["cells"]["nodes"]["Value"];
export type NodeLogFrame = LaneSF["streams"]["nodeLog"]["Output"];
