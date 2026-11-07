/**
 * THE LAST CATCH — what the daemon does with a rejection nobody awaited and an
 * exception nobody caught.
 *
 * It KEEPS SERVING, and that is the whole decision. Issue #160 is the reason:
 * an `S3Failure` thrown out of a `ReadableStream.pull` during a cache readback
 * became an unhandled rejection, and the default reaction — Node's and Bun's —
 * ended the process with exit 1. One refused upload took the whole service,
 * every other bucket, every running lane's status posting and the scrape with
 * it. A failed transfer is a failed transfer; it is not a reason to stop being
 * a daemon. So these handlers log, count, and return, and nothing here calls
 * `process.exit`.
 *
 * Silence would be the other way to get this wrong, so the log line is loud and
 * complete: level ERROR, one sentence (`odu: unhandled`), and the CAUSE CHAIN
 * WALKED — `error.cause`, and its cause, and so on. The crash in #160 was
 * diagnosed from a chain exactly like that, and a handler that printed only the
 * outermost message would have said "fetch failed" and nothing more.
 *
 * The counts are the operator's half: `odu_unhandled_total` on `/metrics` says
 * a daemon has been swallowing faults even when nobody is reading stderr, which
 * is what "it keeps serving" has to come with. The handlers are installed by the
 * web service's tenure and REMOVED with it (`remove()`), so a test process and a
 * CLI command that merely links this module never acquire them.
 */

import type { Logger } from "@kolu/surface-daemon";

/** Which of the two process-level faults a count or a line belongs to. */
export type UnhandledKind = "rejection" | "exception";

/** How far `cause` is followed. Deep enough for the wrapper chains real clients
 *  build (SDK → fetch → socket), short enough that a pathological chain cannot
 *  turn one log line into a flood. */
const MAX_CAUSE_DEPTH = 8;

/** One link of a walked cause chain, as it appears in the log object. */
export interface CauseLink {
  readonly name: string;
  readonly message: string;
}

/** The two counters, as the guard has them right now. A snapshot: the caller
 *  gets numbers, never the live object. */
export interface UnhandledCounts {
  readonly rejection: number;
  readonly exception: number;
}

export interface UnhandledGuard {
  /** What has been caught so far, for the scrape's contributor. */
  counts(): UnhandledCounts;
  /** Uninstall both listeners. Idempotent, and it removes only the functions
   *  this guard installed — a second guard, or an unrelated listener someone
   *  else registered, is untouched. */
  remove(): void;
}

export interface UnhandledGuardOptions {
  readonly log: Logger;
}

/** A thrown value's name, for a value that may not be an `Error` at all: a
 *  rejected string, a rejected plain object, `undefined`. */
function nameOf(value: unknown): string {
  if (value instanceof Error) return value.name;
  if (value === null) return "null";
  return typeof value;
}

/** A thrown value's message, never throwing itself. `String(value)` on an
 *  object with a hostile `toString` would, so that case falls back. */
function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return "[unprintable]";
  }
}

/** The `cause` chain, outermost link first, INCLUDING the value itself — so a
 *  reader sees the whole sequence in one field and does not have to join
 *  `message` to it. Cycle-safe (a caught error re-thrown as its own cause is a
 *  real pattern) and depth-capped. */
export function causeChain(value: unknown): CauseLink[] {
  const links: CauseLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current !== undefined && current !== null && links.length < MAX_CAUSE_DEPTH) {
    if (typeof current === "object" || typeof current === "function") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    links.push({ name: nameOf(current), message: messageOf(current) });
    current = current instanceof Error ? current.cause : undefined;
  }
  return links;
}

/**
 * INSTALL BOTH HANDLERS on this process and answer the two things the tenure
 * needs: the counts for its scrape and the way to take them off again.
 *
 * Note what is NOT here: no exit, no re-throw, no rate limit that could hide the
 * second fault, and no decision about which errors "deserve" survival. The
 * daemon's job is to stay up; triage is the operator's, from these lines.
 */
export function installUnhandledGuard(options: UnhandledGuardOptions): UnhandledGuard {
  const { log } = options;
  const tally: Record<UnhandledKind, number> = { rejection: 0, exception: 0 };

  const record = (kind: UnhandledKind, value: unknown): void => {
    tally[kind] += 1;
    // The handler itself must not be the next unhandled fault, so every field
    // is derived by a function that cannot throw on a hostile value.
    log.error(
      {
        kind,
        name: nameOf(value),
        message: messageOf(value),
        stack: value instanceof Error ? value.stack : undefined,
        causes: causeChain(value),
        total: tally[kind],
      },
      "odu: unhandled",
    );
  };

  const onRejection = (reason: unknown): void => record("rejection", reason);
  const onException = (error: unknown): void => record("exception", error);

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  let installed = true;
  return {
    counts: () => ({ rejection: tally.rejection, exception: tally.exception }),
    remove: () => {
      if (!installed) return;
      installed = false;
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
  };
}

/** The exposition name, spelled ONCE — the docs quote it, the e2e scrape asserts
 *  it, and the contributor below emits it. */
export const UNHANDLED_METRIC = "odu_unhandled_total";

/**
 * THE GUARD AS A SCRAPE CONTRIBUTOR'S READING. Both labelled points are always
 * present, zeros included: a series that springs into existence at the first
 * crash is a series no alert can be written against beforehand.
 */
export function unhandledReading(guard: UnhandledGuard): {
  counters: [{ name: string; help: string; points: { labels: { kind: UnhandledKind }; value: number }[] }];
} {
  const counts = guard.counts();
  return {
    counters: [
      {
        name: UNHANDLED_METRIC,
        help: "Unhandled rejections and uncaught exceptions the daemon caught and kept serving through.",
        points: [
          { labels: { kind: "rejection" }, value: counts.rejection },
          { labels: { kind: "exception" }, value: counts.exception },
        ],
      },
    ],
  };
}
