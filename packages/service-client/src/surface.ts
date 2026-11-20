import {
  defineSurface,
  type SurfaceTypes,
} from "@kolu/surface/define";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { LogStreamSchema, NodeIdSchema } from "@odu/run-client/nodeId";
import {
  type NodeStatus,
  NodePushSchema,
  NodeStatusSchema,
} from "@odu/run-client/surface";
import { RunScopeSchema } from "@odu/run-history/schema";
import { Schema } from "effect";

/** A node's status, re-exported from the live wire's own vocabulary. */
export type { NodeStatus };

/** The glyph and the semantic hue a status is DRAWN with. */
export { STATUS_META, type StatusHue } from "@odu/run-client/surface";

/** What a node's push is doing, and which of its two logs a reader means. */
export { type NodePush } from "@odu/run-client/surface";
export { type LogStream, LOG_STREAMS } from "@odu/run-client/nodeId";

/**
 * THE HOST'S CONTRACT VERSION, `major.minor` — its own verbs (the frozen control
 * fragment), the identity cell below, and the rule a client is admitted by.
 */
export const HOST_CONTRACT_VERSION = "2.5";

/**
 * THE RUNS' CONTRACT VERSION — this surface, and nothing served beside it. The
 * rule is {@link HOST_CONTRACT_VERSION}'s.
 *
 * The identity cell is SERVED on this surface (its tag is the root's, and every
 * deployed reader dials it there) but it is the host's fact, so its shape is the
 * host's version, not this one.
 */
export const CI_CONTRACT_VERSION = "2.7";

/**
 * THE RUNS' VERSION THAT INTRODUCED `log_read`'s `stream`.
 */
export const CI_LOG_STREAM_SINCE = "2.6";

/** THE RUNS' ROW NAME — the word the identity cell's `rows` publishes them
 *  under, a face's needs name them by, and the plugin's own name. */
export const CI_ROW = "ci";

/**
 * Why a call was refused, as data.
 *
 * `code` is what a caller branches on; `message` is the sentence a person
 * reads. `resync` and `suggestion` carry the recovery where there is one —
 * `suggestion` as ARGV.
 */
export const RefusalCodeSchema = Schema.Literals([
  /** The caller's input could not have meant anything — a malformed run id, a
   *  negative limit, a request id outside the grammar. */
  "bad_input",
  /** No such run in the catalog, or its evidence aged out. */
  "unknown_run",
  /** The run existed and its evidence has been expired by retention. */
  "expired",
  /** A cursor that belongs to another run, or is ahead of this run's journal.
   *  Carries `resync`. */
  "bad_cursor",
  /** The checkout named by `run.start` is not a git repository, or the commit
   *  it is on is not the one the caller expected. */
  "checkout_refused",
  /** A run is already live in that checkout. Carries the existing run so the
   *  caller can observe it instead — or repeat with `supersede`. */
  "checkout_busy",
  /** The run cannot be replayed from recorded inputs (a dirty live tree), or
   *  the checkout it ran in is gone. */
  "not_replayable",
  /** The named request id was used before for a DIFFERENT input. */
  "request_conflict",
  /** The request was accepted and its outcome is genuinely unknown. Never
   *  "retry with a fresh id" — that would be a licence to perform the mutation
   *  twice. */
  "request_unresolved",
  /** The node moved past the attempt the caller authorized. */
  "stale_attempt",
  /** No lane could be resolved for the requested platforms, or the host pool
   *  refused. */
  "no_venue",
  /** The service could not start the coordinator. */
  "launch_failed",
  /** The checkout has no `justfile`, or the one it has could not be read as a
   *  pipeline. */
  "pipeline_refused",
  /** A forge write was asked for and the service has no credential to make it.
   *  Carries the `gh auth login` recovery as `suggestion`, as ARGV. */
  "no_credential",
  /** The caller is not allowed to do this: a signed-in person whose role is
   *  below what the verb needs. */
  "not_permitted",
]);
export type RefusalCode = typeof RefusalCodeSchema.Type;

/** The one declared failure every procedure on this surface can raise. */
export class ServiceRefused extends Schema.TaggedError<ServiceRefused>(
  "@odu/service/ServiceRefused",
)("ServiceRefused", {
  code: RefusalCodeSchema,
  message: Schema.String,
  /** The exact command that re-synchronises a caller whose cursor was refused. */
  resync: Schema.optionalKey(Schema.String),
  /** A recovery the caller can run, as ARGV. */
  suggestion: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The run this refusal is about, when it is about one. */
  runId: Schema.optionalKey(Schema.String),
}) {}

const REFUSES = ServiceRefused;

/**
 * WHO is serving, and whether a caller may believe what it says.
 *
 * `protocolVersion` with `rows`, and `storageVersion`, are the two axes a
 * compatible reuse is decided on: the first is the host's contract and each
 * mounted row's own (judged by {@link admitService} against the rows a caller
 * reads), the second is the on-disk record format the catalog is written in. A
 * service speaking a contract a caller cannot decode is a recycle, and one
 * writing a storage format it cannot read is a refusal a person has to settle.
 */
