import { Schema } from "effect";
import { NodeStatusSchema } from "@odu/run-client/surface";

/** The record format every file in a run directory carries. */
export const RUN_RECORD_FORMAT = 1;

const Version = Schema.Literal(RUN_RECORD_FORMAT);

/** The selection a run was started with. */
export const RunScopeSchema = Schema.Struct({
  /** The `recipe[@platform]` selectors, verbatim. Empty means the whole
   *  `[metadata("ci")]` DAG. */
  selectors: Schema.Array(Schema.String),
  /** `--platform` slices. Empty means every platform in the fanout. */
  platforms: Schema.Array(Schema.String),
  /** `--root NAMEPATH`, when the caller named one. */
  root: Schema.optionalKey(Schema.String),
  /** `--no-deps`: the selectors ran alone, with no dependency expansion. */
  noDeps: Schema.Boolean,
});
export type RunScope = typeof RunScopeSchema.Type;

/** The snapshot a run executed. `strict` pins HEAD in a detached worktree;
 *  `live` runs the working tree as it stands (`--no-snapshot`/`--no-strict`).
 *  `expectedSha` is the commit the run claims to be about either way. */
export const RunSnapshotSchema = Schema.Struct({
  contentSha: Schema.optionalKey(Schema.String),
  overlay: Schema.optionalKey(Schema.Struct({ count: Schema.Int, paths: Schema.Array(Schema.String) })),
  mode: Schema.Literals(["strict", "live"]),
  expectedSha: Schema.String,
  /** The working tree carried uncommitted changes (only reachable in `live`). */
  dirty: Schema.Boolean,
  /** Can this snapshot be reproduced from recorded inputs alone? False for a
   *  dirty live-tree run. */
  retryable: Schema.Boolean,
});
export type RunSnapshot = typeof RunSnapshotSchema.Type;

/** Which build produced this run. `self` is the `odu` binary path
 *  (`ODU_SELF`), `runnerFlake` the flake-ref the lane runner was resolved
 *  from. Both nullable. */
export const RunBuildSchema = Schema.Struct({
  oduVersion: Schema.String,
  self: Schema.NullOr(Schema.String),
  runnerFlake: Schema.NullOr(Schema.String),
});
export type RunBuild = typeof RunBuildSchema.Type;

/** Who may write to this run. */
export const OwnerSchema = Schema.Struct({
  /** Monotonic; the holder of the highest epoch is the writer. */
  epoch: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The owning process, on `host`. */
  pid: Schema.Int,
  host: Schema.String,
  /** `Date.now()` when this epoch was claimed. */
  claimedAt: Schema.Number,
  /** Last liveness stamp. */
  heartbeatAt: Schema.Number,
  /** Where this owner serves its live surface (the checkout's `.ci/odu.sock`).
   *  Null once the owner has finished and closed it. */
  endpoint: Schema.NullOr(Schema.String),
});
export type Owner = typeof OwnerSchema.Type;

