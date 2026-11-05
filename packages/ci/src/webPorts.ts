/**
 * HOW THE WEB FACE REACHES THE ENGINE — the ports, implemented.
 *
 * `@odu/service` owns cross-run authority and cannot import `@odu/execution`;
 * everything it must CAUSE arrives as a function type. This module is what
 * those types are bound to, and it is the only place on the web face's side of
 * the wall that knows what a coordinator is.
 *
 * The set grew from four to nine when the public commands stopped doing their
 * own work: reading a checkout's pipeline, probing the venues, taking and
 * dropping a hold, and writing a branch's ruleset are all things `odu ci dump`,
 * `odu ci graph`, `odu ci hosts`, `odu ci lease`, `odu ci release` and `odu ci
 * protect` used to do from whatever process the operator typed in. Each of
 * those has an
 * adapter of its own next door — `./pipelinePort`, `./venuePort`,
 * `./protectPort` — because each moves when a different piece of the engine
 * does; this file's job is to be the ONE list of what the service is wired to.
 *
 * It sits apart from `./web` on purpose. That file is a COMPOSITION ROOT and a
 * process lifecycle — claim the gate, bind the listener, serve, tear down — and
 * an adapter that has to reason about ownership records, run identity and
 * teardown confirmation is not lifecycle. Their reasons to change are different
 * ones: this file moves when the engine's contract does, that one when the
 * daemon's does.
 *
 * It is NOT where the cache is constructed any more: the cache is a row, it
 * constructs itself from the services the host provides, and the engine this
 * file binds has never heard of a bucket.
 *
 * The interesting half is `cancel`, and the note on {@link cancelThroughSocket}
 * is why.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dialRun } from "@odu/run-client/dial";
import { errorMessage, firstFrame, runUnary } from "@odu/execution/common/effectEdge";
import { ghForge } from "@odu/execution/common/forge";
import { packagedLauncher } from "@odu/execution/coordinator/launcher";
import {
  isSameRun,
  retryRun as retryRecordedRun,
} from "@odu/execution/coordinator/recovery";
import { gitBranch } from "@odu/execution/common/git";
import { type CatalogOptions, listRuns } from "@odu/run-history/store";
import { readPipeline } from "./pipelinePort";
import { holdVenue, probeVenues, releaseVenue } from "./venuePort";
import { protectBranch } from "./protectPort";
import type { FlakeNixConfigOutcome } from "@odu/cache/push";
import { nixEvalFlakeConfig, readFlakeNixConfig } from "@odu/cache/push";
import type { CacheGrants } from "@odu/cordis/services";
import type {
  CancelOutcome,
  CancelRequest,
  CheckoutFacts,
  PushPort,
  PushResolution,
  PushTarget,
  ServicePorts,
} from "@odu/service/ports";
import { preparePush } from "@odu/service/pushGrant";

/**
 * What the service can learn about a checkout without running anything.
 *
 * The live-run question is asked of the CATALOG, not of the checkout: a socket
 * file is not a run (it outlives the coordinator that made it), and the
 * ownership record is the copy a heartbeat refreshes and a clean exit clears.
 * Asking the catalog also means the answer is a run ID a caller can address,
 * rather than "something is listening over there".
 *
 * **The catalog is asked with GIT'S OWN NAME for the checkout**, not with the
 * path the caller typed. A run records `repoRoot` from the coordinator's
 * `--show-toplevel`, which is resolved; a caller's path need not be. On macOS
 * `/tmp` is a symlink to `/private/tmp`, so the two are routinely different
 * strings for one directory — and comparing them as given made a busy checkout
 * look free. The service then launched, the coordinator refused the checkout it
 * could see was busy, and the caller got `launch_failed` where the answer was
 * "that run is already there".
 */
