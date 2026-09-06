/**
 * The durable shapes — what a run catalog entry IS, on disk, forever.
 *
 * Three records and one journal:
 *
 *   - {@link RunManifestSchema} — the run's identity, the snapshot it ran, the
 *     build that ran it, and who owns writing to it. Written once, atomically,
 *     BEFORE the run executes, so a coordinator that dies in its first second
 *     still leaves an addressable run rather than a directory nobody can name.
 *   - {@link RunEventSchema} — one line of the ordered journal. The journal is
 *     the run's history; every other durable fact here is a projection of it.
 *   - {@link AttemptRecordSchema} — one attempt's evidence sidecar: where it
 *     ran, how it ended, and whether its log is complete.
 *   - {@link RunVerdictSchema} — the terminal outcome, published at finalize.
 *
 * These bytes are read by a face built from a DIFFERENT commit than the one
 * that wrote them (an agent's `odu` is whatever `nix run` gave it that
 * morning), so every record carries `version` and every reader is expected to
 * skip what it cannot parse rather than crash. That is the same forgiveness
 * rule `@odu/run-client`'s wire schemas state, applied to files instead of a
 * socket — and it is why fields are ADDED as `optionalKey` and never
 * repurposed.
 *
 * Pure schema: no filesystem, no clock. `./store` owns the I/O.
 */

import { Schema } from "effect";
import { NodeStatusSchema } from "@odu/run-client/surface";

/** The record format every file in a run directory carries. Bumped only when a
 *  field changes SHAPE — a new optional field is not a bump, because an older
 *  reader still parses the record it is added to. */
export const RUN_RECORD_FORMAT = 1;

const Version = Schema.Literal(RUN_RECORD_FORMAT);

// ── what the run was asked to do ────────────────────────────────────────────

/** The selection a run was started with — the answer to "what does a green
 *  verdict here actually cover".
 *
 *  It is durable because a finalized retry has to reproduce it: replaying a
 *  run from `--platform x86_64-linux e2e` must replay THAT, not today's idea
 *  of the pipeline. It is also what stops a passing selection from being read
 *  as a passing pipeline — a face that shows a verdict shows this beside it. */
export const RunScopeSchema = Schema.Struct({
  /** The `recipe[@platform]` selectors, verbatim. Empty means the whole
   *  `[metadata("ci")]` DAG. */
  selectors: Schema.Array(Schema.String),
  /** `--platform` slices. Empty means every platform in the fanout. */
  platforms: Schema.Array(Schema.String),
  /** `--root NAMEPATH`, when the caller named one. */
  root: Schema.optionalKey(Schema.String),
  /** `--no-deps`: the selectors ran alone, with no dependency expansion. A
   *  green run under this flag says even less about the pipeline, so it is
   *  part of the scope rather than a run detail. */
  noDeps: Schema.Boolean,
});
export type RunScope = typeof RunScopeSchema.Type;

/** The snapshot a run executed. `strict` pins HEAD in a detached worktree;
 *  `live` runs the working tree as it stands (`--no-snapshot`/`--no-strict`).
 *  `expectedSha` is the commit the run claims to be about either way — a
 *  finalized retry refuses rather than substituting today's HEAD. */
export const RunSnapshotSchema = Schema.Struct({
  mode: Schema.Literals(["strict", "live"]),
  expectedSha: Schema.String,
  /** The working tree carried uncommitted changes (only reachable in `live`).
   *  A verdict about a dirty tree is not a verdict about a commit, and a
   *  replay of one cannot be reconstructed from the sha alone — which is
   *  exactly what `retryable` below records. */
  dirty: Schema.Boolean,
  /** Can this snapshot be reproduced from recorded inputs alone? False for a
   *  dirty live-tree run: its inputs were never committed, so a finalized
   *  retry has nothing to replay and must refuse instead of quietly running
   *  something else. Stored rather than derived so the rule lives with the
   *  record it governs. */
  retryable: Schema.Boolean,
});
export type RunSnapshot = typeof RunSnapshotSchema.Type;

/** Which build produced this run — the provenance a reader needs to explain a
 *  record it does not recognise, and the executable a recovery has to re-launch.
 *  `self` is the `odu` binary path (`ODU_SELF`), `runnerFlake` the flake-ref the
 *  lane runner was resolved from. Both nullable: a source run (`bun src/…`)
 *  has no wrapper to name. */
export const RunBuildSchema = Schema.Struct({
  oduVersion: Schema.String,
  self: Schema.NullOr(Schema.String),
  runnerFlake: Schema.NullOr(Schema.String),
});
export type RunBuild = typeof RunBuildSchema.Type;

// ── ownership ───────────────────────────────────────────────────────────────

