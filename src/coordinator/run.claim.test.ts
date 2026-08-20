/**
 * What the socket owes an observer WHILE a venue claim is outstanding
 * (juspay/odu#84, grok debate F4).
 *
 * The claim is the only thing in `orchestrate` that both takes minutes and dials
 * ssh, so the window it opens — a live socket, live signal handlers, a live
 * `lane.cancel`, and no lanes — could not be reached from a test at all. This
 * drives the real `runCommand` against a throwaway repo with the claim INJECTED
 * and held open, which is the only way to ask the question that matters:
 *
 *   an operator drops the only platform mid-claim; does `wait_for_settle` say
 *   the run is over while the coordinator still holds the box?
 *
 * It did. `cancelPlatform` terminalized the lane's nodes at once, and every
 * out-of-process reader (`odu wait`, the MCP `wait_for_settle`) judges settle by
 * the `nodes` cell — not by the coordinator's private `checkSettled`. So a
 * single-platform run answered "settled, cancelled" while `claimVenues` was
 * still copying a closure, still holding the checkout's one-run lock, and still
 * owed a lease; an agent taking that at face value got "a run is already in
 * progress" from its next `run()`.
 */

import { spawnSync } from "node:child_process";
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
import { runUnary, subscribe } from "../common/effectEdge";
import { waitFor } from "../common/scaffoldForTest";
import { agentReaderFromA } from "../mcp/agentSurface";
import { waitForSettle } from "./waitForSettle";
import type { ClaimOutcome } from "./runEnv";
import { runCommand } from "./run";
import { tryDialSocket } from "./socket";

const hasJust =
  spawnSync("just", ["--version"], { encoding: "utf-8" }).status === 0;

const PLATFORM = process.platform === "darwin" ? "aarch64-darwin" : "x86_64-linux";

interface Fixture {
  dir: string;
  restore: () => void;
}

const open: Fixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) {
    f.restore();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

/** A throwaway git checkout with a one-recipe CI DAG and a hosts file naming a
 *  REMOTE host — remote so the platform lands in `platformsToClaim` and the run
 *  actually enters the claim. Nothing ever dials it: the claim is injected. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-claim-"));
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  writeFileSync(
    join(dir, "justfile"),
    ['[metadata("ci")]', "default: unit", "", "unit:", "    true", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "hosts.json"),
    JSON.stringify({ [PLATFORM]: "unreachable.invalid" }),
  );
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  // A remote lane refuses without an origin to fetch from. Deliberately not a
  // github.com URL: `parseGithubRemote` then yields null, so no forge coordinate
  // is resolved and no status-posting path is reachable at all.
  git("remote", "add", "origin", "file:///nonexistent/origin.git");

  const prevCwd = process.cwd();
  const prevHosts = process.env.ODU_HOSTS;
  const prevFlake = process.env.ODU_RUNNER_FLAKE;
  process.chdir(dir);
  process.env.ODU_HOSTS = join(dir, "hosts.json");
  // Never resolved — `resolveRunnerFlake` only has to not throw, because the
  // injected claim is what would have used it.
  process.env.ODU_RUNNER_FLAKE = "git+file:///nonexistent";
  open.push({
    dir,
    restore: () => {
      process.chdir(prevCwd);
      if (prevHosts === undefined) delete process.env.ODU_HOSTS;
      else process.env.ODU_HOSTS = prevHosts;
      if (prevFlake === undefined) delete process.env.ODU_RUNNER_FLAKE;
      else process.env.ODU_RUNNER_FLAKE = prevFlake;
    },
  });
  return dir;
}

/** Poll the checkout socket until the coordinator answers. */
async function dialUntilServing(
  socketPath: string,
  timeoutMs = 20_000,
): Promise<NonNullable<Awaited<ReturnType<typeof tryDialSocket>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialed = await tryDialSocket(socketPath);
    if (dialed !== null) return dialed;
    if (Date.now() > deadline) throw new Error("the coordinator never served");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.if(hasJust)("a cancel that lands mid-claim", () => {
  it("does not let wait_for_settle call the run over while the claim holds a box", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");

    // The claim, held open until this test releases it — the ssh dial a real
    // run would be inside for minutes.
    let releaseClaim: (outcome: ClaimOutcome) => void = () => {};
    const claimHeld = new Promise<ClaimOutcome>((resolve) => {
      releaseClaim = resolve;
    });
    let claimEntered = false;

    const run = runCommand(
      {
        selectors: [],
        platforms: [],
        hostPins: [],
        noDeps: false,
        noStrict: true,
        noSnapshot: true,
        noPost: true,
        progressJson: false,
        supersede: false,
        linger: false,
        noWait: false,
      },
      {
        claimVenues: async () => {
          claimEntered = true;
          return claimHeld;
        },
      },
    );
    // The run never returns on its own here (it parks or awaits settle); a
    // rejection must still surface rather than becoming an unhandled one.
    const runOutcome = run.catch((err: unknown) => err);

    // The socket comes up BEFORE the claim — the whole point of #84.
    await waitFor(() => claimEntered, 20_000);
    const dialed = await dialUntilServing(socketPath);

    try {
      // Drop the only platform, the way `odu cancel @plat` / MCP `lane_cancel`
      // does — over the socket, from outside, while the claim is still held.
      const ack = await runUnary(
        dialed.client.surface.lane.cancel({ platform: PLATFORM }),
      );
      expect(ack.ok).toBe(true);

      // THE ASSERTION. The run is not over: the coordinator still holds the
      // checkout lock and is still inside the claim. A verdict here must time
      // out, not report a settled/cancelled run.
      const verdict = await waitForSettle({
        client: agentReaderFromA(dialed.client),
        timeoutMs: 750,
        failFast: false,
        socketPath,
      });
      expect(verdict.settled).toBe(false);
      expect(verdict.timed_out).toBe(true);
    } finally {
      // Let the claim fail so the run terminalizes and stops on its own.
      releaseClaim({
        ok: false,
        error: new Error("odu: test released the claim"),
      });
      await dialed.close();
      // Cleared on the happy path: an armed 10s timer holds the loop open long
      // after the assertions pass, which is the whole run's wall time for a
      // backstop that exists only for the case where the run never returns.
      let backstop: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runOutcome,
        new Promise((r) => {
          backstop = setTimeout(r, 10_000);
        }),
      ]);
      if (backstop !== undefined) clearTimeout(backstop);
    }
  }, 60_000);
});

