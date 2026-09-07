/**
 * `log.read` and the `logTails` collection — one attempt's output, two shapes.
 *
 * They answer different questions and that is why there are two:
 *
 *   - **`log.read` is EVIDENCE.** A byte offset, a limit, a next offset and an
 *     EOF flag: a caller paging through a failure's output, or asking for the
 *     last 4 KiB of it. It is addressed and bounded, and a caller can walk the
 *     whole file with it.
 *   - **`logTails` is a VIEW.** The end of the log, re-read as it grows, for a
 *     browser watching a node work. It is a collection so a page subscribes to
 *     one key and gets frames.
 *
 * Collapsing them would mean either a paged read that a browser has to poll
 * itself, or a live tail an agent has to reassemble a file from. Both exist
 * because both callers exist.
 *
 * **The evidence outlives the coordinator, the checkout and the retry.** Every
 * read here goes through the catalog's per-attempt store — `attempts/<node>/<N>/log`
 * — so deleting the worktree does not delete the log you are reading, and a
 * retry writes attempt N+1 rather than over N. That is PR 1's guarantee; this
 * module only addresses it.
 *
 * **THREE facts about the bytes, not two.** `eof` says this READ reached the end
 * of the file; `complete` says the file got its producer's last word; `open`
 * says whether it can still grow. A log that is short because the lane died
 * mid-sentence is `eof: true, complete: false, open: false` — and it is the
 * third field that makes a follow terminate, because `eof` and `complete`
 * together describe that log identically to one whose writer is merely slow.
 *
 * **The follow is `waitMs`, not a sixth verb.** A caller that has read to the
 * end and wants the next bytes re-issues the same paged read with a deadline;
 * the cursor is `nextOffset`, which the CALLER holds, so a call that dies is
 * re-issued rather than resumed from state a server was keeping for it. The
 * surface states why that shape and not a stream; this module only honours it.
 */

import {
  type CatalogOptions,
  handleFor,
  readAttemptLog,
  readAttemptRecord,
  readExpiry,
  readVerdict,
  type LogSlice,
  type RunHandle,
} from "@odu/run-history/store";
import { type LogGrowth, waitForLogGrowth } from "@odu/run-history/query";
import { type LogKey, parseLogKey } from "@odu/service-client/logKey";
import {
  LOG_TAIL_BYTES,
  type LogPage,
  type LogReadInput,
  type LogTail,
  ServiceRefused,
} from "@odu/service-client/surface";
import { Effect } from "effect";

export interface LogDeps {
  catalog?: CatalogOptions;
  /** A caller's own cancellation — an HTTP disconnect, an MCP cancellation, a
   *  CLI Ctrl-C. It ends the OBSERVATION and nothing else: the run keeps going,
   *  because watching a log and producing it are different acts and only one of
   *  them was cancelled. */
  signal?: AbortSignal;
  /** How often the follow looks, and what it calls the clock. Injected only so
   *  a test can state the wait's behaviour in tens of milliseconds instead of
   *  seconds; every real face leaves both alone. */
  pollMs?: number;
  now?: () => number;
}

/** How much a single `log.read` may return when the caller names no limit.
 *  Below the surface's own 16 KiB domain-response budget with room for the
 *  envelope, so the common "give me this failure's log" call comes back in one
 *  frame rather than being chunked by the transport. */
export const DEFAULT_LOG_PAGE_BYTES = 12 * 1024;

/** One page, built from a slice the caller already read.
 *
 *  ONE construction path, used by both the immediate answer and the answer
 *  after a wait. Two would be two places for `open` to be computed, and a
 *  follow whose last page disagreed with its first about whether the log can
 *  still grow is precisely the bug that makes a follower spin. */
function pageOf(handle: RunHandle, key: LogKey, keyText: string, slice: LogSlice): LogPage {
  // Completeness comes from the attempt RECORD rather than from the bytes: a
  // log that simply ends looks identical to one that was cut off, and only the
  // sidecar knows which. Absent means unknown, and unknown is reported as NOT
  // complete — claiming a log had its last word when there is no sidecar to say
  // so is the one lie this field exists to prevent.
  const complete = readAttemptRecord(handle, key.node, key.attempt)?.logComplete ?? false;
  return {
    key: keyText,
    text: slice.text,
    offset: slice.offset,
    size: slice.size,
    // `bytesRead`, never the decoded string's own byte length: the decode is
    // non-fatal, so a slice that cut a multibyte character in half yields
    // U+FFFD where one or two real bytes were — and a caller resuming from a
    // measured text length would skip log content.
    nextOffset: slice.offset + slice.bytesRead,
    // The store's own answer about THIS read, rather than a comparison
    // recomputed here from two numbers it already compared.
    eof: slice.eof,
    complete,
    // Can this log still GROW? Not while the producer has said its last word,
    // and not once the run itself reached a terminal record — a verdict or an
    // expiry both mean there is nobody left to append. The run's records are
    // the arm that answers for the killed writer, whose attempt will never be
    // sealed and so is never `complete`.
    open: !complete && readVerdict(handle) === null && readExpiry(handle) === null,
  };
}