/**
 * Who may write to this run, and how a successor proves the previous writer is
 * gone.
 *
 * `epoch` is the FENCE, and it is the whole reason this is a record rather than
 * a pid file. A pid file answers "is something with that number alive", which
 * is not the question: the number is reused, the process may be alive on
 * another host, and a socket that vanished may be a coordinator mid-restart.
 * So a writer stamps the epoch it claimed and re-checks it before every append;
 * a successor that takes over increments it, and the moment it does, the
 * previous writer's next append finds an epoch it does not hold and stops.
 * Disappearance alone never grants ownership — {@link OwnerSchema} records what
 * a claimant must outlive, and the store decides.
 */
export const OwnerSchema = Schema.Struct({
  /** Monotonic; the holder of the highest epoch is the writer. */
  epoch: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The owning process, on `host`. A pid alone means nothing across hosts,
   *  so the pair travels together. */
  pid: Schema.Int,
  host: Schema.String,
  /** `Date.now()` when this epoch was claimed. */
  claimedAt: Schema.Number,
  /** Last liveness stamp. A stale heartbeat is EVIDENCE, never a verdict: the
   *  store also requires the pid to be gone on this host before it hands the
   *  epoch on. */
  heartbeatAt: Schema.Number,
  /** Where this owner serves its live surface (the checkout's `.ci/odu.sock`),
   *  so a face can find the live run behind a catalog entry. Null once the
   *  owner has finished and closed it. */
  endpoint: Schema.NullOr(Schema.String),
});
export type Owner = typeof OwnerSchema.Type;

// ── the manifest ────────────────────────────────────────────────────────────

export const RunManifestSchema = Schema.Struct({
  version: Version,
  runId: Schema.String,
  /** `owner/repo` for a GitHub origin, `null` for a local-only checkout — the
   *  axis a multi-repo face fans in on. */
  repo: Schema.NullOr(Schema.String),
  /** Full 40-hex commit; `sha7` is derived at read sites, never stored twice. */
  sha: Schema.String,
  /** The checkout-scoped ordinal this run published as `<sha7>#<seq>`, or null
   *  when none could be reserved. Kept so the catalog can answer the ref every
   *  existing face already prints. */
  seq: Schema.NullOr(Schema.Int),
  pipeline: Schema.String,
  /** Absolute path of the checkout this run was started from. The catalog is
   *  per-user, not per-checkout (that is the point — PR 2 discovers runs
   *  without scanning arbitrary directories), so the checkout is a FIELD.
   *  It may no longer exist by the time a reader gets here. */
  repoRoot: Schema.String,
  createdAt: Schema.Number,
  scope: RunScopeSchema,
  snapshot: RunSnapshotSchema,
  build: RunBuildSchema,
  /**
   * Who registered this run — PROVENANCE, stamped once and never updated.
   *
   * Named `registeredBy` rather than `owner` because it is not the owner: the
   * live ownership record is `owner.json`, which `heartbeat` refreshes and
   * `releaseOwnership` clears. Two copies of one fact with no sync path is how
   * a killed coordinator came to be listed as "running" forever; the fix was
   * to stop reading this one as liveness, and the rename is what stops the
   * next reader trying. Its `endpoint` records where the run WAS served, which
   * is a fact about registration and stays true.
   */
  registeredBy: OwnerSchema,
  /** The run this one was derived from, for a finalized retry — so a face can
   *  say "this is a replay of that" instead of showing two unrelated runs of
   *  one commit. Null for a run started from a command line. */
  parentRunId: Schema.NullOr(Schema.String),
  /** The caller's idempotency key for the launch that created this run, when
   *  one was supplied. A repeat of the same id returns THIS run rather than
   *  starting a second one. */
  requestId: Schema.NullOr(Schema.String),
  /** Where this run's evidence was imported from, when it did not originate in
   *  the catalog — the legacy `.ci/<sha7>/runs/<seq>.json` path an import read.
   *  Present only on imported records, so a reader never mistakes a
   *  reconstructed history for a first-hand one. */
  importedFrom: Schema.optionalKey(Schema.String),
});
export type RunManifest = typeof RunManifestSchema.Type;

// ── the journal ─────────────────────────────────────────────────────────────

/** Where the run is in its lifecycle, mirroring `@odu/run-client`'s `RunPhase`
 *  minus the `unstarted` value a REGISTERED run cannot be in. */
const PhaseSchema = Schema.Literals(["provisioning", "lanes", "no_lanes"]);

/** Where a node's work happened: which platform lane, and which machine (null
 *  while a lane is still claiming one). Every failure the attention query
 *  reports carries it, because "it failed" and "it failed on that box" are
 *  different amounts of help. */
export const PlacementSchema = Schema.Struct({
  platform: Schema.String,
  host: Schema.NullOr(Schema.String),
});
export type Placement = typeof PlacementSchema.Type;

