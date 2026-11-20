import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BIG, buildOduBinary, cleanup } from "./harness";
import {
  headOf,
  killDaemon,
  makeWebFixture,
  privateWorld,
  runSocketExists,
  startWebServiceViaCommand,
  suitePortFor,
  tcpListening,
  until,
  verb,
  type WebWorld,
} from "./webHarness";

const SLOW = `[metadata("ci")]
default: slow

slow:
    sleep 600
`;

let oduBin: string;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

const trash: (() => void)[] = [];
afterAll(() => {
  for (const drop of trash.reverse()) {
    try {
      drop();
    } catch (err) {
      process.stderr.write(`e2e: teardown: ${String(err)}\n`);
    }
  }
});

describe("a port that belongs to something else", () => {
  it("is refused by name, on both lifetimes, in seconds", async () => {
    const port = suitePortFor("occupiedTerminal");
    const { root, origin, env } = privateWorld(port);
    trash.push(() => rmSync(root, { recursive: true, force: true }));
    const squatter = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data: () => {}, open: () => {} },
    });
    try {
      const fg = spawnSync(oduBin, ["web"], {
        env: env as Record<string, string>,
        encoding: "utf-8",
        maxBuffer: BIG,
      });
      expect(fg.status).toBe(1);
      expect(fg.stderr).toContain("could not bind");
      expect(fg.stderr).toContain("Another program is on that port");

      const began = Date.now();
      const bg = spawnSync(oduBin, ["web", "--background"], {
        env: env as Record<string, string>,
        encoding: "utf-8",
        maxBuffer: BIG,
      });
      const elapsed = Date.now() - began;
      expect(bg.status).toBe(1);
      expect(bg.stderr, "the refusal never names the occupied port").toContain(
        String(port),
      );
      expect(bg.stderr).toContain("not an odu service");
      expect(
        elapsed,
        `\`odu web --background\` took ${elapsed}ms to refuse an occupied port`,
      ).toBeLessThan(15_000);
    } finally {
      squatter.stop(true);
    }
  }, 300_000);
});

describe("a client that walks away mid-wait", () => {
  let world: WebWorld;
  let dir: string;
  let runId: string;

  beforeAll(async () => {
    world = await startWebServiceViaCommand(oduBin, suitePortFor("disconnect"));
    dir = makeWebFixture(SLOW);
    runId = await startRunning(world, dir, "disconnect-1");
    trash.push(() => cleanup(dir));
    trash.push(() => world.dispose());
    trash.push(() => {
      verb(world, "run_cancel", {
        runId,
        scope: { kind: "run" },
        requestId: "disconnect-cleanup",
      });
    });
  }, 900_000);

  it("leaves the endpoint answering, and the run running", async () => {
    const gone = new AbortController();
    const walked = fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "run_wait",
          arguments: { runId, deadlineMs: 120_000, settle: true },
        },
      }),
      signal: gone.signal,
    });
    await new Promise((r) => setTimeout(r, 1_000));
    gone.abort();
    await expect(walked).rejects.toThrow();

    const began = Date.now();
    const listed = (await (
      await fetch(`${world.origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    ).json()) as { result?: { tools?: { name: string }[] } };
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(listed.result?.tools?.length ?? 0).toBeGreaterThan(0);

    const row = surfaceJson(world, ["get", "runs", runId]) as {
      state: string;
      settled: boolean;
    };
    expect(row.state).toBe("running");
    expect(row.settled).toBe(false);
    expect(runSocketExists(dir)).toBe(true);

    const again = verb(world, "run_wait", { runId, deadlineMs: 3_000 });
    expect(again.status).toBe(0);
    expect((again.json as { reason: string }).reason).toBe("still_running");
  }, 300_000);

  it("survives a bridge that is killed mid-wait", async () => {
    const bridge = Bun.spawn([oduBin, "mcp"], {
      env: world.env as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const send = (message: unknown): void => {
        bridge.stdin.write(`${JSON.stringify(message)}\n`);
        bridge.stdin.flush();
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "odu-e2e-lifecycle", version: "0.0.0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "run_wait",
          arguments: { runId, deadlineMs: 120_000, settle: true },
        },
      });
      await new Promise((r) => setTimeout(r, 2_000));
      bridge.kill("SIGKILL");
      await bridge.exited;
    } finally {
      bridge.kill("SIGKILL");
    }

    expect(await tcpListening(world.origin)).toBe(true);
    const row = surfaceJson(world, ["get", "runs", runId]) as {
      state: string;
      settled: boolean;
    };
    expect(row.state).toBe("running");
    expect(row.settled).toBe(false);

    const fresh = verb(world, "run_wait", { runId, deadlineMs: 3_000 });
    expect(fresh.status).toBe(0);
    expect((fresh.json as { reason: string }).reason).toBe("still_running");
  }, 300_000);

  it("exits 130 when a terminal wait is interrupted, and leaves the run", async () => {
    const waiting = Bun.spawn(
      [
        oduBin,
        "surface",
        "run_wait",
        "--input",
        JSON.stringify({ runId, deadlineMs: 120_000, settle: true }),
        "--json",
      ],
      {
        env: world.env as Record<string, string>,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await new Promise((r) => setTimeout(r, 1_500));
    waiting.kill("SIGINT");
    const status = await waiting.exited;
    expect(
      status === 130 || waiting.signalCode === "SIGINT",
      `an interrupted \`odu surface run_wait\` exited ${status} / ${String(waiting.signalCode)}`,
    ).toBe(true);

    const row = surfaceJson(world, ["get", "runs", runId]) as {
      state: string;
      settled: boolean;
    };
    expect(row.state).toBe("running");
    expect(row.settled).toBe(false);
    expect(runSocketExists(dir)).toBe(true);
  }, 300_000);
});

