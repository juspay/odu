import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { dialRun } from "@odu/run-client/dial";
import { errorMessage, firstFrame, runUnary } from "@odu/execution/common/effectEdge";
import type { Forge } from "@odu/execution/common/forge";
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
  CheckoutMoveOutcome,
  CheckoutMoveRequest,
  PushPort,
  PushResolution,
  PushTarget,
  ServicePorts,
} from "@odu/service/ports";
import { actorOf } from "@odu/service/caller";
import { preparePush } from "@odu/service/pushGrant";

const execFileAsync = promisify(execFile);

/**
 * macOS resolves `/tmp` to `/private/tmp`, so the path a caller typed and the
 * `--show-toplevel` a run recorded are routinely two strings for one directory.
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
  // `git rev-parse HEAD` that exits 0 and says nothing has told us nothing:
  // `null` is what "we do not know" looks like.
  const said = head.status === 0 ? head.stdout.trim() : "";
  return {
    isRepo: true,
    head: said === "" ? null : said,
    branch: gitBranch(checkout),
    liveRunId: live?.runId ?? null,
  };
}

/**
 * One git command, off the event loop, as TWO shapes.
 *
 * `merge-base --is-ancestor` exits 1 for a plumbing command's "no" and 128 for
 * "I could not look", so the EXIT CODE is carried beside the output.
 */
type GitRan =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: number | null; readonly said: string };

async function runGit(checkout: string, args: readonly string[]): Promise<GitRan> {
  try {
    const done = await execFileAsync("git", [...args], {
      cwd: checkout,
      encoding: "utf-8",
      maxBuffer: GIT_OUTPUT_MAX,
    });
    return { ok: true, value: done.stdout.trim() };
  } catch (err) {
    const failure = err as {
      code?: unknown;
      stderr?: string;
      stdout?: string;
      message?: string;
    };
    const text = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim();
    return {
      ok: false,
      // A NUMBER or nothing: a spawn that never ran git at all answers
      // `ENOENT` here, which is not an exit status and must not be read as one.
      code: typeof failure.code === "number" ? failure.code : null,
      said: gitSaid(text === "" ? (failure.message ?? "git failed") : text),
    };
  }
}

const GIT_OUTPUT_MAX = 1024 * 1024;

const GIT_SAID_MAX = 400;

function gitSaid(out: string): string {
  const lines = out.split("\n").slice(0, 5).join("; ");
  return lines.length <= GIT_SAID_MAX ? lines : `${lines.slice(0, GIT_SAID_MAX)}…`;
}

/**
 * The fetched tip is read from `FETCH_HEAD` — what THIS fetch brought back.
 * `origin/<branch>` is the same commit in an ordinary clone and is not updated
 * at all in one whose remote has no fetch refspec.
 *
 * `merge-base --is-ancestor` exits 1 for "not reachable" and anything else for
 * "could not look", so `cat-file -e` and that exit code are read apart.
 */
