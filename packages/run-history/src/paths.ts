import { homedir } from "node:os";
import { join } from "node:path";
import type { LogStream } from "@odu/run-client/nodeId";

export interface StateEnv {
  readonly ODU_STATE_DIR?: string | undefined;
  readonly XDG_STATE_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  /** The index signature is what makes `process.env` assignable here. Named
   *  fields alone are structurally incompatible with `ProcessEnv`. */
  readonly [other: string]: string | undefined;
}

/** The per-user odu state root. Throws only when there is no home and no
 *  override — a machine where no per-user location can be named at all. */
export function stateRoot(
  env: StateEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env.ODU_STATE_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  if (platform === "darwin") {
    const home = homeOf(env);
    return join(home, "Library", "Application Support", "odu");
  }
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg !== undefined && xdg !== "") return join(xdg, "odu");
  return join(homeOf(env), ".local", "state", "odu");
}

function homeOf(env: StateEnv): string {
  const fromEnv = env.HOME?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromOs = homedir();
  if (fromOs !== "") return fromOs;
  throw new Error(
    "odu: no home directory to put the run catalog in — set ODU_STATE_DIR",
  );
}

/** The catalog: one directory per run, named by run id. */
export function catalogRoot(env?: StateEnv, platform?: NodeJS.Platform): string {
  return join(stateRoot(env, platform), "runs");
}

/** One run's directory. The run id is validated by the caller (`isRunId`)
 *  before it reaches here — this function joins, it does not police. */
export function runDir(catalog: string, runId: string): string {
  return join(catalog, runId);
}

export const RUN_FILES = {
  manifest: "manifest.json",
  owner: "owner.json",
  events: "events",
  verdict: "verdict.json",
  expiry: "expired.json",
  attempts: "attempts",
  receipts: "receipts",
  coordinatorLog: "coordinator.log",
  pushToken: "push.token",
} as const;

export const RUN_EVIDENCE = [
  RUN_FILES.attempts,
  RUN_FILES.events,
  RUN_FILES.receipts,
  RUN_FILES.coordinatorLog,
  RUN_FILES.pushToken,
] as const;

export const RUN_IDENTITY = [
  RUN_FILES.manifest,
  RUN_FILES.owner,
  RUN_FILES.verdict,
  RUN_FILES.expiry,
] as const;

/** One attempt's directory: `attempts/<ENCODED_NODE_KEY>/<N>/`. The encoding
 *  is what makes the node id a single safe segment — see `./ids`. */
export function attemptDir(
  dir: string,
  encodedNode: string,
  attempt: number,
): string {
  return join(dir, RUN_FILES.attempts, encodedNode, String(attempt));
}

export const ATTEMPT_FILES = {
  log: "log",
  pushLog: "push.log",
  record: "record.json",
} as const;

export type { LogStream } from "@odu/run-client/nodeId";

/** One attempt's log file, by stream. */
export function attemptLogFile(stream: LogStream = "recipe"): string {
  return stream === "push" ? ATTEMPT_FILES.pushLog : ATTEMPT_FILES.log;
}
