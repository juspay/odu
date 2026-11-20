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
import {
  type LogGrowth,
  ownerAliveFor,
  waitForLogGrowth,
} from "@odu/run-history/query";
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
  signal?: AbortSignal;
  pollMs?: number;
  now?: () => number;
}

export const DEFAULT_LOG_PAGE_BYTES = 12 * 1024;

/** One page, built from a slice the caller already read.
 *
 *  ONE construction path, used by both the immediate answer and the answer
 *  after a wait. Two would be two places for `open` to be computed, and a
 *  follow whose last page disagreed with its first about whether the log can
 *  still grow is precisely the bug that makes a follower spin. */
function pageOf(
  handle: RunHandle,
  key: LogKey,
  keyText: string,
  slice: LogSlice,
  now: number,
): LogPage {
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
    eof: slice.eof,
    complete,
    // Can this log still GROW? Not while the producer has said its last word,
    // not once the run reached a terminal record — a verdict or an expiry both
    // mean there is nobody left to append — and not once its owner is PROVABLY
    // GONE.
    //
    // `null` — no owner record at all — is NOT "gone": an imported run has
    // never had one, and reading its absence as death would close a log nobody
    // has finished writing.
    open:
      !complete &&
      readVerdict(handle) === null &&
      readExpiry(handle) === null &&
      ownerAliveFor(handle, now) !== false,
  };
}

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
    const clock = deps.now ?? Date.now;
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
    const stream = input.stream;
    const slice = readAttemptLog(
      handle,
      key.node,
      key.attempt,
      {
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        limit,
      },
      stream,
    );
    if (slice === null) return Effect.fail(noEvidence(key));
    const page = pageOf(handle, key, input.key, slice, clock());
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
          // THE WAIT WATCHES THE FILE THIS READ IS OF. A follow of the push
          // stream that polled the recipe's log would wake on the recipe's
          // bytes and answer an empty page, and sleep through the push's own.
          ...(stream === undefined ? {} : { stream }),
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
      () => {
        // The outcome named WHY the wait ended; the answer is a fresh read in
        // every case, because "what do the file and the records say now" is the
        // answer to all five and re-deriving it keeps ONE page-construction path.
        // A shrink included: re-reading at a cursor the file no longer reaches
        // comes back clamped, which is how the caller learns its offsets moved.
        const grown = readAttemptLog(
          handle,
          key.node,
          key.attempt,
          { offset: page.nextOffset, limit },
          stream,
        );
        return grown === null
          ? Effect.fail(noEvidence(key))
          : Effect.succeed(pageOf(handle, key, input.key, grown, clock()));
      },
    );
  });
}

/**
 * **THE TAIL IS THE RECIPE'S, and stays so.** There is no `stream` here and
 * there should not be: the live view's tail is the work a node is DOING, and a
 * collection keyed by log key alone is what lets a page subscribe to a node
 * without first knowing which of its streams has bytes.
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
    { offset: -LOG_TAIL_BYTES },
  );
  if (slice === null) return null;
  const page = pageOf(handle, parsed, key, slice, Date.now());
  return {
    key,
    text: slice.text,
    totalBytes: slice.size,
    complete: page.complete,
    open: page.open,
  };
}
