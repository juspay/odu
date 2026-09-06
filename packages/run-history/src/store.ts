/**
 * The durable store — every filesystem operation the run catalog performs, and
 * the only module in this package that touches a disk.
 *
 * The split with `./schema` is the usual portable/platform one: the shapes
 * travel (a browser face in PR 2 will decode the same manifest), the syscalls
 * do not. What is worth stating is the DIRECTION of authority inside this
 * file: the journal is the run's history, and everything else — the verdict,
 * the attempt sidecars, the manifest's mutable half — is a projection kept for
 * the reader's convenience. When a projection and the journal disagree, the
 * journal is right, and the reader that needs to be sure reads it.
 *
 * Three invariants the code below is arranged around:
 *
 *   - REGISTER BEFORE EXECUTE. `registerRun` publishes a manifest and claims
 *     the ownership epoch before the caller does anything observable. A run
 *     that dies in its first second is still a run somebody can address, which
 *     is the difference between "the coordinator crashed" and "nothing
 *     happened".
 *   - APPEND, NEVER REWRITE. The journal is opened `a` and every line is one
 *     `write(2)` of a complete JSON object; a torn tail is the last line only,
 *     and the reader drops it. Attempt logs are the same: one file per
 *     attempt, sealed when the attempt ends, and a retry gets the NEXT ordinal
 *     rather than the same file back.
 *   - EVERY WRITE IS FENCED, with two stated exemptions. `stillOwner` runs
 *     before each durable mutation, so a coordinator that has been superseded
 *     finds out at its next write and stops instead of racing a successor for
 *     the tail of one file. The exemptions are named where they live and both
 *     are deliberate: `appendAttemptLog` is the per-chunk hot path and is
 *     bounded by the seal around it, and `expireRun` is a janitor rather than
 *     a writer — it holds no epoch, so it guards on the owner being gone
 *     instead.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { writeAtomic } from "./atomic";
import {
  decodeNodeKey,
  encodeNodeKey,
  isAttemptOrdinal,
  isRunId,
  runIdStartedAt,
} from "./ids";
import {
  ATTEMPT_FILES,
  attemptDir,
  catalogRoot,
  RUN_EVIDENCE,
  RUN_FILES,
  runDir,
  type StateEnv,
} from "./paths";
import {
  beingWritten,
  claimOwnership,
  type ClaimRefusal,
  currentOwner,
  type OwnershipToken,
  ownershipProvablyLost,
  stillOwner,
} from "./owner";
import {
  type AttemptRecord,
  AttemptRecordSchema,
  type Expiry,
  ExpirySchema,
  type JournalEntry,
  JournalEntrySchema,
  RUN_RECORD_FORMAT,
  type RunEvent,
  type RunManifest,
  RunManifestSchema,
  type RunVerdict,
  RunVerdictSchema,
} from "./schema";
import { isResumptionEvent } from "./schema";

const decodeManifest = Schema.decodeUnknownResult(RunManifestSchema);
const decodeEntry = Schema.decodeUnknownResult(JournalEntrySchema);
const decodeAttempt = Schema.decodeUnknownResult(AttemptRecordSchema);
const decodeVerdict = Schema.decodeUnknownResult(RunVerdictSchema);
const decodeExpiry = Schema.decodeUnknownResult(ExpirySchema);

function readJson<A>(
  path: string,
  decode: (u: unknown) => Result.Result<A, unknown>,
): A | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const decoded = decode(parsed);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

/** A handle on one run's directory. Cheap: it is a path plus the catalog it
 *  came from, so a caller can hold one across a whole run without keeping a
 *  file descriptor open through a multi-hour pipeline. */
export interface RunHandle {
  readonly runId: string;
  readonly dir: string;
}

export interface CatalogOptions {
  /** Override the catalog location. Tests always pass one; production reads
   *  it from `ODU_STATE_DIR` via `./paths`. */
  root?: string;
  env?: StateEnv;
  platform?: NodeJS.Platform;
}

/** Where the catalog is, for these options. */
export function catalogPath(opts: CatalogOptions = {}): string {
  return opts.root ?? catalogRoot(opts.env, opts.platform);
}

export function handleFor(runId: string, opts: CatalogOptions = {}): RunHandle {
  return { runId, dir: runDir(catalogPath(opts), runId) };
}

// ── registration ────────────────────────────────────────────────────────────

