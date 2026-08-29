/**
 * Death-by-signal reaping, over a REAL odu-runner process — the exact
 * teardown a localhost lane performs: surface-remote's `session.destroy()`
 * SIGTERMs the runner process it spawned (sshConnector `teardown()`).
 * Without a signal handler the runner died by default disposition, its
 * `dispose()` never ran, and every `detached` recipe group reparented to
 * init — the production orphans (a 16h-old test fork worker at ppid 1 on
 * the coordinator box). This drives the real `main.ts --stdio` entrypoint
 * over real stdio framing and asserts the recipe tree dies with the runner.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitStdioReadiness } from "@kolu/surface/links/readiness";
import { stdioLink } from "@kolu/surface/links/stdio";
import { afterEach, describe, expect, it } from "bun:test";
import { runUnary } from "../common/effectEdge";
import { laneClientOver, laneSurface } from "../common/laneSurface";

// The child is spawned with the very same Bun that runs this suite — no
// launcher shim in node_modules/.bin to find, `bun src/runner/main.ts` is
// the entrypoint.
const BUN = process.execPath;
const MAIN = join(process.cwd(), "src", "runner", "main.ts");

/** How long this LOCAL child may take to put its readiness banner on stdout.
 *
 * Deliberately NOT the ssh leg's 180s: that budget is the sum of a remote
 * daemon's convergence ceilings (cross-epoch takeover, socket rebind, probe
 * silence) plus network round-trips, and none of those exist here. This wait is
 * one Bun start, one module graph, one `createLaneRunner()` — and `main.ts`
 * hands `serveOverStdio` no explicit transport, so the PROCESS is the agent and
 * the framework writes the banner before the first frame.
 *
 * 15s is the budget this suite already gives every other local liveness fact
 * (`until`'s default), and half the test's own 30s ceiling — so a runner that
 * never greets fails here as a *classified* readiness verdict, with the peer's
 * prelude quoted, instead of expiring later as an opaque "test timed out". */
const RUNNER_GREET_BUDGET_MS = 15_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let runner: ChildProcess | undefined;
afterEach(() => {
  if (runner !== undefined && runner.exitCode === null) {
    runner.kill("SIGKILL");
  }
  runner = undefined;
});

describe("runner death by signal", () => {
  it("SIGTERM (a localhost lane's session.destroy) reaps the recipe tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-sigterm-"));
    const pidFile = join(dir, "pid");
    runner = spawn(BUN, [MAIN, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    runner.stderr?.resume(); // drain diagnostics; the protocol is on stdout
    if (runner.stdout === null || runner.stdin === null) {
      throw new Error("runner spawned without stdio pipes");
    }
    // The epoch gate (juspay/kolu#2101): read the runner's readiness banner
    // BEFORE building the link, because building it starts Effect RPC's pinger
    // and a peer of an unknown epoch answers nothing. This is the coordinator's
    // own move against a real `odu-runner --stdio` child, minus ssh — the
    // `awaitStdioReadiness` proof is the only way `stdioLink` constructs.
    const readiness = await awaitStdioReadiness({
      read: runner.stdout,
      deadlineMs: RUNNER_GREET_BUDGET_MS,
      describe: "odu-runner --stdio",
    });
    const link = await stdioLink({
      group: laneSurface.group,
      read: runner.stdout,
      write: runner.stdin,
      readiness,
    });
    const client = laneClientOver(link.dispatch);

    const ack = await runUnary(
      client.surface.run.configure({
        name: "sigterm-test",
        origin: null,
        sha: null,
        workspace: dir,
        tasks: [
          {
            id: "long",
            command: `echo $BASHPID > ${pidFile}; sleep 60`,
            needs: [],
          },
        ],
      }),
    );
    expect(ack.ok).toBe(true);
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() !== "",
    );
    const recipePid = Number(readFileSync(pidFile, "utf-8").trim());
    expect(alive(recipePid)).toBe(true);

    // The localhost-lane teardown, verbatim: SIGTERM the runner process.
    runner.kill("SIGTERM");

    // The runner exits AND takes the recipe's process group with it —
    // before the handler, the detached tree survived and reparented to init.
    await until(() => runner?.exitCode !== null || runner?.signalCode !== null);
    await until(() => !alive(recipePid));
  }, 30_000);
});