export const ServiceIdentitySchema = Schema.Struct({
  /** The daemon's own process, so an operator can find it. */
  pid: Schema.Int,
  /** `Date.now()` at boot — how long this instance has been up. */
  startedAt: Schema.Number,
  /** The per-user daemon home (gate + control socket live under it). */
  home: Schema.String,
  /** The origin it is actually bound to — the OS's answer, not the request. */
  origin: Schema.String,
  /** The catalog directory whose runs this service is a face onto. */
  catalog: Schema.String,
  /** The HOST's contract ({@link HOST_CONTRACT_VERSION}) — its own verbs, this
   *  cell, and the admission rule. */
  protocolVersion: Schema.String,
  storageVersion: Schema.Int,
  /** EVERY MOUNTED ROW'S OWN CONTRACT VERSION, by row name (`ci`, `cache`, …),
   *  filled by the host from the rows it mounted. Absent on a daemon from
   *  before 2.5, whose `protocolVersion` covered every row at once. */
  rows: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type ServiceIdentity = typeof ServiceIdentitySchema.Type;

/** Which BUILD is serving.
 *
 *  `buildId` and `self` identify the PACKAGE and are baked unconditionally by
 *  the Nix wrapper — a daemon reporting null for either is misbuilt, and
 *  `assertPackaged` refuses to start one. `commit` is separate PROVENANCE and
 *  is genuinely optional: a dirty tree is still a complete Nix package, it just
 *  has no navigable commit to offer.
 *
 *  The fields stay NULLABLE on the wire even so, because `UNKNOWN_SERVICE` is
 *  what a client reads before the first frame arrives — a pre-connect default
 *  is not a claim about a build. The packaging rule is enforced at the daemon's
 *  own startup, which is where it belongs. */
export const ServiceBuildSchema = Schema.Struct({
  oduVersion: Schema.String,
  /** The commit the build was made from, when the build baked one. */
  commit: Schema.NullOr(Schema.String),
  /** The build's stale key — what a supervisor recognises a daemon by across a
   *  restart, and what an upgrade compares. */
  buildId: Schema.NullOr(Schema.String),
  /** The `odu` executable this service is running as (`ODU_SELF`). */
  self: Schema.NullOr(Schema.String),
});
export type ServiceBuild = typeof ServiceBuildSchema.Type;

/** Whether the service is answering, and about what. */
export const ServiceReadinessSchema = Schema.Struct({
  state: Schema.Literals(["starting", "ready", "draining"]),
  /** `Date.now()` when the service entered this state. */
  since: Schema.Number,
  /** Runs reconciled at startup, once `state` leaves `starting`. */
  reconciled: Schema.Int,
});
export type ServiceReadiness = typeof ServiceReadinessSchema.Type;

export const ServiceCellSchema = Schema.Struct({
  identity: ServiceIdentitySchema,
  build: ServiceBuildSchema,
  readiness: ServiceReadinessSchema,
});
export type ServiceCell = typeof ServiceCellSchema.Type;

/** What a client reads before the first frame arrives — a service that has
 *  said nothing about itself, spelled as such rather than as a plausible
 *  zero. */
export const UNKNOWN_SERVICE: ServiceCell = {
  identity: {
    pid: 0,
    startedAt: 0,
    home: "",
    origin: "",
    catalog: "",
    protocolVersion: "",
    storageVersion: 0,
  },
  build: { oduVersion: "", commit: null, buildId: null, self: null },
  readiness: { state: "starting", since: 0, reconciled: 0 },
};

/**
 * WHAT A BUILD READS OF ONE ROW — the version its code was written against.
 *
 * Two values, each carrying its version:
 *
 *   - `{ requires }` — the client is refused when that row is not mounted;
 *   - `{ ifMounted }` — absent is fine, mounted at another major is not.
 */
export type RowNeed = { readonly requires: string } | { readonly ifMounted: string };

/** The rows a face reads, by row name, and at which version. */
export type RowNeeds = Readonly<Record<string, RowNeed>>;

/** A row this build cannot work without. */
export const requires = (version: string): RowNeed => ({ requires: version });

/** A row read only when the daemon mounts it. */
export const ifMounted = (version: string): RowNeed => ({ ifMounted: version });

/**
 * THE RUNS AND NOTHING ELSE — the need of every consumer that reads only the
 * board: kolu's padi, a socket dial, `odu ci run`/`wait`/`logs`. A daemon is
 * adopted on this however far the cache, the door or the tunnel has moved.
 */
export const CI_NEEDS: RowNeeds = { [CI_ROW]: requires(CI_CONTRACT_VERSION) };

/** The verdict on a daemon that ANSWERED — whether this build can speak to it.
 *
 *  A refusal is {@link ServiceRefusal}: which contract it is ON, and only the
 *  facts that arm has. */
export type ServiceAdmission =
  | { kind: "adopt"; identity: ServiceIdentity }
  | ({ kind: "refuse" } & ServiceRefusal);

/**
 * WHY A DAEMON WAS REFUSED — three different facts, so three arms, each
 * carrying only its own:
 *
 *   - `host` — the host's major differs;
 *   - `row` — a row this build reads is mounted at another major;
 *   - `absent` — a row this build requires is not mounted at all (so there is
 *     nothing it `speaks`).
 *
 * `expected` is always the version this build reads; `message` is the whole
 * sentence, for a face that only has somewhere to print.
 */
export type ServiceRefusal =
  | { on: "host"; speaks: string; expected: string; message: string }
  | { on: "row"; row: string; speaks: string; expected: string; message: string }
  | { on: "absent"; row: string; expected: string; message: string };

function contractMajor(version: string): number | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  return match === null ? null : Number(match[1]);
}

function contractMinor(version: string): number | null {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match === null ? null : Number(match[2]);
}

const needReads = (need: RowNeed): string =>
  "requires" in need ? need.requires : need.ifMounted;

/** The version a daemon publishes for one row, or `null` when it does not
 *  mount it. A daemon from before 2.5 publishes no `rows`: its one number
 *  versioned the whole composed wire, so it is read as every row's. */
export function rowSpeaks(identity: ServiceIdentity, row: string): string | null {
  if (identity.rows === undefined) return identity.protocolVersion;
  return identity.rows[row] ?? null;
}

/** Is what a daemon SPEAKS older, on the minor, than what a caller READS?
 *
 *  `null` — a row the daemon does not mount — is not "behind". A version
 *  neither side can parse is not behind either. */
export function minorBehind(speaks: string | null, reads: string): boolean {
  if (speaks === null) return false;
  const theirs = contractMinor(speaks);
  const ours = contractMinor(reads);
  return theirs !== null && ours !== null && theirs < ours;
}

const UPGRADE = "upgrade the daemon (`odu web --upgrade`) or this build.";

/** Read a daemon's own greeting and say whether this build may adopt it.
 *
 *  A malformed or empty version is refused. */
export function admitService(
  cell: ServiceCell,
  where: string,
  /** The rows this build reads, and at which version. */
  needs: RowNeeds,
): ServiceAdmission {
  const host = HOST_CONTRACT_VERSION;
  const identity = cell.identity;
  const hostSpeaks = identity.protocolVersion;
  const hostMajor = contractMajor(hostSpeaks);
  if (hostMajor === null || hostMajor !== contractMajor(host)) {
    return {
      kind: "refuse",
      on: "host",
      speaks: hostSpeaks,
      expected: host,
      message:
        `the odu service at ${where} speaks host contract ${hostSpeaks || "nothing"}; ` +
        `this build reads ${host} — ${UPGRADE}`,
    };
  }
  for (const row of Object.keys(needs).sort()) {
    const need = needs[row] as RowNeed;
    const reads = needReads(need);
    const speaks = rowSpeaks(identity, row);
    if (speaks === null) {
      if ("ifMounted" in need) continue;
      return {
        kind: "refuse",
        on: "absent",
        row,
        expected: reads,
        message:
          `the odu service at ${where} does not mount the ${row} row, ` +
          `which this build reads at ${reads} — enable the row on the daemon, or use a build that does not need it.`,
      };
    }
    const major = contractMajor(speaks);
    if (major === null || major !== contractMajor(reads)) {
      return {
        kind: "refuse",
        on: "row",
        row,
        speaks,
        expected: reads,
        message:
          `the odu service at ${where} serves the ${row} row at ${speaks || "nothing"}; ` +
          `this build reads ${row} ${reads} — ${UPGRADE}`,
      };
    }
  }
  return { kind: "adopt", identity };
}

/** Names every needed row (and the host) whose minor is behind this build, and
 *  is `null` when none is. */
export function skewNote(
  cell: ServiceCell,
  where: string,
  needs: RowNeeds,
): string | null {
  const host = HOST_CONTRACT_VERSION;
  const lines: string[] = [];
  if (minorBehind(cell.identity.protocolVersion, host)) {
    lines.push(`host ${cell.identity.protocolVersion} (this build ${host})`);
  }
  for (const row of Object.keys(needs).sort()) {
    const reads = needReads(needs[row] as RowNeed);
    const speaks = rowSpeaks(cell.identity, row);
    if (minorBehind(speaks, reads)) lines.push(`${row} ${speaks as string} (this build ${reads})`);
  }
  if (lines.length === 0) return null;
  return (
    `odu: the service at ${where} is behind this build on ${lines.join(", ")} — ` +
    "a verb added since answers as unknown; `odu web --upgrade` replaces the daemon."
  );
}

/**
 * How long a handshake waits for the cell, EVERYWHERE one is read.
 */
export const SERVICE_HANDSHAKE_MS = 10_000;

/** The sentence for a daemon that accepted the connection and then said
 *  nothing within its handshake deadline. */
export function handshakeTimedOut(where: string, deadlineMs: number): string {
  return (
    `the odu service at ${where} accepted the connection but did not answer ` +
    `the handshake within ${deadlineMs / 1000}s — it may be wedged; ` +
    "`odu web --upgrade` will drain and replace it."
  );
}

/**
 * Where a run stands, on the board.
 */
export const RunBoardStateSchema = Schema.Literals([
  "provisioning",
  "running",
  "settled",
  "owner_lost",
  "expired",
]);
export type RunBoardState = typeof RunBoardStateSchema.Type;

/** The run's terminal word, as a bare union — the non-null half of the row's
 *  nullable `outcome`. */
export type RunOutcome = typeof RunOutcomeSchema.Type;

/** The run's own terminal word. */
export const RunOutcomeSchema = Schema.Literals([
  "passed",
  "failed",
  "incomplete",
]);

/**
 * WHERE A RUN PUSHED, as every reader of a run is told it (PLAN 4.1) — the
 * target, and the two sentences a setup log owed about it.
 */
const PushedToSchema = Schema.Struct({
  target: Schema.NullOr(
    Schema.Struct({ substituter: Schema.String, bucket: Schema.String }),
  ),
  /** WHY nothing was pushed — null when something was. */
  skipped: Schema.NullOr(Schema.String),
  /** What is wrong while something WAS: the bucket's key is missing from the
   *  repository's `trusted-public-keys`, so what this run warmed will not be
   *  substituted from. Null when there is nothing to say. */
  keyWarning: Schema.NullOr(Schema.String),
});

/**
 * One run, as a board row — everything needed to CHOOSE a run without opening
 * it, and nothing that would need the run's journal to produce.
 *
 * `sha` is the base commit; `contentSha`, when present, identifies the tested
 * working-tree snapshot. `dirty` says whether
 * the verdict is about that commit or about a working tree that merely claimed
 * it.
 */
export const RunRowSchema = Schema.Struct({
  contentSha: Schema.optionalKey(Schema.String),
  runId: Schema.String,
  /** `owner/repo` for a GitHub origin, null for a local-only checkout. */
  repo: Schema.NullOr(Schema.String),
  /** The checkout the run was started from. It may no longer exist. */
  repoRoot: Schema.String,
  /** The branch the run was started on, when one could be read. Null for a
   *  detached HEAD or a checkout that is gone. */
  branch: Schema.NullOr(Schema.String),
  /** Full 40-hex commit. `sha7` is derived at read sites, never stored twice. */
  sha: Schema.String,
  dirty: Schema.Boolean,
  /** The checkout-scoped ordinal, so a row can print the `<sha7>#<seq>` ref
   *  every existing face already prints. Null when none was reserved. */
  seq: Schema.NullOr(Schema.Int),
  pipeline: Schema.String,
  createdAt: Schema.Number,
  /** When the run STOPPED, from its own verdict — null while it has not. */
  finishedAt: Schema.NullOr(Schema.Number),
  state: RunBoardStateSchema,
  settled: Schema.Boolean,
  passed: Schema.Boolean,
  outcome: Schema.NullOr(RunOutcomeSchema),
  /** There is a red node whose evidence is ready to read. */
  actionable: Schema.Boolean,
  /** How many unresolved failures the run HAS — the whole count, not the
   *  number that fit in some page. */
  unresolvedFailures: Schema.Int,
  /** What a green here actually covers. */
  scope: RunScopeSchema,
  /** GitHub contexts this run still owes. Debt, kept apart from the verdict. */
  reportingDebt: Schema.Int,
  /** Where a live owner serves, when one does. Null for every other state, so
   *  a reader cannot mistake a stale address for a reachable one. */
  endpoint: Schema.NullOr(Schema.String),
  /** The run this one replays, when it is a linked retry. */
  parentRunId: Schema.NullOr(Schema.String),
  /**
   * WHO STARTED THIS RUN (PLAN 4.4) — the login of the person whose
   * connection asked for it, or `@local` for a loopback caller, which has no
   * login because it is the machine's own owner.
   *
   * `optionalKey`, so a run recorded before this is a row WITHOUT the field
   * rather than a row claiming nobody started it. PROVENANCE: it is stamped
   * once from the connection's principal and never from input, and it does
   * not grant or withhold anything.
   */
  actor: Schema.optionalKey(Schema.String),
  /** A cursor positioned at the row's own reading of the journal, so a caller
   *  that starts watching from the board resumes rather than replaying. */
  cursor: Schema.String,
  /**
   * WHERE THIS RUN PUSHES WHAT IT BUILDS (PLAN 4.1) — the cache its
   * `flake.nix` already reads from, when this daemon serves it.
   *
   * `target` is null for a run that pushes nothing and `note` says why;
   * with a target, `note` carries the `trusted-public-keys` warning when there
   * is one. `optionalKey`, so a run recorded before this is a row without it
   * rather than a row claiming it pushed nowhere.
   */
  push: Schema.optionalKey(PushedToSchema),
});
export type RunRow = typeof RunRowSchema.Type;

/**
 * One node of a run, as the board's detail view draws it.
 */
export const RunNodeSchema = Schema.Struct({
  id: NodeIdSchema,
  status: NodeStatusSchema,
  /** 1-based; the highest attempt recorded for this node. */
  attempt: Schema.Int,
  exitCode: Schema.NullOr(Schema.Int),
  /** When this attempt began, from the journal's own clock; null for a node
   *  that has not started. */
  startedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  /** The machine the work ran on, null while a lane is still claiming one. */
  host: Schema.NullOr(Schema.String),
  /** How to ask for this attempt's output — derived once, here, so no face
   *  reassembles the three fields a log is addressed by. */
  logKey: Schema.String,
  /** WHAT THIS NODE'S PUSH IS DOING (PLAN 4.1), read off the journal's
   *  `pushing` / `pushed` / `push_failed` lines. Absent for a node with no
   *  push step — a run with no target, or a recipe that built no `result`. */
  push: Schema.optionalKey(NodePushSchema),
});
export type RunNode = typeof RunNodeSchema.Type;

/** Where the run is in its lifecycle. The catalog's own three, which are the
 *  coordinator's `RunPhase` minus the `unstarted` a REGISTERED run cannot be
 *  in. */
export const RunPhaseSchema = Schema.Literals([
  "provisioning",
  "lanes",
  "no_lanes",
]);
export type RunPhase = typeof RunPhaseSchema.Type;

/**
 * One platform lane, as two states that carry different facts.
 */
export const RunLaneSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("claiming"),
    platform: Schema.String,
    /** The candidates this lane may land on. Empty for a run recorded before
     *  odu journalled pools — reported as "not recorded", never as "none". */
    pool: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("leased"),
    platform: Schema.String,
    host: Schema.String,
  }),
]);
export type RunLane = typeof RunLaneSchema.Type;

