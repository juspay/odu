/**
 * `@odu/service-client/surface` — `oduServiceSurface`, the typed contract the
 * singleton odu web service serves on `http://127.0.0.1:18440`, and the whole
 * vocabulary its three faces speak.
 *
 * The coordinator's own surface (`@odu/run-client/surface`) is about ONE run:
 * it is served on a checkout's `.ci/odu.sock`, it exists only while that run
 * does, and everything it says is about the pipeline in front of it. This
 * surface is about EVERY run — the ones still going, the ones that finished
 * last week, the ones started from a checkout that has since been deleted —
 * because the question the web face exists to answer ("what is my CI doing,
 * across all my repositories") is not a question any one coordinator can be
 * asked.
 *
 *   service.cells.service      — who is serving, which build, and is it ready
 *   service.collections.runs   — the board: every registered run, one row each
 *   service.collections.logTails — one attempt's live tail, addressed by log key
 *   service.streams.nodes      — one run's DAG: snapshot, then updates
 *   service.run.start          — start a run, addressed by an explicit checkout
 *   service.run.wait           — bounded, resumable attention on one run
 *   service.run.retry          — live attempt or linked replay; odu decides which
 *   service.run.cancel         — explicit run / node / lane scope
 *   service.log.read           — one attempt's bytes, by offset
 *
 * **Three faces, one contract.** The browser dials this over the framework's
 * websocket route; the generated CLI (`odu surface run_start …`) dials the same
 * route from a terminal; an agent reaches it as MCP tools and resources, over
 * Streamable HTTP at `/mcp` or over the `odu mcp` stdio bridge. None of them
 * carries domain logic: the five procedures below ARE the vocabulary, and the
 * projections are derived from this spec by `@kolu/surface-cli` and
 * `@kolu/surface-mcp` rather than hand-written per face. That is why a verb
 * cannot mean one thing to an agent and another to a terminal.
 *
 * **Run keys are host-global.** Every address on this surface is a run id, or a
 * key built from one — never a path relative to whoever is calling. An MCP host
 * whose cwd is somebody's home directory must be able to name the same run the
 * browser is looking at, so nothing here is scoped to a working directory. The
 * one place a filesystem path appears is `run.start`'s `checkout`, where it is
 * the SUBJECT of the call rather than an implicit frame around it.
 *
 * The zod→Effect Schema laws this repo already keeps apply here verbatim:
 * `.optional()` is `Schema.optionalKey` (absent means ABSENT), never
 * `Schema.optional`, which would round-trip an explicit `undefined` through
 * `null` and put a `null` where a key used to be missing.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { NodeIdSchema } from "@odu/run-client/nodeId";
import { type NodeStatus, NodeStatusSchema } from "@odu/run-client/surface";
import { RunScopeSchema } from "@odu/run-history/schema";
import { Schema } from "effect";

/** A node's status, re-exported from the live wire's own vocabulary.
 *
 *  RE-EXPORTED rather than re-declared, and reachable from here rather than
 *  from `@odu/run-client`, so a consumer of this surface — the browser, a
 *  generated face — imports ONE contract module. The values are the coordinator
 *  surface's: a node means the same seven things whether it is being watched
 *  live or read out of the catalog, and a second enum would be a second answer
 *  to what "errored" is. */
export type { NodeStatus };

/**
 * The contract version this build speaks, `major.minor`.
 *
 * A daemon and the client that dialled it are routinely DIFFERENT BUILDS — the
 * whole point of a singleton is that it outlives the process that started it,
 * including across an upgrade — so the two have to be able to discover they
 * disagree. Compared with the framework's `isContractVersionCompatible`
 * (major.minor), never a string equality: a build that only ADDED a member is
 * still speakable by an older client, and refusing it would make every
 * additive change a flag day.
 */
export const SERVICE_CONTRACT_VERSION = "1.0";

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * Why a call was refused, as data.
 *
 * A REFUSAL is not a failure of the transport and not a failure of CI: it is
 * this service declining to do what it was asked, for a reason the caller can
 * act on. The three outcomes stay separate all the way out to a process exit
 * code (`0` answered — including an answer that reports red CI, `1` refused,
 * `3` nothing serving), which is only possible if the refusal travels on the
 * procedure's DECLARED error channel rather than as a field on a success.
 *
 * `code` is what a caller branches on; `message` is the sentence a person
 * reads. `resync` and `suggestion` carry the recovery where there is one —
 * `suggestion` as ARGV, never a string anything evals, the same rule the retry
 * policy already keeps.
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
]);
export type RefusalCode = typeof RefusalCodeSchema.Type;

