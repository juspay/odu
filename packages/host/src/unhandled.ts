/**
 * So these handlers log, count, and return, and nothing here calls
 * `process.exit`.
 *
 * The handlers are installed by the
 * web service's tenure and REMOVED with it (`remove()`), so a test process and a
 * CLI command that merely links this module never acquire them.
 */

import type { MetricsReading } from "@odu/cordis/metrics";
import type { Logger } from "@kolu/surface-daemon";

export type UnhandledKind = "rejection" | "exception";

const MAX_CAUSE_DEPTH = 8;

export interface CauseLink {
  readonly name: string;
  readonly message: string;
}

export interface UnhandledCounts {
  readonly rejection: number;
  readonly exception: number;
}

export interface UnhandledGuard {
  counts(): UnhandledCounts;
  remove(): void;
}

export interface UnhandledGuardOptions {
  readonly log: Logger;
}

function nameOf(value: unknown): string {
  if (value instanceof Error) return value.name;
  if (value === null) return "null";
  return typeof value;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return "[unprintable]";
  }
}

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
 * Note what is NOT here: no exit, no re-throw, no rate limit that could hide the
 * second fault, and no decision about which errors "deserve" survival.
 */
export function installUnhandledGuard(options: UnhandledGuardOptions): UnhandledGuard {
  const { log } = options;
  const tally: Record<UnhandledKind, number> = { rejection: 0, exception: 0 };

  const record = (kind: UnhandledKind, value: unknown): void => {
    tally[kind] += 1;
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

export function unhandledReading(guard: UnhandledGuard): MetricsReading {
  const counts = guard.counts();
  return {
    counters: [
      {
        name: "odu_unhandled_total",
        help: "Unhandled rejections and uncaught exceptions the daemon caught and kept serving through.",
        points: [
          { labels: { kind: "rejection" }, value: counts.rejection },
          { labels: { kind: "exception" }, value: counts.exception },
        ],
      },
    ],
  };
}