describe("a daemon that died between accepting a start and recording it", () => {
  it("replays the request rather than starting a second run", async () => {
    const stage = restartableWorld(suitePortFor("crashWindow"));
    const world = await stage.bringUp();
    const stateDir = world.env.ODU_STATE_DIR as string;
    const home = world.daemonHome as string;
    const dir = makeWebFixture(SLOW);
    trash.push(() => cleanup(dir));
    const requestId = "crash-window-1";
    const input = {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId,
      noPost: true,
    };

    const runId = await startRunning(world, dir, requestId, input);

    await stage.killIt();

    const receiptPath = join(stateDir, "service", "receipts", `${requestId}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as {
      version: number;
      state: string;
      completedAt: number | null;
      result: unknown;
      plannedRunId: string;
    };
    expect(
      receipt.version,
      "the receipt schema moved past 1 — this gate must move with it",
    ).toBe(1);
    expect(receipt.state).toBe("completed");
    expect(receipt.plannedRunId).toBe(runId);
    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        { ...receipt, state: "accepted", completedAt: null, result: null },
        null,
        2,
      )}\n`,
    );

    const restarted = await stage.bringUp();
    expect(restarted.daemonHome).toBe(home);

    const cell = surfaceJson(restarted, ["get", "service"]) as {
      readiness: { state: string; reconciled: number };
    };
    expect(cell.readiness.state).toBe("ready");
    expect(
      cell.readiness.reconciled,
      "the restarted daemon reconciled nothing — the rewound receipt was not seen",
    ).toBeGreaterThanOrEqual(1);

    const again = verb(restarted, "run_start", input);
    expect(again.status).toBe(0);
    const replayed = again.json as { runId: string; replayed: boolean };
    expect(replayed.runId).toBe(runId);
    expect(replayed.replayed).toBe(true);

    const keys = surfaceJson(restarted, ["keys", "runs"]) as string[];
    const mine = keys.filter((k) => {
      const row = surfaceJson(restarted, ["get", "runs", k]) as {
        repoRoot: string;
      };
      return row.repoRoot === dir;
    });
    expect(mine, `${mine.length} runs exist for one checkout`).toEqual([runId]);

    const conflicting = verb(restarted, "run_start", {
      ...input,
      selectors: ["nothing-like-the-first-request"],
    });
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toContain("request_conflict");

    verb(restarted, "run_cancel", {
      runId,
      scope: { kind: "run" },
      requestId: "crash-window-cleanup",
    });
  }, 900_000);
});

