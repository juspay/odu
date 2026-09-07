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
import { RUN_FILES } from "@odu/run-history/paths";
import { type CatalogOptions, handleFor } from "@odu/run-history/store";
import type { RunScope } from "@odu/run-history/schema";
import {
  oduSelfArgv,
  type SpawnPlan,
  spawnCoordinator,
  waitForReadiness,
} from "./spawn";

/** What a face asks for. Every field is decided before anything is started, so
 *  the request can be recorded, replayed, or refused without a process
 *  existing. */
export interface LaunchRequest {
  readonly checkout: string;
  /** Which catalog the launched run publishes into. Absent means the ambient
   *  one; a test (or a caller with its own root) passes its own, and the
   *  coordinator's log has to land in the SAME catalog as the run it narrates. */
  readonly catalog?: CatalogOptions;
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
  /** Take the checkout from a run that is already in progress there, rather
   *  than being refused by it. The coordinator owns what that MEANS (cancel the
   *  incumbent, confirm it is gone, then claim the lock — see `./run`), and it
   *  has to, because only the process about to hold the lock can do the
   *  cancel-then-confirm without a window. A launcher that dropped this flag
   *  would send a caller's explicit "replace it" into the ordinary
   *  busy-checkout refusal. */
  readonly supersede: boolean;
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
  if (request.supersede) args.push("--supersede");
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
 * MAY A FAILED LAUNCH BE TRIED AGAIN?
 *
 * Only one shape says yes, and getting it wrong doubles a run — so the decision
 * is a pure function rather than a condition inline. `systemd-run` is a
 * SUBMITTER: a non-zero exit from it means the user manager declined to create
 * the unit, which is the only failure that proves nothing was started.
 *
 *   - a ZERO exit means the job was accepted and says nothing about the
 *     service, so a second launch might be a second coordinator;
 *   - a DETACHED spawn's exit is the coordinator's own death, and re-launching
 *     over that would paper over a real refusal (a dirty tree, a bad justfile);
 *   - no exit at all means the readiness ceiling was reached with something
 *     possibly still coming up.
 */
export function mayRelaunchDetached(
  plan: SpawnPlan,
  exitCode: number | null,
): boolean {
  return plan.mechanism === "systemd-run" && exitCode !== null && exitCode !== 0;
}

/** What one launch attempt came to. `managerRefused` is the one outcome a
 *  SECOND attempt is allowed to follow — see {@link mayRelaunchDetached}. */
interface Attempt {
  receipt: LaunchReceipt;
  managerRefused: boolean;
}

async function attemptLaunch(
  request: LaunchRequest,
  endpoint: string,
  env: NodeJS.ProcessEnv,
  lifetime: (plan: SpawnPlan) => string,
): Promise<Attempt> {
  const argv = [...oduSelfArgv(env), ...launchArgv(request)];
  // The coordinator's own narration goes into its catalog directory, beside
  // the evidence it is about to produce. The run id is pre-minted, so the
  // path exists to be named before the process does — and a launcher that
  // exits (as this one does, the moment the socket answers) must not leave
  // the child writing into a pipe nobody is reading. See `spawnCoordinator`.
  const spawned = spawnCoordinator(
    argv,
    request.checkout,
    unitNameFor(request.runId),
    coordinatorLogPath(request.runId, request.catalog ?? {}),
    env,
  );
  // Remembered rather than awaited on the failure path: under `systemd-run`
  // the readiness wait can end on its own ceiling while the submitter is
  // still around, and `await`ing an exit that has not happened would hang the
  // very call that is trying to report a failure. Registered BEFORE the wait,
  // so by the time the wait has resolved this has too.
  let exitCode: number | null = null;
  void spawned.onExit.then((code) => {
    exitCode = code;
  });
  // Readiness, not "did the process we forked exit". Under `systemd-run`
  // the process we forked is a SUBMITTER that exits while the service is
  // still starting, so reading its exit as the coordinator's would refuse a
  // run that is coming up — and leave it running with nobody watching.
  // `waitForReadiness` asks the PLAN which of those it just started.
  const up = await waitForReadiness(spawned.plan, endpoint, spawned.onExit);
  if (up) {
    return {
      managerRefused: false,
      receipt: {
        ok: true,
        runId: request.runId,
        endpoint,
        ...(spawned.child.pid === undefined ? {} : { pid: spawned.child.pid }),
        lifetime: lifetime(spawned.plan),
      },
    };
  }
  const tail = spawned.stderrTail().trim();
  return {
    managerRefused: mayRelaunchDetached(spawned.plan, exitCode),
    receipt: {
      ok: false,
      runId: request.runId,
      endpoint,
      error:
        tail !== ""
          ? tail
          : exitCode === null
            ? "the coordinator did not serve a socket in time"
            : spawned.plan.describeExit(exitCode),
    },
  };
}

/**
 * The packaged launcher: start `odu run` for this request and return once its
 * socket answers.
 *
 * Waiting for the socket is what makes the receipt worth anything. A launcher
 * that returned as soon as `spawn` succeeded would hand back a run id that may
 * belong to a process which died on the strict gate a millisecond later, and
 * the caller would then wait thirty seconds on a run that never existed.
 *
 * **A user manager that refuses the unit is not a failed run.** The plan probes
 * for a session bus before it chooses `systemd-run`, but a socket that exists is
 * not yet a manager that will accept a job — a container, a locked-down runner,
 * a user with `linger` off. When the submitter comes back non-zero, NOTHING was
 * started, so the launch is made again the way it would have been made on a host
 * with no systemd at all. The receipt says which one it got: `lifetime` is the
 * field where "your run survives this shell" and "your run dies with this unit"
 * are different sentences, and a fallback that stayed quiet would print the
 * first while meaning the second.
 */
export function packagedLauncher(): RunLauncher {
  return async (request) => {
    const endpoint = runSocketPath(request.checkout);
    const first = await attemptLaunch(request, endpoint, process.env, lifetimeOf);
    if (!first.managerRefused) return first.receipt;
    // The opt-out the plan already honours, set for this one retry — so the
    // fallback re-uses the decision rather than adding a second way to spell it.
    const refusal = first.receipt.error ?? "the user manager refused the unit";
    const second = await attemptLaunch(
      request,
      endpoint,
      { ...process.env, ODU_NO_SYSTEMD_RUN: "1" },
      (plan) =>
        `the coordinator is a detached process group — systemd-run refused ` +
        `the unit, so odu started it directly (${plan.reason}). It shares this ` +
        `process's cgroup: a restart of the enclosing unit will kill the run.`,
    );
    if (second.receipt.ok) return second.receipt;
    return {
      ...second.receipt,
      error: `${refusal}\nodu then started it directly, and that failed too: ${second.receipt.error}`,
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
export function coordinatorLogPath(
  runId: string,
  /** WHICH catalog. Omitted means the ambient one, which is right in
   *  production and wrong under an injected root — a relaunch would write the
   *  child's log into the developer's real catalog while the run itself lived
   *  in a temp one, where retention could never see it. The same options every
   *  other reader of this catalog already threads. */
  catalog: CatalogOptions = {},
): string {
  // The NAME comes from the package that owns the layout, so retention's
  // evidence partition can see this file. Spelling it here is how it came to
  // survive expiry forever.
  return join(handleFor(runId, catalog).dir, RUN_FILES.coordinatorLog);
}
