/**
 * WHAT SURVIVES WHAT — the service's lifetime, asserted against the things that
 * end it.
 *
 * Everything else in this suite drives a healthy daemon. These gates take one
 * away mid-sentence, or hand it a port it cannot have, or walk away from it
 * while it is waiting, and then ask what is left. Each of them was a claim the
 * codebase made in a comment and nothing checked:
 *
 *   - **A port that belongs to something else is a REFUSAL, said fast.** The
 *     foreground already did this correctly. `--background` did not: it polled
 *     for the full sixty seconds and then reported a failure naming no cause,
 *     while the daemon's own sentence — "could not bind … Another program is on
 *     that port" — sat unread in a file the launcher already knew the path of.
 *     Sixty-six seconds of silence, measured.
 *   - **A client that walks away ends an OBSERVATION.** Not a run, not the
 *     service, and not the endpoint's ability to answer the next caller.
 *   - **A daemon that died between accepting a mutation and recording it can be
 *     asked again.** That is the whole reason `requestId` is mandatory, and the
 *     crash window is the only case where it earns its keep.
 *   - **A restart leaves live runs live.** The runs half of reconciliation
 *     writes nothing on purpose — liveness comes from the catalog's ownership
 *     fence — and "we deliberately do nothing here" is exactly the kind of
 *     claim that needs a test, because nothing about it fails loudly.
 *
 * Each gate owns its port (see `PORT_SLOT` in `./webHarness`), its state root
 * and its daemon home, because they kill daemons and a shared world would make
 * one gate's teardown another's flake.
 */

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

/** A DAG that keeps running long enough to interrupt something. */
const SLOW = `[metadata("ci")]
default: slow

slow:
    sleep 600
`;

let oduBin: string;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

/** Everything a gate created, torn down whatever happened. */
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

// ---------------------------------------------------------------------------