export type RegisterResult =
  | { ok: true; handle: RunHandle; token: OwnershipToken; manifest: RunManifest }
  | { ok: false; refusal: ClaimRefusal };

/**
 * Publish a run into the catalog and take write-ownership of it.
 *
 * The order is the contract: the directory and the ownership epoch come first,
 * the manifest second, the `registered` journal line third. A crash between
 * any two of those leaves a run that is addressable and owned but has not
 * claimed to have started — which is a state a reader can describe. The
 * opposite order would leave a manifest nobody owns, and the next process to
 * look would be entitled to write to it.
 */
export function registerRun(
  manifest: Omit<RunManifest, "version" | "registeredBy">,
  opts: CatalogOptions & { endpoint: string | null; now?: number } ,
): RegisterResult {
  const handle = handleFor(manifest.runId, opts);
  mkdirSync(handle.dir, { recursive: true });
  const claim = claimOwnership({
    runId: manifest.runId,
    dir: handle.dir,
    endpoint: opts.endpoint,
    now: opts.now,
  });
  if (!claim.ok) return { ok: false, refusal: claim.refusal };
  const full: RunManifest = {
    ...manifest,
    version: RUN_RECORD_FORMAT,
    registeredBy: claim.owner,
  };
  writeAtomic(
    join(handle.dir, RUN_FILES.manifest),
    `${JSON.stringify(full, null, 2)}\n`,
  );
  appendEvent(handle, claim.token, {
    kind: "registered",
    scope: manifest.scope,
  }, opts.now);
  return { ok: true, handle, token: claim.token, manifest: full };
}

export function readManifest(handle: RunHandle): RunManifest | null {
  return readJson(join(handle.dir, RUN_FILES.manifest), decodeManifest);
}

// ── the journal ─────────────────────────────────────────────────────────────

/**
 * The next sequence number for a run — one past the highest line already on
 * disk. Read rather than remembered so a coordinator that takes over a run
 * mid-flight continues the numbering rather than restarting it.
 *
 * `highestSeq`, NOT the last DECODED entry, and the difference is a real bug
 * rather than a nicety. `readJournal` is deliberately forgiving and drops a
 * line it cannot decode — a record from a newer writer is the case it names
 * itself — but a dropped line still OCCUPIES its ordinal on disk. Numbering
 * from the decodable tail would hand that ordinal out a second time, and then
 * two lines share a sequence, their order after the sort is arbitrary, and a
 * caller resuming from that cursor silently skips one of them. A cursor is a
 * sequence number; it may only ever mean one line.
 */
function nextSeq(handle: RunHandle): number {
  return readJournal(handle).highestSeq + 1;
}

/**
 * A run's journal, held open by its owner.
 *
 * The ordinal lives IN MEMORY here, and that is the whole reason this type
 * exists rather than a free function. Deriving the next sequence from disk on
 * every append means reading and decoding the entire journal per line: the
 * hundredth event of a run re-reads ninety-nine, which is quadratic in the
 * length of a run and lands squarely on the coordinator's event loop — the one
 * that is also serving `.ci/odu.sock`. Holding the counter is safe precisely
 * because ownership is exclusive: one epoch, one writer, one counter. A
 * successor opens its own writer and re-derives the floor from disk, which is
 * the one moment the file is the authority.
 */
export interface JournalWriter {
  append: (event: RunEvent, now?: number) => JournalEntry | null;
}


/** Open the journal for a run this token owns. The floor is read once. */
export function openJournal(
  handle: RunHandle,
  token: OwnershipToken,
): JournalWriter {
  let next = nextSeq(handle);
  return {
    append: (event, now) => {
      const entry = appendAt(handle, token, next, event, now ?? Date.now());
      if (entry !== null) next += 1;
      return entry;
    },
  };
}

/**
 * Append one event, deriving its ordinal from disk.
 *
 * The one-shot form, for a caller that appends once and does not hold a
 * journal open — registration, and tests. A writer that appends repeatedly
 * wants {@link openJournal}; see its note on why.
 */
export function appendEvent(
  handle: RunHandle,
  token: OwnershipToken,
  event: RunEvent,
  now: number = Date.now(),
): JournalEntry | null {
  return appendAt(handle, token, nextSeq(handle), event, now);
}