export function probeCheckout(
  checkout: string,
  catalog: CatalogOptions = {},
): CheckoutFacts {
  if (!existsSync(checkout)) {
    return { isRepo: false, head: null, branch: null, liveRunId: null };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: checkout,
    encoding: "utf-8",
  });
  if (top.status !== 0) {
    return { isRepo: false, head: null, branch: null, liveRunId: null };
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf-8",
  });
  const live = listRuns({ ...catalog, repoRoot: top.stdout.trim() }).find(
    (row) => row.liveness === "owned" && row.endpoint !== null,
  );
  // AN EMPTY ANSWER IS NOT AN ANSWER. `git rev-parse HEAD` that exits 0 and
  // says nothing has told us nothing, and reporting `""` as the head made the
  // refusal downstream read "this checkout is at , not 7ba435e" — a sentence
  // asserting a commit odu never read, seen on a loaded runner where the daemon
  // could not get output back from its subprocesses at all. `null` is what "we
  // do not know" looks like, and every reader already handles it.
  const said = head.status === 0 ? head.stdout.trim() : "";
  return {
    isRepo: true,
    head: said === "" ? null : said,
    branch: gitBranch(checkout),
    liveRunId: live?.runId ?? null,
  };
}

/**
 * WHERE A CHECKOUT'S RUN PUSHES — the resolution PLAN 4.1 turns on, and the
 * one port that reads a repository's Nix configuration.
 *
 * Two steps, and the second is the whole security argument:
 *
 *   1. **The repository's own declaration.** `flake.nix`'s `nixConfig`, which
 *      a consumer already keeps because it is how it READS from the cache.
 *      Nothing else is asked of the repo — no recipe step, no token, no key.
 *      Evaluated under restraint, in a scratch environment with
 *      `restrict-eval`: see `@odu/cache/push`'s `nixEvalFlakeConfig`.
 *   2. **Which of those substituter URLs THIS DAEMON SERVES.** Asked of the
 *      cache row through `bucketAt`, which matches the URL against the set
 *      this daemon advertises and dials nothing.
 *
 * **Nothing a repository says about a cache is believed.** The first shape of
 * this asked each substituter for its `nix-cache-info` and took the grant out
 * of the `Odu-Origin` / `Odu-Bucket` lines in the body — so a flake naming an
 * attacker's host, answering with any bucket name served here, collected a
 * write token for that bucket and then had it posted to the attacker's own
 * server as a Bearer header. A URL match cannot be forged, costs no request,
 * and resolves a PRIVATE bucket (whose `nix-cache-info` is a 404 to an
 * anonymous reader) exactly as well as a public one.
 *
 * **The interim bound, until orgs land in PLAN 3.1, is the OPERATOR's.** Any
 * checkout this daemon runs can push to any bucket this daemon serves, because
 * there is no row yet that says which repository owns which bucket. That is
 * the reason `run.start` only ever reaches here for a checkout the operator
 * already handed it, and it is stated in `PLAN.md`'s `[^runpush]`, the docs
 * and the skill rather than left to be discovered.
 *
 * Two grantable caches REFUSE the run, with both URLs. A repository builds for
 * one cache; choosing between two would be this port inventing a policy, and
 * the override key stays unwritten until somebody hits the case.
 */
export function resolvePush(
  checkout: string,
  grants: CacheGrants,
  /** The daemon's own environment, HANDED IN — this module reads none. The
   *  evaluator forwards only the names that LOCATE a Nix store out of it,
   *  which is what keeps `$ODU_ROOT_TOKEN` out of reach of a
   *  `builtins.getEnv` in somebody's `flake.nix`. */
  env: NodeJS.ProcessEnv,
): Promise<PushResolution> {
  return resolvePushWith(checkout, grants, (dir) =>
    readFlakeNixConfig(dir, nixEvalFlakeConfig(env)),
  );
}

/** How many `nixConfig` substituters a resolution will look at. A flake that
 *  reads from more caches than this is not a flake; it is an argument for
 *  spending the daemon's event loop. */
const RESOLVE_SUBSTITUTER_MAX = 16;

/** The resolution, with its one reading of the world injected — the seam a
 *  suite states a flake through. */