/**
 * The one declared failure every procedure on this surface can raise.
 *
 * ONE tag rather than one per code, and the reason is the wire: this error
 * crosses a re-serve hop (the MCP bridge decodes what the service encoded and
 * re-encodes it to its host), and a closed union of a dozen tags would have to
 * be extended in lockstep on both ends for every new reason. `code` is a
 * literal union INSIDE one tag, so adding a reason is additive on the wire and
 * a caller that does not know the new code still gets the tag, the message and
 * the recovery.
 */
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

/** Every procedure declares the same error channel. Named once so no member can
 *  quietly declare a narrower one and leave a face unable to branch. */
const REFUSES = ServiceRefused;

// ── the service cell ────────────────────────────────────────────────────────

/**
 * WHO is serving, and whether a caller may believe what it says.
 *
 * `protocolVersion` and `storageVersion` are the two axes a compatible reuse is
 * decided on: the first is this surface's contract, the second is the on-disk
 * record format the catalog is written in. A caller that finds a daemon
 * already running compares both before adopting it — a service speaking a
 * contract it cannot decode is a recycle, and one writing a storage format it
 * cannot read is a refusal a person has to settle.
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
  protocolVersion: Schema.String,
  storageVersion: Schema.Int,
});
export type ServiceIdentity = typeof ServiceIdentitySchema.Type;

/** Which BUILD is serving. Every field is nullable because a source run
 *  (`bun src/main.ts`) has no wrapper to name — reported as null rather than
 *  as a plausible-looking blank. */
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

/**
 * Whether the service is answering, and about what.
 *
 * `starting` is a real state and not a gap: the service reconciles surviving
 * coordinators and terminal records before it claims to know the board, and a
 * caller that read the board during that window would see a partial catalog
 * and no way to tell. `draining` is the upgrade window — the service is still
 * answering reads, but it has been told to hand over.
 */
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
 *  zero. `pid: 0` is not a process and `protocolVersion: ""` matches no
 *  contract, so no compatibility check can pass on the default by accident. */
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

// ── the board ───────────────────────────────────────────────────────────────

/**
 * Where a run stands, on the board.
 *
 * The four durable states come straight from the catalog's own attention fold
 * (`AttentionState`), because a board that classified runs by its own rules
 * would be a second authority on what "still running" means — and the whole
 * reason the catalog exists is that there was more than one. `provisioning` is
 * the one addition, and it is not a fifth state so much as a refinement of
 * `still_running`: a run holding a checkout while it waits for a cold box to
 * finish a `nix copy` has no lane yet, and telling an operator "running" about
 * a run with nothing running is how a multi-minute provision reads as a hang.
 */
export const RunBoardStateSchema = Schema.Literals([
  "provisioning",
  "running",
  "settled",
  "owner_lost",
  "expired",
]);
export type RunBoardState = typeof RunBoardStateSchema.Type;

/** The run's own terminal word. Beside `passed` rather than derived from it,
 *  for the reason the attention payload gives: `passed: false` covers both a
 *  red node and a run torn down before every node finished, and reporting the
 *  second as "failed" sends an operator looking for a test that broke. */
export const RunOutcomeSchema = Schema.Literals([
  "passed",
  "failed",
  "incomplete",
]);

/**
 * One run, as a board row — everything needed to CHOOSE a run without opening
 * it, and nothing that would need the run's journal to produce.
 *
 * `sha` is the exact commit that was tested, in full, and `dirty` says whether
 * the verdict is about that commit or about a working tree that merely claimed
 * it. Both are on the row rather than one line down, because "which commit is
 * this green about" is the question a board exists to answer and a row that
 * makes you click to find out has not answered it.
 */
export const RunRowSchema = Schema.Struct({
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
  /** GitHub contexts this run still owes. Debt, kept apart from the verdict:
   *  a run whose statuses did not land still passed or failed on its own. */
  reportingDebt: Schema.Int,
  /** Where a live owner serves, when one does. Null for every other state, so
   *  a reader cannot mistake a stale address for a reachable one. */
  endpoint: Schema.NullOr(Schema.String),
  /** The run this one replays, when it is a linked retry. */
  parentRunId: Schema.NullOr(Schema.String),
  /** A cursor positioned at the row's own reading of the journal, so a caller
   *  that starts watching from the board resumes rather than replaying. */
  cursor: Schema.String,
});
export type RunRow = typeof RunRowSchema.Type;

