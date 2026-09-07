/**
 * `run.start` — accept a run, or say exactly why not.
 *
 * Four things happen here and the ORDER is the design:
 *
 *   1. **Is this a request at all?** A request id outside the grammar is
 *      refused before anything is claimed, because a claim has to be filed
 *      under a name and that is not one. This is the only check that comes
 *      before the receipt, and it is pure.
 *   2. **Answer the REQUEST before looking at the world.** The request id is
 *      claimed first, against a digest built only from what the caller sent.
 *      A repeat of a request that has already been answered replays that
 *      answer — even if the checkout has since moved to another commit, or has
 *      a different run in it now. Everything about a checkout is mutable, and
 *      a receipt that could be invalidated by the world moving underneath it is
 *      not a receipt; it is a second execution waiting to happen.
 *   3. **Then look at the checkout, and record what it said.** A path that is
 *      not a repository, a SHA the checkout is not on, a checkout that already
 *      has a live run — each is an ANSWER, each is written to the receipt, and
 *      each therefore replays. A checkout that already has a live run is not
 *      even an error: it is almost certainly the run the caller wanted, so the
 *      answer is that run, addressed, with `accepted: false` — and
 *      `supersede: true` is how a caller says it really did mean to take it.
 *   4. **Launch through the port.** How a coordinator comes to exist is not
 *      this package's business — see `./ports`.
 *
 * What this does NOT do is decide anything about the run. Selectors, platforms,
 * host pools, strictness, posting and `supersede` are carried through verbatim
 * to the coordinator, which owns all of them and refuses in its own words. A
 * service that re-derived a lane assignment would be a second scheduler.
 */