/**
 * The run's ENVIRONMENT — where its work is placed, and what it still owes.
 */
export const RunEnvSchema = Schema.Struct({
  phase: RunPhaseSchema,
  /** ms from the run's registration to now — or to its verdict, once it has
   *  one, so a settled run's elapsed time stops rather than counting forever. */
  elapsedMs: Schema.NullOr(Schema.Number),
  lanes: Schema.Array(RunLaneSchema),
  /** The hosts file the lane map was declared in. Null for a run recorded
   *  before odu journalled it — which is a different fact from "no file", and
   *  is why this is nullable rather than an empty string. */
  hostsSource: Schema.NullOr(Schema.String),
  /** The forge page for the commit under test, or null for a checkout with no
   *  GitHub origin. Derived ONCE, here, so no face assembles a URL. */
  commitUrl: Schema.NullOr(Schema.String),
  /** GitHub contexts this run still owes. The same debt `RunRow.reportingDebt`
   *  counts, itemised. */
  owed: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      lastError: Schema.String,
      attempts: Schema.Int,
    }),
  ),
});
export type RunEnv = typeof RunEnvSchema.Type;

/** What a reader sees for a run whose environment has not been established —
 *  spelled as such rather than as a plausible zero. */
export const UNKNOWN_ENV: RunEnv = {
  phase: "provisioning",
  elapsedMs: null,
  lanes: [],
  hostsSource: null,
  commitUrl: null,
  owed: [],
};