/**
 * The append itself. Returns the entry written, or `null` when this writer no
 * longer owns the run (fenced) or the append failed.
 *
 * Best-effort by disposition — a failed history write must never fail a run,
 * which is the rule the checkout ledger already follows — but NOT silent about
 * the one case that matters: a `null` return means the caller has been fenced,
 * and the coordinator uses that to stop rather than to retry.
 */
function appendAt(
  handle: RunHandle,
  token: OwnershipToken,
  seq: number,
  event: RunEvent,
  now: number,
): JournalEntry | null {
  if (!stillOwner(token)) return null;
  const entry: JournalEntry = { seq, at: now, event };
  try {
    // ONE `appendFileSync` of a complete line. `O_APPEND` makes a write under
    // PIPE_BUF atomic against other appenders, and a crash mid-write can only
    // truncate the final line — which `readJournal` drops. Two writes (payload
    // then newline) would let a crash interleave a partial line with a
    // successor's complete one, and no reader could tell them apart.
    appendFileSync(
      join(handle.dir, RUN_FILES.events),
      `${JSON.stringify(entry)}\n`,
    );
  } catch {
    return null;
  }
  return entry;
}

export interface JournalRead {
  entries: JournalEntry[];
  /** Lines that did not parse — a torn tail, or a record from a newer writer.
   *  Surfaced rather than swallowed: a face that shows history should be able
   *  to say "and n events I could not read". */
  unreadable: number;
  /** The highest ordinal ANY line claims, readable or not. The allocator reads
   *  this rather than the decoded tail — see `nextSeq`. */
  highestSeq: number;
}

/** Every journal line for a run, in order. Forgiving by design: an unparseable
 *  line is counted and skipped, never thrown. */
export function readJournal(handle: RunHandle): JournalRead {
  let text: string;
  try {
    text = readFileSync(join(handle.dir, RUN_FILES.events), "utf-8");
  } catch {
    return { entries: [], unreadable: 0, highestSeq: 0 };
  }
  const entries: JournalEntry[] = [];
  let unreadable = 0;
  let highestSeq = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    // The ordinal is read BEFORE the event is decoded, so a line whose payload
    // this build does not understand still reserves its number.
    const claimed = (parsed as { seq?: unknown }).seq;
    if (typeof claimed === "number" && Number.isSafeInteger(claimed)) {
      highestSeq = Math.max(highestSeq, claimed);
    }
    const decoded = decodeEntry(parsed);
    if (Result.isSuccess(decoded)) entries.push(decoded.success);
    else unreadable += 1;
  }
  // Sorted by seq rather than trusted in file order: a takeover that
  // re-derived `nextSeq` writes in order, but an imported record is assembled
  // rather than appended, and a reader that assumes order would paginate a
  // cursor past events it never delivered.
  entries.sort((a, b) => a.seq - b.seq);
  return { entries, unreadable, highestSeq };
}

// ── attempts ────────────────────────────────────────────────────────────────

/** Every attempt ordinal recorded for a node, ascending. Read from the
 *  directory rather than the journal so evidence remains addressable even for
 *  a run whose journal was truncated. */
export function attemptsFor(handle: RunHandle, node: string): number[] {
  const dir = join(handle.dir, RUN_FILES.attempts, encodeNodeKey(node));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const entry of entries) {
    const n = Number(entry);
    if (isAttemptOrdinal(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Every node this run has evidence for, decoded back to node ids. A key that
 *  does not decode is skipped — see `decodeNodeKey` on why null beats a
 *  guess. */
export function nodesWithEvidence(handle: RunHandle): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(handle.dir, RUN_FILES.attempts));
  } catch {
    return [];
  }
  return entries
    .map(decodeNodeKey)
    .filter((id): id is string => id !== null)
    .sort();
}

/** Open (or re-open) an attempt's log for writing, and stamp its sidecar.
 *
 *  Creating the directory is what ALLOCATES the ordinal on disk; the journal's
 *  `attempt_started` line is what makes the allocation observable. Both, in
 *  that order, so a reader never sees an event pointing at evidence that is
 *  not there yet. */