/**
 * One journal line's payload. `kind` is the discriminant (matching this repo's
 * existing wire unions, which use `kind` rather than `_tag`).
 *
 * FROZEN, in the same one-way sense the log-frame union is: a reader older than
 * the writer meets an arm it does not know. The journal reader therefore SKIPS
 * an unparseable line and counts it, rather than failing the read — an
 * unreadable event is a gap a face can report, and a crash is not.
 */
export const RunEventSchema = Schema.Union([
  /** The run exists and is about to execute. Always sequence 1. */
  Schema.Struct({
    kind: Schema.Literal("registered"),
    scope: RunScopeSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("phase"), phase: PhaseSchema }),
  /** The run's node roster, in scheduling order.
   *
   *  Emitted at registration and again whenever the set CHANGES — installing a
   *  sharded recipe's children is the real case. It is what lets a reader
   *  answer "is this run settled" from the journal alone: without a roster,
   *  the journal says which nodes reached a status and nothing about which
   *  ones were expected to, so a run that died before its slowest lane started
   *  would look identical to one that finished. */
  Schema.Struct({
    kind: Schema.Literal("roster"),
    order: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("lane"),
    platform: Schema.String,
    state: Schema.Literals(["claiming", "leased"]),
    host: Schema.NullOr(Schema.String),
  }),
  /** A node started its Nth attempt. The event that ALLOCATES the ordinal, so
   *  the journal is the authority on how many attempts exist — not a directory
   *  listing that a half-written retry could inflate. */
  Schema.Struct({
    kind: Schema.Literal("attempt_started"),
    node: Schema.String,
    attempt: Schema.Int,
    placement: PlacementSchema,
  }),
  /** A node reached a status. Terminal statuses carry the outcome; `running`
   *  and `pending` carry the transition alone. */
  Schema.Struct({
    kind: Schema.Literal("node_status"),
    node: Schema.String,
    attempt: Schema.Int,
    status: NodeStatusSchema,
    exitCode: Schema.NullOr(Schema.Int),
    durationMs: Schema.NullOr(Schema.Number),
    placement: PlacementSchema,
  }),
  /** This attempt's log has had its last word. `complete` is the promise the
   *  whole diagnostics contract turns on: false means the producer was lost
   *  and `reason` says how, so a reader is never handed a truncated log
   *  wearing a completion frame. */
  Schema.Struct({
    kind: Schema.Literal("log_finalized"),
    node: Schema.String,
    attempt: Schema.Int,
    bytes: Schema.Int,
    complete: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
  }),
  /** A GitHub commit status this run owes but could not confirm. Reporting
   *  debt, kept DISTINCT from the test outcome — a run whose statuses did not
   *  land still passed or failed on its own merits. */
  Schema.Struct({
    kind: Schema.Literal("posting_debt"),
    context: Schema.String,
    lastError: Schema.String,
    attempts: Schema.Int,
  }),
  /** A retry was accepted against this run. The durable receipt: a repeat of
   *  `requestId` with identical input replays this line instead of mutating
   *  anything a second time. */
  Schema.Struct({
    kind: Schema.Literal("retry_accepted"),
    requestId: Schema.String,
    /** The run the retry actually acts on — this run for a live retry, a new
     *  linked run for a finalized one. */
    effectiveRunId: Schema.String,
    /** The dependency-minimal nodes the caller asked to re-run. */
    roots: Schema.Array(Schema.String),
    /** Dependants the reset will also clear. Named because a caller that reads
     *  "reran unit" and finds `e2e` pending has to know which happened. */
    resetDependants: Schema.Array(Schema.String),
    /** Hash of the request's meaningful input, so a repeat of the same id with
     *  DIFFERENT input is refused rather than answered with this receipt. */
    inputDigest: Schema.String,
  }),
  /**
   * What became of an accepted retry — the OTHER half of the protocol.
   *
   * `retry_accepted` is written before the reset is performed, which is the
   * ordering that keeps a lost reply from hiding a mutation. The cost of that
   * ordering is that acceptance alone proves only INTENT: between the two
   * lines the coordinator can die, and the lane can refuse. So the intent stays
   * pending until this line resolves it, and a reconciler that finds only the
   * acceptance reports UNKNOWN rather than success.
   *
   * Both outcomes are recorded. A refusal is an answer — replaying it is how a
   * repeat learns its retry was declined instead of being told nothing is known.
   */
  Schema.Struct({
    kind: Schema.Literal("retry_applied"),
    requestId: Schema.String,
    /** WHICH root this resolves. One request can name several roots and they
     *  are dispatched one at a time, so a resolution that named only the
     *  request would be overwritten by the next root's — and a retry where one
     *  root was reset and another declined would read as wholly one or the
     *  other. Per-node, so partial application is representable. */
    node: Schema.String,
    /** Did the lane actually take the reset? */
    applied: Schema.Boolean,
  }),
  /** The run reached a terminal outcome. Sequence-wise the last line any
   *  writer appends. */
  Schema.Struct({
    kind: Schema.Literal("finalized"),
    outcome: Schema.Literals(["passed", "failed", "incomplete"]),
  }),
]);
export type RunEvent = typeof RunEventSchema.Type;

