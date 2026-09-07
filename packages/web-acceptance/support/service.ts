/**
 * The APPLICATION UNDER TEST — a real `odu web-daemon`, in a world of its own.
 *
 * Everything here is out-of-process and black-box. The daemon is the nix-built
 * binary, started the way `odu web` starts it; a fixture is a real git checkout
 * with a real `justfile`; a run is a real coordinator that evaluates a flake and
 * spawns real recipes. Nothing in this package imports `src/` or `packages/*`,
 * because what these features assert is what a person meets in a browser.
 *
 * **The binary is the PACKAGED one, and there is no fallback.** `bun
 * src/main.ts` is not odu: the wrapper `default.nix` builds is where
 * `ODU_SELF`, `ODU_WEB_DIST`, `ODU_BUILD_ID` and the pinned nix/git/just come
 * from, and a suite that fell back to a source runtime would be exercising an
 * application no user runs — including, specifically, a service with no browser
 * bundle to serve. So {@link readOduBin} throws.
 *
 * **The world is private, and privacy stops where odu stops.** The port is per
 * worker, `ODU_STATE_DIR` points into a temp directory, and `ODU_WEB_ORIGIN`
 * moves the daemon's own home — so the catalog, the receipts, the gate and the
 * control socket are all this worker's. A developer's own running `odu web` is
 * untouched, and two workers do not fight.
 *
 * **`HOME` is deliberately NOT redirected**, and that is a correction rather
 * than an omission. `tests/e2e/webHarness.ts` records what happened when it was:
 * a synthetic home takes `~/.config/nix/nix.conf` with it, and on a single-user
 * Nix install — which is what a GitHub runner is — that file holds
 * `experimental-features = nix-command flakes`. Every coordinator started inside
 * such a world could not evaluate a flake, so every run refused with
 * `launch_failed`. It passed locally and failed only on CI, for a reason that
 * had nothing to do with the code under test. A host where odu needs a faked
 * home is a host odu does not work on.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Large maxBuffer for nix output and whole-log reads (256 MiB). */
const BIG = 256 * 1024 * 1024;

/**
 * The `odu` under test.
 *
 * `ODU_BIN` is set by `just web-acceptance`, which builds it first. There is no
 * search of PATH either: a developer's installed `odu` is a DIFFERENT build from
 * the worktree, and a suite that silently graded the wrong binary is worse than
 * one that will not start.
 */
export function readOduBin(): string {
  const bin = process.env.ODU_BIN;
  if (bin === undefined || bin === "") {
    throw new Error(
      "ODU_BIN is not set, and this suite has no fallback. It drives the " +
        "PACKAGED odu — `nix build .#odu` → <out>/bin/odu — which is what " +
        "`just web-acceptance` builds and passes. A source runtime (`bun " +
        "src/main.ts`) has none of the locators the wrapper bakes (ODU_SELF, " +
        "ODU_WEB_DIST, ODU_BUILD_ID), so it cannot even serve the page these " +
        "features are about.",
    );
  }
  return bin;
}

/** This machine's Nix system tuple, asked of Nix itself — the same authority the
 *  coordinator will use when it builds `odu-runner`, so it is the tuple a lane
 *  must name. A hand-rolled arch/os table drifts and disagrees under emulation. */
let system: string | undefined;
export function currentNixSystem(): string {
  return (system ??= execFileSync(
    "nix",
    ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
    { encoding: "utf-8" },
  ).trim());
}

/** One service, and the world it owns. */
export interface Service {
  /** The `odu` binary under test. */
  odu: string;
  /** Where the page is served. */
  origin: string;
  /** The environment every `odu` call in this world is made with. */
  env: NodeJS.ProcessEnv;
  daemon: ChildProcess;
  logPath: string;
  root: string;
  /** Where the daemon put its gate and control socket — read off the service's
   *  own identity rather than re-derived, and removed at teardown so a run
   *  leaves nothing under the developer's state root. */
  daemonHome: string;
}