describe("a port that belongs to something else", () => {
  it("is refused by name, on both lifetimes, in seconds", async () => {
    const port = suitePortFor("occupiedTerminal");
    const { root, origin, env } = privateWorld(port);
    trash.push(() => rmSync(root, { recursive: true, force: true }));
    // A plain listener that accepts and never speaks odu's protocol — which is
    // all "another program" means from odu's side.
    const squatter = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data: () => {}, open: () => {} },
    });
    try {
      // THE FOREGROUND, which was already right. Pinned so it stays right: this
      // is the wording every other face's refusal is measured against.
      const fg = spawnSync(oduBin, ["web"], {
        env: env as Record<string, string>,
        encoding: "utf-8",
        maxBuffer: BIG,
      });
      expect(fg.status).toBe(1);
      expect(fg.stderr).toContain("could not bind");
      expect(fg.stderr).toContain("Another program is on that port");

      // THE BACKGROUND, which was not. It spawned a daemon into a port it could
      // not have, waited out the whole readiness deadline, and then said "it
      // did not answer … Its own account of why is in the journal or on
      // stderr" — a sentence that names no cause and asks the reader to go
      // looking. The port is knowable BEFORE the spawn: nothing answered as an
      // odu service and no odu daemon holds the gate, so anything the kernel
      // still accepts at that address is somebody else's and always will be.
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
      // The measured defect was 66.5s. Fifteen seconds is slack for a loaded
      // runner and still names the regression if it comes back.
      expect(
        elapsed,
        `\`odu web --background\` took ${elapsed}ms to refuse an occupied port`,
      ).toBeLessThan(15_000);
    } finally {
      squatter.stop(true);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------

describe("a client that walks away mid-wait", () => {
  let world: WebWorld;
  let dir: string;
  let runId: string;

  beforeAll(async () => {
    world = await startWebServiceViaCommand(oduBin, suitePortFor("disconnect"));
    trash.push(() => world.dispose());
    dir = makeWebFixture(SLOW);
    trash.push(() => cleanup(dir));
    runId = await startRunning(world, dir, "disconnect-1");
  }, 900_000);

  it("leaves the endpoint answering, and the run running", async () => {
    // The HTTP door, which is the one arm with real production wiring:
    // `mcpRoute` hands `RouteTransport.ask` the request's own abort signal, and
    // the adapter turns a withdrawn caller into a cancellation of the in-flight
    // call rather than a waiter nobody will ever answer.
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
    // Long enough for the wait to be genuinely in flight rather than still in
    // the router.
    await new Promise((r) => setTimeout(r, 1_000));
    gone.abort();
    await expect(walked).rejects.toThrow();

    // (i) THE ENDPOINT IS STILL HEALTHY. The adapter and its transport are ONE
    // pair for the listener's life, so an abandoned request is not merely a
    // wasted fiber — it is state inside the object every other caller goes
    // through. This does not prove the waiter was withdrawn (the transport
    // multiplexes, so a second call could be answered alongside a stuck one);
    // it proves the door still opens, which is the part a next caller feels.
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

    // (ii) THE RUN IS UNTOUCHED. Ending an observation is not ending the work,
    // and its coordinator is still there to prove it.
    const row = surfaceJson(world, ["get", "runs", runId]) as {
      state: string;
      settled: boolean;
    };
    expect(row.state).toBe("running");
    expect(row.settled).toBe(false);
    expect(runSocketExists(dir)).toBe(true);

    // (iii) AND A FRESH WAIT STILL ANSWERS — the seat the walker left is not
    // still warm.
    const again = verb(world, "run_wait", { runId, deadlineMs: 3_000 });
    expect(again.status).toBe(0);
    expect((again.json as { reason: string }).reason).toBe("still_running");
  }, 300_000);

  it("survives a bridge that is killed mid-wait", async () => {
    // The stdio face's version of the same promise, and the one the skill makes
    // in so many words: "a harness restarting your MCP server kills nothing".
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
      // Issued and deliberately NOT awaited: the point is to kill the process
      // while the call is outstanding.
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

    // SIGKILL, so nothing drained and nothing said goodbye. The daemon holds no
    // authority on behalf of a bridge, so there is nothing for it to have lost.
    expect(await tcpListening(world.origin)).toBe(true);
    const row = surfaceJson(world, ["get", "runs", runId]) as {
      state: string;
      settled: boolean;
    };
    expect(row.state).toBe("running");
    expect(row.settled).toBe(false);

    // And a NEW bridge reaches the same run — the state was never in the
    // process that died.
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
    // 130, or the signal itself where the runtime re-raises rather than
    // translating — the two spellings of "interrupted", and this suite must not
    // be the place that decides which a host uses.
    expect(
      status === 130 || waiting.signalCode === "SIGINT",
      `an interrupted \`odu surface run_wait\` exited ${status} / ${String(waiting.signalCode)}`,
    ).toBe(true);

    // Ctrl-C ended an OBSERVATION.
    const row = surfaceJson(world, ["get", "runs", runId]) as {
      state: string;
      settled: boolean;
    };
    expect(row.state).toBe("running");
    expect(row.settled).toBe(false);
    expect(runSocketExists(dir)).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------

/**
 * THE CRASH WINDOW — a daemon that died between accepting a mutation and
 * recording its outcome.
 *
 * This is the only case `requestId` exists for. Everywhere else a lost reply is
 * a lost reply; here the request was ACCEPTED, a run id was minted, a run may
 * or may not have been launched, and the process that knew died before it could
 * write down which. An agent re-issuing with the same id must get the run that
 * already exists, and never a second one.
 *
 * The receipt is rewound ON DISK, which is the only place in `tests/e2e` that
 * reaches into odu's state instead of driving it through a face. Justified: it
 * is the exact artefact a crash leaves, only the three fields a crash would
 * have left unwritten are changed, and `version` is asserted on the way in so a
 * schema that moves past `RUN_RECORD_FORMAT = 1` fails here loudly rather than
 * silently reconciling nothing.
 */
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

    // SIGKILL the whole group, so nothing drains and nothing gets to finish a
    // write. A SIGTERM would give the daemon the orderly shutdown the crash
    // window is defined by the absence of.
    await stage.killIt();

    // REWIND THE RECEIPT to what a crash inside markDispatched → launch →
    // completeReceipt leaves: accepted, undispatched outcome, no result. Every
    // other field — version, requestId, kind, digest, acceptedAt,
    // plannedRunId, dispatchedAt, claimant — is left exactly as odu wrote it,
    // and the claimant's pid is now a dead process, which is the real
    // post-crash state.
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

    // Restart, in the SAME world — same state root, same origin, so the same
    // catalog and the same receipt store the crash left behind.
    const restarted = await stage.bringUp();
    expect(restarted.daemonHome).toBe(home);

    // (1) IT NOTICED. Reconciliation found the pre-minted run in the catalog
    // and completed the receipt from it, and it publishes the count rather than
    // doing it quietly — which is what lets this assert the mechanism instead
    // of just its effect.
    const cell = surfaceJson(restarted, ["get", "service"]) as {
      readiness: { state: string; reconciled: number };
    };
    expect(cell.readiness.state).toBe("ready");
    expect(
      cell.readiness.reconciled,
      "the restarted daemon reconciled nothing — the rewound receipt was not seen",
    ).toBeGreaterThanOrEqual(1);

    // (2) THE REPEAT REPLAYS. Same id, same input: the recorded receipt comes
    // back, with the original run id and `replayed: true`.
    const again = verb(restarted, "run_start", input);
    expect(again.status).toBe(0);
    const replayed = again.json as { runId: string; replayed: boolean };
    expect(replayed.runId).toBe(runId);
    expect(replayed.replayed).toBe(true);

    // (3) AND THERE IS ONLY ONE. The failure this whole mechanism exists to
    // prevent is a second run for one intent, and it is invisible from the
    // receipt alone — a second run would have its own id and its own receipt,
    // both perfectly well-formed.
    const keys = surfaceJson(restarted, ["keys", "runs"]) as string[];
    const mine = keys.filter((k) => {
      const row = surfaceJson(restarted, ["get", "runs", k]) as {
        repoRoot: string;
      };
      return row.repoRoot === dir;
    });
    expect(mine, `${mine.length} runs exist for one checkout`).toEqual([runId]);

    // (4) THE NEGATIVE ARM. The digest rule has to survive the restart too: the
    // same id with a DIFFERENT request is a conflict, not a replay of something
    // the caller did not ask for.
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

// ---------------------------------------------------------------------------

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

    // THE RUNS OUTLIVED THE SERVICE. That is the claim `reconcile`'s run half
    // makes by writing nothing at all: a coordinator is its own process group,
    // its liveness is the catalog's ownership fence, and the service observes
    // that rather than owning it. Both sockets are still there with no service
    // anywhere to have kept them.
    for (const dir of dirs) expect(runSocketExists(dir)).toBe(true);

    const after = await stage.bringUp();

    for (const runId of runs) {
      const row = surfaceJson(after, ["get", "runs", runId]) as {
        state: string;
        settled: boolean;
        outcome: string | null;
      };
      // STILL RUNNING, NOT `owner_lost` and not tombstoned. A restart that
      // decided an unfinished run must have died with the daemon would have
      // thrown away work that is still going, and it would look exactly like a
      // finished run to everyone downstream.
      expect(row.state, `run ${runId} is ${row.state} after the restart`).toBe(
        "running",
      );
      expect(row.settled).toBe(false);
      expect(row.outcome).toBeNull();

      // The new daemon can WAIT on them — an answer, not a refusal.
      const waited = verb(after, "run_wait", { runId, deadlineMs: 3_000 });
      expect(waited.status).toBe(0);
      expect((waited.json as { reason: string }).reason).toBe("still_running");
    }

    // And it can reach their coordinators: a cancel through the NEW daemon has
    // to travel to a process the OLD one started, which is the one thing a
    // restart could plausibly have broken and the one nothing else here would
    // have noticed.
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

// ---------------------------------------------------------------------------

/**
 * A world whose daemon can be killed and started again IN PLACE.
 *
 * {@link startWebServiceViaCommand} makes a fresh state root each time it is
 * called, which is right for a suite that wants isolation and wrong for a gate
 * whose whole subject is what a restart finds on disk. This keeps the one
 * origin, the one state root and the one daemon home across every tenure, so
 * "restart" means what it says.
 */
function restartableWorld(port: number): {
  bringUp: () => Promise<WebWorld>;
  killIt: () => Promise<void>;
} {
  const { root, origin, env } = privateWorld(port);
  let home: string | undefined;
  /** The tenure currently serving, so teardown can reap it without asking odu
   *  — and asking odu is not available at teardown anyway: every face
   *  bootstraps, so a probe would start the daemon it is trying to remove. */
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
      // The crash catcher, where the daemon says why when it dies without
      // binding — read off the service's own identity rather than re-derived.
      world.logPath = join(home, "web-daemon.stderr.log");
      return world;
    },
  };
}

// ---------------------------------------------------------------------------

/** One `odu surface …` answer, parsed, with a failure that says what it said. */
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

/** Start a run and wait until it is genuinely running — a gate that killed the
 *  daemon while a start was still in flight would be testing a different
 *  window from the one it names. */
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
      // The fixture has no GitHub origin, and strict mode is right to refuse a
      // run it could not report. `noPost` is strict WITHOUT the GitHub writes.
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