/** No evidence at this address — told as a refusal, because a caller that asked
 *  for a specific attempt's output and got an empty success would read it as
 *  "the recipe was quiet". */
function noEvidence(key: LogKey): ServiceRefused {
  return new ServiceRefused({
    code: "unknown_run",
    message:
      `odu: no recorded output for ${key.node} attempt ${key.attempt} on ` +
      `run ${key.runId} — the attempt never ran, or its evidence aged out`,
    runId: key.runId,
  });
}

export function readLog(
  input: LogReadInput,
  deps: LogDeps = {},
): Effect.Effect<LogPage, ServiceRefused> {
  return Effect.suspend(() => {
    const catalog = deps.catalog ?? {};
    const key = parseLogKey(input.key);
    if (key === null) {
      // A malformed key is refused BEFORE any deadline is honoured. A follow
      // that held a bad address open for its full `waitMs` would turn a typo
      // into a minute of silence and then the same refusal.
      return Effect.fail(
        new ServiceRefused({
          code: "bad_input",
          message:
            `odu: "${input.key}" is not a log key odu issued — a key is ` +
            "`<runId>/<encoded node>/<attempt>`, and every failure carries one",
        }),
      );
    }
    const handle = handleFor(key.runId, catalog);
    const limit = input.limit ?? DEFAULT_LOG_PAGE_BYTES;
    const slice = readAttemptLog(handle, key.node, key.attempt, {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      limit,
    });
    if (slice === null) return Effect.fail(noEvidence(key));
    const page = pageOf(handle, key, input.key, slice);
    // THE WAIT FIRES ONLY FOR A CAUGHT-UP FOLLOWER. `bytesRead === 0` is
    // load-bearing: a caller that is BEHIND has bytes in hand and must get them
    // now — delaying a page that is already full would turn a follow of a
    // finished log into one deadline per page. And a log that cannot grow has
    // nothing to wait for, so `open` is what stops the follow of a dead
    // writer's log from blocking on every call forever.
    if (input.waitMs === undefined || slice.bytesRead !== 0 || !page.open) {
      return Effect.succeed(page);
    }
    return Effect.flatMap(
      // `Effect.callback`, not `Effect.promise`: a promise is UNINTERRUPTIBLE,
      // so a caller that walked away — an HTTP client that disconnected, an MCP
      // request that was cancelled, a browser tab that closed — left this poll
      // running to its full deadline with nobody to answer. Interruption is the
      // signal here, and the finalizer turns it into the abort the poll already
      // knows how to take, leaving no timer behind. The RUN is untouched either
      // way: ending an observation and stopping CI are different acts.
      Effect.callback<LogGrowth>((resume) => {
        const controller = new AbortController();
        const stop = (): void => controller.abort();
        const outer = deps.signal;
        if (outer !== undefined) {
          if (outer.aborted) stop();
          else outer.addEventListener("abort", stop, { once: true });
        }
        void waitForLogGrowth(handle, key.node, key.attempt, {
          // The end of the page just built, never the caller's own `offset`,
          // which may have been a negative tail.
          from: page.nextOffset,
          deadlineMs: input.waitMs,
          ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
          signal: controller.signal,
        }).then(
          (growth) => resume(Effect.succeed(growth)),
          (err: unknown) => resume(Effect.die(err)),
        );
        return Effect.sync(() => {
          controller.abort();
          outer?.removeEventListener("abort", stop);
        });
      }),
      // The outcome named WHY the wait ended; the answer is a fresh read in
      // every case, because "what do the file and the records say now" is the
      // answer to all five and re-deriving it keeps ONE page-construction path.
      // A shrink included: re-reading at a cursor the file no longer reaches
      // comes back clamped, which is how the caller learns its offsets moved.
      () => {
        const grown = readAttemptLog(handle, key.node, key.attempt, {
          offset: page.nextOffset,
          limit,
        });
        return grown === null
          ? Effect.fail(noEvidence(key))
          : Effect.succeed(pageOf(handle, key, input.key, grown));
      },
    );
  });
}

/**
 * The tail of one attempt's log, for the live view.
 *
 * `null` for a key that addresses nothing — which the collection turns into an
 * absent item rather than an error, because a browser subscribing to a node
 * that has not started yet is asking a reasonable question and the answer is
 * "not yet".
 */
export function readTail(
  key: string,
  catalog: CatalogOptions = {},
): LogTail | null {
  const parsed = parseLogKey(key);
  if (parsed === null) return null;
  const handle = handleFor(parsed.runId, catalog);
  const slice = readAttemptLog(
    handle,
    parsed.node,
    parsed.attempt,
    // NEGATIVE offset: a tail, because the end of a failing log is where the
    // reason is. The same spelling `odu logs --offset=-4096` already takes.
    { offset: -LOG_TAIL_BYTES },
  );
  if (slice === null) return null;
  // The same three facts the page carries, minus the addressing a tail has no
  // cursor for — so a view that stops re-subscribing when a log closes reaches
  // that decision by the same rule a follower does.
  const page = pageOf(handle, parsed, key, slice);
  return {
    key,
    text: slice.text,
    totalBytes: slice.size,
    complete: page.complete,
    open: page.open,
  };
}