describe("a daemon restarted under live runs", () => {
  it("leaves them live, and can still drive them", async () => {
    const stage = restartableWorld(suitePortFor("restartUnderRuns"));
    const before = await stage.bringUp();
    const dirs = [makeWebFixture(SLOW), makeWebFixture(SLOW)];
    for (const dir of dirs) trash.push(() => cleanup(dir));
    const runs = [
      await startRunning(before, dirs[0] as string, "restart-a"),
      await startRunning(before, dirs[1] as string, "restart-b"),
    ];

    await stage.killIt();

    for (const dir of dirs) expect(runSocketExists(dir)).toBe(true);

    const after = await stage.bringUp();

    for (const runId of runs) {
      const row = surfaceJson(after, ["get", "runs", runId]) as {
        state: string;
        settled: boolean;
        outcome: string | null;
      };
      expect(row.state, `run ${runId} is ${row.state} after the restart`).toBe(
        "running",
      );
      expect(row.settled).toBe(false);
      expect(row.outcome).toBeNull();

      const waited = verb(after, "run_wait", { runId, deadlineMs: 3_000 });
      expect(waited.status).toBe(0);
      expect((waited.json as { reason: string }).reason).toBe("still_running");
    }

    for (const runId of runs) {
      const cancelled = verb(after, "run_cancel", {
        runId,
        scope: { kind: "run" },
        requestId: `restart-cancel-${runId}`,
      });
      expect(cancelled.status).toBe(0);
      expect(
        (cancelled.json as { effective: string }).effective,
        `cancelling ${runId} through the restarted daemon reached nothing`,
      ).not.toBe("nothing");
    }
    for (const runId of runs) {
      const settled = await until(
        `run ${runId} to settle after a cancel through the new daemon`,
        () => {
          const row = surfaceJson(after, ["get", "runs", runId]) as {
            state: string;
            outcome: string | null;
          };
          return row.state === "running" ? null : row;
        },
        300_000,
      );
      expect(settled.outcome).toBe("incomplete");
    }
  }, 900_000);
});

function restartableWorld(port: number): {
  bringUp: () => Promise<WebWorld>;
  killIt: () => Promise<void>;
} {
  const { root, origin, env } = privateWorld(port);
  let home: string | undefined;
  let pid: number | null = null;
  const world: WebWorld = {
    odu: oduBin,
    origin,
    env,
    daemon: null,
    logPath: "",
    root,
    dispose: () => {},
  };
  const stop = async (): Promise<void> => {
    if (pid !== null) killDaemon(pid, "SIGKILL");
    pid = null;
    await until(
      "the killed daemon to stop answering",
      async () => ((await tcpListening(origin)) ? null : true),
      60_000,
    );
  };
  trash.push(() => {
    if (pid !== null) killDaemon(pid, "SIGKILL");
    for (const dir of [root, home]) {
      if (dir === undefined) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
      }
    }
  });
  return {
    killIt: stop,
    bringUp: async () => {
      const started = spawnSync(oduBin, ["web", "--background"], {
        env,
        encoding: "utf-8",
        maxBuffer: BIG,
      });
      if (started.status !== 0) {
        throw new Error(
          `e2e: \`odu web --background\` on ${origin} exited ${started.status}\n${started.stderr}${started.stdout}`,
        );
      }
      const cell = await until(
        `a ready service at ${origin}`,
        () => {
          const answer = spawnSync(oduBin, ["surface", "get", "service"], {
            env,
            encoding: "utf-8",
            maxBuffer: BIG,
          });
          if (answer.status !== 0) return null;
          try {
            const value = JSON.parse(answer.stdout) as {
              identity: { home: string; pid: number };
              readiness: { state: string };
            };
            return value.readiness.state === "ready" ? value : null;
          } catch {
            return null;
          }
        },
        120_000,
      );
      pid = cell.identity.pid;
      home = cell.identity.home;
      world.daemonHome = home;
      world.logPath = join(home, "web-daemon.stderr.log");
      return world;
    },
  };
}

function surfaceJson(world: WebWorld, argv: string[]): unknown {
  const res = spawnSync(world.odu, ["surface", ...argv], {
    env: world.env,
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  if (res.status !== 0) {
    throw new Error(
      `e2e: \`odu surface ${argv.join(" ")}\` exited ${res.status}\n${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout);
}

async function startRunning(
  world: WebWorld,
  dir: string,
  requestId: string,
  input?: Record<string, unknown>,
): Promise<string> {
  const started = verb(
    world,
    "run_start",
    input ?? {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId,
      noPost: true,
    },
  );
  if (started.status !== 0) {
    throw new Error(`e2e: run_start was refused — ${started.stderr}`);
  }
  const { runId, accepted } = started.json as {
    runId: string;
    accepted: boolean;
  };
  expect(accepted).toBe(true);
  await until(
    `run ${runId} to be running`,
    () => {
      const row = surfaceJson(world, ["get", "runs", runId]) as { state: string };
      return row.state === "running" ? true : null;
    },
    300_000,
  );
  return runId;
}
