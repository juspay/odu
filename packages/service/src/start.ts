/**
 * `run.start` — accept a run, or say exactly why not.
 *
 * Five things happen here and the ORDER is the design:
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
 *
 *      **A start that names a `branch` may MOVE that checkout** (PLAN 4.4).
 *      Only then, and only after the live-run rule above has had its say: a
 *      clone with a live run in it is still answered with that run, and a
 *      caller that said `supersede` has the incumbent stopped and confirmed
 *      stopped before a file moves. Without `branch` nothing is ever moved
 *      and a checkout that is not on the commit is refused, which is what
 *      every run from the caller's own checkout gets.
 *   4. **Resolve where this run PUSHES** (PLAN 4.1). The cache the checkout's
 *      `flake.nix` already reads from, if this daemon serves it, plus a write
 *      token minted for this run. Deliberately AFTER the receipt and
 *      deliberately NOT in the digest: the digest is what the caller sent, and
 *      where a checkout pushes is a fact about the world — so a replayed
 *      request re-resolves rather than replaying yesterday's bucket. The one
 *      arm that is a REFUSAL is two odu caches, because a repository builds
 *      for one.
 *   5. **Launch through the port.** How a coordinator comes to exist is not
 *      this package's business — see `./ports`.
 *
 * What this does NOT do is decide anything about the run. Selectors, platforms,
 * host pools, strictness, posting and `supersede` are carried through verbatim
 * to the coordinator, which owns all of them and refuses in its own words. A
 * service that re-derived a lane assignment would be a second scheduler.
 */

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
  /** Put the service's own clone on the branch and commit a `branch` start
   *  named. Only reached by such a start; every other one never moves a file. */
  moveCheckout: CheckoutMover;
  /** Stop the run already in that clone before moving it, when the caller
   *  said `supersede`. The coordinator's own cancel-then-claim is too late:
   *  it runs after the launch, and the tree has to be still by then. */
  cancel: RunCanceller;
  push: PushPort;
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
    // THE BRANCH, which changes what the request DOES — it licenses moving
    // the checkout — so a start repeated under one id with and without it is
    // two requests. `optionalPart` because absent ("refuse a checkout that
    // moved") and a named branch are different asks, not one with a default.
    optionalPart(input.branch),
    scope.selectors.join(","),
    scope.platforms.join(","),
    scope.root ?? "",
    scope.noDeps,
    (input.hostPins ?? []).join(","),
    // THE FLEET those pins are names in — absent from this digest entirely
    // until the three venue verbs were audited for the same fault. Pins say
    // WHICH BOX; the inventory says which fleet that name resolves in, so a
    // start repeated under one id against a different inventory is a request
    // to run somewhere else — a conflict to be told about, not a replay of the
    // first fleet's run. `optionalPart` rather than `?? ""` because absent
    // (use the daemon's `$ODU_HOSTS`) and `""` (the caller's shell had none)
    // reach the coordinator as different environments.
    optionalPart(input.hostsFile),
    input.noStrict ?? false,
    input.noSnapshot ?? false,
    input.noPost ?? false,
    // `supersede` changes what the request DOES — it evicts a run — so two
    // requests that differ only in it are two requests, and repeating one under
    // the other's id is a conflict rather than a replay.
    input.supersede ?? false,
    // WHERE THE RUN PUSHES IS DELIBERATELY ABSENT (PLAN 4.1). It is not
    // something the caller sent — it is read out of the checkout's `flake.nix`
    // and off a substituter — so putting it here would make the digest a
    // function of the world again, which is the exact fault `expectedSha`
    // replaced a HEAD read to avoid. A replayed `requestId` re-resolves.
  ]);
}

/**
 * WHY THIS IS NOT A BRANCH NAME, or `null` when it is one.
 *
 * `git check-ref-format --branch` states the same rules, and calling it would
 * mean handing the very string this exists to distrust to a git process — the
 * option-injection it is here to stop. So the rules are written out: git's
 * `refs/heads/<name>` grammar, plus the leading `-` that makes a name an
 * option rather than a ref.
 *
 * A SENTENCE rather than a boolean, because a caller that typed `feature/x..y`
 * is owed which character git refused.
 */
