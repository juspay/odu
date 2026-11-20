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
  attemptLogFile,
  type LogStream,
  catalogRoot,
  RUN_EVIDENCE,
  RUN_FILES,
  runDir,
  type StateEnv,
} from "./paths";
import {
  claimOwnership,
  type ClaimRefusal,
  currentOwner,
  heartbeatFreshWithinGrace,
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

/** A handle on one run's directory. */
export interface RunHandle {
  readonly runId: string;
  readonly dir: string;
}

export interface CatalogOptions {
  /** Override the catalog location. */
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

export type RegisterResult =
  | { ok: true; handle: RunHandle; token: OwnershipToken; manifest: RunManifest }
  | { ok: false; refusal: ClaimRefusal };

/** Publish a run into the catalog and take write-ownership of it. */
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

/** The next sequence number for a run — one past the highest line already on
 *  disk. */
function nextSeq(handle: RunHandle): number {
  return readJournal(handle).highestSeq + 1;
}

/** A run's journal, held open by its owner. */
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

/** Append one event, deriving its ordinal from disk. */
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
    // `O_APPEND` makes a write under PIPE_BUF atomic against other appenders,
    // and a crash mid-write can only truncate the final line.
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
  /** Lines that did not parse — a torn tail, or a record from a newer
   *  writer. */
  unreadable: number;
  /** The highest ordinal ANY line claims, readable or not. */
  highestSeq: number;
}

/** Every journal line for a run, in order. An unparseable line is counted and
 *  skipped, never thrown. */
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
    const claimed = (parsed as { seq?: unknown }).seq;
    if (typeof claimed === "number" && Number.isSafeInteger(claimed)) {
      highestSeq = Math.max(highestSeq, claimed);
    }
    const decoded = decodeEntry(parsed);
    if (Result.isSuccess(decoded)) entries.push(decoded.success);
    else unreadable += 1;
  }
  entries.sort((a, b) => a.seq - b.seq);
  return { entries, unreadable, highestSeq };
}

/** Every attempt ordinal recorded for a node, ascending. */
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
 *  does not decode is skipped. */
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

/** Open (or re-open) an attempt's log for writing, and stamp its sidecar. */
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
  writeAtomic(join(dir, ATTEMPT_FILES.log), "");
  writeAtomic(join(dir, ATTEMPT_FILES.pushLog), "");
  return true;
}

/** REPLACE an attempt's log with `text`. */
export function writeAttemptLog(
  handle: RunHandle,
  node: string,
  attempt: number,
  text: string,
  stream: LogStream = "recipe",
): void {
  try {
    writeAtomic(
      join(
        attemptDir(handle.dir, encodeNodeKey(node), attempt),
        attemptLogFile(stream),
      ),
      text,
    );
  } catch {
  }
}

/** Append raw bytes to an attempt's log. */
export function appendAttemptLog(
  handle: RunHandle,
  node: string,
  attempt: number,
  text: string,
  stream: LogStream = "recipe",
): void {
  const path = join(
    attemptDir(handle.dir, encodeNodeKey(node), attempt),
    attemptLogFile(stream),
  );
  try {
    appendFileSync(path, text);
  } catch {
  }
}

/** Close an attempt: record how it ended, stamp the log's completeness, and
 *  make the evidence read-only. */
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
  }
  writeAtomic(
    join(dir, ATTEMPT_FILES.record),
    `${JSON.stringify({ ...existing, ...outcome, logBytes: bytes }, null, 2)}\n`,
  );
  for (const path of [logPath, join(dir, ATTEMPT_FILES.pushLog)]) {
    try {
      chmodSync(path, 0o444);
    } catch {
    }
  }
  return true;
}

/** Fill an initially unknown placement without reallocating or truncating its log. */
export function locateAttempt(
  handle: RunHandle,
  token: OwnershipToken,
  node: string,
  attempt: number,
  placement: AttemptRecord["placement"],
): boolean {
  if (!stillOwner(token)) return false;
  const path = join(attemptDir(handle.dir, encodeNodeKey(node), attempt), ATTEMPT_FILES.record);
  const existing = readJson(path, decodeAttempt);
  if (existing === null || existing.placement.host !== null || placement.host === null) return false;
  writeAtomic(path, `${JSON.stringify({ ...existing, placement }, null, 2)}\n`);
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
   * Continue from `offset + bytesRead`.
   */
  bytesRead: number;
  /** Total size of the log at read time. */
  size: number;
  /** Did this slice reach the end of the file? Distinct from `logComplete` on
   *  the attempt record. */
  eof: boolean;
}

/**
 * Read a byte range of a file. A negative `offset` counts back from the end.
 * UTF-8 is decoded non-fatally, so {@link LogSlice.bytesRead} rather than the
 * decoded string's length is what was read. `null` when the file is not there.
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

/** One attempt's log, by address. */
export function readAttemptLog(
  handle: RunHandle,
  node: string,
  attempt: number,
  range: { offset?: number; limit?: number } = {},
  stream: LogStream = "recipe",
): LogSlice | null {
  return readFileSlice(
    join(
      attemptDir(handle.dir, encodeNodeKey(node), attempt),
      attemptLogFile(stream),
    ),
    range,
  );
}

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
 * Replace a run's evidence with a tombstone: the manifest and verdict stay,
 * the logs and journal go. Refuses a run that is still being written. Returns
 * whether it did anything.
 */
export function expireRun(handle: RunHandle, now: number = Date.now()): boolean {
  if (heartbeatFreshWithinGrace(currentOwner(handle.dir), now)) return false;
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
    }
  }
  writeAtomic(
    join(handle.dir, RUN_FILES.expiry),
    `${JSON.stringify(expiry, null, 2)}\n`,
  );
  return true;
}

/** One row of the catalog listing: enough to choose a run without opening it. */
export interface CatalogRow {
  runId: string;
  manifest: RunManifest | null;
  verdict: RunVerdict | null;
  expiry: Expiry | null;
  /** Whether anything is writing this run, read from `owner.json`. */
  liveness: "owned" | "owner_lost" | "no_owner";
  /** Work has restarted since this run published `verdict`. */
  resumed: boolean;
  /** Where a live owner serves, when one does. Null for every other state. */
  endpoint: string | null;
}

/**
 * Every run id in the catalog, newest first — and NOTHING ELSE. It reads the
 * directory and no file inside it (juspay/odu#113).
 */
export function listRunIds(
  opts: CatalogOptions & { limit?: number } = {},
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(catalogPath(opts));
  } catch {
    return [];
  }
  const ids = entries.filter(isRunId).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return opts.limit === undefined ? ids : ids.slice(0, opts.limit);
}

/** Every run in the catalog, newest first, ordered by the run id, which
 *  encodes its start instant. */
export function listRuns(
  opts: CatalogOptions & { limit?: number; repoRoot?: string; now?: number } = {},
): CatalogRow[] {
  const now = opts.now ?? Date.now();
  const catalog = catalogPath(opts);
  const rows: CatalogRow[] = [];
  for (const runId of listRunIds({ root: catalog })) {
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
      resumed: verdict !== null && resumedSinceFinal(handle),
      endpoint: alive ? owner.endpoint : null,
    });
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
  }
  return rows;
}

/** Resolve a run-id PREFIX against the catalog. Exactly one match resolves;
 *  several are an ambiguity. */
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
 *  given. Newest wins if a checkout somehow published the ref twice. */
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

/** Run ids whose start instant is older than `before`, for retention. */
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

/** Has work restarted since the run's last terminal line? */
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
