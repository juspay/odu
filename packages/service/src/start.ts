import { isAbsolute } from "node:path";
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
import { callerOf } from "./caller";
import type { Principal } from "@odu/cordis/principal";
import type {
  CheckoutMover,
  CheckoutProbe,
  PushPort,
  RunCanceller,
  RunLauncher,
} from "./ports";
import { stopLiveRun } from "./cancel";
import { preparePush } from "./pushGrant";
import {
  CLAIMANT_STILL_STARTING,
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  optionalPart,
  reconcileStart,
  type ReceiptStore,
} from "./requests";

export interface StartDeps {
  launch: RunLauncher;
  probeCheckout: CheckoutProbe;
  moveCheckout: CheckoutMover;
  cancel: RunCanceller;
  push: PushPort;
  requests: ReceiptStore;
  catalog?: CatalogOptions;
  host: string;
  now: () => number;
}

function scopeOf(input: StartInput): RunScope {
  return {
    selectors: [...(input.selectors ?? [])],
    platforms: [...(input.platforms ?? [])],
    ...(input.root === undefined ? {} : { root: input.root }),
    noDeps: input.noDeps ?? false,
  };
}

export function digestOfRequest(input: StartInput, scope: RunScope): string {
  return digestOf([
    input.checkout,
    input.expectedSha,
    optionalPart(input.branch),
    scope.selectors.join(","),
    scope.platforms.join(","),
    scope.root ?? "",
    scope.noDeps,
    (input.hostPins ?? []).join(","),
    optionalPart(input.hostsFile),
    input.noStrict ?? false,
    input.noSnapshot ?? false,
    input.noPost ?? false,
    input.supersede ?? false,
  ]);
}

function branchNameProblem(name: string): string | null {
  if (name === "") return "it is empty";
  if (name.startsWith("-")) return "git reads a leading dash as an option";
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    return "it holds a character git refuses in a ref (space, control, or one of ~^:?*[\\)";
  }
  if (name.includes("..")) return "`..` separates two refs";
  if (name.includes("@{")) return "`@{` names a reflog entry";
  if (name === "@") return "`@` is git's own name for HEAD";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "a ref's path components cannot be empty";
  }
  if (name.endsWith(".") || name.endsWith(".lock")) {
    return "a ref cannot end with `.` or `.lock`";
  }
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return "no path component may begin with `.` or end with `.lock`";
  }
  return null;
}

export type Recorded =
  | { outcome: "receipt"; receipt: StartReceipt }
  | {
      outcome: "refusal";
      code: ServiceRefused["code"];
      message: string;
      suggestion?: readonly string[];
      runId?: string;
    };

