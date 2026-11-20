import { dirname, join } from "node:path";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { runSocketPath } from "@odu/run-client/dial";
import { RUN_FILES } from "@odu/run-history/paths";
import {
  type CatalogOptions,
  handleFor,
  readManifest,
} from "@odu/run-history/store";
import type { RunScope } from "@odu/run-history/schema";
import {
  oduSelfArgv,
  type SpawnPlan,
  spawnCoordinator,
  waitForReadiness,
} from "./spawn";

export interface LaunchPush {
  readonly substituter: string;
  readonly origin: string;
  readonly bucket: string;
  readonly tokenId: string;
  readonly token: string;
}

export const PUSH_NOTE_MAX = 512;

export interface LaunchRequest {
  readonly checkout: string;
  readonly catalog?: CatalogOptions;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly requestId: string | null;
  readonly scope: RunScope;
  readonly expectedSha: string;
  readonly noStrict: boolean;
  readonly noSnapshot: boolean;
  readonly noPost: boolean;
  readonly hostPins: readonly string[];
  readonly hostsFile: string | null;
  readonly actor: string | null;
  readonly supersede: boolean;
  readonly linger: boolean;
  readonly push: LaunchPush | null;
  readonly pushSkipped: string | null;
  readonly pushKeyWarning: string | null;
  readonly checkoutMoved: string | null;
}

export interface LaunchReceipt {
  ok: boolean;
  runId: string;
  endpoint: string;
  pid?: number;
  lifetime?: string;
  error?: string;
}

export type RunLauncher = (request: LaunchRequest) => Promise<LaunchReceipt>;

export const COORDINATOR_VERB = "run-coordinator";

export function launchArgv(request: LaunchRequest): string[] {
  const args = [COORDINATOR_VERB, ...request.scope.selectors];
  for (const p of request.scope.platforms) args.push("--platform", p);
  for (const h of request.hostPins) args.push("--host", h);
  if (request.scope.root !== undefined) args.push("--root", request.scope.root);
  if (request.scope.noDeps) args.push("--no-deps");
  if (request.noStrict) args.push("--no-strict");
  if (request.noSnapshot) args.push("--no-snapshot");
  if (request.noPost) args.push("--no-post");
  if (request.supersede) args.push("--supersede");
  if (request.linger) args.push("--linger");
  args.push("--run-id", request.runId);
  args.push("--expected-sha", request.expectedSha);
  if (request.parentRunId !== null) {
    args.push("--parent-run", request.parentRunId);
  }
  if (request.requestId !== null) {
    args.push("--request-id", request.requestId);
  }
  if (request.actor !== null) {
    args.push("--actor", request.actor);
  }
  if (request.push !== null) {
    args.push("--push", request.push.substituter);
    args.push("--push-origin", request.push.origin);
    args.push("--push-bucket", request.push.bucket);
    args.push("--push-token-id", request.push.tokenId);
  }
  if (request.pushSkipped !== null) {
    args.push("--push-skipped", request.pushSkipped.slice(0, PUSH_NOTE_MAX));
  }
  if (request.pushKeyWarning !== null) {
    args.push("--push-key-warning", request.pushKeyWarning.slice(0, PUSH_NOTE_MAX));
  }
  if (request.checkoutMoved !== null) {
    args.push("--checkout-moved", request.checkoutMoved.slice(0, PUSH_NOTE_MAX));
  }
  return args;
}

export function unitNameFor(runId: string): string {
  return `odu-run-${runId}`;
}

function lifetimeOf(plan: SpawnPlan): string {
  return plan.mechanism === "systemd-run"
    ? `the coordinator runs as its own transient user service — ${plan.reason}`
    : `the coordinator is a detached process group — ${plan.reason}`;
}

export function mayRelaunchDetached(
  plan: SpawnPlan,
  exitCode: number | null,
): boolean {
  return plan.mechanism === "systemd-run" && exitCode !== null && exitCode !== 0;
}

function runIsRegistered(request: LaunchRequest): boolean {
  return (
    readManifest(handleFor(request.runId, request.catalog ?? {})) !== null
  );
}

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
  if (request.push !== null) {
    const tokenPath = pushTokenPath(request.runId, request.catalog ?? {});
    mkdirSync(dirname(tokenPath), { recursive: true });
    rmSync(tokenPath, { force: true });
    // `O_NOFOLLOW` has no string spelling in `fs`'s flag grammar, so the
    const handle = openSync(
      tokenPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(handle, request.push.token);
    } finally {
      closeSync(handle);
    }
  }
  const spawned = spawnCoordinator(
    argv,
    request.checkout,
    unitNameFor(request.runId),
    coordinatorLogPath(request.runId, request.catalog ?? {}),
    env,
  );
  let exitCode: number | null = null;
  void spawned.onExit.then((code) => {
    exitCode = code;
  });
  const up = await waitForReadiness(
    spawned.plan,
    () => Promise.resolve(runIsRegistered(request)),
    spawned.onExit,
  );
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
            ? `the coordinator never registered run ${request.runId}`
            : spawned.plan.describeExit(exitCode),
    },
  };
}

export function coordinatorEnv(
  request: LaunchRequest,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (request.hostsFile !== null) env.ODU_HOSTS = request.hostsFile;
  return env;
}

export function packagedLauncher(): RunLauncher {
  return async (request) => {
    const receipt = await launchOnce(request);
    if (!receipt.ok && request.push !== null) {
      dropPushToken(request.runId, request.catalog ?? {});
    }
    return receipt;
  };
}

async function launchOnce(request: LaunchRequest): Promise<LaunchReceipt> {
  const endpoint = runSocketPath(request.checkout);
  const base = coordinatorEnv(request, process.env);
  const first = await attemptLaunch(request, endpoint, base, lifetimeOf);
  if (!first.managerRefused) return first.receipt;
  const refusal = first.receipt.error ?? "the user manager refused the unit";
  const second = await attemptLaunch(
    request,
    endpoint,
    { ...base, ODU_NO_SYSTEMD_RUN: "1" },
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
}

export function checkoutLockPath(checkout: string): string {
  return join(checkout, ".ci", "odu.run.lock");
}

export function coordinatorLogPath(
  runId: string,
  catalog: CatalogOptions = {},
): string {
  return join(handleFor(runId, catalog).dir, RUN_FILES.coordinatorLog);
}

export function pushTokenPath(
  runId: string,
  catalog: CatalogOptions = {},
): string {
  return join(handleFor(runId, catalog).dir, RUN_FILES.pushToken);
}

export function takePushToken(
  runId: string | undefined,
  catalog: CatalogOptions = {},
): string | null {
  if (runId === undefined) return null;
  const path = pushTokenPath(runId, catalog);
  try {
    const token = readFileSync(path, "utf-8").trim();
    rmSync(path, { force: true });
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

export function dropPushToken(runId: string, catalog: CatalogOptions = {}): void {
  rmSync(pushTokenPath(runId, catalog), { force: true });
}
