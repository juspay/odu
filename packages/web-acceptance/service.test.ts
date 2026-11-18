/**
 * NO DAEMON OUTLIVES THE WORKER THAT STARTED IT, and no port is one a
 * survivor could hold.
 *
 * On a persistent CI host, a web-acceptance run that never reached `AfterAll`
 * left its `odu web-daemon` running for weeks on a pid-derived port, and a
 * later run's sign-in scenario met it ("Is port 19691 in use?"). These pin the
 * three things that close it, against a stand-in `odu` whose `web-daemon`
 * starts a child of its own, so a kill that missed the process group shows.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveWorldPorts, startService, stubPort, workerPort } from "./support/service.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "odu-wa-stale-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** An `odu` that starts a daemon which never stops by itself. Its `web-daemon`
 *  records its own pid and a child's, and its `surface get service` answers
 *  "ready" only when `$FAKE_READY` says so. */
function fakeOdu(): string {
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

// POLLED ON THE REAL CLOCK, both of these: what is waited on is another
// process's file and another process's death, which no fake timer advances.

/** Both pids the stand-in daemon wrote, once it has written them. */
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

/** Whether `pid` is gone within five seconds. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("a web-acceptance worker leaves no daemon behind", () => {
  // FIRST, because the reservation is per process and the next test makes it.
  test("a port asked for before the reservation is refused, not derived", () => {
    expect(() => workerPort()).toThrow(/before reserveWorldPorts\(\) ran/);
  });

  test("every reserved port is free when it is handed out", async () => {
    await reserveWorldPorts();
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
    // The timeout IS the behaviour under test, so it is real and short.
    const started = startService(fakeOdu(), workerPort(), { FAKE_PIDS: pids }, 300);
    await expect(started).rejects.toThrow(/did not happen within 300ms/);
    const { daemon, child } = await pidsIn(pids);
    expect({ daemon: await gone(daemon), child: await gone(child) }).toEqual({
      daemon: true,
      child: true,
    });
  });

  test("a worker ended by SIGTERM takes its live daemons with it", async () => {
    const pids = mkdtempSync(join(SCRATCH, "signalled-"));
    // A WORKER OF ITS OWN, so the signal goes to a process that is not this
    // test runner. It starts one service that says it is ready, says so in
    // turn, and then stays up until it is killed.
    const worker = join(SCRATCH, "worker.ts");
    const service = join(import.meta.dirname, "support", "service.ts");
    writeFileSync(
      worker,
      `import { startService } from ${JSON.stringify(service)};
await startService(${JSON.stringify(fakeOdu())}, 1, { FAKE_PIDS: ${JSON.stringify(pids)}, FAKE_READY: "1" });
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
    // RE-RAISED: whoever waits on a worker learns it died of the signal.
    expect(await exited.promise).toBe("SIGTERM");
    expect({ daemon: await gone(daemon), child: await gone(grandchild) }).toEqual({
      daemon: true,
      child: true,
    });
  });
});
