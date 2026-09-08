/**
 * `catalog.import` and `catalog.prune` — the run store as OPERATIONS.
 *
 * These two used to run in the caller's own process. `odu history import`
 * opened the catalog and wrote run directories into it; `odu history prune`
 * opened the same catalog and expired them — both beside a daemon that reads
 * and writes those exact files on a timer. That is two writers on one store,
 * and the fact that it mostly worked is not the same as it being safe: a prune
 * tombstoning a run's evidence while the service holds its journal open is a
 * race with nobody in charge of it. Here there is exactly one process that
 * mutates the catalog, and every face asks it.
 *
 * **Both are MUTATIONS, so both carry a request id**, claimed through the same
 * receipt machinery `run.start` and `run.cancel` use — not a copy of it. A
 * repeat replays the recorded report rather than pruning a second time, and the
 * replayed report says so (`replayed: true`) rather than pretending to be a
 * fresh pass that found nothing left to do.
 *
 * **What this module does NOT do is decide anything about the catalog.** What
 * an import means (a run id derived from the source record's identity, an
 * attempt marked incomplete because the old layout overwrote its log) lives in
 * `@odu/run-history/import`; what retention means (active runs are never
 * pruned, expiry is a tombstone rather than an `rm -rf`) lives in
 * `@odu/run-history/retention`. This is the seam that makes them addressable
 * and answers for the request id — the policies are theirs.
 */

