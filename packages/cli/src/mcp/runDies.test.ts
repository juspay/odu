/**
 * REPRODUCTION of the incident: a run started through a HOSTED `odu mcp` died
 * when its host (the service the MCP server runs in) was restarted — the
 * cgroup answer killed the coordinator mid-flight and left its residue in
 * `.ci`. The ruling (the human's, 2026-09-02): odu ADMITS the limit — the
 * tool says the run dies with its host — and every face REPORTS the corpse
 * instead of answering an empty ledger / a silent wait.
 *
 * The corpse is built the way the kill really leaves it: a REAL child process
 * acquires the real run lock (odu.run.lock naming its pid), reserves the real
 * seq (`.ci/<sha7>/runs/<seq>.json` sentinel), serves a REAL socket file on
 * `.ci/odu.sock` — and is then SIGKILLed by explicit pid, so none of its
 * cleanup runs: the exact residue systemd's KillMode=cgroup leaves.
 *
 * These tests were seen RED against the unfixed code: `listRuns` had no
 * `dead_run` to name, `wait_for_settle` answered "no run in progress",
 * `node_rerun` answered `{ok: false}`, `run`'s description advertised the
 * opposite ("the run keeps going even if this MCP server exits or is
 * restarted"), and `startRun` said nothing about what it started over.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentNodes } from "./agentSurface";
import { EMPTY_NODES } from "./agentSurface";
import { rerunTool } from "./rerunTool";
import { listRuns } from "./runsTool";
import { runTool, startRun } from "./runTool";
import { waitForSettle } from "@odu/execution/coordinator/waitForSettle";
import { Effect, Stream } from "effect";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  // Kills by explicit PID only.
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

/**
 * Build the incident's corpse in `dir` and return its paths: a real child
 * process acquires the REAL run lock and reserves the REAL seq (odu's own
 * modules, so the residue is what the writers actually write), binds the real
 * socket path — and is SIGKILLed before any cleanup can run.
 */
