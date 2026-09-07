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
 * **`complete` is not `eof`.** `eof` says this READ reached the end of the file;
 * `complete` says the file got its producer's last word. A log that is short
 * because the lane died mid-sentence is `eof: true, complete: false`, and the
 * difference is "the recipe was quiet" versus "the evidence is gone".
 */

import {
  type CatalogOptions,
  handleFor,
  readAttemptLog,
  readAttemptRecord,
} from "@odu/run-history/store";
import { parseLogKey } from "@odu/service-client/logKey";
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
}

/** How much a single `log.read` may return when the caller names no limit.
 *  Below the surface's own 16 KiB domain-response budget with room for the
 *  envelope, so the common "give me this failure's log" call comes back in one
 *  frame rather than being chunked by the transport. */
export const DEFAULT_LOG_PAGE_BYTES = 12 * 1024;

/** Did this attempt's log get its producer's last word? Read from the attempt
 *  RECORD rather than inferred from the bytes: a log that simply ends looks
 *  identical to one that was cut off, and only the sidecar knows which. */
function completenessOf(
  runId: string,
  node: string,
  attempt: number,
  catalog: CatalogOptions,
): boolean {
  const record = readAttemptRecord(handleFor(runId, catalog), node, attempt);
  // Absent means unknown, and unknown is reported as NOT complete: claiming a
  // log had its last word when there is no sidecar to say so is the one lie
  // this field exists to prevent.
  return record?.logComplete ?? false;
}

export function readLog(
  input: LogReadInput,
  deps: LogDeps = {},
): Effect.Effect<LogPage, ServiceRefused> {
  return Effect.suspend(() => {
    const catalog = deps.catalog ?? {};
    const key = parseLogKey(input.key);
    if (key === null) {
      return Effect.fail(
        new ServiceRefused({
          code: "bad_input",
          message:
            `odu: "${input.key}" is not a log key odu issued — a key is ` +
            "`<runId>/<encoded node>/<attempt>`, and every failure carries one",
        }),
      );
    }
    const slice = readAttemptLog(handleFor(key.runId, catalog), key.node, key.attempt, {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      limit: input.limit ?? DEFAULT_LOG_PAGE_BYTES,
    });
    if (slice === null) {
      return Effect.fail(
        new ServiceRefused({
          code: "unknown_run",
          message:
            `odu: no recorded output for ${key.node} attempt ${key.attempt} on ` +
            `run ${key.runId} — the attempt never ran, or its evidence aged out`,
          runId: key.runId,
        }),
      );
    }
    return Effect.succeed({
      key: input.key,
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
      complete: completenessOf(key.runId, key.node, key.attempt, catalog),
    });
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
  const slice = readAttemptLog(
    handleFor(parsed.runId, catalog),
    parsed.node,
    parsed.attempt,
    // NEGATIVE offset: a tail, because the end of a failing log is where the
    // reason is. The same spelling `odu logs --offset=-4096` already takes.
    { offset: -LOG_TAIL_BYTES },
  );
  if (slice === null) return null;
  return {
    key,
    text: slice.text,
    totalBytes: slice.size,
    complete: completenessOf(parsed.runId, parsed.node, parsed.attempt, catalog),
  };
}