export const RunManifestSchema = Schema.Struct({
  version: Version,
  runId: Schema.String,
  /** `owner/repo` for a GitHub origin, `null` for a local-only checkout. */
  repo: Schema.NullOr(Schema.String),
  /** Full 40-hex commit; `sha7` is derived at read sites, never stored twice. */
  sha: Schema.String,
  /** The checkout-scoped ordinal this run published as `<sha7>#<seq>`, or null
   *  when none could be reserved. */
  seq: Schema.NullOr(Schema.Int),
  pipeline: Schema.String,
  /**
   * The branch the run was started on. ABSENT when the record predates the
   * field or HEAD was detached.
   */
  branch: Schema.optionalKey(Schema.String),
  /** Absolute path of the checkout this run was started from. It may no longer
   *  exist by the time a reader gets here. */
  repoRoot: Schema.String,
  createdAt: Schema.Number,
  scope: RunScopeSchema,
  /**
   * The `PLATFORM=ADDR` placement pins the caller passed, verbatim.
   *
   *   - `["x86_64-linux=boxA"]` — pinned.
   *   - `[]` — explicitly unpinned.
   *   - ABSENT — written before odu recorded placement; a finalized retry
   *     REFUSES.
   */
  hostPins: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The caller's `$ODU_HOSTS`, as the coordinator saw it.
   *
   *   - a PATH — resolve against that file.
   *   - `""` — the caller's shell had none, so the chain starts at
   *     `~/.config`.
   *   - ABSENT — written before odu recorded inventory; a finalized retry
   *     REFUSES.
   */
  hostsFile: Schema.optionalKey(Schema.String),
  snapshot: RunSnapshotSchema,
  build: RunBuildSchema,
  /** Who registered this run. */
  registeredBy: OwnerSchema,
  /**
   * WHO STARTED THIS RUN: a signed-in person's `login`, or the reserved
   * `"@local"` for a loopback connection. ABSENT when the record predates the
   * field.
   */
  actor: Schema.optionalKey(Schema.String),
  /** The run this one was derived from, for a finalized retry. Null for a run
   *  started from a command line. */
  parentRunId: Schema.NullOr(Schema.String),
  /** The caller's idempotency key for the launch that created this run, when
   *  one was supplied. A repeat of the same id returns THIS run. */
  requestId: Schema.NullOr(Schema.String),
  /** Where this run's evidence was imported from; present only on imported
   *  records. */
  importedFrom: Schema.optionalKey(Schema.String),
  /**
   * WHERE THIS RUN PUSHED WHAT IT BUILT. `target` is null for a run that
   * pushed nothing. `tokenId` is the handle the token is revoked by at
   * finalize.
   */
  push: Schema.optionalKey(
    Schema.Struct({
      target: Schema.NullOr(
        Schema.Struct({
          substituter: Schema.String,
          bucket: Schema.String,
          tokenId: Schema.String,
        }),
      ),
      /** WHY NOTHING IS PUSHED. Null when a target stands. */
      skipped: Schema.NullOr(Schema.String),
      /** WHAT IS WRONG WHILE SOMETHING IS PUSHED: the bucket's key is missing
       *  from the repository's `trusted-public-keys`, so what this run warms
       *  will not be substituted from. Null when there is nothing to say. */
      keyWarning: Schema.NullOr(Schema.String),
    }),
  ),
});
export type RunManifest = typeof RunManifestSchema.Type;

/** Where the run is in its lifecycle. */
const PhaseSchema = Schema.Literals(["provisioning", "lanes", "no_lanes"]);

/** Where a node's work happened: which platform lane, and which machine (null
 *  while a lane is still claiming one). */
export const PlacementSchema = Schema.Struct({
  platform: Schema.String,
  host: Schema.NullOr(Schema.String),
});
export type Placement = typeof PlacementSchema.Type;