function branchNameProblem(name: string): string | null {
  if (name === "") return "it is empty";
  // THE ONE THAT MATTERS. Everything below is git's own ref grammar; this is
  // the rule about git's command line.
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
      { suggestion: ["odu", "ci", "history", "list"] },
    );
  }

  // ── freshly claimed: this is NEW work, so now the world matters ──
  //
  // ABSOLUTE FIRST, and explicitly, rather than leaning on `probeCheckout` to
  // fail. A relative path resolves against the DAEMON's cwd — which is
  // wherever the shell that first started it happened to be, possibly months
  // ago and possibly deleted since. `probeCheckout` would usually answer "not a
  // repository" and the refusal would be true by accident; the case that
  // matters is when it is not, and a run starts in a directory the caller has
  // never seen. The message already tells callers this path is absolute; this
  // is the check that makes the sentence true.
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
  // The same rule, for the same reason, one field over. `hostsFile` is read by
  // the COORDINATOR — a child of the daemon, whose cwd is the checkout — so a
  // relative one would name a file inside the repository being tested rather
  // than the one the caller's shell meant. That is a config a run could ship
  // its own copy of, which is the one shape this must never allow.
  // `""` is exempt because it is not a path: it is a caller saying its shell
  // has no `$ODU_HOSTS`, which is exactly what `loadHosts` reads it as.
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
  // ── THE TWO FIELDS THAT REACH GIT'S ARGV, CHECKED BEFORE THEY DO ──
  //
  // `expectedSha` and `branch` are the only caller strings a start can put in
  // front of git (`git fetch origin -- <branch>`, `git checkout -B <branch>
  // <sha>`). `execFile` takes the shell out of it and takes nothing out of
  // GIT'S OWN option parsing: `branch: "--upload-pack=<cmd>"` is a command
  // run on this machine by anyone who may start a run. So both are held to
  // their grammars HERE, with nothing of them having been spelled to a
  // subprocess — `git check-ref-format` would itself be a place to send
  // `--upload-pack=…`, which is why the rule below is code rather than a
  // call.
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
  // `let`, because a start that MOVES this checkout re-probes it below and
  // the facts it continues on are the ones after the move.
  let facts = deps.probeCheckout(input.checkout);
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
  // prints.
  const wanted = input.expectedSha.toLowerCase();
  /** What the checkout is on, which the move below can change. */
  let head = facts.head;
  // WITHOUT `branch`, a checkout that is not on that commit is refused rather
  // than substituted: the whole promise of `expectedSha` is that a checkout
  // which moved on gets an answer, not a different run. That is every start
  // from a checkout the caller is standing in, byte for byte as it was.
  //
  // WITH `branch`, the caller is naming a clone the SERVICE keeps and saying
  // where it should be — so this refusal is deferred until after the live-run
  // rule below, which decides whether that tree may be touched at all.
  if (!head.toLowerCase().startsWith(wanted) && input.branch === undefined) {
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

  // ── THE CLONE IS NOT ON THAT COMMIT, AND THE CALLER NAMED A BRANCH ──
  //
  // A GitHub workflow calls `run.start` with the commit it has just pushed,
  // and the service's clone has never heard of it — so the service fetches
  // and moves it rather than refusing every such call (PLAN 4.4).
  //
  // AFTER the live-run rule, which is the ordering this block turns on. A run
  // already in that clone is still answered with itself and nothing is
  // touched; reaching here with one means the caller said `supersede`, and
  // then the incumbent is stopped AND CONFIRMED STOPPED before the tree
  // moves. The coordinator's own cancel-then-claim cannot do it: that happens
  // after the launch, by which time this would already have moved the files
  // under a process still reading them.
  let movedNote: string | null = null;
  if (input.branch !== undefined && !head.toLowerCase().startsWith(wanted)) {
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
      // BOTH SHAS, because the two mistakes behind this are opposite ones: a
      // commit that is on another branch, and one that was force-pushed away.
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
    // RE-PROBED rather than trusted: the port says what it did, and this says
    // what the checkout now IS. They agree in every ordinary case, and the
    // case they do not is somebody else moving that tree in between — which
    // must not reach a launch as the commit this start asked for.
    facts = deps.probeCheckout(input.checkout);
    if (facts.head === null || !facts.head.toLowerCase().startsWith(wanted)) {
      return refuseAndRecord(
        deps,
        input.requestId,
        "checkout_refused",
        `odu: ${input.checkout} was moved to ${input.branch} at ` +
          `${outcome.head.slice(0, 12)} and reads ` +
          `${facts.head === null ? "no HEAD" : facts.head.slice(0, 12)} now — ` +
          "something else is moving this checkout",
      );
    }
    head = facts.head;
    movedNote = `moved ${input.checkout} to ${input.branch} at ${head.slice(0, 7)}`;
  }

  const runId = claim.receipt.plannedRunId;
  // ── WHERE THIS RUN PUSHES (PLAN 4.1) ──
  //
  // After the receipt and after the checkout, because it is the most expensive
  // question asked here — it evaluates somebody else's `flake.nix` — and every
  // cheaper refusal above it must answer first. Its result is NOT part of the
  // request digest: see the module header.
  const prepared = await preparePush(deps.push, input.checkout, runId);
  if (prepared.kind === "ambiguous") {
    // A START IS REFUSED, where a replay is not: this caller is being asked to
    // begin work for a repository that declares two caches, and choosing one
    // would be the service inventing a policy nobody wrote down.
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
    expectedSha: head,
    noStrict: input.noStrict ?? false,
    noSnapshot: input.noSnapshot ?? false,
    noPost: input.noPost ?? false,
    hostPins: [...(input.hostPins ?? [])],
    // Absent on the wire means the CALLER had no `$ODU_HOSTS` — which is a
    // fact to carry, not a gap to fill from this process. Filling it is how
    // the daemon's shell came to decide where other people's runs execute.
    caller: callerOf(input, principal),
    // The caller's explicit "take this checkout". The coordinator does the
    // cancel-then-confirm; this only has to not lose the word.
    supersede: input.supersede ?? false,
    linger: input.linger ?? false,
    // WHERE THIS RUN PUSHES, and what its setup log owes about it. Two
    // fields, because "nothing is pushed, here is why" and "something is, and
    // here is what is wrong with your trust settings" are opposite facts.
    push,
    pushSkipped: prepared.skipped,
    pushKeyWarning: prepared.keyWarning,
    // AND WHETHER THIS CHECKOUT HAD TO BE MOVED to be on that commit — one
    // sentence for the same setup log, beside the push's.
    checkoutMoved: movedNote,
  });
  if (!launched.ok) {
    // THE TOKEN GOES BACK. Nothing ever reached a lane, so a credential left
    // live for a day would be a grant with no run behind it. The FILE the
    // launcher wrote is the launcher's to remove, and it does.
    if (push !== null) deps.push.revoke(push.tokenId);
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
    sha: registered?.sha ?? head,
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
