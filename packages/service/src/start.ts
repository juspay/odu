/**
 * `run.start` — accept a run, or say exactly why not.
 *
 * Four things happen here and the ORDER is the design:
 *
 *   1. **Validate before accepting.** A checkout that is not a repository, a
 *      SHA the checkout is not on, a request id outside the grammar — all
 *      refused before anything is claimed or minted. Blind process polling is
 *      what this replaces: an agent used to start a coordinator, watch it die
 *      on the strict gate, and be left inferring the reason from silence.
 *   2. **Answer the conflict rather than refusing it.** A checkout that already
 *      has a live run is not an error: it is almost certainly the run the
 *      caller wanted. So the answer is that run, addressed, with `accepted:
 *      false` — and `supersede: true` is how a caller says it really did mean
 *      to take the checkout.
 *   3. **Persist the request BEFORE dispatching.** The id is claimed and the
 *      new run's id minted on disk first, so a crash between here and the
 *      coordinator's registration leaves a question with an answer instead of a
 *      choice between two mutations.
 *   4. **Launch through the port.** How a coordinator comes to exist is not
 *      this package's business — see `./ports`.
 *
 * What this does NOT do is decide anything about the run. Selectors, platforms,
 * host pools, strictness and posting are carried through verbatim to the
 * coordinator, which owns all of them and refuses in its own words. A service
 * that re-derived a lane assignment would be a second scheduler.
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

async function start(input: StartInput, deps: StartDeps): Promise<Outcome> {
  const catalog = deps.catalog ?? {};

  if (!isRequestId(input.requestId)) {
    return refuse(
      "bad_input",
      `odu: "${input.requestId}" is not a usable request id ` +
        "(letters, digits, dot, dash and underscore; 128 chars)",
    );
  }

  // ── the checkout, before anything is claimed ──
  const facts = deps.probeCheckout(input.checkout);
  if (!facts.isRepo) {
    return refuse(
      "checkout_refused",
      `odu: ${input.checkout} is not a git checkout — run.start takes the ` +
        "ABSOLUTE path of a repository, never a relative one and never a cwd",
    );
  }
  if (facts.head === null) {
    return refuse(
      "checkout_refused",
      `odu: ${input.checkout} has no readable HEAD — an unborn branch has no ` +
        "commit for a run to be about",
    );
  }
  // A PREFIX match, so a caller may name the sha the length its own tooling
  // prints. Refused rather than substituted: the whole promise of `expectedSha`
  // is that a checkout which moved on gets an answer, not a different run.
  if (!facts.head.toLowerCase().startsWith(input.expectedSha.toLowerCase())) {
    return refuse(
      "checkout_refused",
      `odu: ${input.checkout} is on ${facts.head.slice(0, 12)}, not ` +
        `${input.expectedSha} — the checkout moved since you read it`,
      { suggestion: ["git", "-C", input.checkout, "rev-parse", "HEAD"] },
    );
  }

  // ── an existing run in that checkout is an ANSWER ──
  if (facts.liveRunId !== null && input.supersede !== true) {
    const existing = readManifest(handleFor(facts.liveRunId, catalog));
    return {
      ok: true,
      receipt: {
        accepted: false,
        runId: facts.liveRunId,
        requestId: input.requestId,
        replayed: false,
        sha: existing?.sha ?? facts.head,
        scope: existing?.scope ?? scopeOf(input),
        endpoint: existing?.registeredBy.endpoint ?? null,
        cursor: formatCursor({ runId: facts.liveRunId, seq: 0 }),
        existing: {
          runId: facts.liveRunId,
          sha: existing?.sha ?? facts.head,
        },
      },
    };
  }

  // ── the request id, claimed before anything is started ──
  const scope = scopeOf(input);
  const digest = digestOf([
    input.checkout,
    facts.head,
    scope.selectors.join(","),
    scope.platforms.join(","),
    scope.root ?? "",
    scope.noDeps,
    (input.hostPins ?? []).join(","),
    input.noStrict ?? false,
    input.noSnapshot ?? false,
    input.noPost ?? false,
  ]);
  const plannedRunId = mintRunId(deps.now());
  const claim = claimReceipt(deps.requests, {
    requestId: input.requestId,
    kind: "start",
    digest,
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
    if (replayed !== null) return { ok: true, receipt: replayed };
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
      if (replayed !== null) return { ok: true, receipt: replayed };
    }
    if (reconciled.kind === "run_exists") {
      const rebuilt = receiptOfRun(reconciled.runId, input.requestId, true, catalog);
      if (rebuilt !== null) {
        completeReceipt(deps.requests, input.requestId, rebuilt, deps.now());
        return { ok: true, receipt: rebuilt };
      }
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

  // ── freshly claimed: this is NEW work ──
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
  });
  if (!launched.ok) {
    const refusal = refuse(
      "launch_failed",
      `odu: could not start the run — ${launched.error ?? "unknown error"}`,
      { runId },
    );
    // Recorded like every other outcome, so the next identical ask replays this
    // refusal rather than starting a coordinator against a world that has since
    // changed underneath it.
    completeReceipt(deps.requests, input.requestId, null, deps.now());
    return refusal;
  }
  // Read back what the child published, so the receipt describes the run that
  // EXISTS rather than the one that was asked for.
  const registered = readManifest(handleFor(runId, catalog));
  const receipt: StartReceipt = {
    accepted: true,
    runId,
    requestId: input.requestId,
    replayed: false,
    sha: registered?.sha ?? facts.head,
    scope: registered?.scope ?? scope,
    endpoint: launched.endpoint,
    cursor: formatCursor({ runId, seq: 0 }),
    ...(launched.lifetime === undefined ? {} : { lifetime: launched.lifetime }),
  };
  completeReceipt(deps.requests, input.requestId, receipt, deps.now());
  return { ok: true, receipt };
}

/** Rebuild a recorded answer. A stored value this build cannot recognise is
 *  refused rather than cast: handing a caller an object shaped like a receipt
 *  with nothing in it is worse than saying so. */
function replayOf(stored: unknown, requestId: string): StartReceipt | null {
  if (stored === null || typeof stored !== "object") return null;
  const value = stored as Partial<StartReceipt>;
  if (typeof value.runId !== "string" || typeof value.sha !== "string") {
    return null;
  }
  return { ...(value as StartReceipt), requestId, replayed: true };
}