async function killACoordinator(dir: string): Promise<{
  socketPath: string;
  lockPath: string;
}> {
  mkdirSync(join(dir, ".ci"), { recursive: true });
  const socketPath = join(dir, ".ci", "odu.sock");
  const lockPath = join(dir, ".ci", "odu.run.lock");
  // The corpse imports the REAL writers, so the residue it leaves is what a
  // real coordinator leaves. Both now live in sibling workspace packages —
  // the run lock in the engine, the seq reservation in the durable history —
  // so the paths are spelled from this file rather than assumed to be under
  // one `src/`.
  const lock = new URL(
    "../../../execution/src/coordinator/checkoutLock.ts",
    import.meta.url,
  ).pathname;
  const ledger = new URL(
    "../../../run-history/src/legacy/ledger.ts",
    import.meta.url,
  ).pathname;
  writeFileSync(
    join(dir, "corpse.ts"),
    [
      `import { createServer } from "node:net";`,
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { tryAcquireRunLock } from ${JSON.stringify(lock)};`,
      `import { reserveNextSeq } from ${JSON.stringify(ledger)};`,
      `const held = tryAcquireRunLock(${JSON.stringify(lockPath)});`,
      `if (held === null) { console.error("the run lock was not free"); process.exit(1); }`,
      // The reservation the coordinator stamps once it owns the run's
      // identity — the file a mid-flight kill leaves as the run's tombstone.
      `reserveNextSeq(${JSON.stringify(dir)}, "deadbee");`,
      `mkdirSync(${JSON.stringify(join(dir, ".ci", "deadbee", "x86_64-linux"))}, { recursive: true });`,
      `writeFileSync(${JSON.stringify(join(dir, ".ci", "deadbee", "x86_64-linux", "ci::e2e.log"))}, "half a lane's output\\n");`,
      // A REAL socket file at the coordinator's path: the server behind it
      // dies with the process, the FILE does not (only an orderly close
      // unlinks) — the incident's stale `.ci/odu.sock`.
      `const server = createServer();`,
      `server.listen(${JSON.stringify(socketPath)}, () => {`,
      `  writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));`,
      `});`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [join(dir, "corpse.ts")], {
    stdio: "inherit",
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
  // Wait for the child to stamp its pid, then do to it what systemd's
  // KillMode=cgroup did to the incident's coordinator.
  for (let i = 0; i < 100 && !readPid(dir); i += 1) await sleep(50);
  const pid = readPid(dir);
  if (pid === null) throw new Error("the stand-in coordinator never came up");
  child.kill("SIGKILL");
  expect(await exited).not.toBe(0);
  pids.push(pid);
  return { socketPath, lockPath };
}

function readPid(dir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The reader a post-kill dial yields: one no-run frame, then end of stream —
 *  `redialingAClient`'s answer over a socket nobody serves any more. */
function deadReader(): {
  surface: { nodes: { get: () => Stream.Stream<AgentNodes, unknown> } };
} {
  return {
    surface: {
      nodes: {
        get: () => Stream.make(EMPTY_NODES),
      },
    },
  };
}

describe("a run whose host killed its coordinator is REPORTED, not hidden", () => {
  it("`runs` names the death instead of answering an empty ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-died-"));
    dirs.push(dir);
    await killACoordinator(dir);

    const result = await listRuns({ checkout: dir });
    // The dead run had no time to finalize a record: the ledger is empty,
    // and THAT used to be the whole answer.
    expect(result.runs).toEqual([]);
    expect(result.dead_run).not.toBeNull();
    expect(result.dead_run!.sha7).toBe("deadbee");
    expect(result.dead_run!.seq).toBe(1);
    expect(result.dead_run!.message).toContain("deadbee#1");
    expect(result.dead_run!.message).toContain(
      "died with the process that started it",
    );
  });

  it("`wait_for_settle` refuses LOUDLY naming the death — never a silent 'no run'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-died-"));
    dirs.push(dir);
    const { socketPath } = await killACoordinator(dir);

    await expect(
      waitForSettle({
        client: deadReader(),
        socketPath,
        resolveRunContext: () => ({ repoRoot: dir, sha7: "deadbee" }),
      }),
    ).rejects.toThrow(/run .* died with the process that started it|deadbee#1/);
  });

  it("`wait_for_settle` on an OBSERVED-then-killed run answers the death, not a half-observed verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-died-"));
    dirs.push(dir);
    const { socketPath } = await killACoordinator(dir);

    // The wait that was attached when the host died: it saw the run live
    // (nodes running), then the coordinator's socket closed and there is no
    // finalized record to answer from — exactly the arm that used to fall
    // back to a silent "settled:false, passed:false" nobody could act on.
    const reader: {
      surface: { nodes: { get: () => Stream.Stream<AgentNodes, unknown> } };
    } = {
      surface: {
        nodes: {
          get: () =>
            Stream.make({
              run: true,
              pipeline: "ci::default",
              sha7: "deadbee",
              seq: 1,
              nodes: [
                {
                  id: "ci::e2e@x86_64-linux",
                  name: "ci::e2e",
                  status: "running",
                  exit_code: null,
                  duration_ms: null,
                  red: false,
                },
              ],
              unposted: [],
            } satisfies AgentNodes),
        },
      },
    };
    await expect(
      waitForSettle({
        client: reader,
        socketPath,
        resolveRunContext: () => ({ repoRoot: dir, sha7: "deadbee" }),
      }),
    ).rejects.toThrow(/died with the process that started it/);
  });

  it("`node_rerun` errors naming the death — there is no live run to rerun on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-died-"));
    dirs.push(dir);
    await killACoordinator(dir);

    // The named-checkout fork of the handler dials the corpse's socket for
    // real; the injected client never enters (see clientForCheckout).
    await expect(
      Effect.runPromise(
        rerunTool.handler(
          { id: "ci::e2e@x86_64-linux", checkout: dir },
          {} as never,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/died with the process that started it|deadbee#1/);
  });

  it("starting over the corpse works WITHOUT supersede — and the answer says what it cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-died-"));
    dirs.push(dir);
    await killACoordinator(dir);

    const spawned: { args: string[]; checkout: string }[] = [];
    const r = await startRun(
      { checkout: dir },
      {
        spawnRun: (args, checkout) => {
          spawned.push({ args, checkout });
          return { stderr: "", onExit: new Promise<number>(() => {}) };
        },
        waitForSocket: async () => true,
      },
    );
    // No supersede, and the start goes through — the run that died is not a
    // live run holding the checkout.
    expect(r).toMatchObject({ ok: true, started: true });
    expect(spawned).toHaveLength(1);
    // …and the answer SAYS the previous run died with its host, and what of
    // it this start cleared.
    expect(r.coordinator_lifetime).toContain(
      "lives and dies with the process that started it",
    );
    expect(r.cleared).toContain("deadbee#1");
  });
});

describe("the `run` tool's own text admits the limit", () => {
  it("the description states the host-coupling instead of denying it", () => {
    expect(runTool.description).toContain(
      "lives and dies with the process that started it",
    );
    expect(runTool.description).toContain("a restart of that host kills the run");
    // The claim that was false under a service restart is gone.
    expect(runTool.description).not.toContain(
      "keeps going even if this MCP server exits or is restarted",
    );
  });
});
