import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitStdioReadiness } from "@kolu/surface/links/readiness";
import { stdioLink } from "@kolu/surface/links/stdio";
import { afterEach, describe, expect, it } from "bun:test";
import { runUnary } from "../common/effectEdge";
import { laneClientOver, laneSurface } from "../common/laneSurface";

const BUN = process.execPath;
const MAIN = join(process.cwd(), "src", "runner-main.ts");

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
    runner.stderr?.resume();
    if (runner.stdout === null || runner.stdin === null) {
      throw new Error("runner spawned without stdio pipes");
    }
    // The epoch gate (juspay/kolu#2101): read the runner's readiness banner
    // BEFORE building the link, because building it starts Effect RPC's pinger
    // and a peer of an unknown epoch answers nothing.
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

    runner.kill("SIGTERM");

    await until(() => runner?.exitCode !== null || runner?.signalCode !== null);
    await until(() => !alive(recipePid));
  }, 30_000);
});