/**
 * A frame of `streams.nodes` — one whole picture of a run's work.
 */
export const NodesFrameSchema = Schema.Struct({
  /** Node ids in scheduling order — the row order a dashboard paints. */
  order: Schema.Array(NodeIdSchema),
  nodes: Schema.Array(RunNodeSchema),
  state: RunBoardStateSchema,
  /** Where the work is placed and what the run owes. */
  env: RunEnvSchema,
  /** No further frame will arrive: the run has settled, expired, or lost its
   *  owner. In none of those three will anything move again. */
  done: Schema.Boolean,
});
export type NodesFrame = typeof NodesFrameSchema.Type;

/** How many of a checkout's runs a {@link CheckoutFrameSchema} carries. The
 *  head of the list is the run the checkout STANDS FOR; the rest is the short
 *  history a reader scans without opening anything. */
export const CHECKOUT_RECENT_RUNS = 5;

/**
 * A frame of `streams.checkout` — EVERYTHING ONE CHECKOUT IS DOING, as one
 * whole picture.
 *
 * `latest` is null for a checkout with no runs at all — and the
 * same answer {@link CHECKOUT_NONE} gives for a service that is not there.
 */
export const CheckoutFrameSchema = Schema.Struct({
  /** The run this checkout stands for — its newest — and that run's work. */
  latest: Schema.NullOr(
    Schema.Struct({
      run: RunRowSchema,
      /** In the run's own scheduling order — the order a dashboard paints. */
      nodes: Schema.Array(RunNodeSchema),
    }),
  ),
  /** The checkout's runs, newest first, at most {@link CHECKOUT_RECENT_RUNS}
   *  of them. Its head IS `latest.run`, so a face painting a list does not
   *  special-case the first row. */
  recent: Schema.Array(RunRowSchema),
  /** How many runs this checkout has in the catalog — the whole count, not the
   *  number that fit in `recent`. */
  total: Schema.Int,
});
export type CheckoutFrame = typeof CheckoutFrameSchema.Type;

/** What a checkout looks like when there is NOTHING to say about it — no runs,
 *  or no service to ask. */
export const CHECKOUT_NONE: CheckoutFrame = {
  latest: null,
  recent: [],
  total: 0,
};

/**
 * One attempt's log, as a subscribable tail.
 *
 * The key is the encoded log key (`@odu/service-client/logKey`).
 */
export const LogTailSchema = Schema.Struct({
  /** The key this tail is for, echoed so a frame is self-describing. */
  key: Schema.String,
  /** The tail's bytes, decoded as text. Bounded — see `LOG_TAIL_BYTES`. */
  text: Schema.String,
  /** Total bytes in the whole log, so a reader can say the tail is a tail. */
  totalBytes: Schema.Int,
  /** Did this attempt's log get its producer's last word? A `false` with a
   *  non-empty tail is the honest "there was more and it is gone". */
  complete: Schema.Boolean,
  /** Can this log still GROW? See {@link LogPageSchema}'s `open`. */
  open: Schema.Boolean,
});
export type LogTail = typeof LogTailSchema.Type;

/** How much of a log a TAIL carries. The same bound the live wire already
 *  promises (`MAX_LOG_CHARS`), stated in bytes. */
export const LOG_TAIL_BYTES = 64 * 1024;

/**
 * IS THERE MORE OF THIS LOG TO READ? The one rule, for every follower.
 *
 * A page carries THREE facts and they are not interchangeable. `eof` is about
 * THIS read — the page reached the end of the file as it stands. `complete` is
 * about the PRODUCER — it said its last word. `open` is about the FUTURE — the
 * file can still grow.
 *
 * So: keep reading while the file can still grow, OR while this read did not
 * reach the end. Stop only when both are settled.
 */
export function logHasMore(page: Pick<LogPage, "open" | "eof">): boolean {
  return page.open || !page.eof;
}

/** A caller's idempotency key. Present on every mutating verb, and not
 *  optional on `start` and `retry`. */
const RequestId = Schema.String.check(Schema.isMinLength(1));

/**
 * A checkout's path, as the verbs that take one OUTSIDE `run.start` declare it:
 * a plain string, with the rule (absolute, therefore non-empty) checked by the
 * VERB — `notAbsolute` / the catalog's own guard — rather than by the schema.
 */
const CheckoutPath = Schema.String;

const StartInputSchema = Schema.Struct({
  /** ABSOLUTE path of the checkout to run in, ON THE SERVICE'S MACHINE.
   *  Explicit, never the caller's cwd. */
  checkout: Schema.String.check(Schema.isMinLength(1)),
  /** The commit the caller believes that checkout is on. Validated before
   *  acceptance — a checkout that has moved on is a REFUSAL, never a quiet
   *  different run. */
  expectedSha: Schema.String.check(Schema.isMinLength(7)),
  requestId: RequestId,
  /**
   * THE BRANCH THAT CLONE SHOULD BE ON, when the caller is handing the
   * service a commit rather than reading one back (PLAN 4.4).
   *
   * Absent — today's rule, unchanged: a checkout that is not already on
   * `expectedSha` is REFUSED.
   *
   * Present — the caller is naming a clone the SERVICE keeps (the pod's
   * `/data/checkouts/<repo>`), so the service fetches `origin/<branch>`,
   * refuses unless `expectedSha` is an ancestor of it, and moves the clone to
   * that commit ON that branch.
   *
   * ON A BRANCH, never a detached HEAD.
   *
   * A BRANCH NAME, held to git's own grammar and refused with a sentence
   * when it is not one — a name beginning with `-` most of all, because git
   * reads it as an option and this one ends up on a `git fetch` command
   * line.
   */
  branch: Schema.optionalKey(Schema.String),
  /** `recipe[@platform]` selectors. Empty means the whole `[metadata("ci")]`
   *  DAG. */
  selectors: Schema.optionalKey(Schema.Array(Schema.String)),
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `P=ADDR` host pins, the same spelling `odu ci run --host` takes. */
  hostPins: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The CALLER's `$ODU_HOSTS`, forwarded verbatim.
   *
   * THREE READINGS, and the third is why an empty string is legal:
   *
   *   - a PATH — resolve hosts from this file.
   *   - `""` — the caller HAS a shell and it has no `$ODU_HOSTS`. Unset on the
   *     child, so the chain falls to `~/.config/odu/hosts.json` the way it
   *     does in that shell. (`loadHosts` already reads `""` as unset, so this
   *     is the same spelling, not a second one.)
   *   - ABSENT — the caller has no shell to speak of: an agent, a browser. It
   *     is expressing no preference, so the SERVICE's own configuration
   *     stands. A service started with an explicit hosts file was configured
   *     on purpose, and a verb that quietly discarded that would be its own
   *     kind of surprise.
   */
  hostsFile: Schema.optionalKey(Schema.String),
  root: Schema.optionalKey(Schema.String),
  noDeps: Schema.optionalKey(Schema.Boolean),
  noStrict: Schema.optionalKey(Schema.Boolean),
  noSnapshot: Schema.optionalKey(Schema.Boolean),
  noPost: Schema.optionalKey(Schema.Boolean),
  /** Take the checkout from a run already live in it. Explicit, because the
   *  default answer to "a run is already going there" is to show the caller
   *  that run rather than to kill it. */
  supersede: Schema.optionalKey(Schema.Boolean),
  /** Park the coordinator at settle instead of tearing down, so its socket
   *  stays answerable after the verdict. The shape an agent's loop wants —
   *  settle, then read — and the one a test uses to observe a settled run
   *  without racing a teardown. */
  linger: Schema.optionalKey(Schema.Boolean),
});
export type StartInput = typeof StartInputSchema.Encoded;