// ── one run's DAG ───────────────────────────────────────────────────────────

/**
 * One node of a run, as the board's detail view draws it.
 *
 * Exactly what the durable record knows, and nothing that would have to be
 * guessed at. Two absences are deliberate:
 *
 *   - **No `needs`.** The journal records the roster's ORDER, not its edges — a
 *     run's DAG is a fact about the `justfile` at the commit it ran, and the
 *     catalog never stored one. A field here would be filled from the live
 *     coordinator when there is one and left empty when there is not, which is
 *     a view that quietly changes shape as a run finishes. The order IS the
 *     schedule, and it is what a reader can act on.
 *   - **No `platform`.** A node id is `<namepath>@<platform>` and every face in
 *     this tree already reads it with `@odu/run-client/nodeId`. A second copy
 *     on the row would be a second thing to keep true. `host` stays, because
 *     which MACHINE the work landed on is not in the id and is exactly what a
 *     placement failure is about.
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
});
export type RunNode = typeof RunNodeSchema.Type;

/**
 * A frame of `streams.nodes` — one whole picture of a run's work.
 *
 * **Every frame is self-contained, and that is a decision.** A delta protocol
 * would carry less on the wire and would make every consumer a fold: the
 * browser, a CLI watcher and a test would each keep a copy of the roster and
 * each re-derive it, and the three copies would be three chances to disagree
 * about which attempt a node is on. A run's roster is tens of nodes and a frame
 * is only sent when something actually moved, so the traffic this trades away
 * is small and the concept it removes is not.
 *
 * `done` is the terminal, and it rides the frame rather than being an arm of a
 * union for the reason the log wire learned the hard way: a terminal that
 * carried no payload would replace the last real frame with an empty one, and a
 * consumer holding "the latest frame" would watch its own view go blank at the
 * exact moment the run finished. A stream that cannot say it is finished leaves
 * "is more coming?" unobservable; one that says so by throwing away its content
 * has answered a different question.
 */
export const NodesFrameSchema = Schema.Struct({
  /** Node ids in scheduling order — the row order a dashboard paints. */
  order: Schema.Array(NodeIdSchema),
  nodes: Schema.Array(RunNodeSchema),
  state: RunBoardStateSchema,
  /** No further frame will arrive: the run has settled, expired, or lost its
   *  owner. In none of those three will anything move again. */
  done: Schema.Boolean,
});
export type NodesFrame = typeof NodesFrameSchema.Type;

// ── log tails ───────────────────────────────────────────────────────────────

/**
 * One attempt's log, as a subscribable tail.
 *
 * The COLLECTION is the live read: a browser watching a running node, an agent
 * subscribing to `surface://collections/logTails/<key>`. `log.read` below is
 * the paged read — bytes at an offset, for a caller that wants the whole thing
 * or a specific window. Two members because they answer different questions:
 * "show me what is happening" is unbounded and wants the end, "give me the
 * evidence" is bounded and wants an address.
 *
 * The key is the encoded log key (`@odu/service-client/logKey`), which is what
 * makes this addressable from a host with no cwd.
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
});
export type LogTail = typeof LogTailSchema.Type;

/** How much of a log a TAIL carries. The same bound the live wire already
 *  promises (`MAX_LOG_CHARS`), stated in bytes because this one is clamped on
 *  a byte budget: a log of box-drawing characters would blow a
 *  character-counted bound by a factor of three. */
export const LOG_TAIL_BYTES = 64 * 1024;

// ── procedures ──────────────────────────────────────────────────────────────

/** A caller's idempotency key. Present on every mutating verb, and not
 *  optional on `start` and `retry`: those are the two calls whose lost reply
 *  costs a second execution, and a caller that cannot name its request cannot
 *  be told what happened to it. */
const RequestId = Schema.String.check(Schema.isMinLength(1));