export function recordedStart(receipt: StartReceipt): Recorded {
  return { outcome: "receipt", receipt };
}

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
  principal: Principal,
): Effect.Effect<StartReceipt, ServiceRefused> {
  return Effect.suspend(() => Effect.promise(() => start(input, deps, principal))).pipe(
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

function answerAndRecord(
  deps: StartDeps,
  requestId: string,
  receipt: StartReceipt,
): Outcome {
  completeReceipt(deps.requests, requestId, recordedStart(receipt), deps.now());
  return { ok: true, receipt };
}

async function start(
  input: StartInput,
  deps: StartDeps,
  principal: Principal,
): Promise<Outcome> {
  const catalog = deps.catalog ?? {};

  if (!isRequestId(input.requestId)) {
    return refuse(
      "bad_input",
      `odu: "${input.requestId}" is not a usable request id ` +
        "(letters, digits, dot, dash and underscore; 128 chars)",
    );
  }

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
    return refuse(
      "request_unresolved",
      `odu: request "${input.requestId}" was used before, but this build ` +
        "cannot read what it recorded",
    );
  }
  if (claim.kind === "held_unreadable") {
    return refuse(
      "request_unresolved",
      `odu: request "${input.requestId}" was accepted and its outcome is ` +
        `UNKNOWN — ${CLAIMANT_STILL_STARTING}. ` +
        "Do not repeat it with a fresh id until you have checked whether it " +
        "took effect: a second start would be a second run.",
      { suggestion: ["odu", "ci", "history", "list"] },
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
      { suggestion: ["odu", "ci", "history", "list"] },
    );
  }

  if (!isAbsolute(input.checkout)) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: ${input.checkout} is not an absolute path — run.start takes the ` +
        "ABSOLUTE path of a repository. A relative one would resolve against " +
        "the daemon's working directory, which is not yours.",
    );
  }
  if (
    input.hostsFile !== undefined &&
    input.hostsFile !== "" &&
    !isAbsolute(input.hostsFile)
  ) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: $ODU_HOSTS is "${input.hostsFile}", which is not an absolute ` +
        "path — run.start resolves it in the service, where your working " +
        "directory does not exist. Point $ODU_HOSTS at an absolute path.",
    );
  }
  if (!/^[0-9a-fA-F]{7,40}$/.test(input.expectedSha)) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "bad_input",
      `odu: "${input.expectedSha}" is not a commit — expectedSha is 7 to 40 ` +
        "hex characters, the sha a caller read with `git rev-parse HEAD`",
    );
  }
  if (input.branch !== undefined) {
    const wrong = branchNameProblem(input.branch);
    if (wrong !== null) {
      return refuseAndRecord(
        deps,
        input.requestId,
        "bad_input",
        `odu: "${input.branch}" is not a usable branch name — ${wrong}. ` +
          "run.start moves a checkout with git, and a name git would read as " +
          "an option is a command, not a branch.",
      );
    }
  }
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
  const wanted = input.expectedSha.toLowerCase();
  const onWanted = facts.head.toLowerCase().startsWith(wanted);
  let head = facts.head;
  if (!onWanted && input.branch === undefined) {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: ${input.checkout} is on ${facts.head.slice(0, 12)}, not ` +
        `${input.expectedSha} — the checkout moved since you read it`,
      { suggestion: ["git", "-C", input.checkout, "rev-parse", "HEAD"] },
    );
  }

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

  let movedNote: string | null = null;
  if (input.branch !== undefined && !onWanted) {
    if (facts.liveRunId !== null) {
      const stopped = await stopLiveRun(facts.liveRunId, {
        cancel: deps.cancel,
        catalog,
        now: deps.now,
      });
      if (stopped.kind !== "stopped") {
        return refuseAndRecord(
          deps,
          input.requestId,
          "checkout_refused",
          `odu: run ${facts.liveRunId} is live in ${input.checkout} and ` +
            `could not be confirmed stopped — ${stopped.detail}. Nothing was ` +
            "moved: a checkout is not taken from a run that may still be " +
            "reading it.",
          { runId: facts.liveRunId },
        );
      }
    }
    const outcome = await deps.moveCheckout({
      checkout: input.checkout,
      branch: input.branch,
      sha: input.expectedSha,
    });
    if (outcome.kind === "dirty") {
      return refuseAndRecord(
        deps,
        input.requestId,
        "checkout_refused",
        `odu: ${input.checkout} has uncommitted changes, so it cannot be ` +
          `moved to ${input.branch} — ${outcome.detail}. odu does not discard ` +
          "work it did not make.",
        { suggestion: ["git", "-C", input.checkout, "status", "--porcelain"] },
      );
    }
    if (outcome.kind === "fetch_failed") {
      return refuseAndRecord(
        deps,
        input.requestId,
        "checkout_refused",
        `odu: could not fetch origin ${input.branch} in ${input.checkout} — ` +
          outcome.detail,
      );
    }
    if (outcome.kind === "not_on_branch") {
      return refuseAndRecord(
        deps,
        input.requestId,
        "checkout_refused",
        `odu: ${input.expectedSha} is not on origin/${input.branch}, which is ` +
          `at ${outcome.tip.slice(0, 12)} — odu runs a commit that branch ` +
          "contains, never one it has to be moved off to reach",
      );
    }
    if (outcome.kind === "failed") {
      return refuseAndRecord(
        deps,
        input.requestId,
        "checkout_refused",
        `odu: could not put ${input.checkout} on ${input.branch} at ` +
          `${input.expectedSha} — ${outcome.detail}`,
      );
    }
    const after = deps.probeCheckout(input.checkout);
    if (after.head === null || !after.head.toLowerCase().startsWith(wanted)) {
      return refuseAndRecord(
        deps,
        input.requestId,
        "checkout_refused",
        `odu: ${input.checkout} was moved to ${input.branch} at ` +
          `${outcome.head.slice(0, 12)} and reads ` +
          `${after.head === null ? "no HEAD" : after.head.slice(0, 12)} now — ` +
          "something else is moving this checkout",
      );
    }
    head = after.head;
    movedNote = `moved ${input.checkout} to ${input.branch} at ${head.slice(0, 7)}`;
  }

  const runId = claim.receipt.plannedRunId;
  const prepared = await preparePush(deps.push, input.checkout, runId);
  if (prepared.kind === "ambiguous") {
    return refuseAndRecord(
      deps,
      input.requestId,
      "checkout_refused",
      `odu: ${input.checkout} reads from two odu caches — ` +
        `${prepared.substituters.join(" and ")}. A repository builds for one ` +
        "cache; name a single one in flake.nix nixConfig.",
    );
  }
  const push = prepared.push;

  markDispatched(deps.requests, input.requestId, scope.selectors, deps.now());
  const launched = await deps.launch({
    checkout: input.checkout,
    catalog,
    runId,
    parentRunId: null,
    requestId: input.requestId,
    scope,
    expectedSha: head,
    noStrict: input.noStrict ?? false,
    noSnapshot: input.noSnapshot ?? false,
    noPost: input.noPost ?? false,
    hostPins: [...(input.hostPins ?? [])],
    caller: callerOf(input, principal),
    supersede: input.supersede ?? false,
    linger: input.linger ?? false,
    push,
    pushSkipped: prepared.skipped,
    pushKeyWarning: prepared.keyWarning,
    checkoutMoved: movedNote,
  });
  if (!launched.ok) {
    prepared.release();
    return refuseAndRecord(
      deps,
      input.requestId,
      "launch_failed",
      `odu: could not start the run — ${launched.error ?? "unknown error"}`,
      { runId },
    );
  }
  const registered = readManifest(handleFor(runId, catalog));
  return answerAndRecord(deps, input.requestId, {
    accepted: true,
    runId,
    requestId: input.requestId,
    replayed: false,
    sha: registered?.sha ?? head,
    scope: registered?.scope ?? scope,
    endpoint: launched.endpoint,
    cursor: formatCursor({ runId, seq: 0 }),
    ...(launched.lifetime === undefined ? {} : { lifetime: launched.lifetime }),
  });
}

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