export function startAttempt(
  handle: RunHandle,
  token: OwnershipToken,
  record: Omit<
    AttemptRecord,
    | "version"
    | "endedAt"
    | "status"
    | "exitCode"
    | "signal"
    | "logBytes"
    | "logComplete"
    | "logTruncationReason"
  >,
): boolean {
  if (!stillOwner(token)) return false;
  const dir = attemptDir(
    handle.dir,
    encodeNodeKey(record.node),
    record.attempt,
  );
  mkdirSync(dir, { recursive: true });
  const full: AttemptRecord = {
    ...record,
    version: RUN_RECORD_FORMAT,
    endedAt: null,
    status: null,
    exitCode: null,
    signal: null,
    logBytes: 0,
    logComplete: false,
    logTruncationReason: null,
  };
  writeAtomic(
    join(dir, ATTEMPT_FILES.record),
    `${JSON.stringify(full, null, 2)}\n`,
  );
  // Truncating create: an attempt directory is allocated once, but a
  // coordinator that took over a run mid-attempt re-opens the same ordinal and
  // must not append onto bytes it did not produce.
  writeAtomic(join(dir, ATTEMPT_FILES.log), "");
  return true;
}

/**
 * REPLACE an attempt's log with `text`.
 *
 * For the one frame that is a re-sync rather than new output: a lane
 * re-sending a node's buffered tail. That is not a retry — the attempt is the
 * same attempt — so the bytes are replaced in place rather than rotated onto a
 * new ordinal, which would leave an empty ghost attempt behind and make
 * "attempt 2" mean nothing.
 */
export function writeAttemptLog(
  handle: RunHandle,
  node: string,
  attempt: number,
  text: string,
): void {
  try {
    writeAtomic(
      join(
        attemptDir(handle.dir, encodeNodeKey(node), attempt),
        ATTEMPT_FILES.log,
      ),
      text,
    );
  } catch {
    // Best-effort, like every other evidence write — see `appendAttemptLog`.
  }
}

/** Append raw bytes to an attempt's log. Hot path — called per output chunk —
 *  so it does NOT re-check the fence on every call: the fence is checked when
 *  the attempt starts and when it is sealed, and a fenced writer appending to
 *  a log it will never seal is a bounded, recoverable mess (a log that ends
 *  without a terminal), whereas a `stat` per chunk is a syscall per line of
 *  every recipe's output. Stated rather than left as an oversight. */
export function appendAttemptLog(
  handle: RunHandle,
  node: string,
  attempt: number,
  text: string,
): void {
  const path = join(
    attemptDir(handle.dir, encodeNodeKey(node), attempt),
    ATTEMPT_FILES.log,
  );
  try {
    appendFileSync(path, text);
  } catch {
    // Evidence is best-effort against the run: a full disk must not kill a
    // coordinator mid-pipeline. The sidecar's byte count will disagree with
    // the file, and `sealAttempt` records the log as incomplete because of it.
  }
}

/**
 * Close an attempt: record how it ended, stamp the log's completeness, and make
 * the evidence READ-ONLY.
 *
 * The chmod is the immutability the spec asks for, and it is worth being
 * precise about what it buys. It does not defend against a determined process
 * — the owner can chmod it back — but it turns "a retry overwrote the old log"
 * from a plausible bug into an operation that has to be spelled out on purpose.
 * The real guarantee is the addressing: a retry allocates attempt N+1 and
 * never names N again.
 */
export function sealAttempt(
  handle: RunHandle,
  token: OwnershipToken,
  node: string,
  attempt: number,
  outcome: Pick<
    AttemptRecord,
    "endedAt" | "status" | "exitCode" | "signal" | "logComplete" | "logTruncationReason"
  >,
): boolean {
  if (!stillOwner(token)) return false;
  const dir = attemptDir(handle.dir, encodeNodeKey(node), attempt);
  const existing = readJson(join(dir, ATTEMPT_FILES.record), decodeAttempt);
  if (existing === null) return false;
  const logPath = join(dir, ATTEMPT_FILES.log);
  let bytes = 0;
  try {
    bytes = statSync(logPath).size;
  } catch {
    // No log file at all — an attempt that produced nothing before it died.
  }
  writeAtomic(
    join(dir, ATTEMPT_FILES.record),
    `${JSON.stringify({ ...existing, ...outcome, logBytes: bytes }, null, 2)}\n`,
  );
  try {
    chmodSync(logPath, 0o444);
  } catch {
    // A filesystem that will not take the mode (or a log that never existed)
    // costs the belt, not the braces: the ordinal is still never reused.
  }
  return true;
}