export async function resolvePushWith(
  checkout: string,
  grants: CacheGrants,
  readConfig: (checkout: string) => Promise<FlakeNixConfigOutcome>,
): Promise<PushResolution> {
  // BEFORE THE FLAKE IS READ AT ALL. A daemon serving no cache can grant
  // nothing, and evaluating every repository's Nix to find that out would be
  // a cost — and an exposure — paid for an answer that is already known.
  if (!grants.serves()) {
    return { kind: "skipped", reason: "this daemon serves no cache" };
  }
  const config = await readConfig(checkout);
  if (!config.ok) return { kind: "skipped", reason: config.reason };
  if (config.config.substituters.length === 0) {
    return { kind: "skipped", reason: "flake.nix nixConfig names no substituters" };
  }
  // AS MANY AS A REAL FLAKE HAS, AND NO MORE. The list is a repository's, the
  // loop below runs on the daemon's single event loop during `run.start`, and
  // the eval's 64 KiB stdout cap is the only other bound on its length — so a
  // branch declaring ten thousand substituters would be a repeatable way to
  // spend the daemon's time on a question whose answer is in the first few.
  const substituters = config.config.substituters.slice(0, RESOLVE_SUBSTITUTER_MAX);
  const grantable: PushTarget[] = [];
  for (const substituter of substituters) {
    const bucket = grants.bucketAt(substituter);
    if (bucket === null) continue;
    grantable.push({
      substituter: bucket.substituter,
      origin: bucket.origin,
      bucket: bucket.name,
      // A REPOSITORY THAT CANNOT VERIFY WHAT IT READS is still worth pushing
      // for — the bytes are correct and the next machine may trust the key —
      // so this is a warning and never a refusal.
      keyWarning: config.config.trustedPublicKeys.includes(bucket.publicKey)
        ? null
        : `${bucket.substituter} is pushed to, but its key is missing from ` +
          `trusted-public-keys — add "${bucket.publicKey}" to flake.nix ` +
          "nixConfig or nothing will substitute from it",
    });
  }
  if (grantable.length === 0) {
    // ONE SENTENCE, and it says what odu knows: a substituter this daemon
    // does not serve is indistinguishable here from `cache.nixos.org`, and
    // guessing which it was would be the body-trusting resolution again.
    return {
      kind: "skipped",
      reason:
        "no substituter in flake.nix nixConfig is a cache this odu serves " +
        `(${substituters.join(", ")})`,
    };
  }
  if (grantable.length > 1) {
    return {
      kind: "ambiguous",
      substituters: grantable.map((target) => target.substituter),
    };
  }
  return { kind: "target", target: grantable[0] as PushTarget };
}

/** What the web face needs from its root: the ports, and nothing else — the
 *  cache is a row that constructs itself. */
export interface WebPorts {
  ports: ServicePorts;
}

/** An environment variable's value, or `null` when it is unset or blank. A
 *  blank `$ODU_ROOT_TOKEN=` is the same absence as no variable at all, and
 *  reading it as a real token would make an empty string a credential. */
export function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/**
 * The ports the service is bound to — the ONE place the web face is wired to
 * the engine. Everything below this line knows what a coordinator is;
 * `@odu/service` does not.
 *
 * Nothing is read from the environment here: every fact the ports need arrives
 * from the host, which is the one place that reads one.
 */