/**
 * What a start ANSWERS with: an addressed receipt.
 *
 * `accepted` is false for the one non-refusal case — the caller asked for a
 * checkout that already has a live run and did not say `supersede`, so odu is
 * showing them that run instead of starting a second one.
 */
const StartReceiptSchema = Schema.Struct({
  accepted: Schema.Boolean,
  /** The run this call is about — the one it started, or the one already
   *  running in that checkout. */
  runId: Schema.String,
  requestId: Schema.String,
  /** True when this receipt was REPLAYED from a recorded request rather than
   *  produced by work this call did. */
  replayed: Schema.Boolean,
  sha: Schema.String,
  scope: RunScopeSchema,
  /** Where the coordinator serves, once it does. */
  endpoint: Schema.NullOr(Schema.String),
  /** A cursor positioned at the new run's beginning, so the caller's very next
   *  `run_wait` resumes rather than replaying. */
  cursor: Schema.String,
  /** How independent the coordinator actually is, and why. */
  lifetime: Schema.optionalKey(Schema.String),
  /** Present when `accepted` is false: what the existing run is, so the caller
   *  can decide between observing it and superseding it. */
  existing: Schema.optionalKey(
    Schema.Struct({ runId: Schema.String, sha: Schema.String }),
  ),
});
export type StartReceipt = typeof StartReceiptSchema.Type;

const WaitInputSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  /** Resume from here. A cursor belonging to another run is REFUSED with a
   *  resync route rather than silently restarted — which matters most exactly
   *  where it is hardest to notice, because a finalized retry mints a NEW run
   *  and an agent that kept its cursor is holding the parent's. */
  after: Schema.optionalKey(Schema.String),
  /** Bounded observation deadline in ms. Reaching it is `still_running`, which
   *  is a fact rather than an error. Defaults to 30 seconds. */
  deadlineMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Return only when the run has fully settled, rather than on the first
   *  actionable red. */
  settle: Schema.optionalKey(Schema.Boolean),
  /** Page size for `events`. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type WaitInput = typeof WaitInputSchema.Encoded;

/**
 * The same question as `wait`, asked without waiting.
 *
 * One answer shape, deliberately: `run.read` and `run.wait` return the identical
 * `AttentionAnswer`, because "what is this run's state" has one answer and a
 * second shape for the non-blocking case would be a second thing to keep true.
 * The difference is entirely in whether the service holds the call open.
 */
const ReadInputSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  after: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type ReadInput = typeof ReadInputSchema.Encoded;

/**
 * The board, filtered on the service's side — one call for "which run".
 *
 * The filters are
 * those faces' own, ANDed, and every one absent is the whole board.
 *
 * `checkout` is the SUBJECT of the query, as an absolute path the caller
 * resolved — the same rule `run.start` keeps. This does not scope the surface
 * to a working directory; it names one, explicitly, as data.
 */