const StartInputSchema = Schema.Struct({
  /** ABSOLUTE path of the checkout to run in. Explicit, never the caller's
   *  cwd: an MCP host's cwd is not a fact about what the user meant. */
  checkout: Schema.String.check(Schema.isMinLength(1)),
  /** The commit the caller believes that checkout is on. Validated before
   *  acceptance — a checkout that has moved on is a REFUSAL, never a quiet
   *  different run. */
  expectedSha: Schema.String.check(Schema.isMinLength(7)),
  requestId: RequestId,
  /** `recipe[@platform]` selectors. Empty means the whole `[metadata("ci")]`
   *  DAG. */
  selectors: Schema.optionalKey(Schema.Array(Schema.String)),
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `P=ADDR` host pins, the same spelling `odu run --host` takes. */
  hostPins: Schema.optionalKey(Schema.Array(Schema.String)),
  root: Schema.optionalKey(Schema.String),
  noDeps: Schema.optionalKey(Schema.Boolean),
  noStrict: Schema.optionalKey(Schema.Boolean),
  noSnapshot: Schema.optionalKey(Schema.Boolean),
  noPost: Schema.optionalKey(Schema.Boolean),
  /** Take the checkout from a run already live in it. Explicit, because the
   *  default answer to "a run is already going there" is to show the caller
   *  that run rather than to kill it. */
  supersede: Schema.optionalKey(Schema.Boolean),
});
export type StartInput = typeof StartInputSchema.Encoded;

/**
 * What a start ANSWERS with: an addressed receipt.
 *
 * `accepted` is false for the one non-refusal case — the caller asked for a
 * checkout that already has a live run and did not say `supersede`, so odu is
 * showing them that run instead of starting a second one. It is an ANSWER and
 * not a refusal: nothing went wrong, and the run the caller is pointed at is
 * the one they almost certainly wanted.
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

/** One node whose failure is still unresolved, with the evidence to act on it.
 *  Every field is the attention payload's own — this surface re-publishes the
 *  catalog's answer rather than deriving a second one, so the browser, the CLI
 *  and `odu wait --run` cannot disagree about what is red. */
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
});
export type AttentionAnswer = typeof AttentionAnswerSchema.Type;

const RetryInputSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  /** `ci::unit@plat`, `@plat`, or a recipe name — the same grammar
   *  `odu rerun` has always taken. */
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
 *  inputs. The two need different next moves and a caller that could not tell
 *  them apart would resume the wrong run. */
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
 *
 * A tagged union rather than three optional fields, because a request that
 * named both a node and a lane would have to be resolved by precedence — and a
 * precedence rule is exactly how a caller who meant to stop one node stops the
 * whole run. Cancellation is the verb where an ambiguous input costs the most,
 * so it is not expressible.
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
   *  the same spelling `odu logs --offset` already takes. */
  offset: Schema.optionalKey(Schema.Int),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
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
   *  only about this read: a complete-false log that has been read to its end
   *  is a truncated log, and saying so is the difference between "the recipe
   *  was quiet" and "the evidence is gone". */
  complete: Schema.Boolean,
});
export type LogPage = typeof LogPageSchema.Type;

// ── the surface ─────────────────────────────────────────────────────────────

export const oduServiceSurface = defineSurface({
  cells: {
    service: { schema: ServiceCellSchema, default: UNKNOWN_SERVICE },
  },
  collections: {
    runs: {
      keySchema: Schema.String,
      schema: RunRowSchema,
      // `deltas` on top of the default set, because the BOARD is the one member
      // a reader follows rather than samples: a browser painting forty rows and
      // a `odu surface watch runs` in a terminal both want "here is the set,
      // then here is what changed", and without this verb each would have to
      // re-read every row to notice one moved. `logTails` deliberately has no
      // deltas — its key set is what happens to be watched, so a delta stream
      // over it would describe subscriptions rather than runs.
      verbs: ["keys", "get", "upsert", "delete", "deltas"],
    },
    logTails: { keySchema: Schema.String, schema: LogTailSchema },
  },
  streams: {
    nodes: {
      inputSchema: Schema.Struct({ runId: Schema.String }),
      outputSchema: NodesFrameSchema,
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
  },
});

type ServiceSF = SurfaceTypes<typeof oduServiceSurface.spec>;
export type ServiceSnapshot = ServiceSF["cells"]["service"]["Value"];
export type NodesStreamInput = ServiceSF["streams"]["nodes"]["InputWire"];

/** The service face — `runs`, `logTails`, `nodes`, and the five verbs. */
export type OduServiceClient = SurfaceClientOf<typeof oduServiceSurface.spec>;

/** Build the service face over any dispatch. ONE cast, here, so no consumer
 *  writes its own: the runtime object carries every member the type names
 *  (minted by `defineSurface`'s own tag algebra); the cast only tells the
 *  compiler which projection of that walk it is looking at. The same idiom
 *  `oduClientOver` keeps for the coordinator surface, and for the same
 *  reason. */
export function oduServiceClientOver(
  dispatch: SurfaceDispatch,
): OduServiceClient {
  return buildSurfaceFace(
    oduServiceSurface,
    dispatch,
  ) as unknown as OduServiceClient;
}