/**
 * The second question the same harness can ask: a node whose fate the
 * COORDINATOR decides — no lane ever attached — still has a log, and a reader is
 * owed the same two facts about it as about any other node.
 */
describe.if(hasJust)("a node the coordinator itself terminalizes", () => {
  it("ends its fan-in log and owns its file, so `logs -f` returns and no stale bytes survive", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    // `.ci/` is where the run writes; ignoring it keeps the tree CLEAN, which a
    // remote-pool run requires (a dirty tree refuses before it ever claims).
    writeFileSync(join(dir, ".gitignore"), ".ci/\n");
    git("add", "-A");
    git("commit", "-qm", "ignore .ci");
    const sha7 = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    }).stdout.trim();
    // A PREVIOUS run of this same commit left its output here. The path is
    // addressed by commit, not by run, so this run must replace it — including
    // for a node that never emits a byte, which is exactly this one.
    const logFile = join(dir, ".ci", sha7, PLATFORM, "unit.log");
    mkdirSync(join(dir, ".ci", sha7, PLATFORM), { recursive: true });
    writeFileSync(logFile, "STALE OUTPUT FROM THE PREVIOUS RUN\n");

    let releaseClaim: (outcome: ClaimOutcome) => void = () => {};
    const claimHeld = new Promise<ClaimOutcome>((resolve) => {
      releaseClaim = resolve;
    });
    let claimEntered = false;
    const run = runCommand(
      {
        selectors: [],
        platforms: [],
        hostPins: [],
        noDeps: false,
        noStrict: true,
        noSnapshot: true,
        noPost: true,
        progressJson: false,
        supersede: false,
        linger: false,
        noWait: false,
      },
      {
        claimVenues: async () => {
          claimEntered = true;
          return claimHeld;
        },
      },
    );
    const runOutcome = run.catch((err: unknown) => err);

    await waitFor(() => claimEntered, 20_000);
    const dialed = await dialUntilServing(socketPath);
    try {
      // Attached BEFORE the node is terminalized, the way `odu logs -f` is:
      // this is the reader whose loop only ends on a terminal frame.
      const kinds: string[] = [];
      const sub = subscribe(
        dialed.client.surface.nodeLog.get({ id: `unit@${PLATFORM}` }),
      );
      void (async () => {
        try {
          for await (const frame of sub) {
            kinds.push(frame.kind);
            if (frame.kind === "end") break;
          }
        } catch {
          // The socket closes when the run exits; a reader still parked on it
          // then sees the transport go, which is NOT the terminal under test.
        }
      })();
      // The subscription is live once its opening snapshot lands — assert
      // against a reader that was already attached, not one that raced.
      await waitFor(() => kinds.length > 0, 20_000);

      // The claim fails: no machine, no lane, and every node on the platform
      // goes terminal by the coordinator's own decision.
      releaseClaim({
        ok: false,
        error: new Error("odu: test released the claim"),
      });

      // THE ASSERTION. The node reached a terminal status, so its log reached
      // its terminal too — on the fan-in socket, not only on a lane's. Without
      // it `odu logs -f unit@<plat>` against this run never returns.
      await waitFor(() => kinds.includes("end"), 20_000);
      void sub.return?.();
      await runOutcome;

      // …and the run owns the file, so a reader who opens it is not handed the
      // previous run's output under this run's red verdict.
      expect(readFileSync(logFile, "utf-8")).not.toContain("STALE OUTPUT");
    } finally {
      await dialed.close();
      let backstop: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runOutcome,
        new Promise((r) => {
          backstop = setTimeout(r, 10_000);
        }),
      ]);
      if (backstop !== undefined) clearTimeout(backstop);
    }
  }, 60_000);
});
