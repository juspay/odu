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
import { stdioLink } from "@kolu/surface/links/stdio";
import { afterEach, describe, expect, it } from "bun:test";
import type { laneSurface } from "../common/surface";

// The child is spawned with the very same Bun that runs this suite — no
// launcher shim in node_modules/.bin to find, `bun src/runner/main.ts` is
// the entrypoint.
const BUN = process.execPath;
const MAIN = join(process.cwd(), "src", "runner", "main.ts");

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
    const client = stdioLink<typeof laneSurface.contract>({
      read: runner.stdout,
      write: runner.stdin,
    });

    const ack = await client.surface.run.configure({
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
    });
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