/**
 * Does this event mean WORK IS HAPPENING?
 *
 * The one rule the journal's writer and its readers must agree on, so it is
 * written once. After a `finalized` line, an event that satisfies this is the
 * run RESUMING — a new execution generation — and the two sides draw opposite
 * halves of the same conclusion from it: the reader stops calling the run
 * settled, and the writer knows it now owes a SECOND `finalized` when this
 * generation ends.
 *
 * They were not always the same rule, and the asymmetry was a bug in both
 * directions at once. The reader treated a resumed run as unsettled forever
 * because the writer emitted `finalized` once per run and never again; a
 * caller waiting on a retry could therefore never observe it finish. Neither
 * half is wrong on its own — which is why the rule cannot live in either.
 *
 * `pending`/`running` and not merely `attempt_started`, because a lane
 * publishes `pending` before it starts an attempt: keying on the attempt alone
 * leaves a window in which resumed work still reads as settled.
 */
export function isResumptionEvent(event: RunEvent): boolean {
  if (event.kind === "attempt_started") return true;
  if (event.kind === "node_status")
    return event.status === "pending" || event.status === "running";
  return false;
}

/** A journal line: the payload plus its ordinal and wall clock. `seq` is dense
 *  and 1-based within a run — a cursor is a `seq`, so a gap would be a hole a
 *  caller could not tell from a delivery it missed. */
export const JournalEntrySchema = Schema.Struct({
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.Number,
  event: RunEventSchema,
});
export type JournalEntry = typeof JournalEntrySchema.Type;

// ── attempts ────────────────────────────────────────────────────────────────

/** One attempt's sidecar. Written when the attempt starts (so an interrupted
 *  attempt is still addressable) and completed as it ends; NEVER rewritten
 *  once `endedAt` is set — a retry allocates the next ordinal instead. */
export const AttemptRecordSchema = Schema.Struct({
  version: Version,
  node: Schema.String,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  placement: PlacementSchema,
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  status: Schema.NullOr(NodeStatusSchema),
  exitCode: Schema.NullOr(Schema.Int),
  /** The signal the shell reported this attempt died of, when it did. DERIVED
   *  from the exit status by the POSIX shell's `128 + N` convention and stored
   *  only when the status is a failure — so it is a reading of what the shell
   *  said, not a fact the runner reported. `null` whenever that reading does
   *  not apply. A consumer that needs certainty reads `exitCode`. */
  signal: Schema.NullOr(Schema.String),
  /** Bytes written to this attempt's log. */
  logBytes: Schema.Int,
  /** Did this attempt's log get its producer's last word? */
  logComplete: Schema.Boolean,
  /** Why the log is short, when it is. */
  logTruncationReason: Schema.NullOr(Schema.String),
});
export type AttemptRecord = typeof AttemptRecordSchema.Type;

// ── the verdict ─────────────────────────────────────────────────────────────

export const RunVerdictSchema = Schema.Struct({
  version: Version,
  runId: Schema.String,
  /** `passed` only when the run COMPLETED with no red and no cancelled node —
   *  the same three-state rule the checkout ledger already uses, so a reader
   *  that knows one knows the other. */
  outcome: Schema.Literals(["passed", "failed", "incomplete"]),
  startedAt: Schema.Number,
  finishedAt: Schema.Number,
  failed: Schema.Array(Schema.String),
  errored: Schema.Array(Schema.String),
  cancelled: Schema.Array(Schema.String),
  /** Commit statuses still unconfirmed at finalize. Debt, not verdict. */
  unposted: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      lastError: Schema.String,
      attempts: Schema.Int,
    }),
  ),
});
export type RunVerdict = typeof RunVerdictSchema.Type;

/** A run whose evidence has aged out. A TOMBSTONE, not a deletion: the
 *  directory keeps this file so an addressed read answers "expired on <date>"
 *  instead of "no such run", which are different things to an agent holding a
 *  months-old run id. */
export const ExpirySchema = Schema.Struct({
  version: Version,
  runId: Schema.String,
  expiredAt: Schema.Number,
  /** What the run had ended as, kept so an expired entry can still say whether
   *  it passed. */
  outcome: Schema.Literals(["passed", "failed", "incomplete", "unknown"]),
});
export type Expiry = typeof ExpirySchema.Type;
