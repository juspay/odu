import { statSync } from "node:fs";
import { join } from "node:path";
import {
  type Attention,
  type AttentionQuery,
  attentionFor,
  EXCERPT_BUDGET_BYTES,
} from "./attention";
import {
  type Cursor,
  encodeNodeKey,
  isRunId,
  parseCursor,
  parseRunSelector,
} from "./ids";
import { currentOwner, ownerProvablyAlive } from "./owner";
import { attemptDir, attemptLogFile, type LogStream, RUN_FILES } from "./paths";
import {
  type CatalogOptions,
  catalogPath,
  handleFor,
  latestRun,
  readAttemptLog,
  readAttemptRecord,
  readExpiry,
  readJournal,
  readManifest,
  readVerdict,
  resolveRunIdPrefix,
  resolveRunRef,
  type RunHandle,
} from "./store";

/** The default bounded observation deadline. Reaching it means `still_running`. */
export const DEFAULT_ATTENTION_DEADLINE_MS = 30_000;

const UTF8_TAIL_SLACK = 4;

export type RunResolution =
  | { ok: true; handle: RunHandle }
  | { ok: false; message: string };

/** Resolve a `--run` token to a catalog entry. Ambiguity is a REFUSAL, never a
 *  first match. */
export function resolveRun(
  token: string,
  opts: CatalogOptions & { repoRoot?: string } = {},
): RunResolution {
  const selector = parseRunSelector(token);
  if (selector === null) {
    return {
      ok: false,
      message: `odu: "${token}" is not a run — use a run id, \`<sha7>#<seq>\`, or \`latest\``,
    };
  }
  if (selector.kind === "latest") {
    const runId = latestRun(opts);
    if (runId === null) {
      return {
        ok: false,
        message: opts.repoRoot === undefined
          ? "odu: no runs in the catalog yet"
          : `odu: no runs in the catalog for ${opts.repoRoot}`,
      };
    }
    return { ok: true, handle: handleFor(runId, opts) };
  }
  if (selector.kind === "ref") {
    const runId = resolveRunRef(selector, opts);
    if (runId === null) {
      return {
        ok: false,
        message: `odu: no run ${selector.sha7}#${selector.seq} in the catalog (it may have been pruned — see \`odu runs\`)`,
      };
    }
    return { ok: true, handle: handleFor(runId, opts) };
  }
  if (isRunId(selector.value)) {
    const handle = handleFor(selector.value, opts);
    if (readManifest(handle) !== null || readExpiry(handle) !== null) {
      return { ok: true, handle };
    }
  }
  const found = resolveRunIdPrefix(selector.value, opts);
  if (found.kind === "one") return { ok: true, handle: handleFor(found.runId, opts) };
  if (found.kind === "many") {
    return {
      ok: false,
      message: `odu: "${selector.value}" matches ${found.matches.length} runs (${found.matches.slice(0, 4).join(", ")}…) — give more of the id`,
    };
  }
  return {
    ok: false,
    message: `odu: no run "${selector.value}" in the catalog (see \`odu runs\`)`,
  };
}

export type CursorResolution =
  | { ok: true; cursor: Cursor | null }
  | { ok: false; message: string; resync: string };

/**
 * Validate a caller's `--after` cursor against the run it is being used on.
 *
 * A cursor that names another run is REFUSED with a resync route.
 */
export function resolveCursor(
  handle: RunHandle,
  token: string | undefined,
): CursorResolution {
  if (token === undefined || token.trim() === "") {
    return { ok: true, cursor: null };
  }
  const cursor = parseCursor(token.trim());
  if (cursor === null) {
    return {
      ok: false,
      message: `odu: "${token}" is not a cursor odu issued`,
      resync: `odu ci wait --run ${handle.runId}`,
    };
  }
  if (cursor.runId !== handle.runId) {
    return {
      ok: false,
      message: `odu: that cursor belongs to run ${cursor.runId}, not ${handle.runId}`,
      resync: `odu ci wait --run ${handle.runId}`,
    };
  }
  const journal = readJournal(handle);
  const highest = journal.entries.at(-1)?.seq ?? 0;
  if (cursor.seq > highest) {
    return {
      ok: false,
      message: `odu: that cursor is ahead of run ${handle.runId}'s journal (${cursor.seq} > ${highest}) — the run's evidence was pruned or rewritten`,
      resync: `odu ci wait --run ${handle.runId}`,
    };
  }
  return { ok: true, cursor };
}

/** The owner's liveness, as {@link ownerProvablyAlive} defines it. */
export const ownerAliveFor = (handle: RunHandle, now: number): boolean | null =>
  ownerProvablyAlive(handle.dir, now);