const ListInputSchema = Schema.Struct({
  /** ABSOLUTE path of a checkout: only runs started there (`repoRoot`). */
  checkout: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** A commit prefix — see {@link isCommitPrefix} — matched case-insensitively. */
  sha: Schema.optionalKey(Schema.String),
  /** The run's per-commit ordinal — the `#N` in `<sha7>#<seq>`. Requires `sha`. */
  seq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** At most this many rows. `total` still counts every match. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type ListInput = typeof ListInputSchema.Encoded;

/**
 * A commit PREFIX as `run.list` takes it: at least 7 hex digits.
 *
 * One rule, stated on the contract both sides import — the procedure refuses a
 * `sha` that fails it.
 */
export const isCommitPrefix = (s: string): boolean => /^[0-9a-fA-F]{7,}$/.test(s);

const ListOutputSchema = Schema.Struct({
  /** Matching rows, newest run first. */
  rows: Schema.Array(RunRowSchema),
  /** How many rows matched before `limit` cut them. */
  total: Schema.Int,
});
export type ListOutput = typeof ListOutputSchema.Type;

/** One node whose failure is still unresolved, with the evidence to act on it.
 *  Every field is the attention payload's own — this surface re-publishes the
 *  catalog's answer rather than deriving a second one, so the browser, the CLI
 *  and `odu ci wait --run` cannot disagree about what is red. */
const FailureSchema = Schema.Struct({
  node: Schema.String,
  attempt: Schema.Int,
  status: Schema.Literals(["failed", "errored"]),
  exitCode: Schema.NullOr(Schema.Int),
  /** The signal the shell's exit status implies (`128 + N`). A READING. */
  signal: Schema.NullOr(Schema.String),
  platform: Schema.String,
  host: Schema.NullOr(Schema.String),
  /** How to ask for this evidence again — the encoded log key, so an agent
   *  echoes rather than reassembles. */
  logKey: Schema.String,
  logComplete: Schema.Boolean,
  logBytes: Schema.Int,
  excerpt: Schema.String,
  /** Where the excerpt came from. `none` means the log was unreadable, which
   *  is reported as itself and never as a passing or flaky node. */
  excerptSource: Schema.Literals(["attempt_log", "none"]),
  excerptTruncated: Schema.Boolean,
});

/**
 * The answer to a wait: attention, and the state it was read against.
 *
 * `reason` is what a caller branches on and it is deliberately not a verdict:
 * `failure` means there is something to act on NOW (which does not mean the
 * run has settled — a red unit lane beside a lane with ninety seconds to go is
 * already actionable), `still_running` means nothing red at the deadline, and
 * `settled` means the whole run is done. A red CI answer is a normal, exit-0
 * answer on every face; only a REFUSAL is an error.
 */
const AttentionAnswerSchema = Schema.Struct({
  dirty: Schema.optionalKey(Schema.Boolean),
  contentSha: Schema.optionalKey(Schema.String),
  runId: Schema.String,
  reason: Schema.Literals(["failure", "still_running", "settled", "owner_lost"]),
  settled: Schema.Boolean,
  passed: Schema.Boolean,
  outcome: Schema.NullOr(RunOutcomeSchema),
  actionable: Schema.Boolean,
  sha: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(RunScopeSchema),
  failures: Schema.Array(FailureSchema),
  /** How many the run HAS, whether or not they all fit in `failures`. */
  failuresTotal: Schema.Int,
  failuresOmitted: Schema.Int,
  /** Feed this back as `after`. */
  cursor: Schema.String,
  /** Events after `cursor` this page did not carry. */
  remaining: Schema.Int,
  hasMore: Schema.Boolean,
  /** Journal lines this reader could not parse. Reported rather than
   *  swallowed, so "nothing happened" and "I could not read what happened"
   *  stay different answers. */
  unreadableEvents: Schema.Int,
  /** This payload is larger than the budget it was asked for — reachable only
   *  because a caller must always be able to drain a journal, so one event is
   *  carried even when nothing else fits. */
  overBudget: Schema.Boolean,
  reportingDebt: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      lastError: Schema.String,
      attempts: Schema.Int,
    }),
  ),
  endpoint: Schema.NullOr(Schema.String),
  /**
   * WHO STARTED THIS RUN (PLAN 4.4) — a login, or `@local` for a loopback
   * caller.
   *
   * Absent for a run recorded before the field.
   */
  actor: Schema.optionalKey(Schema.String),
  /**
   * WHERE THIS RUN PUSHED WHAT IT BUILT (PLAN 4.1) — the bucket a green run
   * warmed, or the sentence saying why it warmed nothing.
   */
  push: Schema.optionalKey(
    Schema.Struct({
      ...PushedToSchema.fields,
      /** WHAT THE BUCKET SERVES as a result of this run, summed over its
       *  nodes, and the NAR bytes the uploads cost. The pushes that LANDED
       *  only: a node still pushing, or one whose push failed, adds nothing
       *  to a count that claims the bucket serves it. */
      paths: Schema.Int,
      /** Of `paths`, how many the bucket ALREADY served — so `paths - present`
       *  is what this run sent. Absent when the daemon does not record the
       *  split; read it as `0`. */
      present: Schema.optionalKey(Schema.Int),
      bytes: Schema.Int,
      /** The nodes whose push FAILED, in roster order — empty when none did.
       *  Absent when the daemon does not record it; read it as `[]`, never as
       *  "none failed". */
      failedOn: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export type AttentionAnswer = typeof AttentionAnswerSchema.Type;

const RetryInputSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  /** `ci::unit@plat`, `@plat`, or a recipe name — the same grammar
   *  `odu ci rerun` has always taken. */
  selector: Schema.String.check(Schema.isMinLength(1)),
  requestId: RequestId,
  /** Refuse unless the named node is on exactly this attempt — the guard
   *  against acting on a stale reading of a run that has moved on. Validated
   *  where it can be enforced, not at the caller. */
  expectAttempt: Schema.optionalKey(
    Schema.Struct({
      node: Schema.String,
      attempt: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
});
export type RetryInput = typeof RetryInputSchema.Encoded;

/** What a retry actually did — and `mode` is the field that matters, because
 *  the caller did not choose it. `live` reset nodes on a coordinator still up;
 *  `relaunched` started a NEW run linked to the one retried, from its recorded
 *  inputs. */
const RetryReceiptSchema = Schema.Struct({
  requestId: Schema.String,
  mode: Schema.Literals(["live", "relaunched"]),
  replayed: Schema.Boolean,
  /** The run the caller should now watch. For `relaunched` this is the CHILD. */
  effectiveRun: Schema.String,
  parentRun: Schema.NullOr(Schema.String),
  /** The nodes actually reset — the minimal roots, not the closure. */
  roots: Schema.Array(Schema.String),
  /** Dependants reset as a consequence. Sibling work is preserved and is
   *  deliberately absent from both lists. */
  resetDependants: Schema.Array(Schema.String),
  attempts: Schema.Array(
    Schema.Struct({ node: Schema.String, attempt: Schema.Int }),
  ),
  /** What the effective run's selection covers. A selection is not a pipeline,
   *  and this is where a caller reads which one it got. */
  scope: RunScopeSchema,
  sha: Schema.String,
  cursor: Schema.String,
  lifetime: Schema.optionalKey(Schema.String),
});
export type RetryReceipt = typeof RetryReceiptSchema.Type;

/**
 * What to cancel, spelled as one of three explicit scopes.
 */
const CancelScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("run") }),
  Schema.Struct({ kind: Schema.Literal("node"), node: NodeIdSchema }),
  Schema.Struct({
    kind: Schema.Literal("lane"),
    platform: Schema.String.check(Schema.isMinLength(1)),
  }),
]);

const CancelInputSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  scope: CancelScopeSchema,
  requestId: RequestId,
});
export type CancelInput = typeof CancelInputSchema.Encoded;

const CancelResultSchema = Schema.Struct({
  runId: Schema.String,
  requestId: Schema.String,
  replayed: Schema.Boolean,
  /** What was actually cancelled. Echoed rather than assumed: a caller asking
   *  to cancel a lane on a run whose coordinator has already gone gets
   *  `effective: "nothing"` and the reason, not a cheerful ok. */
  effective: Schema.Literals(["run", "node", "lane", "nothing"]),
  /** Why nothing was cancelled, when nothing was. */
  detail: Schema.NullOr(Schema.String),
});
export type CancelResult = typeof CancelResultSchema.Type;

const LogReadInputSchema = Schema.Struct({
  /** The encoded log key — `@odu/service-client/logKey` owns the format. A run
   *  id, a node and an attempt travel as ONE token so a caller echoes the key
   *  a failure handed it rather than reassembling three fields. */
  key: Schema.String.check(Schema.isMinLength(1)),
  /** Byte offset from the start. NEGATIVE is a tail (`-4096` is the last 4 KiB),
   *  the same spelling `odu ci logs --offset` already takes. */
  offset: Schema.optionalKey(Schema.Int),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * Wait up to this many ms for the log to grow past the end of this page,
   * rather than answering an empty one at EOF. Absent means answer now — a
   * paged read must never block.
   */
  waitMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * WHICH of the node's two logs: the recipe's output, or the push that sent
   * what it built to the cache. Absent is `"recipe"`, so every existing
   * caller reads exactly what it always read.
   */
  stream: Schema.optionalKey(LogStreamSchema),
});
export type LogReadInput = typeof LogReadInputSchema.Encoded;

const LogPageSchema = Schema.Struct({
  key: Schema.String,
  /** The bytes, decoded as text. */
  text: Schema.String,
  /** Where this page starts in the file. */
  offset: Schema.Int,
  /** Total bytes in the whole log. */
  size: Schema.Int,
  /** Where a caller asks for the next page. Equal to `size` at EOF. */
  nextOffset: Schema.Int,
  eof: Schema.Boolean,
  /** Did the log get its producer's last word? Distinct from `eof`, which is
   *  only about this read. */
  complete: Schema.Boolean,
  /**
   * Can this log still grow? False once the producer said its last word, and
   * false once the run reached a terminal record — after either, nothing will
   * ever append again.
   */
  open: Schema.Boolean,
});
export type LogPage = typeof LogPageSchema.Type;

