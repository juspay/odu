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
import { interruptiblePoll } from "./sleep";

export interface LogDeps {
  catalog?: CatalogOptions;
  signal?: AbortSignal;
  pollMs?: number;
  now?: () => number;
}

export const DEFAULT_LOG_PAGE_BYTES = 12 * 1024;

type LogCompleteness = "complete" | "cut" | "unknown";

function completenessOf(handle: RunHandle, key: LogKey): LogCompleteness {
  const record = readAttemptRecord(handle, key.node, key.attempt);
  if (record === null) return "unknown";
  return record.logComplete ? "complete" : "cut";
}

function logCanStillGrow(
  handle: RunHandle,
  completeness: LogCompleteness,
  now: number,
): boolean {
  return (
    completeness !== "complete" &&
    readVerdict(handle) === null &&
    readExpiry(handle) === null &&
    ownerAliveFor(handle, now) !== false
  );
}

function pageOf(
  handle: RunHandle,
  key: LogKey,
  keyText: string,
  slice: LogSlice,
  now: number,
): LogPage {
  const completeness = completenessOf(handle, key);
  return {
    key: keyText,
    text: slice.text,
    offset: slice.offset,
    size: slice.size,
    nextOffset: slice.offset + slice.bytesRead,
    eof: slice.eof,
    complete: completeness === "complete",
    open: logCanStillGrow(handle, completeness, now),
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
    if (input.waitMs === undefined || slice.bytesRead !== 0 || !page.open) {
      return Effect.succeed(page);
    }
    return Effect.flatMap(
      interruptiblePoll<LogGrowth>(
        (signal) =>
          waitForLogGrowth(handle, key.node, key.attempt, {
            from: page.nextOffset,
            deadlineMs: input.waitMs,
            ...(stream === undefined ? {} : { stream }),
            ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
            ...(deps.now === undefined ? {} : { now: deps.now }),
            signal,
          }),
        deps.signal,
      ),
      () => {
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

export function readRecipeTail(
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
