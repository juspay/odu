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
import { coordinatorSpawnSpec } from "./spawn";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
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

describe("a spawned run outlives the process that launched it", () => {
  it("parent dies, pipes die, the child keeps writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-survive-"));
    dirs.push(dir);
    const aliveFile = join(dir, "alive");
    const pidFile = join(dir, "pid");

    writeChildAndParent(dir);

    const parent = spawn(
      process.execPath,
      [
        join(dir, "parent.ts"),
        new URL("./spawn.ts", import.meta.url).pathname,
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
      `const { coordinatorSpawnSpec } = await import(specModule);`,
      `const child = spawn(process.execPath, [childPath, aliveFile], coordinatorSpawnSpec(cwd));`,
      `child.unref();`,
      `writeFileSync(pidFile, String(child.pid));`,
      `process.exit(0); // the launcher exiting under the run`,
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