export function readAttemptRecord(
  handle: RunHandle,
  node: string,
  attempt: number,
): AttemptRecord | null {
  return readJson(
    join(
      attemptDir(handle.dir, encodeNodeKey(node), attempt),
      ATTEMPT_FILES.record,
    ),
    decodeAttempt,
  );
}

export interface LogSlice {
  /** The bytes read, decoded as UTF-8. */
  text: string;
  /** Where this slice started, in bytes. */
  offset: number;
  /**
   * How many BYTES this slice consumed — which is not `text`'s byte length.
   *
   * The decode is non-fatal (see below), so a range whose boundary lands
   * inside a multibyte character yields U+FFFD where one or two real bytes
   * were: measuring the decoded string would then report MORE bytes than were
   * read, and a caller resuming from that number would skip real log content.
   * The offset to continue from is `offset + bytesRead`, and it is a fact
   * about the read rather than one a consumer can recover from the text.
   */
  bytesRead: number;
  /** Total size of the log at read time. */
  size: number;
  /** Did this slice reach the end of the file? Distinct from `logComplete` on
   *  the attempt record: this is "you have read everything that is there",
   *  that is "everything there is, is there". A reader needs both — the pair
   *  is what lets a face say "complete" honestly. */
  eof: boolean;
}

/**
 * Read a byte range of a file, race-free.
 *
 * ONE DESCRIPTOR. `statSync(path)` followed by `readFileSync(path)` asks the
 * filesystem about a NAME twice, and a name is not a file: between the two
 * calls the writer is still writing (that is what a coordinator, a lane and a
 * recipe all do), so the size the read is planned from is not the size of what
 * it reads. Opening once and `fstat`ing the handle makes both facts about the
 * same inode at the same instant.
 *
 * BYTE OFFSETS, not lines, because the caller that matters is resuming: "give
 * me from where I stopped" has a cheap exact answer in bytes and an expensive
 * approximate one in lines. A negative `offset` counts back from the end,
 * which is how a face asks for a tail without first stat-ing the file.
 *
 * UTF-8 is decoded NON-fatally on purpose: a slice boundary can land inside a
 * multibyte character, and refusing to render a log because a range cut a
 * character in half would be a worse answer than a replacement character at
 * the seam. That is exactly why {@link LogSlice.bytesRead} exists — the
 * decoded string's byte length is NOT what was read, so a caller resuming from
 * it would skip content.
 *
 * The primitive, not the policy: what to do about a file that is not there is
 * the caller's (`null`), and so is what the file MEANS.
 */
export function readFileSlice(
  path: string,
  range: { offset?: number; limit?: number } = {},
): LogSlice | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const requested = range.offset ?? 0;
    const start =
      requested < 0 ? Math.max(0, size + requested) : Math.min(requested, size);
    const limit = range.limit ?? size - start;
    const length = Math.max(0, Math.min(limit, size - start));
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return {
      text: buf.subarray(0, read).toString("utf-8"),
      offset: start,
      bytesRead: read,
      size,
      eof: start + read >= size,
    };
  } finally {
    closeSync(fd);
  }
}

/** One attempt's log, by address. Path resolution over {@link readFileSlice} —
 *  the technique is the primitive's, and which file it is is this function's
 *  entire contribution. */
export function readAttemptLog(
  handle: RunHandle,
  node: string,
  attempt: number,
  range: { offset?: number; limit?: number } = {},
): LogSlice | null {
  return readFileSlice(
    join(
      attemptDir(handle.dir, encodeNodeKey(node), attempt),
      ATTEMPT_FILES.log,
    ),
    range,
  );
}

// ── verdict and expiry ──────────────────────────────────────────────────────

export function writeVerdict(
  handle: RunHandle,
  token: OwnershipToken,
  verdict: Omit<RunVerdict, "version">,
): boolean {
  if (!stillOwner(token)) return false;
  writeAtomic(
    join(handle.dir, RUN_FILES.verdict),
    `${JSON.stringify({ ...verdict, version: RUN_RECORD_FORMAT }, null, 2)}\n`,
  );
  return true;
}

export function readVerdict(handle: RunHandle): RunVerdict | null {
  return readJson(join(handle.dir, RUN_FILES.verdict), decodeVerdict);
}

export function readExpiry(handle: RunHandle): Expiry | null {
  return readJson(join(handle.dir, RUN_FILES.expiry), decodeExpiry);
}