import { isAbsolute } from "node:path";
import { importCheckout } from "@odu/run-history/import";
import {
  DEFAULT_RETENTION_MS,
  pruneCatalog as expireOldRuns,
} from "@odu/run-history/retention";
import type { CatalogOptions } from "@odu/run-history/store";
import {
  type CatalogImportInput,
  type CatalogImportReport,
  type CatalogPruneInput,
  type CatalogPruneReport,
  ServiceRefused,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import type { CheckoutProbe } from "./ports";
import {
  claimReceipt,
  type ClaimOutcome,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  type ReceiptStore,
} from "./requests";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The window a prune keeps, in the unit the wire speaks. Derived from the
 *  catalog's own default rather than restated, so the two cannot drift. */
export const DEFAULT_RETENTION_DAYS = Math.round(
  DEFAULT_RETENTION_MS / MS_PER_DAY,
);

export interface CatalogImportDeps {
  /** Injected for the same reason `run.start` injects it: deciding whether a
   *  path is a repository shells out to git, and a suite that wants to state
   *  "that is not a checkout" must be able to say so without one. */
  probeCheckout: CheckoutProbe;
  requests: ReceiptStore;
  catalog?: CatalogOptions;
  now: () => number;
}

export interface CatalogPruneDeps {
  requests: ReceiptStore;
  catalog?: CatalogOptions;
  now: () => number;
}

const refuse = (
  code: ServiceRefused["code"],
  message: string,
  extra: Partial<Pick<ServiceRefused, "suggestion">> = {},
): ServiceRefused => new ServiceRefused({ code, message, ...extra });

/**
 * WHY these claims are filed as `catalog`.
 *
 * The rules a catalog mutation needs are `cancel`'s: claimed against the
 * SERVICE's own receipt directory rather than a run's (there is no run for
 * these to belong to), no pre-minted run id to reconcile against, and inert to
 * the startup reconciler, which only settles `start` claims. Filing them as
 * `start` would put them in front of a reconciler that would go looking for a
 * run they can never have produced.
 *
 * They were filed as `cancel` for exactly one release-day, because the union
 * had no better arm. Coinciding rules are not the same concept, and a receipt
 * directory is where a wrong word survives longest — so the arm exists now.
 */
const RECEIPT_KIND = "catalog" as const;

/** A claim, or the refusal that ends the request. Shared because the three
 *  outcomes that are not "go ahead" read identically for both verbs — only the
 *  sentence naming the operation differs. */
type Claimed =
  | { ok: true; claim: ClaimOutcome; replayable: boolean }
  | { ok: false; refusal: ServiceRefused };

function claim(
  store: ReceiptStore,
  requestId: string,
  digest: string,
  what: string,
  now: number,
): Claimed {
  const outcome = claimReceipt(store, {
    requestId,
    kind: RECEIPT_KIND,
    digest,
    // Neither verb can ever create a run, so there is nothing to pre-mint. The
    // empty string is what "this request could never have produced a run" looks
    // like, and it is also what stops a reconciler from looking for one.
    plannedRunId: "",
    now,
  });
  if (outcome === null) {
    return {
      ok: false,
      refusal: refuse("bad_input", `odu: could not record request ${requestId}`),
    };
  }
  if (outcome.kind === "conflict") {
    return {
      ok: false,
      refusal: refuse(
        "request_conflict",
        `odu: request id "${requestId}" was already used for a different ` +
          `${what} — use a fresh id, or repeat the original request exactly`,
      ),
    };
  }
  // A recorded answer replays; an unreadable or absent one falls through and
  // does the work again, which is SAFE for both of these and for the same
  // reason: an import's run id is derived from the source record's identity so
  // a second pass skips what the first wrote, and expiry is a tombstone that
  // an already-tombstoned run is skipped for. Doing it twice does it once.
  return {
    ok: true,
    claim: outcome,
    replayable: outcome.kind === "replay" || outcome.kind === "in_flight",
  };
}

/**
 * Bring a checkout's legacy `.ci` records into the catalog the service serves.
 *
 * The catalog in the report is the SERVICE's, which is the point of routing
 * this through the daemon at all: a caller cannot import into a catalog nobody
 * is serving and then wonder why the board never showed the runs.
 */
export function importCatalog(
  input: CatalogImportInput,
  deps: CatalogImportDeps,
): Effect.Effect<CatalogImportReport, ServiceRefused> {
  return Effect.suspend(() => {
    const outcome = runImport(input, deps);
    return "refusal" in outcome
      ? Effect.fail(outcome.refusal)
      : Effect.succeed(outcome.report);
  });
}

function runImport(
  input: CatalogImportInput,
  deps: CatalogImportDeps,
): { report: CatalogImportReport } | { refusal: ServiceRefused } {
  const catalog = deps.catalog ?? {};
  const dryRun = input.dryRun ?? false;

  if (!isRequestId(input.requestId)) {
    return {
      refusal: refuse(
        "bad_input",
        `odu: "${input.requestId}" is not a usable request id ` +
          "(letters, digits, dot, dash and underscore; 128 chars)",
      ),
    };
  }
  // Checked BEFORE the claim, because it is a fact about the request alone and
  // will answer the same way for ever — there is nothing here for a receipt to
  // protect. Refused rather than resolved: the daemon's cwd is not the caller's
  // and never was, so a relative path would name a directory the caller has
  // never seen, and importing from it would be silent and wrong.
  if (!isAbsolute(input.checkout)) {
    return {
      refusal: refuse(
        "checkout_refused",
        `odu: "${input.checkout}" is not an absolute path — catalog.import ` +
          "takes the ABSOLUTE path of a checkout, because the service's " +
          "working directory is not the caller's",
      ),
    };
  }

  const claimed = claim(
    deps.requests,
    input.requestId,
    digestOf([input.checkout, dryRun]),
    "import",
    deps.now(),
  );
  if (!claimed.ok) return { refusal: claimed.refusal };
  if (claimed.replayable) {
    const replayed = replayOf(claimed.claim.receipt.result, isImportReport);
    if (replayed !== null) return replayed;
  }

  const facts = deps.probeCheckout(input.checkout);
  if (!facts.isRepo) {
    // Recorded, so a repeat replays the refusal instead of probing a checkout
    // that has since been deleted or created and getting a different answer to
    // the same question.
    const recorded: Recorded<never> = {
      outcome: "refusal",
      code: "checkout_refused",
      message:
        `odu: ${input.checkout} is not a git checkout — catalog.import reads ` +
        "a repository's `.ci` directory, and there is none to read",
      // ARGV, never a string anything could eval: this is how a caller finds
      // the root they meant.
      suggestion: ["git", "-C", input.checkout, "rev-parse", "--show-toplevel"],
    };
    completeReceipt(deps.requests, input.requestId, recorded, deps.now());
    return { refusal: refusalOf(recorded) };
  }

  // A DRY RUN dispatches nothing, so it is not marked as having dispatched:
  // the marker is what tells a reconciler "a mutation may have landed", and
  // claiming that about a pass which writes no bytes would make a lost reply
  // look like an unresolved mutation.
  if (!dryRun) {
    markDispatched(deps.requests, input.requestId, [input.checkout], deps.now());
  }
  const done = importCheckout({
    ...catalog,
    repoRoot: input.checkout,
    dryRun,
    now: deps.now(),
  });
  const report: CatalogImportReport = {
    // `reason: null` on an imported row, because there is nothing to explain
    // about a record that came in. A SKIPPED row has exactly one cause and the
    // importer does not spell it: the run id is derived from the source
    // record's identity, so a record already in the catalog is one this or an
    // earlier pass already wrote.
    imported: done.imported.map((row) => ({ ...row, reason: null })),
    skipped: done.skipped.map((row) => ({
      ...row,
      reason: "already in the catalog — imported by an earlier pass",
    })),
    catalog: done.catalog,
    dryRun,
    replayed: false,
  };
  completeReceipt(
    deps.requests,
    input.requestId,
    { outcome: "report", report },
    deps.now(),
  );
  return { report };
}

/**
 * Expire finished runs past the retention window.
 *
 * Expiry is a TOMBSTONE, not a deletion — see `@odu/run-history/retention` for
 * why: an agent holding a month-old run id deserves to be told the run existed
 * and its evidence aged out, which is a different answer from the one a typo
 * gets.
 */
export function pruneCatalog(
  input: CatalogPruneInput,
  deps: CatalogPruneDeps,
): Effect.Effect<CatalogPruneReport, ServiceRefused> {
  return Effect.suspend(() => {
    const outcome = runPrune(input, deps);
    return "refusal" in outcome
      ? Effect.fail(outcome.refusal)
      : Effect.succeed(outcome.report);
  });
}

function runPrune(
  input: CatalogPruneInput,
  deps: CatalogPruneDeps,
): { report: CatalogPruneReport } | { refusal: ServiceRefused } {
  const catalog = deps.catalog ?? {};
  const dryRun = input.dryRun ?? false;
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;

  if (!isRequestId(input.requestId)) {
    return {
      refusal: refuse(
        "bad_input",
        `odu: "${input.requestId}" is not a usable request id ` +
          "(letters, digits, dot, dash and underscore; 128 chars)",
      ),
    };
  }

  const claimed = claim(
    deps.requests,
    input.requestId,
    digestOf([retentionDays, dryRun]),
    "prune",
    deps.now(),
  );
  if (!claimed.ok) return { refusal: claimed.refusal };
  if (claimed.replayable) {
    const replayed = replayOf(claimed.claim.receipt.result, isPruneReport);
    if (replayed !== null) return replayed;
  }

  if (!dryRun) {
    markDispatched(
      deps.requests,
      input.requestId,
      [`${retentionDays}d`],
      deps.now(),
    );
  }
  const done = expireOldRuns({
    ...catalog,
    retentionMs: retentionDays * MS_PER_DAY,
    dryRun,
    now: deps.now(),
  });
  const report: CatalogPruneReport = {
    expired: [...done.expired],
    // Carried with the REASON, so "why is this still here" is answerable
    // without a second call — a live owner and a run that never finalized are
    // both kept, and only one of them is something to look into.
    kept: done.kept.map((row) => ({ runId: row.runId, reason: row.reason })),
    retentionDays,
    dryRun,
    replayed: false,
  };
  completeReceipt(
    deps.requests,
    input.requestId,
    { outcome: "report", report },
    deps.now(),
  );
  return { report };
}

/**
 * What a finished catalog request recorded.
 *
 * A REFUSAL IS AN ANSWER, and is stored as one: the request was understood, it
 * will not be performed, and repeating it must produce the same sentence rather
 * than a fresh attempt against a world that has since moved. The tag is what
 * tells a reader which arm it is holding — the lesson `run.start`'s receipt
 * learned when storing only successes made a recorded refusal replay as "this
 * build cannot read what it recorded".
 */
type Recorded<R> =
  | { outcome: "report"; report: R }
  | {
      outcome: "refusal";
      code: ServiceRefused["code"];
      message: string;
      /** ARGV, and carried THROUGH the receipt: a replayed refusal that had
       *  lost its recovery route would be a different answer from the one the
       *  first caller got, which is the one thing a receipt exists to rule
       *  out. */
      suggestion?: readonly string[];
    };

/** A recorded refusal, back as the value it was. */
function refusalOf(
  recorded: Extract<Recorded<never>, { outcome: "refusal" }>,
): ServiceRefused {
  return refuse(recorded.code, recorded.message, {
    ...(recorded.suggestion === undefined
      ? {}
      : { suggestion: [...recorded.suggestion] }),
  });
}

/** Rebuild a recorded outcome, or `null` when this build cannot read it —
 *  never a cast, because handing a caller an object shaped like a report with
 *  nothing in it is worse than doing the idempotent work again. */
function recordedOf<R>(
  stored: unknown,
  isReport: (value: unknown) => value is R,
): Recorded<R> | null {
  if (stored === null || typeof stored !== "object") return null;
  const value = stored as Partial<Recorded<R>>;
  if (value.outcome === "refusal") {
    if (typeof value.code !== "string" || typeof value.message !== "string") {
      return null;
    }
    return {
      outcome: "refusal",
      code: value.code,
      message: value.message,
      ...(Array.isArray(value.suggestion)
        ? { suggestion: [...value.suggestion] }
        : {}),
    };
  }
  if (value.outcome !== "report") return null;
  return isReport(value.report) ? { outcome: "report", report: value.report } : null;
}

/** A recorded outcome, in the same two arms the caller returns — so a replay
 *  and a fresh answer travel the same channels. `null` is "nothing readable
 *  was recorded", which is not an answer and must not become one. */
function replayOf<R>(
  stored: unknown,
  isReport: (value: unknown) => value is R,
): { report: R & { replayed: boolean } } | { refusal: ServiceRefused } | null {
  const recorded = recordedOf(stored, isReport);
  if (recorded === null) return null;
  // A recorded refusal replays as the refusal it was, on the declared error
  // channel — never as a field on a success.
  if (recorded.outcome === "refusal") return { refusal: refusalOf(recorded) };
  return { report: { ...recorded.report, replayed: true } };
}

function isImportReport(value: unknown): value is CatalogImportReport {
  if (value === null || typeof value !== "object") return false;
  const report = value as Partial<CatalogImportReport>;
  return (
    Array.isArray(report.imported) &&
    Array.isArray(report.skipped) &&
    typeof report.catalog === "string"
  );
}

function isPruneReport(value: unknown): value is CatalogPruneReport {
  if (value === null || typeof value !== "object") return false;
  const report = value as Partial<CatalogPruneReport>;
  return (
    Array.isArray(report.expired) &&
    Array.isArray(report.kept) &&
    typeof report.retentionDays === "number"
  );
}
