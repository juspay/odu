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

export const DEFAULT_RETENTION_DAYS = Math.round(
  DEFAULT_RETENTION_MS / MS_PER_DAY,
);

export interface CatalogImportDeps {
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

const RECEIPT_KIND = "catalog" as const;

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
  return {
    ok: true,
    claim: outcome,
    replayable: outcome.kind === "replay" || outcome.kind === "in_flight",
  };
}

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
    const recorded: Recorded<never> = {
      outcome: "refusal",
      code: "checkout_refused",
      message:
        `odu: ${input.checkout} is not a git checkout — catalog.import reads ` +
        "a repository's `.ci` directory, and there is none to read",
      suggestion: ["git", "-C", input.checkout, "rev-parse", "--show-toplevel"],
    };
    completeReceipt(deps.requests, input.requestId, recorded, deps.now());
    return { refusal: refusalOf(recorded) };
  }

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

  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    return {
      refusal: refuse(
        "bad_input",
        `odu: retention must be a positive whole number of days (got ${retentionDays})`,
      ),
    };
  }

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

type Recorded<R> =
  | { outcome: "report"; report: R }
  | {
      outcome: "refusal";
      code: ServiceRefused["code"];
      message: string;
      suggestion?: readonly string[];
    };

function refusalOf(
  recorded: Extract<Recorded<never>, { outcome: "refusal" }>,
): ServiceRefused {
  return refuse(recorded.code, recorded.message, {
    ...(recorded.suggestion === undefined
      ? {}
      : { suggestion: [...recorded.suggestion] }),
  });
}

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

function replayOf<R>(
  stored: unknown,
  isReport: (value: unknown) => value is R,
): { report: R & { replayed: boolean } } | { refusal: ServiceRefused } | null {
  const recorded = recordedOf(stored, isReport);
  if (recorded === null) return null;
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
