/**
 * Holding the lane's link open through an ssh drop is not available: the
 * session's watchdog force-cycles a silent ssh arm at ~25s, ssh's dead-peer
 * policy ends it at ~30s, and the link's own pinger is a 60–65s backstop
 * beneath both. kolu bakes all three (`@kolu/surface/keepAlive`; no link
 * factory takes a timing parameter).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { handleFor, readAttemptRecord } from "@odu/run-history/store";
import { dialRun } from "@odu/run-client/dial";
import {
  type NodeLogFrame,
  type NodeStatus,
  type PipelineState,
  pendingNode,
} from "@odu/run-client/surface";
import { runUnary, subscribe } from "../common/effectEdge";
import { waitFor } from "../common/scaffoldForTest";
import type { Lane, LaneOptions } from "./lane";
import type { LeaseHandle } from "./lease";
import type { ClaimOutcome } from "./runEnv";
import { maxLaneResurrections } from "./laneResurrection";
import { type RunArgs, runCommand } from "./run";

const hasJust =
  spawnSync("just", ["--version"], { encoding: "utf-8" }).status === 0;

const MAX_RESURRECTIONS = maxLaneResurrections();

const PLATFORM =
  process.platform === "darwin" ? "aarch64-darwin" : "x86_64-linux";
const HOST_A = "builder-a.invalid";
const HOST_B = "builder-b.invalid";

const runArgs = (): RunArgs => ({
  selectors: [],
  platforms: [],
  hostPins: [],
  noDeps: false,
  noStrict: true,
  noSnapshot: false,
  noPost: true,
  supersede: false,
  linger: false,
  noWait: false,
});

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

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-resurrect-"));
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  writeFileSync(
    join(dir, "justfile"),
    [
      '[metadata("ci")]',
      "default: alpha beta gamma",
      "",
      "alpha:",
      "    true",
      "",
      "beta: alpha",
      "    true",
      "",
      "gamma: alpha",
      "    true",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [PLATFORM]: HOST_A }));
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", "file:///nonexistent/origin.git");

  const prevCwd = process.cwd();
  const env: Record<string, string> = {
    ODU_HOSTS: join(dir, "hosts.json"),
    ODU_STATE_DIR: join(dir, ".ci", "state"),
    SURFACE_AGENT_FLAKE_REF: "path:/nonexistent",
  };
  const previous = new Map(
    Object.keys(env).map((key) => [key, process.env[key]] as const),
  );
  process.chdir(dir);
  Object.assign(process.env, env);
  open.push({
    dir,
    restore: () => {
      process.chdir(prevCwd);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  });
  return dir;
}

function sha7Of(dir: string): string {
  return spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).stdout.trim();
}

function laneState(statuses: Record<string, NodeStatus>): PipelineState {
  const ids = Object.keys(statuses);
  return {
    name: "ci",
    sha7: "",
    dirty: false,
    order: ids,
    nodes: Object.fromEntries(
      ids.map((id) => {
        const status = statuses[id] as NodeStatus;
        return [
          id,
          {
            ...pendingNode({ id, name: id, command: "true", needs: [] }),
            status,
            exitCode: status === "ok" ? 0 : null,
            startedAt: status === "pending" ? null : 1_000,
            durationMs: status === "ok" ? 5 : null,
          },
        ];
      }),
    ),
  };
}

interface FakeLane {
  opts: LaneOptions;
  closed: boolean;
}

interface FakeLease extends LeaseHandle {
  released: boolean;
  die: () => void;
}

function fakeLease(host: string): FakeLease {
  let fire: () => void = () => {};
  const lost = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const lease: FakeLease = {
    host,
    lost,
    released: false,
    release: () => {
      lease.released = true;
    },
    die: () => fire(),
  };
  return lease;
}

function harness(opts: { hold?: () => Promise<void> } = {}) {
  const lanes: FakeLane[] = [];
  const leases: FakeLease[] = [];
  const claimHosts: string[] = [];

  const startLane = (laneOpts: LaneOptions): Lane => {
    const entry: FakeLane = { opts: laneOpts, closed: false };
    if (lanes.length > 0) expect(laneOpts.snapshot?.commit).toBe(lanes[0]!.opts.snapshot?.commit);
    expect(laneOpts.snapshot?.commit).toMatch(/^[0-9a-f]{40}$/);
    lanes.push(entry);
    for (const id of ["_ci-setup", ...laneOpts.tasks.map((t) => t.id)]) {
      laneOpts.onLogFrame(id, { kind: "snapshot", text: "" }, "recipe");
      laneOpts.onLogFrame(id, { kind: "snapshot", text: "" }, "push");
    }
    return {
      platform: laneOpts.platform,
      extend: async () => true,
      rerun: async () => true,
      cancel: async () => true,
      drain: async () => ({ reason: "complete" as const }),
      close: () => {
        entry.closed = true;
      },
    };
  };

  const claimVenues = async (): Promise<ClaimOutcome> => {
    const host = claimHosts.length % 2 === 0 ? HOST_A : HOST_B;
    claimHosts.push(host);
    if (claimHosts.length > 1 && opts.hold !== undefined) await opts.hold();
    const lease = fakeLease(host);
    leases.push(lease);
    return { ok: true, lanes: { [PLATFORM]: host }, leases: [lease] };
  };

  return { lanes, leases, claimHosts, deps: { startLane, claimVenues } };
}

async function dialUntilServing(
  socketPath: string,
  timeoutMs = 20_000,
): Promise<NonNullable<Awaited<ReturnType<typeof dialRun>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialed = await dialRun(socketPath);
    if (dialed !== null) return dialed;
    if (Date.now() > deadline) throw new Error("the coordinator never served");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function watchNodes(socketPath: string): Promise<{
  statusOf: (namepath: string) => NodeStatus | undefined;
  close: () => Promise<void>;
}> {
  const dialed = await dialUntilServing(socketPath);
  let latest: PipelineState | undefined;
  void (async () => {
    try {
      for await (const state of subscribe(
        dialed.client.surface.nodes.get(undefined),
      )) {
        latest = state;
      }
    } catch {
    }
  })();
  return {
    statusOf: (namepath) => latest?.nodes[`${namepath}@${PLATFORM}`]?.status,
    close: () => dialed.close().catch(() => {}),
  };
}

const laneFrame = (frame: NodeLogFrame): NodeLogFrame => frame;

async function waitForLive(
  outcome: Promise<unknown>,
  pred: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  await Promise.race([
    waitFor(pred, timeoutMs),
    outcome.then((result) => {
      throw new Error(`the run ended before the test drove it: ${String(result)}`);
    }),
  ]);
}

async function settleOrGiveUp(outcome: Promise<unknown>): Promise<void> {
  let backstop: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    outcome,
    new Promise((resolve) => {
      backstop = setTimeout(resolve, 3_000);
    }),
  ]);
  if (backstop !== undefined) clearTimeout(backstop);
}

async function readWhenWritten(path: string): Promise<string> {
  await waitFor(() => existsSync(path), 20_000);
  return readFileSync(path, "utf-8");
}

describe.if(hasJust)("a remote primary lane that dies mid-run", () => {
  it("re-claims a venue and retries only the unfinished nodes", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const { lanes, leases, claimHosts, deps } = harness();

    const run = runCommand({ ...runArgs(), runId: "placement-retry" }, deps);
    const outcome = run.catch((err: unknown) => err);
    const nodes = await watchNodes(socketPath);

    try {
      await waitForLive(outcome, () => lanes.length === 1);
      const first = lanes[0]!;
      expect(first.opts.host).toBe(HOST_A);
      expect(first.opts.tasks.map((t) => t.id)).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);

      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "running",
          beta: "pending",
          gamma: "pending",
        }),
      );
      first.opts.onLogFrame("alpha", laneFrame({ kind: "append", text: "ALPHA OUTPUT\n" }), "recipe");
      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "ok",
          beta: "running",
          gamma: "pending",
        }),
      );
      first.opts.onLogFrame("alpha", laneFrame({ kind: "end" }), "recipe");
      await waitFor(() => nodes.statusOf("alpha") === "ok", 20_000);
      expect(nodes.statusOf("beta")).toBe("running");

      first.opts.onDead("ssh pipe died");

      await waitFor(() => lanes.length === 2, 20_000);
      expect(claimHosts).toEqual([HOST_A, HOST_B]);
      expect(leases[0]!.released).toBe(true);
      expect(first.closed).toBe(true);

      const second = lanes[1]!;
      expect(second.opts.host).toBe(HOST_B);
      expect(second.opts.tasks.map((t) => t.id)).toEqual(["beta", "gamma"]);
      expect(second.opts.tasks.map((t) => [...t.needs])).toEqual([[], []]);

      await waitFor(() => nodes.statusOf("alpha") === "ok", 20_000);
      await waitFor(() => nodes.statusOf("beta") === "pending", 20_000);
      const sha7 = sha7Of(dir);
      const logOf = (node: string): string => {
        const path = join(dir, ".ci", sha7, PLATFORM, `${node}.log`);
        return existsSync(path) ? readFileSync(path, "utf-8") : "";
      };
      expect(
        await readWhenWritten(join(dir, ".ci", sha7, PLATFORM, "alpha.log")),
      ).toContain("ALPHA OUTPUT");
      await waitFor(
        () => logOf("_ci-setup").includes("reclaiming a venue"),
        20_000,
      );
      expect(logOf("_ci-setup")).toContain("(attempt 1 of 2)");
      expect(logOf("_ci-setup")).toContain(
        "[odu] cut off mid-recipe, re-running from the start: beta",
      );
      expect(logOf("beta")).toBe("");

      second.opts.onNodes(
        laneState({ "_ci-setup": "ok", beta: "ok", gamma: "ok" }),
      );
      second.opts.onLogFrame("beta", laneFrame({ kind: "end" }), "recipe");
      second.opts.onLogFrame("gamma", laneFrame({ kind: "end" }), "recipe");

      expect(await outcome).toBe(0);
      const recorded = handleFor("placement-retry", { root: join(dir, ".ci", "state", "runs") });
      expect(readAttemptRecord(recorded, `alpha@${PLATFORM}`, 1)?.placement.host).toBe(HOST_A);
      expect(readAttemptRecord(recorded, `beta@${PLATFORM}`, 1)?.placement.host).toBe(HOST_A);
      expect(readAttemptRecord(recorded, `beta@${PLATFORM}`, 2)?.placement.host).toBe(HOST_B);
    } finally {
      await nodes.close();
      await settleOrGiveUp(outcome);
    }
  }, 60_000);

  it("does not re-run a node whose ok verdict was still in flight", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const { lanes, deps } = harness();

    const run = runCommand(runArgs(), deps);
    const outcome = run.catch((err: unknown) => err);
    const nodes = await watchNodes(socketPath);

    try {
      await waitForLive(outcome, () => lanes.length === 1);
      const first = lanes[0]!;
      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "running",
          beta: "pending",
          gamma: "pending",
        }),
      );
      first.opts.onLogFrame(
        "alpha",
        laneFrame({ kind: "append", text: "ALPHA OUTPUT\n" }),
        "recipe",
      );
      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "ok",
          beta: "pending",
          gamma: "pending",
        }),
      );
      await waitFor(() => nodes.statusOf("alpha") === "running", 20_000);

      first.opts.onDead("ssh pipe died");
      await waitForLive(outcome, () => lanes.length === 2);

      await waitFor(() => nodes.statusOf("alpha") === "ok", 20_000);
      expect(lanes[1]!.opts.tasks.map((t) => t.id)).toEqual(["beta", "gamma"]);
      expect(
        await readWhenWritten(join(dir, ".ci", sha7Of(dir), PLATFORM, "alpha.log")),
      ).toContain("ALPHA OUTPUT");

      lanes[1]!.opts.onNodes(
        laneState({ "_ci-setup": "ok", beta: "ok", gamma: "ok" }),
      );
      lanes[1]!.opts.onLogFrame("beta", laneFrame({ kind: "end" }), "recipe");
      lanes[1]!.opts.onLogFrame("gamma", laneFrame({ kind: "end" }), "recipe");
      expect(await outcome).toBe(0);
    } finally {
      await nodes.close();
      await settleOrGiveUp(outcome);
    }
  }, 60_000);

  it("errors the platform once the resurrection budget is spent", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const { lanes, deps } = harness();

    const run = runCommand(runArgs(), deps);
    const outcome = run.catch((err: unknown) => err);
    const nodes = await watchNodes(socketPath);

    try {
      for (let attempt = 0; attempt <= MAX_RESURRECTIONS; attempt += 1) {
        await waitForLive(outcome, () => lanes.length === attempt + 1);
        const lane = lanes[attempt]!;
        lane.opts.onNodes(
          laneState({
            "_ci-setup": "ok",
            alpha: "running",
            beta: "pending",
            gamma: "pending",
          }),
        );
        await waitFor(() => nodes.statusOf("alpha") === "running", 20_000);
        lane.opts.onDead(`link died #${attempt + 1}`);
      }

      const code = await outcome;
      expect(code).not.toBe(0);
      expect(lanes.length).toBe(MAX_RESURRECTIONS + 1);

      const sha7 = sha7Of(dir);
      const timings = (await readWhenWritten(join(dir, ".ci", sha7, "timings.jsonl")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { node: string; status: string });
      const statusOf = (node: string): string | undefined =>
        timings.find((t) => t.node === `${node}@${PLATFORM}`)?.status;
      expect(statusOf("alpha")).toBe("errored");
      expect(statusOf("beta")).toBe("skipped");
      expect(statusOf("gamma")).toBe("skipped");

      const setupLog = await readWhenWritten(
        join(dir, ".ci", sha7, PLATFORM, "_ci-setup.log"),
      );
      expect(setupLog).toContain(
        `gave up after ${MAX_RESURRECTIONS} lane resurrections`,
      );
      expect(
        await readWhenWritten(join(dir, ".ci", sha7, PLATFORM, "alpha.log")),
      ).toContain("[odu] lane died: link died #3");
    } finally {
      await nodes.close();
      await settleOrGiveUp(outcome);
    }
  }, 60_000);

  it("treats a lost venue lease as the same death, exactly once", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const { lanes, leases, claimHosts, deps } = harness();

    const run = runCommand(runArgs(), deps);
    const outcome = run.catch((err: unknown) => err);
    const nodes = await watchNodes(socketPath);

    try {
      await waitForLive(outcome, () => lanes.length === 1 && leases.length === 1);
      const first = lanes[0]!;
      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "running",
          beta: "pending",
          gamma: "pending",
        }),
      );
      await waitFor(() => nodes.statusOf("alpha") === "running", 20_000);

      leases[0]!.die();
      await waitFor(() => lanes.length === 2, 20_000);
      expect(claimHosts).toEqual([HOST_A, HOST_B]);

      first.opts.onDead("ssh pipe died");
      await new Promise((r) => setTimeout(r, 150));
      expect(lanes.length).toBe(2);
      expect(claimHosts.length).toBe(2);

      const second = lanes[1]!;
      second.opts.onNodes(
        laneState({ "_ci-setup": "ok", alpha: "ok", beta: "ok", gamma: "ok" }),
      );
      for (const id of ["alpha", "beta", "gamma"]) {
        second.opts.onLogFrame(id, laneFrame({ kind: "end" }), "recipe");
      }
      expect(await outcome).toBe(0);
    } finally {
      await nodes.close();
      await settleOrGiveUp(outcome);
    }
  }, 60_000);

  it("applies a cancel that lands while the retry claim is still queueing", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    let releaseHold: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const { lanes, leases, deps } = harness({ hold: () => held });

    const run = runCommand(runArgs(), deps);
    const outcome = run.catch((err: unknown) => err);
    const nodes = await watchNodes(socketPath);
    const dialed = await dialUntilServing(socketPath);

    try {
      await waitForLive(outcome, () => lanes.length === 1);
      lanes[0]!.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "running",
          beta: "pending",
          gamma: "pending",
        }),
      );
      await waitFor(() => nodes.statusOf("alpha") === "running", 20_000);
      lanes[0]!.opts.onDead("ssh pipe died");
      await waitFor(() => leases.length === 0 || leases[0]!.released, 20_000);
      const ack = await runUnary(
        dialed.client.surface.lane.cancel({ platform: PLATFORM }),
      );
      expect(ack.ok).toBe(true);

      releaseHold();
      const code = await outcome;
      expect(code).not.toBe(0);
      expect(lanes.length).toBe(1);
      expect(leases.length).toBe(2);
      expect(leases[1]!.released).toBe(true);

      const sha7 = sha7Of(dir);
      const timings = (await readWhenWritten(join(dir, ".ci", sha7, "timings.jsonl")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { node: string; status: string });
      for (const node of ["alpha", "beta", "gamma"]) {
        expect(
          timings.find((t) => t.node === `${node}@${PLATFORM}`)?.status,
        ).toBe("cancelled");
      }
    } finally {
      await dialed.close().catch(() => {});
      await nodes.close();
      await settleOrGiveUp(outcome);
    }
  }, 60_000);
});
