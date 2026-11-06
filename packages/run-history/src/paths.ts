/**
 * Where the run catalog lives, and the one place that decides.
 *
 * The catalog is PER USER, not per checkout, and that is the change this
 * package exists to make. Odu's history has always lived in the checkout's
 * `.ci/`, which ties a run's evidence to a directory: delete the worktree and
 * the logs go with it, and anything wanting to discover runs has to be told
 * which checkouts to look in. A per-user root inverts both — evidence survives
 * the checkout, and discovery is one `readdir`.
 *
 * Resolution order, and why each rung is there:
 *
 *   1. `ODU_STATE_DIR` — an explicit override. Tests need it (a suite that
 *      writes into the developer's real catalog is a suite nobody can run
 *      twice), and so does anyone running odu under a service manager that
 *      hands it a state directory of its own.
 *   2. `XDG_STATE_HOME/odu` on Linux — state, not cache and not config: this
 *      is data that should survive a reboot and does not belong in a backup.
 *      `~/.local/state/odu` when the variable is unset, which is what the XDG
 *      basedir spec names as the default.
 *   3. `~/Library/Application Support/odu` on macOS, which has no XDG state
 *      directory and whose convention puts application-owned data there.
 *
 * A missing home is not a fallback to the cwd. Writing a catalog into whatever
 * directory a process happened to start in is exactly the checkout-scoped
 * problem again, wearing a worse mask, so {@link stateRoot} throws instead —
 * and the callers that must not fail on it (a best-effort history write) catch.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The environment slice this module reads. Passed in rather than reached for,
 *  so a test names the world it is testing against. */
export interface StateEnv {
  readonly ODU_STATE_DIR?: string | undefined;
  readonly XDG_STATE_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  /** The index signature is what makes `process.env` assignable here. Named
   *  fields alone are structurally incompatible with `ProcessEnv`, and the
   *  alternative — a cast at every call site — would put the one place this
   *  type is checked behind an `as`. */
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

/** The file names inside a run directory, in one place so a reader and a
 *  writer cannot disagree about a spelling.
 *
 *  `events` has no extension on purpose: it is an append-only journal of
 *  JSON lines, and calling it `.json` would invite a reader to `JSON.parse`
 *  the whole file — which is the one thing that must never happen to a file a
 *  crash can leave with a torn last line. */
export const RUN_FILES = {
  manifest: "manifest.json",
  owner: "owner.json",
  events: "events",
  verdict: "verdict.json",
  expiry: "expired.json",
  attempts: "attempts",
  /** Idempotency receipts, one file per request id. */
  receipts: "receipts",
  /** What the coordinator itself said, when a launcher started it — the
   *  account of a run that failed on the strict gate, or died before its
   *  per-node logs said anything. */
  coordinatorLog: "coordinator.log",
  /**
   * THE RUN'S WRITE TOKEN, in flight (PLAN 4.1) — written by the launcher
   * with mode 0600, read ONCE by the coordinator it just started, and unlinked
   * there.
   *
   * A file rather than an argv or a unit's environment, because both of those
   * are readable by anyone on the machine: `ps` shows one and `systemctl show`
   * the other. A file in the run's own directory, under a per-user state root
   * that is already the owner's alone, is the narrowest handoff available
   * between two processes this daemon owns.
   *
   * It is EVIDENCE for expiry's purposes — a leftover from a coordinator that
   * died before reading it must not survive the run — but never present on a
   * run anybody can read, because the coordinator removes it within a second
   * of being started.
   */
  pushToken: "push.token",
} as const;

/**
 * What expiry throws away, and what it keeps.
 *
 * A PARTITION rather than a list at the call site, because the two halves
 * answer different questions and a new file has to land in one of them on
 * purpose. EVIDENCE is what a run produced and what retention exists to bound;
 * IDENTITY is what makes an expired run still answerable — "it existed, it
 * failed, its evidence aged out" rather than the answer a typo gets.
 *
 * The list used to be two names spelled inside `expireRun`, and `receipts/`
 * and `coordinator.log` were added afterwards without either being considered.
 * Both survived expiry forever, and the coordinator log — the record of a
 * coordinator that died on the strict gate, the case this release exists for —
 * was the one file the janitor could not see.
 */
export const RUN_EVIDENCE = [
  RUN_FILES.attempts,
  RUN_FILES.events,
  RUN_FILES.receipts,
  RUN_FILES.coordinatorLog,
  // A leftover from a coordinator that died before it could read and unlink
  // its own token. Expiry must take it; it is never there on a live run.
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

/** The files an attempt directory holds: the recipe's raw bytes, the push's
 *  raw bytes, and the sidecar that says what they are.
 *
 *  TWO LOGS, because a node does two things: it runs a recipe, and then it
 *  puts what the recipe built in the cache. Interleaving them cost the reader
 *  the one thing a log is for — the recipe's log stopped being exactly the
 *  recipe's output the moment a push appended `[odu] …` to it. */
export const ATTEMPT_FILES = {
  log: "log",
  pushLog: "push.log",
  record: "record.json",
} as const;

/** Which of an attempt's two logs a caller means. `"recipe"` is the default
 *  everywhere: it is the log that existed first and the one every reader that
 *  does not say otherwise wants. */
export type LogStream = "recipe" | "push";

/** One attempt's log file, by stream. The ONE place a stream name becomes a
 *  file name, so a writer and a reader cannot disagree about which bytes they
 *  are addressing. */
export function attemptLogFile(stream: LogStream = "recipe"): string {
  return stream === "push" ? ATTEMPT_FILES.pushLog : ATTEMPT_FILES.log;
}