/** One attention answer over the run's real files. */
export function readAttention(
  handle: RunHandle,
  query: AttentionQuery = {},
  now: number = Date.now(),
): Attention {
  const journal = readJournal(handle);
  const owner = currentOwner(handle.dir);
  return attentionFor(
    {
      runId: handle.runId,
      manifest: readManifest(handle),
      journal: journal.entries,
      unreadableEvents: journal.unreadable,
      verdict: readVerdict(handle),
      expiry: readExpiry(handle),
      ownerAlive: ownerAliveFor(handle, now),
      endpoint: owner?.endpoint ?? null,
      readExcerpt: (node, attempt, maxBytes) => {
        const slice = readAttemptLog(handle, node, attempt, {
          offset: -Math.max(maxBytes * UTF8_TAIL_SLACK, EXCERPT_BUDGET_BYTES),
        });
        return slice === null
          ? null
          : { text: slice.text, totalBytes: slice.size };
      },
    },
    query,
  );
}

export interface WaitOptions extends AttentionQuery {
  /** Bounded observation deadline. Reaching it is `still_running`. */
  deadlineMs?: number;
  /** How often to look. */
  pollMs?: number;
  /** Return only when the run has fully settled, rather than on the first
   *  actionable red. */
  settle?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Wait for something worth reporting, or for the deadline.
 *
 * "Worth reporting": a settled run, an actionable red (a failure whose log has
 * had its last word), an owner that is provably gone, or — for a caller that
 * supplied a cursor — any new event at all.
 */
export async function waitForAttention(
  handle: RunHandle,
  opts: WaitOptions = {},
): Promise<Attention> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_ATTENTION_DEADLINE_MS);
  const pollMs = Math.max(10, opts.pollMs ?? 150);
  const eventsPath = join(handle.dir, RUN_FILES.events);
  let lastSize: number | null = null;
  let looked = false;
  for (;;) {
    const size = fileSize(eventsPath);
    if (!looked || size !== lastSize) {
      looked = true;
      lastSize = size;
      const attention = readAttention(handle, opts, now());
      if (isAnswer(attention, opts)) return attention;
    }
    if (opts.signal?.aborted === true || now() >= deadline) {
      return readAttention(handle, opts, now());
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())), opts.signal);
  }
}

function isAnswer(attention: Attention, opts: WaitOptions): boolean {
  if (attention.state === "expired" || attention.state === "unknown_run") {
    return true;
  }
  if (attention.state === "owner_lost") return true;
  if (attention.settled) return true;
  if (opts.settle === true) return false;
  if (opts.after != null) return attention.events.length > 0;
  return attention.actionable;
}

/**
 * Why a log wait ended: `grew` means read again from where you stopped,
 * `shrank` means the cursor you are holding no longer addresses what it did,
 * `complete` and `run_terminal` mean stop following, `deadline` means ask
 * again.
 */
export type LogGrowth = "grew" | "shrank" | "complete" | "run_terminal" | "deadline";

export interface LogGrowthOptions {
  /** The byte offset the caller has already read up to. */
  from: number;
  /** Bounded observation deadline. Reaching it is `deadline`, which is a fact. */
  deadlineMs?: number;
  /** How often to look. */
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** Which of the attempt's two logs to watch. The recipe's, unless a
   *  follower said otherwise. */
  stream?: LogStream;
}

/**
 * Wait for one attempt's log to grow past `from`, or for it to become certain
 * that it never will.
 */
export async function waitForLogGrowth(
  handle: RunHandle,
  node: string,
  attempt: number,
  opts: LogGrowthOptions,
): Promise<LogGrowth> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_ATTENTION_DEADLINE_MS);
  const pollMs = Math.max(10, opts.pollMs ?? 150);
  const logPath = join(
    attemptDir(handle.dir, encodeNodeKey(node), attempt),
    attemptLogFile(opts.stream),
  );
  for (;;) {
    const size = fileSize(logPath);
    if (size !== null && size > opts.from) return "grew";
    if (size !== null && size < opts.from) return "shrank";
    if (readAttemptRecord(handle, node, attempt)?.logComplete === true) {
      return "complete";
    }
    if (runTerminal(handle, now())) return "run_terminal";
    if (opts.signal?.aborted === true || now() >= deadline) return "deadline";
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())), opts.signal);
  }
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function runTerminal(handle: RunHandle, now: number): boolean {
  return (
    readVerdict(handle) !== null ||
    readExpiry(handle) !== null ||
    ownerAliveFor(handle, now) === false
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted === true) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** The catalog directory these options resolve to. */
export function describeCatalog(opts: CatalogOptions = {}): string {
  return catalogPath(opts);
}
