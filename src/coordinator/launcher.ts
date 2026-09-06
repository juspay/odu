/**
 * `RunLauncher` — the port a face asks for a NEW run through, and the packaged
 * implementation the composition root binds it to.
 *
 * A port rather than a function call because two things must not know each
 * other. The retry policy (`./recovery`) decides that a finalized run needs a
 * fresh run from its recorded inputs; how a coordinator process comes to exist
 * is a different question with a different answer per environment, and the CLI
 * that types `odu rerun` has no business holding either. So the policy takes a
 * launcher, the root supplies one, and a test supplies a stub that records the
 * request instead of starting anything.
 *
 * THE REQUEST IS IMMUTABLE AND CARRIES ITS OWN IDENTITY. `runId` is minted by
 * the CALLER, before the spawn, and handed to the child — which is what makes
 * a lost reply recoverable. Without it, a launcher that spawned and then lost
 * its answer has no way to ask "did that run happen?" except by looking for
 * something it cannot name; with it, the question is a directory lookup. The
 * same field is what lets the child link itself to the run it replays.
 */

import { join } from "node:path";
import { runSocketPath } from "@odu/run-client/dial";
import { handleFor } from "@odu/run-history/store";
import type { RunScope } from "@odu/run-history/schema";
import {
  defaultWaitForSocket,
  oduSelfArgv,
  type SpawnPlan,
  spawnCoordinator,
} from "./spawn";

/** What a face asks for. Every field is decided before anything is started, so
 *  the request can be recorded, replayed, or refused without a process
 *  existing. */
export interface LaunchRequest {
  readonly checkout: string;
  /** The id the new run will publish under — minted by the caller. */
  readonly runId: string;
  /** The run this one replays, when it is a recovery. */
  readonly parentRunId: string | null;
  /** The caller's idempotency key, when it supplied one. */
  readonly requestId: string | null;
  /** What to run: the recorded scope of the run being replayed, or a fresh
   *  selection. */
  readonly scope: RunScope;
  /** The commit this run is about. A launcher never substitutes today's HEAD:
   *  a checkout that has moved on is a REFUSAL, made by the child's own strict
   *  gate, not a quiet different run. */
  readonly expectedSha: string;
  /** Strict-mode flags, carried through so a replay reproduces the run it is
   *  replaying rather than today's defaults. */
  readonly noStrict: boolean;
  readonly noSnapshot: boolean;
  readonly noPost: boolean;
  readonly hostPins: readonly string[];
}

export interface LaunchReceipt {
  ok: boolean;
  /** The run id the request named — the same one whether this call started it
   *  or found it already started. */
  runId: string;
  /** Where the new coordinator serves. */
  endpoint: string;
  pid?: number;
  /** How independent the coordinator actually is, and why. Reported rather
   *  than assumed: "your run survives this shell" and "your run dies with this
   *  unit" are different promises and an operator is entitled to know which
   *  one it got. */
  lifetime?: string;
  error?: string;
}

export type RunLauncher = (request: LaunchRequest) => Promise<LaunchReceipt>;

/**
 * The argv a launch request becomes.
 *
 * Pure, exported, and tested: this is the "structured data/argv, never a
 * string to eval" rule made concrete. A face that wants to show a person what
 * a recovery would run prints this array; nothing anywhere builds a shell
 * command out of a user's selectors.
 */
export function launchArgv(request: LaunchRequest): string[] {
  const args = ["run", ...request.scope.selectors];
  for (const p of request.scope.platforms) args.push("--platform", p);
  for (const h of request.hostPins) args.push("--host", h);
  if (request.scope.root !== undefined) args.push("--root", request.scope.root);
  if (request.scope.noDeps) args.push("--no-deps");
  if (request.noStrict) args.push("--no-strict");
  if (request.noSnapshot) args.push("--no-snapshot");
  if (request.noPost) args.push("--no-post");
  // The identity the caller minted, so the child publishes under the id the
  // receipt already names.
  args.push("--run-id", request.runId);
  args.push("--expected-sha", request.expectedSha);
  if (request.parentRunId !== null) {
    args.push("--parent-run", request.parentRunId);
  }
  if (request.requestId !== null) {
    args.push("--request-id", request.requestId);
  }
  return args;
}

/** The transient unit name a systemd-run launch uses. Scoped to the run so two
 *  coordinators never collide, and recognisable so `systemctl --user status`
 *  names the run an operator is asking about. */
export function unitNameFor(runId: string): string {
  return `odu-run-${runId}`;
}

/** The lifetime sentence a receipt carries, from the plan that was used. */
function lifetimeOf(plan: SpawnPlan): string {
  return plan.mechanism === "systemd-run"
    ? `the coordinator runs as its own transient user service — ${plan.reason}`
    : `the coordinator is a detached process group — ${plan.reason}`;
}

/**
 * The packaged launcher: start `odu run` for this request and return once its
 * socket answers.
 *
 * Waiting for the socket is what makes the receipt worth anything. A launcher
 * that returned as soon as `spawn` succeeded would hand back a run id that may
 * belong to a process which died on the strict gate a millisecond later, and
 * the caller would then wait thirty seconds on a run that never existed.
 */
export function packagedLauncher(): RunLauncher {
  return async (request) => {
    const endpoint = runSocketPath(request.checkout);
    const argv = [...oduSelfArgv(), ...launchArgv(request)];
    // The coordinator's own narration goes into its catalog directory, beside
    // the evidence it is about to produce. The run id is pre-minted, so the
    // path exists to be named before the process does — and a launcher that
    // exits (as this one does, the moment the socket answers) must not leave
    // the child writing into a pipe nobody is reading. See `spawnCoordinator`.
    const spawned = spawnCoordinator(
      argv,
      request.checkout,
      unitNameFor(request.runId),
      coordinatorLogPath(request.runId),
    );
    const up = await defaultWaitForSocket(endpoint, spawned.onExit);
    if (!up) {
      const tail = spawned.stderrTail().trim();
      return {
        ok: false,
        runId: request.runId,
        endpoint,
        error:
          tail !== ""
            ? tail
            : "the coordinator exited before serving a socket",
      };
    }
    return {
      ok: true,
      runId: request.runId,
      endpoint,
      ...(spawned.child.pid === undefined ? {} : { pid: spawned.child.pid }),
      lifetime: lifetimeOf(spawned.plan),
    };
  };
}

/** Where a checkout's coordinator lock lives, beside its socket. Named here
 *  because the launcher's refusals cite it. */
export function checkoutLockPath(checkout: string): string {
  return join(checkout, ".ci", "odu.run.lock");
}

/** Where a launched coordinator writes its own account of the run —
 *  `runs/<runId>/coordinator.log` in the catalog. Addressed by RUN, so it is
 *  still findable when the checkout is not, and durable, so a startup failure
 *  survives the launcher that observed it. */
export function coordinatorLogPath(runId: string): string {
  return join(handleFor(runId).dir, "coordinator.log");
}