export function webPorts(
  grants: CacheGrants,
  /** The daemon's environment, for the ONE thing below that needs one: the
   *  parent environment a `flake.nix` evaluation is given a minimal slice of.
   *  A parameter, so the sentence above stays true of this module. */
  env: NodeJS.ProcessEnv,
): WebPorts {
  const launcher = packagedLauncher();
  // ONE forge for this service's life, and the SAME implementation the
  // coordinator constructs for its statuses. Two constructions of `gh` in one
  // product is two places a credential decision would have to be threaded
  // through, which is exactly what the port exists to stop.
  const forge = ghForge();
  const push: PushPort = {
    resolve: (checkout) => resolvePush(checkout, grants, env),
    grant: ({ bucket, runId }) => {
      const minted = grants.mint({ bucket, runId });
      return minted === null ? null : { tokenId: minted.id, token: minted.token };
    },
    revoke: (tokenId) => grants.revoke(tokenId),
  };
  /**
   * The launcher a REPLAY goes through — the same one, with the push target
   * resolved again from the checkout it is about to run in.
   *
   * A replay is a new run, with a new id and a new token, and the cache its
   * checkout reads from is a fact about the world rather than about the run
   * being replayed. Freezing the parent's bucket into it would be the same
   * mistake recording a resolved host pool would be, and replaying its TOKEN
   * is not even possible: that one was revoked when the parent settled.
   */
  const replayLauncher: typeof launcher = async (request) => {
    const prepared = await preparePush(push, request.checkout, request.runId);
    // AMBIGUITY IS NOT A REFUSAL HERE, where a `run.start` refuses it: a
    // replay of a recorded run must not be turned away by a fact about the
    // world that changed after the run it replays. It runs, and says so.
    const launched =
      prepared.kind === "ambiguous"
        ? await launcher({
            ...request,
            push: null,
            pushSkipped:
              "this checkout reads from two odu caches " +
              `(${prepared.substituters.join(", ")})`,
            pushKeyWarning: null,
          })
        : await launcher({
            ...request,
            push: prepared.push,
            pushSkipped: prepared.skipped,
            pushKeyWarning: prepared.keyWarning,
          });
    // THE TOKEN GOES BACK when nothing was started, exactly as `run.start`
    // does on its own failed launch: a credential with no run behind it is
    // one that only its expiry would ever take away. The FILE the launcher
    // wrote is the launcher's own to remove, and it does.
    const minted = prepared.kind === "prepared" ? prepared.push : null;
    if (!launched.ok && minted !== null) push.revoke(minted.tokenId);
    return launched;
  };
  const ports: ServicePorts = {
    // The engine's `LaunchRequest` still spells the caller's inventory as the
    // flat `hostsFile` it has always taken; the port hands it a Caller. The
    // adaptation belongs HERE, at the root, because `@odu/service` cannot name
    // the engine's type and `@odu/execution` cannot name the service's.
    launch: ({ caller, ...request }) =>
      launcher({ ...request, hostsFile: caller.hostsFile }),
    retry: (request) =>
      retryRecordedRun({
        runId: request.runId,
        selector: request.selector,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
        ...(request.expectAttempt === undefined
          ? {}
          : { expectAttempt: request.expectAttempt }),
        ...(request.catalog === undefined ? {} : { catalog: request.catalog }),
        launcher: replayLauncher,
      }),
    cancel: cancelThroughSocket,
    probeCheckout,
    push,
    // The five that made `odu ci hosts`, `odu ci lease`, `odu ci release`,
    // `odu ci dump`, `odu ci graph` and `odu ci protect` clients of the shared
    // authority rather than six programs doing their own work in whatever
    // process the operator typed in. Bound by reference where the shape allows
    // it: a lambda here would be a second place their contract could drift.
    pipeline: readPipeline,
    probeVenues,
    holdVenue,
    releaseVenue,
    protect: protectBranch(forge),
  };
  return { ports };
}

/** How long a whole-run cancel waits for the socket to go away before it says
 *  it does not know. Teardown finalizes posted statuses and closes lanes, so it
 *  is not instant; bounded, because a caller must eventually be answered. */
const TEARDOWN_CONFIRM_MS = 10_000;

/** Has the coordinator let go of this socket? The run surface's own documented
 *  confirmation for a cancel — the ack may never flush, the socket always
 *  goes. */
async function socketGone(endpoint: string): Promise<boolean> {
  const dialed = await dialRun(endpoint).catch(() => null);
  if (dialed === null) return true;
  await dialed.close();
  return false;
}