/**
 * Replace a run's evidence with a tombstone. The manifest and verdict stay —
 * they are small and they are what makes an expired run still answerable — and
 * the logs and journal go.
 *
 * REFUSES A RUN THAT IS STILL BEING WRITTEN, and takes no ownership token to
 * do it. Retention is a janitor, not a writer, so it cannot hold the fence —
 * but deleting the journal out from under a live coordinator would be the
 * worst outcome available here: that coordinator's own fence still passes (the
 * epoch has not moved), so it would keep appending and leave a journal that
 * restarts mid-history.
 *
 * The guard is a FRESH HEARTBEAT, deliberately not the full
 * `ownershipProvablyLost` test that a successor uses. A successor must not
 * displace a live writer, so it also asks whether the recorded pid is alive; a
 * janitor asking the same question would refuse forever, because a finished
 * coordinator's `owner.json` keeps naming a pid that the OS is free to hand to
 * somebody else. "Somebody stamped this within the grace" is the question that
 * actually means *being written*, and it answers itself correctly for a run
 * that ended a month ago.
 *
 * Returns whether it did anything, so a caller can say why a run is still on
 * disk.
 */
export function expireRun(handle: RunHandle, now: number = Date.now()): boolean {
  if (beingWritten(currentOwner(handle.dir), now)) return false;
  const verdict = readVerdict(handle);
  const expiry: Expiry = {
    version: RUN_RECORD_FORMAT,
    runId: handle.runId,
    expiredAt: now,
    outcome: verdict?.outcome ?? "unknown",
  };
  for (const name of RUN_EVIDENCE) {
    try {
      rmSync(join(handle.dir, name), { recursive: true, force: true });
    } catch {
      // A file we cannot remove is a file that stays: expiry is a courtesy to
      // the disk, never a correctness requirement.
    }
  }
  writeAtomic(
    join(handle.dir, RUN_FILES.expiry),
    `${JSON.stringify(expiry, null, 2)}\n`,
  );
  return true;
}

// ── discovery ───────────────────────────────────────────────────────────────

/** One row of the catalog listing: enough to choose a run without opening it. */
export interface CatalogRow {
  runId: string;
  manifest: RunManifest | null;
  verdict: RunVerdict | null;
  expiry: Expiry | null;
  /**
   * Whether anything is writing this run, from the OWNER RECORD rather than
   * from the manifest.
   *
   * The manifest's `registeredBy` is stamped once, at registration, and no
   * write path ever updates it — so a coordinator that is killed before it
   * finalizes leaves an endpoint there forever, and a listing that trusted it
   * would report that run as "running" for the rest of the catalog's life.
   * That is precisely the "a killed coordinator is indistinguishable from a
   * slow one" failure this package exists to remove, and it was removed for
   * `odu wait --run` (which folds the owner record) while surviving here.
   *
   * `owner.json` is the live copy: `heartbeat` refreshes it and
   * `releaseOwnership` clears the endpoint. So the listing asks it, and gets
   * the same three-state answer the attention query gives.
   */
  liveness: "owned" | "owner_lost" | "no_owner";
  /**
   * Work has restarted since this run published `verdict`.
   *
   * `verdict.json` is a PROJECTION of the journal, and it is refreshed only at
   * `finalize`. A `--linger` run that settles, takes a rerun, and is mid-retry
   * therefore still has last generation's verdict on disk while its journal has
   * already moved on — so a listing that read the verdict alone showed an
   * actively re-running run as "passed". That is the same "a stale field
   * misreports a run" failure this catalog exists to remove, reappearing at one
   * of its own read paths.
   *
   * The journal is the authority, so this asks it: is there a resumption event
   * after the last `finalized` line? See `isResumptionEvent`, the rule the
   * attention fold and the coordinator's writer both use.
   */
  resumed: boolean;
  /** Where a live owner serves, when one does. Null for every other state, so
   *  a reader cannot mistake a stale address for a reachable one. */
  endpoint: string | null;
}

/**
 * Every run in the catalog, newest first.
 *
 * The ordering comes from the run id, which encodes its start instant — so the
 * common listing is a string sort and not a manifest read per directory. The
 * manifests ARE read (a row without one is barely a row), but the order does
 * not depend on them, which is what keeps a corrupted manifest from
 * scrambling the list.
 */