/**
 * A port for THIS worker.
 *
 * Two bands are being kept apart. `tests/e2e/webHarness.ts` derives its port as
 * `18500 + (pid % 900)`, so 18500–19399 belongs to that suite and a developer
 * running both at once must not collide with it. Within this suite the WORKER ID
 * is a separate hundred rather than another modulus of the pid: two cucumber
 * workers are forked back to back and their pids are usually consecutive, so a
 * pid-only derivation is one unlucky spawn away from two daemons racing one
 * origin — and because odu derives the daemon home FROM the origin, the loser
 * would not fail to bind, it would yield to its sibling's gate and every
 * scenario behind it would grade the wrong service.
 */
export function workerPort(): number {
  const worker = Number(process.env.CUCUMBER_WORKER_ID ?? 0);
  return 19500 + worker * 100 + (process.pid % 100);
}

/** Poll until `ask` answers, or fail with a sentence naming what was waited on. */
export async function until<T>(
  what: string,
  ask: () => Promise<T | null> | (T | null),
  timeoutMs = 120_000,
  pollMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ask();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`web-acceptance: ${what} did not happen within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Whatever the daemon has said about itself, for a failure that needs to name a
 *  cause rather than a timeout. */
export function daemonLog(service: Pick<Service, "logPath">): string {
  try {
    return readFileSync(service.logPath, "utf-8").slice(-4000);
  } catch {
    return `(no daemon log at ${service.logPath})`;
  }
}

/** Start a service in a private world and wait for it to SAY it is ready.
 *  Readiness is asked for, never slept on: the service publishes its own state
 *  and this reads it. */
export async function startService(odu: string, port: number): Promise<Service> {
  const root = mkdtempSync(join(tmpdir(), "odu-wa-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const hosts = join(root, "hosts.json");
  // A hosts file pinning this machine's platform to a localhost lane, so lane
  // resolution is hermetic wherever the suite runs — an ambient
  // `~/.config/odu/hosts.json` naming a remote would need an origin a throwaway
  // fixture has none of.
  writeFileSync(hosts, JSON.stringify({ [currentNixSystem()]: "localhost" }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ODU_STATE_DIR: state,
    ODU_HOSTS: hosts,
    // AND the daemon home, transitively: odu places that under
    // `~/.local/state/<app>` and derives `<app>` from the origin, deliberately
    // ignoring XDG_STATE_HOME (which varies by launch context and would split
    // one daemon's identity). Moving the origin is therefore what keeps this
    // worker's gate out of a developer's own.
    ODU_WEB_ORIGIN: origin,
  };

  const logPath = join(root, "daemon.log");
  const sink = createWriteStream(logPath);
  const daemon = spawn(odu, ["web-daemon"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  daemon.stdout?.pipe(sink);
  daemon.stderr?.pipe(sink);

  const partial: Pick<Service, "odu" | "env" | "logPath"> = { odu, env, logPath };
  try {
    const cell = await until("the web service to say it is ready", () => {
      const answer = spawnSync(odu, ["surface", "get", "service"], {
        env,
        encoding: "utf-8",
        maxBuffer: BIG,
      });
      if (answer.status !== 0) return null;
      try {
        const value = JSON.parse(answer.stdout) as {
          identity: { home: string };
          readiness: { state: string };
        };
        return value.readiness.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    return { ...partial, origin, daemon, root, daemonHome: cell.identity.home };
  } catch (err) {
    // A daemon that never answered has usually SAID why, and a bare "did not
    // happen within 120000ms" throws that away — which on a CI runner is the
    // whole of what a failure gets to say.
    throw new Error(`${String(err)}\n--- daemon log ---\n${daemonLog(partial)}`);
  }
}

/** Stop a service and remove everything it owns. */
export function stopService(service: Service): void {
  try {
    // The whole process GROUP: the daemon is detached, and a coordinator it
    // started is detached from IT, so a plain kill would leave one behind
    // holding a fixture's lock and the machine's cores.
    if (service.daemon.pid !== undefined) {
      process.kill(-service.daemon.pid, "SIGTERM");
    }
  } catch {
    // Already gone. Nothing to do, and nothing worth failing a teardown for.
  }
  for (const dir of [service.root, service.daemonHome]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`web-acceptance: could not remove ${dir}: ${String(err)}\n`);
    }
  }
}

/** One `odu surface …` call against this world's service. */
export function surfaceCall(
  service: Service,
  argv: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(service.odu, ["surface", ...argv], {
    env: service.env,
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * A verb call with a JSON input, answered as JSON.
 *
 * Used ONLY to arrange a scenario (start the run a feature is then about) and to
 * read facts a browser cannot be asked for (which node the coordinator called
 * `quick@…`). Never to ACT where the scenario is about a control: a feature that
 * cancelled a run through this instead of through the button would be asserting
 * on the service and calling it browser coverage.
 */
export function verb(
  service: Service,
  name: string,
  input: unknown,
): { status: number | null; json: unknown; stderr: string } {
  const res = surfaceCall(service, [name, "--input", JSON.stringify(input), "--json"]);
  let json: unknown = null;
  try {
    json = JSON.parse(res.status === 0 ? res.stdout : res.stderr);
  } catch {
    json = null;
  }
  return { status: res.status, json, stderr: res.stderr };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** A DAG whose second node fails — the shape a diagnosis is about. Copied from
 *  `tests/e2e/web.e2e.test.ts` rather than imported: the two suites live in
 *  different package trees and this one must stay black-box, so a shared module
 *  would be the one import that reached back into the repo under test. */
export const FAILING = `[metadata("ci")]
default: alpha beta

alpha:
    echo "alpha ok"

beta: alpha
    echo "beta is about to fail"
    exit 3
`;

/** A DAG that stays running, to cancel or supersede out from under. The sleep is
 *  far longer than any scenario's patience on purpose: an assertion about a run
 *  that is still live must never pass because the run happened to finish. */
export const SLOW = `[metadata("ci")]
default: alpha slow

alpha:
    echo "alpha ok"

slow: alpha
    echo "slow start"
    sleep 300
`;

/** ONE LANE FAILS AT ONCE while its sibling sleeps — the reviewer's "early
 *  failure while a sibling continues", and the same fixture
 *  `tests/e2e/fixtures/fast-red` uses. The two are parallel roots with no
 *  dependency between them, which is what makes the failure observable before
 *  the run is over. */
export const FAST_RED = `[parallel]
[metadata("ci")]
default: quick slow

quick:
    echo "BOOM: the quick lane failed"
    exit 1

slow:
    sleep 120
`;

/**
 * A log too long to read in one page.
 *
 * The SIZE is chosen against `LOG_PAGE_BYTES` (64 KiB, `packages/web-ui`), not
 * for its own sake: 5 000 numbered lines of ~67 bytes is about 330 KB, so a
 * reader starting at the first byte has four more pages ahead and both "Newer"
 * and "Older" have somewhere to go rather than immediately hitting an end.
 *
 * The lines are NUMBERED because that is what makes a window checkable: a
 * scenario can say the second page holds a line the first did not, which no
 * assertion over repeated filler could.
 *
 * The PACING is the part worth explaining. `tests/e2e/fixtures/noisy` dumps
 * fourteen megabytes as fast as bash can write them, and it does that on
 * purpose — it exists to outrun odu's log transport, because whether every byte
 * survives that race is what juspay/odu#87 was about. This fixture wants the
 * opposite: it is about the browser's paging controls, and a race it might lose
 * would turn a UI scenario into a flaky assertion about throughput. So it writes
 * in bursts with a pause between them. Measured, unpaced, this same output
 * reached the panel as 66 KiB of 330 KB — barely two pages, starting at line
 * 3993 — which is a fact about the transport and would have been read here as a
 * fact about the buttons.
 */
export const LONG_LOG = `[metadata("ci")]
default: noisy

noisy:
    #!/usr/bin/env bash
    set -euo pipefail
    for burst in $(seq 0 19); do
      for i in $(seq 1 250); do
        printf 'noisy line %06d — padding so every line is the same width here\\n' "$((burst * 250 + i))"
      done
      sleep 0.05
    done
    echo "NOISY SUMMARY: 5000 lines emitted"
`;

/**
 * A throwaway git repo with a `justfile`, committed — the subject of a run.
 *
 * The path is RESOLVED before it is returned. `tmpdir()` is `/var/folders/…` on
 * macOS and `/private/var/folders/…` once anything resolves it, and a run
 * records the second (git's `--show-toplevel`) while a step holding the first
 * would type one spelling into the form and then fail to find the other on the
 * board. That is the fixture's identity, so it is settled once, here.
 */
export function makeFixture(justfile: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odu-wa-repo-")));
  // `.ci/` is ignored so a SECOND run in the same checkout still sees a clean
  // tree: odu writes its per-checkout ledger there and strict mode refuses a
  // dirty one — which is correct, and would otherwise make every fixture
  // single-use.
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  writeFileSync(join(dir, "justfile"), justfile);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=acceptance@odu.test",
    "-c",
    "user.name=odu web acceptance",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return dir;
}

/** The commit a fixture is on. */
export function headOf(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

/** Remove a fixture checkout. Best effort: a teardown that threw would replace a
 *  scenario's own verdict with a housekeeping failure. */
export function removeFixture(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`web-acceptance: could not remove ${dir}: ${String(err)}\n`);
  }
}

// ── runs ────────────────────────────────────────────────────────────────────

/**
 * Start a run through the service, or fail with the REASON.
 *
 * The reason matters. `run_start` refusing is one number — exit 1 — and on a CI
 * runner nobody can attach to, "expected 0, received 1" is the whole of what a
 * failure gets to say. The refusal is already a sentence written for a person,
 * and the daemon's log carries the rest, so both go into the message.
 */
export function startRun(
  service: Service,
  input: Record<string, unknown>,
): string {
  const start = verb(service, "run_start", { ...input, noPost: true });
  if (start.status !== 0) {
    throw new Error(
      `web-acceptance: run_start refused (exit ${start.status})\n${start.stderr}\n` +
        `--- daemon log ---\n${daemonLog(service)}`,
    );
  }
  const receipt = start.json as { runId: string; accepted: boolean };
  return receipt.runId;
}

/**
 * Wait for a run to settle, and answer what it settled as.
 *
 * The `failures` it carries are the ONE thing a step reads from the wire and
 * could not compute: a node's id is minted by the coordinator out of the recipe
 * name and this machine's platform, and its LOG KEY is minted from that plus an
 * attempt through the catalog's own encoding. A step that spelled either by hand
 * would be asserting that the browser agrees with this file's copy of an
 * encoding, which is not the claim. Taking the service's own minting and
 * checking the address bar against it is.
 */
export async function waitSettled(
  service: Service,
  runId: string,
  timeoutMs: number,
): Promise<{ passed: boolean; failures: { node: string; logKey: string }[] }> {
  return await until(
    `run ${runId} to settle`,
    () => {
      const waited = verb(service, "run_wait", { runId, deadlineMs: 20_000 });
      if (waited.status !== 0) return null;
      const value = waited.json as {
        settled: boolean;
        passed: boolean;
        failures: { node: string; logKey: string }[];
      };
      return value.settled ? value : null;
    },
    timeoutMs,
    // Zero, because `run_wait` is itself a 20-second blocking wait — a poll
    // interval on top of it would only add latency to the answer.
    0,
  );
}