/** One journal line's payload. `kind` is the discriminant. */
export const RunEventSchema = Schema.Union([
  /** The run exists and is about to execute. Always sequence 1. */
  Schema.Struct({
    kind: Schema.Literal("registered"),
    scope: RunScopeSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("phase"), phase: PhaseSchema }),
  /** The run's node roster, in scheduling order. */
  Schema.Struct({
    kind: Schema.Literal("roster"),
    order: Schema.Array(Schema.String),
  }),
  /** A platform lane changed state. `claiming` is waiting for a venue and has
   *  no host yet; `leased` has one. */
  Schema.Struct({
    kind: Schema.Literal("lane"),
    platform: Schema.String,
    state: Schema.Literals(["claiming", "leased"]),
    host: Schema.NullOr(Schema.String),
    /** The candidate machines this lane may land on, while it is `claiming`. */
    pool: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The hosts file the pool was declared in. */
    hostsSource: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  /** A node started its Nth attempt. */
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
  /** This attempt's log has had its last word. `complete` false means the
   *  producer was lost and `reason` says how. */
  Schema.Struct({
    kind: Schema.Literal("log_finalized"),
    node: Schema.String,
    attempt: Schema.Int,
    bytes: Schema.Int,
    complete: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
  }),
  /** A GitHub commit status this run owes but could not confirm. */
  Schema.Struct({
    kind: Schema.Literal("posting_debt"),
    context: Schema.String,
    lastError: Schema.String,
    attempts: Schema.Int,
  }),
  /** A retry was accepted against this run. */
  Schema.Struct({
    kind: Schema.Literal("retry_accepted"),
    requestId: Schema.String,
    /** The run the retry actually acts on — this run for a live retry, a new
     *  linked run for a finalized one. */
    effectiveRunId: Schema.String,
    /** The dependency-minimal nodes the caller asked to re-run. */
    roots: Schema.Array(Schema.String),
    /** Dependants the reset will also clear. */
    resetDependants: Schema.Array(Schema.String),
    /** Hash of the request's meaningful input, so a repeat of the same id with
     *  DIFFERENT input is refused rather than answered with this receipt. */
    inputDigest: Schema.String,
  }),
  /** What became of an accepted retry. */
  Schema.Struct({
    kind: Schema.Literal("retry_applied"),
    requestId: Schema.String,
    /** WHICH root this resolves. */
    node: Schema.String,
    /** Did the lane actually take the reset? */
    applied: Schema.Boolean,
  }),
  /** A NODE BEGAN PUSHING: its recipe exited 0 and the lane started sending
   *  the closure. */
  Schema.Struct({
    kind: Schema.Literal("pushing"),
    node: Schema.String,
    bucket: Schema.String,
    /** THE RECIPE'S OWN DURATION, as it was known the instant the push
     *  began. */
    durationMs: Schema.optionalKey(Schema.Int),
  }),
  /**
   * A NODE'S OUTPUTS LANDED IN THE CACHE. `paths` counts what the bucket
   * SERVES as a result (stored plus already-present); `bytes` is the
   * UNCOMPRESSED NAR size of what was uploaded.
   */
  Schema.Struct({
    kind: Schema.Literal("pushed"),
    node: Schema.String,
    bucket: Schema.String,
    paths: Schema.Int,
    /** Of `paths`, how many the bucket ALREADY served before this node. */
    present: Schema.optionalKey(Schema.Int),
    bytes: Schema.Int,
    /** HOW LONG THE PUSH TOOK, on its own. A node's `durationMs` is the
     *  RECIPE's time and stays that: a run whose timings silently absorbed
     *  upload seconds would change what every existing timing surface means.
     *  `optionalKey`, so a line written before this field still decodes. */
    durationMs: Schema.optionalKey(Schema.Int),
  }),
  /** A NODE'S PUSH FAILED: the recipe passed and its outputs did not reach
   *  the bucket, which makes the node red. */
  Schema.Struct({
    kind: Schema.Literal("push_failed"),
    node: Schema.String,
    bucket: Schema.String,
    /** The push client's own sentence, as it went into the node's push log. */
    message: Schema.String,
    durationMs: Schema.optionalKey(Schema.Int),
  }),
  /** The run reached a terminal outcome. */
  Schema.Struct({
    kind: Schema.Literal("finalized"),
    outcome: Schema.Literals(["passed", "failed", "incomplete"]),
  }),
]);
export type RunEvent = typeof RunEventSchema.Type;

/** Does this event mean WORK IS HAPPENING? */
export function isResumptionEvent(event: RunEvent): boolean {
  if (event.kind === "attempt_started") return true;
  if (event.kind === "node_status")
    return event.status === "pending" || event.status === "running";
  return false;
}

/** A journal line: the payload plus its ordinal and wall clock. `seq` is dense
 *  and 1-based within a run. */
export const JournalEntrySchema = Schema.Struct({
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.Number,
  event: RunEventSchema,
});
export type JournalEntry = typeof JournalEntrySchema.Type;

/** WHAT ONE NODE'S PUSH IS DOING, folded out of the three `push*` lines
 *  above. */
export type NodePush =
  | { state: "pushing"; bucket: string }
  | {
      state: "pushed";
      bucket: string;
      /** Paths this node uploaded. */
      stored: number;
      /** Paths of this node's closure the bucket already served. */
      present: number;
      bytes: number;
      durationMs: number;
    }
  | { state: "failed"; bucket: string; message: string; durationMs: number };

/** One attempt's sidecar. */
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
   *  only when the status is a failure. `null` whenever that reading does not
   *  apply. */
  signal: Schema.NullOr(Schema.String),
  /** Bytes written to this attempt's log. */
  logBytes: Schema.Int,
  /** Did this attempt's log get its producer's last word? */
  logComplete: Schema.Boolean,
  /** Why the log is short, when it is. */
  logTruncationReason: Schema.NullOr(Schema.String),
});
export type AttemptRecord = typeof AttemptRecordSchema.Type;

export const RunVerdictSchema = Schema.Struct({
  version: Version,
  runId: Schema.String,
  /** `passed` only when the run COMPLETED with no red and no cancelled
   *  node. */
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

/** A run whose evidence has aged out. A TOMBSTONE, not a deletion. */
export const ExpirySchema = Schema.Struct({
  version: Version,
  runId: Schema.String,
  expiredAt: Schema.Number,
  /** What the run had ended as, kept so an expired entry can still say whether
   *  it passed. */
  outcome: Schema.Literals(["passed", "failed", "incomplete", "unknown"]),
});
export type Expiry = typeof ExpirySchema.Type;
