import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reserveWorldPortsBeforeAnyWorldStarts,
  startService,
  stubPort,
  workerPort,
} from "./support/service.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "odu-wa-stale-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface StandInEnv extends NodeJS.ProcessEnv {
  FAKE_PIDS: string;
  FAKE_READY?: "1";
}

function standInDaemonThatNeverStops(): string {
  const bin = join(SCRATCH, "odu");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  web-daemon)
    sleep 300 &
    echo $! > "$FAKE_PIDS/child"
    echo $$ > "$FAKE_PIDS/daemon"
    wait
    ;;
  surface)
    [ "$FAKE_READY" = 1 ] || exit 1
    printf '{"identity":{"home":"%s"},"readiness":{"state":"ready"}}' "$FAKE_PIDS/home"
    ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidsIn(dir: string): Promise<{ daemon: number; child: number }> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, "daemon")) && existsSync(join(dir, "child"))) {
      return {
        daemon: Number(readFileSync(join(dir, "daemon"), "utf-8")),
        child: Number(readFileSync(join(dir, "child"), "utf-8")),
      };
    }
    await Bun.sleep(50);
  }
  throw new Error(`the stand-in daemon never wrote its pids to ${dir}`);
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("a web-acceptance worker leaves no daemon behind", () => {
  test("a port asked for before the reservation is refused, not derived", () => {
    expect(() => workerPort()).toThrow(/before reserveWorldPortsBeforeAnyWorldStarts\(\) ran/);
  });

  test("every reserved port is free when it is handed out", async () => {
    await reserveWorldPortsBeforeAnyWorldStarts();
    for (const port of [workerPort(), stubPort()]) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
      expect({ port, bound: await promise }).toEqual({ port, bound: true });
    }
  });

  test("a daemon that never says it is ready is killed, process group and all", async () => {
    const pids = mkdtempSync(join(SCRATCH, "never-ready-"));
    const env: StandInEnv = { FAKE_PIDS: pids };
    const started = startService(standInDaemonThatNeverStops(), workerPort(), env, 300);
    await expect(started).rejects.toThrow(/did not happen within 300ms/);
    const { daemon, child } = await pidsIn(pids);
    expect({ daemon: await gone(daemon), child: await gone(child) }).toEqual({
      daemon: true,
      child: true,
    });
  });

  test("a worker ended by SIGTERM takes its live daemons with it", async () => {
    const pids = mkdtempSync(join(SCRATCH, "signalled-"));
    const worker = join(SCRATCH, "worker.ts");
    const service = join(import.meta.dirname, "support", "service.ts");
    const env: StandInEnv = { FAKE_PIDS: pids, FAKE_READY: "1" };
    writeFileSync(
      worker,
      `import { startService } from ${JSON.stringify(service)};
await startService(${JSON.stringify(standInDaemonThatNeverStops())}, 1, ${JSON.stringify(env)});
console.log("ready");
process.stdin.resume();
`,
    );
    const child = spawn(process.execPath, [worker], { stdio: ["pipe", "pipe", "inherit"] });
    const ready = Promise.withResolvers<void>();
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) ready.resolve();
    });
    child.once("exit", (code) => ready.reject(new Error(`the worker exited early (${code})`)));
    await ready.promise;
    const { daemon, child: grandchild } = await pidsIn(pids);
    expect(alive(daemon)).toBe(true);

    const exited = Promise.withResolvers<NodeJS.Signals | null>();
    child.once("exit", (_code, signal) => exited.resolve(signal));
    child.kill("SIGTERM");
    expect(await exited.promise).toBe("SIGTERM");
    expect({ daemon: await gone(daemon), child: await gone(grandchild) }).toEqual({
      daemon: true,
      child: true,
    });
  });
});
