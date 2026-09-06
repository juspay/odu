/**
 * The reader half of the catalog: resolve what a caller typed into a run, and
 * answer the attention query over real files.
 *
 * `./attention` is the pure fold and `./store` is the I/O; this is the seam
 * that joins them, plus the two decisions that need both — how a cursor is
 * validated against the run it names, and how a bounded wait decides it has
 * something worth returning.
 *
 * THE BOUNDED WAIT is the piece the whole "react before the slow lane
 * finishes" promise rests on, and it is a poll rather than a watch on purpose.
 * `fs.watch` is per-platform in its guarantees, silently degrades over network
 * filesystems, and has no answer at all for the case that matters most here —
 * the writer being a different process that may have died. A poll of a file
 * whose length only grows is a `stat` and a short read; the deadline is real
 * either way, and the failure mode is "answers 150ms late", not "never wakes".
 */

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
  isRunId,
  parseCursor,
  parseRunSelector,
} from "./ids";
import { currentOwner, ownershipProvablyLost } from "./owner";
import { RUN_FILES } from "./paths";
import {
  type CatalogOptions,
  catalogPath,
  handleFor,
  latestRun,
  readAttemptLog,
  readExpiry,
  readJournal,
  readManifest,
  readVerdict,
  resolveRunIdPrefix,
  resolveRunRef,
  type RunHandle,
} from "./store";

/** The default bounded observation deadline. Thirty seconds is long enough for
 *  a fast unit lane to fail and finalize its log, and short enough that an
 *  agent asking "anything yet?" gets an answer inside one thought. It is a
 *  DEADLINE, not a timeout in the failure sense: reaching it means
 *  `still_running`, which is a fact, not an error. */
export const DEFAULT_ATTENTION_DEADLINE_MS = 30_000;

// ── resolving what the caller typed ─────────────────────────────────────────

export type RunResolution =
  | { ok: true; handle: RunHandle }
  | { ok: false; message: string };

/**
 * Resolve a `--run` token to a catalog entry.
 *
 * Ambiguity is a REFUSAL, never a first match. The three things a caller does
 * with a resolved run — read a log, wait on it, retry it — all act on a
 * specific commit's evidence, and picking the wrong one is silent until it has
 * already misled somebody.
 */
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
  // An exact id short-circuits the prefix scan: the common case is an agent
  // echoing back an id it was given, and that must not depend on a readdir.
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
 * A cursor that names another run is REFUSED with a resync route rather than
 * silently restarted, and the difference matters at exactly the moment it is
 * hardest to notice: a finalized retry mints a NEW run, so an agent that kept
 * its cursor is holding a token for the parent. Resuming it against the child
 * would report "nothing new" about a run that has done everything.
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
      resync: `odu wait --run ${handle.runId}`,
    };
  }
  if (cursor.runId !== handle.runId) {
    return {
      ok: false,
      message: `odu: that cursor belongs to run ${cursor.runId}, not ${handle.runId}`,
      resync: `odu wait --run ${handle.runId}`,
    };
  }
  const journal = readJournal(handle);
  const highest = journal.entries.at(-1)?.seq ?? 0;
  if (cursor.seq > highest) {
    return {
      ok: false,
      message: `odu: that cursor is ahead of run ${handle.runId}'s journal (${cursor.seq} > ${highest}) — the run's evidence was pruned or rewritten`,
      resync: `odu wait --run ${handle.runId}`,
    };
  }
  return { ok: true, cursor };
}

// ── the attention read ──────────────────────────────────────────────────────

/** Is this run's owner alive, as far as the fence can prove? `null` when there
 *  is no owner record at all (an imported run, say) — a question that was
 *  never asked reads better than a `false` that implies a death. */
export function ownerAliveFor(handle: RunHandle, now = Date.now()): boolean | null {
  const owner = currentOwner(handle.dir);
  if (owner === null) return null;
  return !ownershipProvablyLost(owner, now).lost;
}

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
        // A tail: the reason a recipe failed is at the end of its output.
        // `maxBytes * 4` because a byte-clamped tail of a multibyte log needs
        // slack to land on a character boundary without losing content the
        // budget would have allowed.
        const slice = readAttemptLog(handle, node, attempt, {
          offset: -Math.max(maxBytes * 4, EXCERPT_BUDGET_BYTES),
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
   *  actionable red. The `--settle` half of the existing `odu wait` contract,
   *  kept as a flag on one function so the two waits cannot drift. */
  settle?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Wait for something worth reporting, or for the deadline.
 *
 * "Worth reporting" is deliberately narrow: a settled run, an actionable red
 * (a failure whose log has had its last word), an owner that is provably gone,
 * or — for a caller that supplied a cursor — any new event at all. That last
 * one is what makes a reconnecting agent's `--after` return promptly with the
 * backlog rather than blocking for thirty seconds on a run that has been
 * quietly progressing.
 */
export async function waitForAttention(
  handle: RunHandle,
  opts: WaitOptions = {},
): Promise<Attention> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_ATTENTION_DEADLINE_MS);
  const pollMs = Math.max(10, opts.pollMs ?? 150);
  const eventsPath = join(handle.dir, RUN_FILES.events);
  let lastSize = -1;
  for (;;) {
    // Only re-read the journal when the file has actually grown (or on the
    // first pass, or when the run has no journal yet). A poll that decodes a
    // whole journal every 150ms would be the same busy loop it replaced,
    // wearing a deadline.
    let size = -1;
    try {
      size = statSync(eventsPath).size;
    } catch {
      size = -1;
    }
    if (size !== lastSize || lastSize === -1) {
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

/**
 * Is this worth returning, or should the wait keep looking?
 *
 * THE CURSOR CHANGES THE QUESTION, and that is the whole of this function.
 *
 * A caller with NO cursor is asking "tell me when something is wrong", so a
 * failure that is already on the record answers it immediately — that is the
 * fast red the whole command exists for.
 *
 * A caller WITH a cursor has already been shown that failure. Waking it again
 * on the same red returns in about a millisecond with zero events and the
 * cursor it came in with, which is not a wait at all: it is the polling loop
 * this release set out to remove, wearing a blocking call's clothes. So a
 * resumed wait wakes for what it has NOT seen — new events, settlement, an
 * owner that went away — and otherwise holds until its deadline.
 *
 * The failure stays in every answer either way. Suppressing a repeat delivery
 * is not resolving anything, and `unresolved_failures` is recomputed in full
 * on every read precisely so the two cannot be confused.
 */
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

/** The catalog directory these options resolve to — exported so a face can say
 *  WHERE it looked when it found nothing. */
export function describeCatalog(opts: CatalogOptions = {}): string {
  return catalogPath(opts);
}