/**
 * Reach the coordinator serving a run and stop what the caller named — after
 * proving it is that run.
 *
 * The identity check is not a nicety. `owner.json` keeps a crashed
 * coordinator's endpoint for the ownership grace, and a checkout serves one run
 * after another on one socket path, so the window where "the address the dead
 * run recorded" and "the address the live run is on" are the same string is a
 * real one. `isSameRun` is the retry policy's own comparison, reused rather
 * than re-derived: one answer to "is this the run I mean".
 */
async function cancelThroughSocket(
  request: CancelRequest,
): Promise<CancelOutcome> {
  const dispatched = await dispatchCancel(request);
  if (dispatched.kind !== "await-teardown") return dispatched;
  // The whole-run case, and the connection is CLOSED before this: the caller
  // confirms teardown by the socket going away, and a dial this process is
  // still holding open is not a socket that has gone away.
  const deadline = Date.now() + TEARDOWN_CONFIRM_MS;
  for (;;) {
    if (await socketGone(request.endpoint)) {
      return { kind: "cancelled", detail: null };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return dispatched.acked
    ? {
        // It said yes. Teardown finalizes posted statuses and closes lanes, and
        // a slow one is not a failed one.
        kind: "cancelled",
        detail: "the coordinator accepted the cancel and is still shutting down",
      }
    : {
        kind: "unresolved",
        detail:
          "the coordinator did not answer and its socket is still up after " +
          `${Math.round(TEARDOWN_CONFIRM_MS / 1000)}s`,
      };
}

/** Dial, prove it is the right run, mutate, and let go. `await-teardown` is the
 *  whole-run arm, which cannot be settled from this side of the connection. */
async function dispatchCancel({
  endpoint,
  runId,
  expect,
  scope,
}: CancelRequest): Promise<
  CancelOutcome | { kind: "await-teardown"; acked: boolean }
> {
  const dialed = await dialRun(endpoint);
  // Nothing serving that path. An ANSWER, not a failure: the run the caller
  // named has no coordinator to stop, and saying so beats a cheerful ok.
  if (dialed === null) {
    return { kind: "declined", detail: "nothing is serving this run's socket" };
  }
  try {
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    if (state === undefined || !isSameRun(expect, state)) {
      return {
        kind: "declined",
        detail:
          `the coordinator on this checkout's socket is not run ${runId} — ` +
          "that run's coordinator is gone and another has taken the checkout, " +
          "so nothing was cancelled",
      };
    }
    switch (scope.kind) {
      case "run": {
        // The reply may never arrive: this call routes into the same teardown a
        // SIGINT takes, and the coordinator may exit before it flushes. So the
        // ack is not what is believed — the socket is — and this arm carries the
        // ack out only as a tiebreaker for the case where the socket stays up.
        const acked = await runUnary(dialed.client.surface.run.cancel({}))
          .then(() => true)
          .catch(() => false);
        return { kind: "await-teardown", acked };
      }
      case "node": {
        const result = await runUnary(
          dialed.client.surface.node.cancel({ id: scope.node }),
        );
        return result.ok
          ? { kind: "cancelled", detail: null }
          : {
              kind: "declined",
              detail: `this run has no node ${scope.node} to cancel`,
            };
      }
      case "lane": {
        const result = await runUnary(
          dialed.client.surface.lane.cancel({ platform: scope.platform }),
        );
        return result.ok
          ? { kind: "cancelled", detail: null }
          : {
              kind: "declined",
              detail: `this run has no ${scope.platform} lane to cancel`,
            };
      }
    }
  } catch (err) {
    // A node or lane cancel whose reply was lost. Those do NOT tear the socket
    // down, so there is no second signal to confirm them by — and a mutation
    // with no confirmation is exactly what `unresolved` is for.
    return {
      kind: "unresolved",
      detail: `the call to the coordinator failed — ${errorMessage(err)}`,
    };
  } finally {
    await dialed.close();
  }
}