export function listRuns(
  opts: CatalogOptions & { limit?: number; repoRoot?: string; now?: number } = {},
): CatalogRow[] {
  const now = opts.now ?? Date.now();
  const catalog = catalogPath(opts);
  let entries: string[];
  try {
    entries = readdirSync(catalog);
  } catch {
    return [];
  }
  const ids = entries.filter(isRunId).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const rows: CatalogRow[] = [];
  for (const runId of ids) {
    const handle: RunHandle = { runId, dir: runDir(catalog, runId) };
    const manifest = readManifest(handle);
    if (opts.repoRoot !== undefined && manifest?.repoRoot !== opts.repoRoot) {
      continue;
    }
    const owner = currentOwner(handle.dir);
    const alive = owner !== null && !ownershipProvablyLost(owner, now).lost;
    const verdict = readVerdict(handle);
    rows.push({
      runId,
      manifest,
      verdict,
      expiry: readExpiry(handle),
      liveness:
        owner === null ? "no_owner" : alive ? "owned" : "owner_lost",
      // Only asked when there is a verdict that could be stale. A run with no
      // verdict has nothing for a resumption to contradict, and this listing
      // deliberately avoids reading a journal it does not need.
      resumed: verdict !== null && resumedSinceFinal(handle),
      endpoint: alive ? owner.endpoint : null,
    });
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
  }
  return rows;
}

/** Resolve a run-id PREFIX against the catalog. Exactly one match resolves;
 *  several are an ambiguity the caller reports rather than a first-match
 *  guess, because addressing the wrong run is how a retry lands on the wrong
 *  commit. */
export function resolveRunIdPrefix(
  prefix: string,
  opts: CatalogOptions = {},
): { kind: "one"; runId: string } | { kind: "none" } | { kind: "many"; matches: string[] } {
  const catalog = catalogPath(opts);
  let entries: string[];
  try {
    entries = readdirSync(catalog);
  } catch {
    return { kind: "none" };
  }
  const matches = entries.filter((e) => isRunId(e) && e.startsWith(prefix));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1 && matches[0] !== undefined) {
    return { kind: "one", runId: matches[0] };
  }
  return { kind: "many", matches: matches.sort() };
}

/** The run id a `<sha7>#<seq>` ref names, scoped to a checkout when one is
 *  given. Newest wins if a checkout somehow published the ref twice — the
 *  ordinal is reserved exclusively, so that is a torn-catalog case, not a
 *  routine one. */
export function resolveRunRef(
  ref: { sha7: string; seq: number },
  opts: CatalogOptions & { repoRoot?: string } = {},
): string | null {
  for (const row of listRuns(opts)) {
    const m = row.manifest;
    if (m === null) continue;
    if (m.seq !== ref.seq) continue;
    if (!m.sha.toLowerCase().startsWith(ref.sha7.toLowerCase())) continue;
    return row.runId;
  }
  return null;
}

/** The catalog's newest run for a checkout, or the newest overall when no
 *  checkout is named. What `--run latest` resolves to. */
export function latestRun(
  opts: CatalogOptions & { repoRoot?: string } = {},
): string | null {
  const rows = listRuns({ ...opts, limit: 1 });
  return rows[0]?.runId ?? null;
}

/** Run ids whose start instant is older than `before`, for retention. Derived
 *  from the id, so pruning does not have to read a manifest per run. */
export function runsStartedBefore(
  before: number,
  opts: CatalogOptions = {},
): string[] {
  const catalog = catalogPath(opts);
  let entries: string[];
  try {
    entries = readdirSync(catalog);
  } catch {
    return [];
  }
  return entries.filter((entry) => {
    if (!isRunId(entry)) return false;
    const started = runIdStartedAt(entry);
    return started !== null && started < before;
  });
}

/**
 * Has work restarted since the run's last terminal line?
 *
 * The journal is the authority on this; `verdict.json` cannot answer it,
 * because it is written at `finalize` and never invalidated by the resumption
 * that follows. Reads only the event kinds, so it stays cheap enough for a
 * listing: no attempt records, no logs, no excerpts.
 */
export function resumedSinceFinal(handle: RunHandle): boolean {
  let seenFinal = false;
  let resumed = false;
  for (const { event } of readJournal(handle).entries) {
    if (event.kind === "finalized") {
      seenFinal = true;
      resumed = false;
      continue;
    }
    if (seenFinal && isResumptionEvent(event)) resumed = true;
  }
  return resumed;
}