/**
 * The per-user run catalog, as operations rather than as a directory.
 */
const CatalogImportInputSchema = Schema.Struct({
  /** ABSOLUTE path of the checkout whose legacy `.ci` records to bring in.
   *  Explicit, never the caller's cwd — the same rule `run.start` keeps. */
  checkout: CheckoutPath,
  dryRun: Schema.optionalKey(Schema.Boolean),
  requestId: RequestId,
});
export type CatalogImportInput = typeof CatalogImportInputSchema.Encoded;

const ImportedRunSchema = Schema.Struct({
  runId: Schema.String,
  /** The `<sha7>#<seq>` a person recognises the run by. */
  ref: Schema.String,
  /** Why it was skipped, for a row that was. Null for one that was imported. */
  reason: Schema.NullOr(Schema.String),
});

const CatalogImportReportSchema = Schema.Struct({
  imported: Schema.Array(ImportedRunSchema),
  skipped: Schema.Array(ImportedRunSchema),
  /** The catalog directory the runs landed in — the service's. */
  catalog: Schema.String,
  dryRun: Schema.Boolean,
  replayed: Schema.Boolean,
});
export type CatalogImportReport = typeof CatalogImportReportSchema.Type;

const CatalogPruneInputSchema = Schema.Struct({
  /** Positive whole days. Checked by the VERB, not here — see {@link CheckoutPath}. */
  retentionDays: Schema.optionalKey(Schema.Number),
  dryRun: Schema.optionalKey(Schema.Boolean),
  requestId: RequestId,
});
export type CatalogPruneInput = typeof CatalogPruneInputSchema.Encoded;

const CatalogPruneReportSchema = Schema.Struct({
  /** Runs whose evidence was expired. */
  expired: Schema.Array(Schema.String),
  /** Runs inside the window, or held back for a reason — a live owner, most
   *  often. Carried with the reason. */
  kept: Schema.Array(
    Schema.Struct({ runId: Schema.String, reason: Schema.String }),
  ),
  retentionDays: Schema.Int,
  dryRun: Schema.Boolean,
  replayed: Schema.Boolean,
});
export type CatalogPruneReport = typeof CatalogPruneReportSchema.Type;

/** One recipe in a checkout's CI DAG, as the resolved pipeline sees it. */
export const TaskRowSchema = Schema.Struct({
  id: NodeIdSchema,
  /** The `[name(...)]` label, when the recipe carries one. */
  name: Schema.NullOr(Schema.String),
  command: Schema.String,
  needs: Schema.Array(NodeIdSchema),
  /** OS attributes constraining where this recipe may run. Empty means any. */
  os: Schema.Array(Schema.String),
  /** Shard count for a sharded recipe; null for an ordinary one. */
  shards: Schema.NullOr(Schema.Int),
});
export type TaskRow = typeof TaskRowSchema.Type;

const PipelineReadInputSchema = Schema.Struct({
  checkout: CheckoutPath,
  root: Schema.optionalKey(Schema.String),
});
export type PipelineReadInput = typeof PipelineReadInputSchema.Encoded;

const PipelineSchema = Schema.Struct({
  checkout: Schema.String,
  name: Schema.String,
  tasks: Schema.Array(TaskRowSchema),
  /** The DAG as Mermaid. */
  mermaid: Schema.String,
});
export type Pipeline = typeof PipelineSchema.Type;

/** Who holds a venue lock, and since when. */
export const VenueHolderSchema = Schema.Struct({
  /** `user@short-hostname`. */
  holder: Schema.String,
  /** The run holding it, when a run is. Null for a hand-taken `odu ci lease`. */
  run: Schema.NullOr(Schema.String),
  sinceMs: Schema.Number,
});
export type VenueHolder = typeof VenueHolderSchema.Type;

/**
 * One venue — a slot on one machine, for one platform.
 */
export const VenueRowSchema = Schema.Struct({
  platform: Schema.String,
  host: Schema.String,
  slot: Schema.Int,
  slots: Schema.Int,
  /** `down` is `unreachable` under the name an operator reads. `local` is a
   *  localhost lane, which takes no remote lock at all. `probing` is a host
   *  that has been DIALLED and has not answered yet. */
  state: Schema.Literals(["probing", "free", "busy", "local", "down"]),
  heldBy: Schema.NullOr(VenueHolderSchema),
  /** Why the probe failed, for a `down` row. Null otherwise. */
  error: Schema.NullOr(Schema.String),
});
export type VenueRow = typeof VenueRowSchema.Type;

/** Which venues to probe. Empty means every configured platform.
 *
 *  It is also why this input is not `Schema.Struct({})`. An empty struct is
 *  what the verb wanted to say, and `@kolu/surface-cli` cannot project one —
 *  `odu surface --help` fails outright on it, which is the sort of thing only
 *  running the built binary tells you. */
const VenueProbeInputSchema = Schema.Struct({
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The CALLER's `$ODU_HOSTS`, on the same three readings `run.start` takes it
   * on — a path, `""` for "my shell has none", absent for "I have no shell,
   * use the service's own".
   */
  hostsFile: Schema.optionalKey(Schema.String),
});
export type VenueProbeInput = typeof VenueProbeInputSchema.Encoded;

const VenueProbeOutputSchema = Schema.Struct({
  /** The hosts file that won, or null when none existed. */
  source: Schema.NullOr(Schema.String),
  /** Configuration problems worth reporting but not worth refusing over — a
   *  pool mixing localhost with remote hosts, most of all. */
  warnings: Schema.Array(Schema.String),
  rows: Schema.Array(VenueRowSchema),
});

/**
 * THE LAST PROBE, as a FACT — what the Machines page reads on open. `null`
 * until the first probe since the daemon started.
 */
export const VenueReadingSchema = Schema.NullOr(
  Schema.Struct({
    /** When the probe answered. */
    at: Schema.Number,
    /** The platforms it was narrowed to; empty means every configured one. */
    platforms: Schema.Array(Schema.String),
    source: Schema.NullOr(Schema.String),
    warnings: Schema.Array(Schema.String),
    rows: Schema.Array(VenueRowSchema),
  }),
);
export type VenueReading = typeof VenueReadingSchema.Type;
export type VenueProbeOutput = typeof VenueProbeOutputSchema.Type;

const VenueHoldInputSchema = Schema.Struct({
  /** The checkout the hold is FOR. A lease is recorded per checkout because
   *  that is what a subsequent `odu ci run` there consults. */
  checkout: CheckoutPath,
  /** Empty means every configured platform. */
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The CALLER's `$ODU_HOSTS`, on the same three readings `run.start` takes it
   * on — a path, `""` for "my shell has none", absent for "I have no shell,
   * use the service's own".
   */
  hostsFile: Schema.optionalKey(Schema.String),
  /** Do not queue behind an existing holder — answer `waiting` and return. */
  noWait: Schema.optionalKey(Schema.Boolean),
  /** Correlates a call with its answer in the service's log. NOT an
   *  idempotency key. */
  requestId: RequestId,
});
export type VenueHoldInput = typeof VenueHoldInputSchema.Encoded;

const VenueHoldOutputSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      platform: Schema.String,
      status: Schema.Literals(["held", "waiting", "already"]),
      host: Schema.NullOr(Schema.String),
      /** The holder process, which is now the SERVICE's child rather than the
       *  caller's. */
      holderPid: Schema.NullOr(Schema.Int),
      waitingBehind: Schema.NullOr(VenueHolderSchema),
      message: Schema.String,
    }),
  ),
  /** TRUE when this answer came from the request's RECEIPT rather than from
   *  work this call did. */
  replayed: Schema.Boolean,
});
export type VenueHoldOutput = typeof VenueHoldOutputSchema.Type;

const VenueReleaseInputSchema = Schema.Struct({
  checkout: CheckoutPath,
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The caller's `$ODU_HOSTS` — see `venue.hold`. A release resolves the same
   *  inventory a hold did, and the two disagreeing about which fleet a platform
   *  names is how a hold becomes unreleasable. */
  hostsFile: Schema.optionalKey(Schema.String),
  requestId: RequestId,
});
export type VenueReleaseInput = typeof VenueReleaseInputSchema.Encoded;

const VenueReleaseOutputSchema = Schema.Struct({
  released: Schema.Array(
    Schema.Struct({
      platform: Schema.String,
      /** `nothing` is an ANSWER: releasing a platform nobody held is not an
       *  error. */
      effective: Schema.Literals(["released", "nothing"]),
      host: Schema.NullOr(Schema.String),
      detail: Schema.NullOr(Schema.String),
    }),
  ),
  /** TRUE when this answer came from the request's RECEIPT rather than from
   *  work this call did. */
  replayed: Schema.Boolean,
});
export type VenueReleaseOutput = typeof VenueReleaseOutputSchema.Type;

// ── branch protection ───────────────────────────────────────────────────────

const ProtectInputSchema = Schema.Struct({
  checkout: CheckoutPath,
  /** The branch to protect. Absent means the repository's default branch,
   *  which the service resolves from the forge. */
  branch: Schema.optionalKey(Schema.String),
  /** The platform set whose lanes become required contexts. Absent DERIVES it
   *  from the hosts file, which is a machine-local fact rather than a repo one
   *  — so a derived set is reported in `derivedFrom` and a caller can refuse
   *  it. */
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The CALLER's `$ODU_HOSTS`, on the same three readings `run.start` takes
   *  it on — a path, `""` for "my shell has none", absent for "I have no
   *  shell, use the service's own". */
  hostsFile: Schema.optionalKey(Schema.String),
  /** Compute and report the contexts without writing anything. */
  dryRun: Schema.optionalKey(Schema.Boolean),
  /** Create the branch's ruleset when there is none. */
  create: Schema.optionalKey(Schema.Boolean),
  requestId: RequestId,
});
export type ProtectInput = typeof ProtectInputSchema.Encoded;

const ProtectOutputSchema = Schema.Struct({
  /** `owner/repo`, once the forge has been consulted. NULL under `dryRun`. */
  repo: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  /** Exactly the contexts `odu ci run` posts for this platform set. */
  contexts: Schema.Array(Schema.String),
  /** The ruleset that carries them, once one does. */
  rulesetId: Schema.NullOr(Schema.Int),
  applied: Schema.Boolean,
  created: Schema.Boolean,
  dryRun: Schema.Boolean,
  /** The hosts file a derived platform set came from — null when the caller
   *  named the platforms, which is the case a repo should be pinned to. */
  derivedFrom: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  /** TRUE when this answer came from the request's RECEIPT rather than from
   *  work this call did. */
  replayed: Schema.Boolean,
});
export type ProtectOutput = typeof ProtectOutputSchema.Type;

export const oduServiceSurface = defineSurface({
  cells: {
    service: { schema: ServiceCellSchema, default: UNKNOWN_SERVICE },
    venues: { schema: VenueReadingSchema, default: null, verbs: ["get"] },
  },
  collections: {
    runs: {
      keySchema: Schema.String,
      schema: RunRowSchema,
      verbs: ["keys", "get", "upsert", "delete", "deltas"],
    },
    logTails: { keySchema: Schema.String, schema: LogTailSchema },
  },
  streams: {
    nodes: {
      inputSchema: Schema.Struct({ runId: Schema.String }),
      outputSchema: NodesFrameSchema,
    },
    /** ONE CHECKOUT, whole — addressed by the absolute path a run was started
     *  in. The input is a stable KEY (a path), never a live fact, so a relay
     *  that re-subscribes after a dropped transport replays an input that is
     *  still true. */
    checkout: {
      inputSchema: Schema.Struct({ repoRoot: Schema.String }),
      outputSchema: CheckoutFrameSchema,
    },
  },
  procedures: {
    run: {
      start: {
        input: StartInputSchema,
        output: StartReceiptSchema,
        error: REFUSES,
      },
      wait: {
        input: WaitInputSchema,
        output: AttentionAnswerSchema,
        error: REFUSES,
      },
      read: {
        input: ReadInputSchema,
        output: AttentionAnswerSchema,
        error: REFUSES,
      },
      list: {
        input: ListInputSchema,
        output: ListOutputSchema,
        error: REFUSES,
      },
      retry: {
        input: RetryInputSchema,
        output: RetryReceiptSchema,
        error: REFUSES,
      },
      cancel: {
        input: CancelInputSchema,
        output: CancelResultSchema,
        error: REFUSES,
      },
    },
    log: {
      read: { input: LogReadInputSchema, output: LogPageSchema, error: REFUSES },
    },
    catalog: {
      import: {
        input: CatalogImportInputSchema,
        output: CatalogImportReportSchema,
        error: REFUSES,
      },
      prune: {
        input: CatalogPruneInputSchema,
        output: CatalogPruneReportSchema,
        error: REFUSES,
      },
    },
    pipeline: {
      read: {
        input: PipelineReadInputSchema,
        output: PipelineSchema,
        error: REFUSES,
      },
    },
    venue: {
      probe: {
        input: VenueProbeInputSchema,
        output: VenueProbeOutputSchema,
        error: REFUSES,
      },
      hold: {
        input: VenueHoldInputSchema,
        output: VenueHoldOutputSchema,
        error: REFUSES,
      },
      release: {
        input: VenueReleaseInputSchema,
        output: VenueReleaseOutputSchema,
        error: REFUSES,
      },
    },
    protect: {
      apply: {
        input: ProtectInputSchema,
        output: ProtectOutputSchema,
        error: REFUSES,
      },
    },
  },
});

type ServiceSF = SurfaceTypes<typeof oduServiceSurface.spec>;
export type ServiceSnapshot = ServiceSF["cells"]["service"]["Value"];
export type NodesStreamInput = ServiceSF["streams"]["nodes"]["InputWire"];
export type CheckoutStreamInput = ServiceSF["streams"]["checkout"]["InputWire"];

/** The service face — `runs`, `logTails`, `nodes`, `checkout`, and every
 *  procedure. */
export type OduServiceClient = SurfaceClientOf<typeof oduServiceSurface.spec>;

/** Build the service face over any dispatch. */
export function oduServiceClientOver(
  dispatch: SurfaceDispatch,
): OduServiceClient {
  return buildSurfaceFace(
    oduServiceSurface,
    dispatch,
  ) as unknown as OduServiceClient;
}