import { mintRunId } from "@odu/run-history/ids";
import { formatCursor } from "@odu/run-history/ids";
import type { RunScope } from "@odu/run-history/schema";
import { type CatalogOptions, handleFor, readManifest } from "@odu/run-history/store";
import {
  ServiceRefused,
  type StartInput,
  type StartReceipt,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import type { CheckoutProbe, RunLauncher } from "./ports";
import {
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  reconcileStart,
  type ReceiptStore,
} from "./requests";

export interface StartDeps {
  launch: RunLauncher;
  probeCheckout: CheckoutProbe;
  requests: ReceiptStore;
  catalog?: CatalogOptions;
  host: string;
  now: () => number;
}

/** The scope a start asks for, in the catalog's own vocabulary. Built once so
 *  the receipt, the launch request and the answer all describe one selection. */
function scopeOf(input: StartInput): RunScope {
  return {
    selectors: [...(input.selectors ?? [])],
    platforms: [...(input.platforms ?? [])],
    ...(input.root === undefined ? {} : { root: input.root }),
    noDeps: input.noDeps ?? false,
  };
}

/**
 * WHAT A REQUEST IS, as one string.
 *
 * Every field the caller sent, and nothing the world can move. In particular
 * the checkout's actual HEAD is NOT in here: it was, and it made the digest a
 * function of the clock — the same request repeated after a `git pull` hashed
 * differently, so a caller retrying a lost reply got `request_conflict` for a
 * request it had not changed. `expectedSha` is in here instead, which is the
 * caller's own claim about the commit and is exactly as stable as the rest of
 * the request.
 */
export function digestOfRequest(input: StartInput, scope: RunScope): string {
  return digestOf([
    input.checkout,
    input.expectedSha,
    scope.selectors.join(","),
    scope.platforms.join(","),
    scope.root ?? "",
    scope.noDeps,
    (input.hostPins ?? []).join(","),
    input.noStrict ?? false,
    input.noSnapshot ?? false,
    input.noPost ?? false,
    // `supersede` changes what the request DOES — it evicts a run — so two
    // requests that differ only in it are two requests, and repeating one under
    // the other's id is a conflict rather than a replay.
    input.supersede ?? false,
  ]);
}

/**
 * What a finished request recorded, as a value with a tag.
 *
 * A refusal is an ANSWER: the request was understood, it will not be performed,
 * and repeating it must produce the same sentence rather than a fresh attempt
 * against a world that has since changed. Storing only the successes made
 * `launch_failed` replay as "this build cannot read what it recorded", which is
 * the one thing the receipt was there to prevent — so both arms are written,
 * and the tag is what tells a reader which it is holding.
 */
export type Recorded =
  | { outcome: "receipt"; receipt: StartReceipt }
  | {
      outcome: "refusal";
      code: ServiceRefused["code"];
      message: string;
      suggestion?: readonly string[];
      runId?: string;
    };

/** Wrap an answer for storage. Exported so startup reconciliation writes the
 *  same envelope this module reads — one shape, one place it is spelled. */
export function recordedStart(receipt: StartReceipt): Recorded {
  return { outcome: "receipt", receipt };
}

/** Rebuild the answer from a run that exists — the reconciliation path, and
 *  the replay path once a receipt has been completed. */
function receiptOfRun(
  runId: string,
  requestId: string,
  replayed: boolean,
  catalog: CatalogOptions,
): StartReceipt | null {
  const manifest = readManifest(handleFor(runId, catalog));
  if (manifest === null) return null;
  return {
    accepted: true,
    runId,
    requestId,
    replayed,
    sha: manifest.sha,
    scope: manifest.scope,
    endpoint: manifest.registeredBy.endpoint,
    cursor: formatCursor({ runId, seq: 0 }),
  };
}

export function startRun(
  input: StartInput,
  deps: StartDeps,
): Effect.Effect<StartReceipt, ServiceRefused> {
  return Effect.suspend(() => Effect.promise(() => start(input, deps))).pipe(
    Effect.flatMap((outcome) =>
      outcome.ok ? Effect.succeed(outcome.receipt) : Effect.fail(outcome.refusal),
    ),
  );
}

type Outcome =
  | { ok: true; receipt: StartReceipt }
  | { ok: false; refusal: ServiceRefused };

const refuse = (
  code: ServiceRefused["code"],
  message: string,
  extra: Partial<Pick<ServiceRefused, "resync" | "suggestion" | "runId">> = {},
): Outcome => ({
  ok: false,
  refusal: new ServiceRefused({ code, message, ...extra }),
});

/** Refuse, and write the refusal to the receipt so the next identical ask
 *  replays it rather than trying again against a world that has moved. */
function refuseAndRecord(
  deps: StartDeps,
  requestId: string,
  code: ServiceRefused["code"],
  message: string,
  extra: Partial<Pick<ServiceRefused, "suggestion" | "runId">> = {},
): Outcome {
  const recorded: Recorded = {
    outcome: "refusal",
    code,
    message,
    ...(extra.suggestion === undefined ? {} : { suggestion: extra.suggestion }),
    ...(extra.runId === undefined ? {} : { runId: extra.runId }),
  };
  completeReceipt(deps.requests, requestId, recorded, deps.now());
  return refuse(code, message, extra);
}

/** Answer, and write the answer to the receipt. */
function answerAndRecord(
  deps: StartDeps,
  requestId: string,
  receipt: StartReceipt,
): Outcome {
  completeReceipt(deps.requests, requestId, recordedStart(receipt), deps.now());
  return { ok: true, receipt };
}

async function start(input: StartInput, deps: StartDeps): Promise<Outcome> {
  const catalog = deps.catalog ?? {};

  if (!isRequestId(input.requestId)) {
    return refuse(
      "bad_input",
      `odu: "${input.requestId}" is not a usable request id ` +
        "(letters, digits, dot, dash and underscore; 128 chars)",
    );
  }

  // ── the request id, claimed BEFORE anything mutable is consulted ──
  //
  // This is the ordering the whole module turns on. A repeat is answered from
  // what was recorded, and nothing about the checkout can change that answer;
  // only a request that has never been answered goes on to look at the world.
  const scope = scopeOf(input);
  const plannedRunId = mintRunId(deps.now());
  const claim = claimReceipt(deps.requests, {
    requestId: input.requestId,
    kind: "start",
    digest: digestOfRequest(input, scope),
    plannedRunId,
    now: deps.now(),
  });
  if (claim === null) {
    return refuse(
      "bad_input",
      `odu: could not record request ${input.requestId}`,
    );
  }
  if (claim.kind === "conflict") {
    return refuse(
      "request_conflict",
      `odu: request id "${input.requestId}" was already used to start a ` +
        "different run — use a fresh id, or repeat the original request exactly",
    );
  }
  if (claim.kind === "replay") {
    const replayed = replayOf(claim.receipt.result, input.requestId);
    if (replayed !== null) return replayed;
    // A recorded outcome this build cannot read. Reported as itself rather
    // than re-run: a repeat that could not be understood is not a licence to
    // start a second coordinator.
    return refuse(
      "request_unresolved",
      `odu: request "${input.requestId}" was used before, but this build ` +
        "cannot read what it recorded",
    );
  }
  if (claim.kind === "in_flight") {
    const reconciled = reconcileStart(claim.receipt, {
      catalog,
      now: deps.now(),
      host: deps.host,
    });
    if (reconciled.kind === "replay") {
      const replayed = replayOf(reconciled.result, input.requestId);
      if (replayed !== null) return replayed;
    }
    if (reconciled.kind === "run_exists") {
      const rebuilt = receiptOfRun(reconciled.runId, input.requestId, true, catalog);
      if (rebuilt !== null) return answerAndRecord(deps, input.requestId, rebuilt);
    }
    if (reconciled.kind === "nothing_happened") {
      // The claimant is provably gone and never dispatched, so nothing was
      // started. Still not re-run under this id — the receipt is the record
      // that this id was used, and re-using it would make the two attempts
      // indistinguishable in the very file that exists to tell them apart.
      return refuse(
        "request_unresolved",
        `odu: request "${input.requestId}" was accepted by a process that is ` +
          "gone and never started anything. Retry with a fresh id.",
      );
    }
    return refuse(
      "request_unresolved",
      `odu: request "${input.requestId}" was accepted and its outcome is ` +
        `UNKNOWN — ${reconciled.kind === "unresolved" ? reconciled.reason : "no run was recorded"}. ` +
        "Do not repeat it with a fresh id until you have checked whether it " +
        "took effect: a second start would be a second run.",
      { suggestion: ["odu", "history", "list"] },
    );
  }

  // ── freshly claimed: this is NEW work, so now the world matters ──
  const facts = deps.probeCheckout(input.checkout);
  if (!facts.isRepo) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: ${input.checkout} is not a git checkout — run.start takes the ` +
        "ABSOLUTE path of a repository, never a relative one and never a cwd",
    );
  }
  if (facts.head === null) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: ${input.checkout} has no readable HEAD — an unborn branch has no ` +
        "commit for a run to be about",
    );
  }
  // A PREFIX match, so a caller may name the sha the length its own tooling
  // prints. Refused rather than substituted: the whole promise of `expectedSha`
  // is that a checkout which moved on gets an answer, not a different run.
  if (!facts.head.toLowerCase().startsWith(input.expectedSha.toLowerCase())) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: ${input.checkout} is on ${facts.head.slice(0, 12)}, not ` +
        `${input.expectedSha} — the checkout moved since you read it`,
      { suggestion: ["git", "-C", input.checkout, "rev-parse", "HEAD"] },
    );
  }

  // ── an existing run in that checkout is an ANSWER ──
  if (facts.liveRunId !== null && input.supersede !== true) {
    const existing = readManifest(handleFor(facts.liveRunId, catalog));
    return answerAndRecord(deps, input.requestId, {
      accepted: false,
      runId: facts.liveRunId,
      requestId: input.requestId,
      replayed: false,
      sha: existing?.sha ?? facts.head,
      scope: existing?.scope ?? scope,
      endpoint: existing?.registeredBy.endpoint ?? null,
      cursor: formatCursor({ runId: facts.liveRunId, seq: 0 }),
      existing: {
        runId: facts.liveRunId,
        sha: existing?.sha ?? facts.head,
      },
    });
  }

  const runId = claim.receipt.plannedRunId;
  // A LAUNCH IS A DISPATCH. Marked before the launcher is entered, because from
  // here on "my reply went missing" and "nothing happened" stop being the same
  // thing — a launcher that is still running has not published a manifest yet,
  // and reading that absence as proof of no spawn is how one request becomes
  // two coordinators.
  markDispatched(deps.requests, input.requestId, scope.selectors, deps.now());
  const launched = await deps.launch({
    checkout: input.checkout,
    catalog,
    runId,
    parentRunId: null,
    requestId: input.requestId,
    scope,
    expectedSha: facts.head,
    noStrict: input.noStrict ?? false,
    noSnapshot: input.noSnapshot ?? false,
    noPost: input.noPost ?? false,
    hostPins: [...(input.hostPins ?? [])],
    // The caller's explicit "take this checkout". The coordinator does the
    // cancel-then-confirm; this only has to not lose the word.
    supersede: input.supersede ?? false,
  });
  if (!launched.ok) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "launch_failed",
      `odu: could not start the run — ${launched.error ?? "unknown error"}`,
      { runId },
    );
  }
  // Read back what the child published, so the receipt describes the run that
  // EXISTS rather than the one that was asked for.
  const registered = readManifest(handleFor(runId, catalog));
  return answerAndRecord(deps, input.requestId, {
    accepted: true,
    runId,
    requestId: input.requestId,
    replayed: false,
    sha: registered?.sha ?? facts.head,
    scope: registered?.scope ?? scope,
    endpoint: launched.endpoint,
    cursor: formatCursor({ runId, seq: 0 }),
    ...(launched.lifetime === undefined ? {} : { lifetime: launched.lifetime }),
  });
}

/** Rebuild a recorded outcome — an answer or a refusal, told apart by its tag.
 *  A stored value this build cannot recognise yields `null` rather than being
 *  cast: handing a caller an object shaped like a receipt with nothing in it is
 *  worse than saying so. */
function replayOf(stored: unknown, requestId: string): Outcome | null {
  if (stored === null || typeof stored !== "object") return null;
  const value = stored as Partial<Recorded>;
  if (value.outcome === "refusal") {
    const refusal = value as Extract<Recorded, { outcome: "refusal" }>;
    if (typeof refusal.code !== "string" || typeof refusal.message !== "string") {
      return null;
    }
    return refuse(refusal.code, refusal.message, {
      ...(refusal.suggestion === undefined
        ? {}
        : { suggestion: [...refusal.suggestion] }),
      ...(refusal.runId === undefined ? {} : { runId: refusal.runId }),
    });
  }
  if (value.outcome !== "receipt") return null;
  const receipt = (value as Extract<Recorded, { outcome: "receipt" }>).receipt;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    typeof receipt.runId !== "string" ||
    typeof receipt.sha !== "string"
  ) {
    return null;
  }
  return { ok: true, receipt: { ...receipt, requestId, replayed: true } };
}