export async function moveCheckout({
  checkout,
  branch,
  sha,
}: CheckoutMoveRequest): Promise<CheckoutMoveOutcome> {
  const dirty = await runGit(checkout, ["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok) return { kind: "failed", detail: dirty.said };
  if (dirty.value !== "") return { kind: "dirty", detail: gitSaid(dirty.value) };
  // `checkout -B` cannot take `--`: a `--` there begins PATHS, not a
  // start-point.
  const fetched = await runGit(checkout, ["fetch", "origin", "--", branch]);
  if (!fetched.ok) return { kind: "fetch_failed", detail: fetched.said };
  const tip = await runGit(checkout, ["rev-parse", "FETCH_HEAD"]);
  if (!tip.ok) return { kind: "failed", detail: tip.said };
  // A sha from another branch is one the fetch above did not bring, so the
  // object does not exist locally and `merge-base` cannot compare it.
  const present = await runGit(checkout, ["cat-file", "-e", `${sha}^{commit}`]);
  if (!present.ok) return { kind: "not_on_branch", tip: tip.value };
  const contains = await runGit(checkout, [
    "merge-base",
    "--is-ancestor",
    "--",
    sha,
    tip.value,
  ]);
  if (!contains.ok && contains.code !== 1) {
    return { kind: "failed", detail: contains.said };
  }
  if (!contains.ok) return { kind: "not_on_branch", tip: tip.value };
  const moved = await runGit(checkout, ["checkout", "-B", branch, sha]);
  if (!moved.ok) return { kind: "failed", detail: moved.said };
  const head = await runGit(checkout, ["rev-parse", "HEAD"]);
  if (!head.ok) return { kind: "failed", detail: head.said };
  if (head.value === "") return { kind: "failed", detail: "git read no HEAD back" };
  return { kind: "moved", head: head.value };
}

export function resolvePush(
  checkout: string,
  grants: CacheGrants,
  env: NodeJS.ProcessEnv,
): Promise<PushResolution> {
  return resolvePushWith(checkout, grants, (dir) =>
    readFlakeNixConfig(dir, nixEvalFlakeConfig(env)),
  );
}

const RESOLVE_SUBSTITUTER_MAX = 16;

export async function resolvePushWith(
  checkout: string,
  grants: CacheGrants,
  readConfig: (checkout: string) => Promise<FlakeNixConfigOutcome>,
): Promise<PushResolution> {
  if (!grants.serves()) {
    return { kind: "skipped", reason: "this daemon serves no cache" };
  }
  const config = await readConfig(checkout);
  if (!config.ok) return { kind: "skipped", reason: config.reason };
  if (config.config.substituters.length === 0) {
    return { kind: "skipped", reason: "flake.nix nixConfig names no substituters" };
  }
  const substituters = config.config.substituters.slice(0, RESOLVE_SUBSTITUTER_MAX);
  const grantable: PushTarget[] = [];
  for (const substituter of substituters) {
    const bucket = grants.bucketAt(substituter);
    if (bucket === null) continue;
    grantable.push({
      substituter: bucket.substituter,
      origin: bucket.origin,
      bucket: bucket.name,
      keyWarning: config.config.trustedPublicKeys.includes(bucket.publicKey)
        ? null
        : `${bucket.substituter} is pushed to, but its key is missing from ` +
          `trusted-public-keys — add "${bucket.publicKey}" to flake.nix ` +
          "nixConfig or nothing will substitute from it",
    });
  }
  if (grantable.length === 0) {
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

export interface WebPorts {
  ports: ServicePorts;
}

export function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

export function webPorts(
  grants: CacheGrants,
  env: NodeJS.ProcessEnv,
  forge: Forge,
): WebPorts {
  const launcher = packagedLauncher();
  const push: PushPort = {
    resolve: (checkout) => resolvePush(checkout, grants, env),
    grant: ({ bucket, runId }) => {
      const minted = grants.mint({ bucket, runId });
      return minted === null ? null : { tokenId: minted.id, token: minted.token };
    },
    revoke: (tokenId) => grants.revoke(tokenId),
  };
  const replayLauncher: typeof launcher = async (request) => {
    const prepared = await preparePush(push, request.checkout, request.runId);
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
    if (!launched.ok && prepared.kind === "prepared") prepared.release();
    return launched;
  };
  const ports: ServicePorts = {
    launch: ({ caller, ...request }) =>
      launcher({
        ...request,
        hostsFile: caller.hostsFile,
        actor: actorOf(caller.principal),
      }),
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
    moveCheckout,
    push,
    pipeline: readPipeline,
    probeVenues,
    holdVenue,
    releaseVenue,
    protect: protectBranch(forge),
  };
  return { ports };
}

const TEARDOWN_CONFIRM_MS = 10_000;

async function socketGone(endpoint: string): Promise<boolean> {
  const dialed = await dialRun(endpoint).catch(() => null);
  if (dialed === null) return true;
  await dialed.close();
  return false;
}

async function confirmTeardown(
  endpoint: string,
  acked: boolean,
): Promise<CancelOutcome> {
  const deadline = Date.now() + TEARDOWN_CONFIRM_MS;
  for (;;) {
    if (await socketGone(endpoint)) {
      return { kind: "cancelled", detail: null };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return acked
    ? {
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

async function dispatchCancel({
  coordinator,
  runId,
  scope,
}: CancelRequest): Promise<CancelDispatch> {
  const dialed = await dialRun(coordinator.endpoint);
  if (dialed === null) {
    return { kind: "declined", detail: "nothing is serving this run's socket" };
  }
  try {
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    if (state === undefined || !isSameRun(coordinator, state)) {
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
    return {
      kind: "unresolved",
      detail: `the call to the coordinator failed — ${errorMessage(err)}`,
    };
  } finally {
    await dialed.close();
  }
}
