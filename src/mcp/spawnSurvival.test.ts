/**
 * The survival property of the `run` tool's spawn, measured — not assumed:
 * an `odu run` coordinator outlives the MCP server that launched it.
 *
 * Measured against the REAL runtime (`process.execPath` — bun, the runtime
 * every shipped coordinator runs on) and the REAL spawn options
 * (`coordinatorSpawnSpec`), through the REAL hazard: the launcher EXITS, its
 * ends of the child's output pipes die with it, and the child keeps writing.
 * Two facts are load-bearing and either's regression must fail this file:
 *
 *   - the spawn (`detached` + `unref`): the child is its own process-group
 *     leader and its handle doesn't hold the launcher open, so the launcher's
 *     exit leaves the run reparented, not reaped;
 *   - the write contract: bun's stdio swallows EPIPE — a write to a pipe
 *     whose reader is gone never becomes an uncaughtException (Node would
 *     crash the child here). If a runtime bump changes that, this file goes
 *     red and the run-descriptor comment in `runTool.ts` goes with it.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { coordinatorSpawnSpec } from "./runTool";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  // Kills by explicit PID only: grandchildren this suite spawned via a parent.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("an MCP-spawned run outlives its MCP server", () => {
  it("parent dies, pipes die, the child keeps writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-survive-"));
    dirs.push(dir);
    const aliveFile = join(dir, "alive");
    const pidFile = join(dir, "pid");

    // The grandchild: a bun process writing to stdout (the dead-to-be pipe)
    // AND stamping a file, so liveness is observable from the test after the
    // pipe is gone.
    writeChildAndParent(dir);

    // Spawn the PARENT (the stand-in for the exiting `odu mcp`): it spawns
    // the child with the real spawn spec, unrefs, and exits. Every path it
    // needs arrives as ARGV — see `writeChildAndParent`.
    const parent = spawn(
      process.execPath,
      [
        join(dir, "parent.ts"),
        new URL("./runTool.ts", import.meta.url).pathname,
        join(dir, "child.ts"),
        dir,
        pidFile,
        aliveFile,
      ],
      { stdio: "inherit" },
    );
    const parentExit = new Promise<number>((resolve) => {
      parent.on("exit", (code) => resolve(code ?? -1));
    });
    expect(await parentExit).toBe(0);

    // The parent reports its child's pid; then the child must keep stamping
    // for a window WIDE ENOUGH to span several writes past the parent's death.
    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isFinite(pid) && pid > 0).toBe(true);
    pids.push(pid);

    await waitForFile(aliveFile);
    const countThen = stampedCount(aliveFile);
    await sleep(1200); // ~12 ticks past the parent's exit
    const countNow = stampedCount(aliveFile);
    expect(countNow, "the run kept writing after its launcher died").toBeGreaterThan(
      countThen,
    );
    expect(alive(pid)).toBe(true);
  }, 20_000);
});

/**
 * Write the two scripts this test drives, WITHOUT interpolating a single value
 * into either of them.
 *
 * Both used to be assembled by splicing `JSON.stringify(path)` into source
 * text. That is code construction from data, and `JSON.stringify` is not an
 * escape for it: it leaves U+2028/U+2029 raw, which are line terminators to a
 * JavaScript parser but not to JSON. A test fixture under a temp path will
 * never carry one — and a guard that holds only because of what the input
 * happens to be is not a guard, which is why the tooling flags the shape
 * rather than the instance.
 *
 * So the scripts became CONSTANT text and every path arrives on `process.argv`.
 * There is nothing left to escape, and the two files are now readable as the
 * programs they are.
 */
function writeChildAndParent(dir: string): void {
  writeFileSync(
    join(dir, "child.ts"),
    [
      `const fs = require("node:fs");`,
      `const aliveFile = process.argv[2];`,
      `let n = 0;`,
      // The write that would be fatal if the runtime routed a dead-reader
      // EPIPE to uncaughtException (Node does; bun swallows it — THAT is the
      // contract this suite pins).
      `setInterval(() => console.log("tick " + (++n)), 80);`,
      `setInterval(() => fs.appendFileSync(aliveFile, "x"), 80);`,
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "parent.ts"),
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `const [specModule, childPath, cwd, pidFile, aliveFile] = process.argv.slice(2);`,
      // The REAL spawn spec, imported from the module that ships it — a
      // dynamic import because the path is data now, and the point of the
      // test is that these options are odu's own and not a copy.
      `const { coordinatorSpawnSpec } = await import(specModule);`,
      `const child = spawn(process.execPath, [childPath, aliveFile], coordinatorSpawnSpec(cwd));`,
      `child.unref();`,
      `writeFileSync(pidFile, String(child.pid));`,
      `process.exit(0); // the harness restarting its MCP server`,
    ].join("\n"),
  );
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`${path} never appeared`);
}

function stampedCount(path: string): number {
  return readFileSync(path, "utf8").length;
}
