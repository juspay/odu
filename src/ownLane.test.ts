/**
 * `odu:shard=1` puts a node on a lane of its own when the pool has a spare
 * slot — and changes nothing when it does not.
 *
 * Why it exists: a run leases one venue per platform, so every unsharded
 * node shares one machine; on a Cloudflare lane that is one 18 GB disk, and
 * a consumer's heavy nodes (VM tests, e2e suites) need disk of their own.
 * A sharded root with a slot for EVERY shard now runs all of its shards off
 * the primary, each paying its dependency closure on its own lane, and the
 * primary keeps only the unsharded nodes. With fewer slots, shard 0 stays on
 * the primary as it always has.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@odu/execution/coordinator/run";
import type { LaneOptions } from "@odu/execution/coordinator/lane";
import type { LeaseHandle } from "@odu/execution/coordinator/lease";
import type { TaskSpec } from "@odu/execution/common/spec";
import { pendingNode, type NodeStatus, type PipelineState } from "@odu/run-client/surface";

const platform = process.platform === "darwin" ? "aarch64-darwin" : "x86_64-linux";
const originalCwd = process.cwd();
const restores: (() => void)[] = [];
let debugLanes: FakeLane[] = [];
afterEach(() => {
  process.chdir(originalCwd);
  for (const restore of restores.splice(0)) restore();
});

interface FakeLane {
  opts: LaneOptions;
  tasks: TaskSpec[];
  closed: boolean;
  report: (statuses: Record<string, NodeStatus>) => void;
}

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out; lanes: ${JSON.stringify(debugLanes.map((l) => [l.opts.host, l.tasks.map((t) => t.id)]))}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A checkout whose `heavy` asks for a lane of its own, and a hand-driven run. */
function scenario(runId: string, burstsPerCall: string[][]) {
  const dir = mkdtempSync(join(tmpdir(), "odu-own-lane-"));
  const catalog = mkdtempSync(join(tmpdir(), "odu-own-lane-catalog-"));
  restores.push(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(catalog, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, "justfile"),
    '[metadata("ci")]\ndefault: heavy light\n\nprepare:\n    true\n\n[metadata("odu:shard=1")]\nheavy: prepare\n    true\n\nlight: prepare\n    true\n',
  );
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  git("remote", "add", "origin", "file:///unused.git");
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [platform]: ["primary.invalid"] }));
  const env: Record<string, string> = {
    ODU_HOSTS: join(dir, "hosts.json"),
    ODU_STATE_DIR: catalog,
    ODU_RUNNER_FLAKE: "git+file:///nonexistent",
    ODU_AGENT_SUBSTITUTERS: "https://cache.invalid",
    ODU_AGENT_TRUSTED_PUBLIC_KEYS: "cache.invalid:0000000000",
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]] as const));
  restores.push(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);
  process.chdir(dir);

  const released = new Set<string>();
  const lose = new Map<string, () => void>();
  const lease = (host: string): LeaseHandle => {
    let fire: () => void = () => {};
    const lost = new Promise<void>((resolve) => {
      fire = resolve;
    });
    lose.set(host, fire);
    return { host, lost, release: () => released.add(host) };
  };
  const lanes: FakeLane[] = [];
  let calls = 0;
  debugLanes = lanes;
  const startLane = (opts: LaneOptions) => {
    const state: { order: string[]; nodes: Record<string, PipelineState["nodes"][string]> } = { order: [], nodes: {} };
    const add = (tasks: readonly TaskSpec[]) => {
      for (const task of [{ id: "_ci-setup", command: "true", needs: [] } as TaskSpec, ...tasks]) {
        if (state.nodes[task.id] !== undefined) continue;
        state.order.push(task.id);
        state.nodes[task.id] = pendingNode({ id: task.id, name: task.id, command: "true", needs: [] });
        opts.onLogFrame(task.id, { kind: "snapshot", text: `on ${opts.host}\n` });
      }
    };
    const lane: FakeLane = {
      opts,
      tasks: [...opts.tasks],
      closed: false,
      report: (statuses) => {
        for (const [id, status] of Object.entries(statuses)) {
          state.nodes[id] = { ...state.nodes[id]!, status, exitCode: status === "ok" ? 0 : null };
        }
        opts.onNodes(structuredClone({ name: "ci", sha7: "", dirty: false, ...state }));
        for (const [id, status] of Object.entries(statuses)) {
          if (status !== "running" && status !== "pending") opts.onLogFrame(id, { kind: "end" });
        }
      },
    };
    add(opts.tasks);
    lanes.push(lane);
    return {
      platform,
      extend: async (tasks: readonly TaskSpec[]) => {
        lane.tasks.push(...tasks);
        add(tasks);
        return true;
      },
      rerun: async () => true,
      cancel: async () => true,
      drain: async () => ({ reason: "complete" as const }),
      close: () => {
        lane.closed = true;
      },
    };
  };
  const outcome = runCommand(
    {
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
      runId,
    },
    {
      claimVenues: async () => ({ ok: true, lanes: { [platform]: "primary.invalid" }, leases: [lease("primary.invalid")] }),
      leaseBurstSlots: async () => (burstsPerCall[calls++] ?? []).map(lease),
      startLane,
    },
  ).catch((error: unknown) => error);
  const on = (host: string) => lanes.find((l) => l.opts.host === host);
  return { lanes, released, lose, outcome, on, catalog };
}

describe("odu:shard=1 — a lane of its own", () => {
  it("runs the node on a spare slot with its own closure; the primary keeps the rest", async () => {
    const run = scenario("own-lane", [["spare.invalid"]]);
    await waitFor(() => run.on("spare.invalid") !== undefined && run.on("primary.invalid") !== undefined);
    const primary = run.on("primary.invalid")!;
    const own = run.on("spare.invalid")!;
    expect(own.tasks.map((t) => t.id)).toEqual(["prepare", "heavy"]);
    expect(own.tasks.find((t) => t.id === "heavy")!.env).toMatchObject({ ODU_SHARD_INDEX: "0", ODU_SHARD_TOTAL: "1" });
    // The primary never runs `heavy` — not at start, not by extension.
    primary.report({ "_ci-setup": "ok", prepare: "ok", light: "ok" });
    own.report({ "_ci-setup": "ok", prepare: "ok", heavy: "ok" });
    expect(await run.outcome).toBe(0);
    expect(primary.tasks.map((t) => t.id)).not.toContain("heavy");
    expect(run.released.has("spare.invalid")).toBe(true);
    // Log routing: `heavy`'s log is the own lane's, `light`'s the primary's.
    const logs = execFileSync("grep", ["-rl", "on spare.invalid", run.catalog], { encoding: "utf8" });
    expect(logs).toContain("heavy");
    expect(logs).not.toContain("light");
  }, 60_000);

  it("degrades to today's placement when the pool has no spare slot", async () => {
    const run = scenario("own-lane-no-slot", [[]]);
    await waitFor(() => run.on("primary.invalid")?.tasks.some((t) => t.id === "heavy") === true);
    const primary = run.on("primary.invalid")!;
    expect(run.lanes).toHaveLength(1);
    primary.report({ "_ci-setup": "ok", prepare: "ok", heavy: "ok", light: "ok" });
    expect(await run.outcome).toBe(0);
  }, 60_000);

  it.each(["transport", "lease"] as const)("re-places an own lane whose %s dies", async (how) => {
    const run = scenario(`own-lane-dies-${how}`, [["spare.invalid"], ["spare-2.invalid"]]);
    await waitFor(() => run.on("spare.invalid") !== undefined && run.on("primary.invalid") !== undefined);
    const primary = run.on("primary.invalid")!;
    const own = run.on("spare.invalid")!;
    own.report({ "_ci-setup": "ok", prepare: "ok", heavy: "running" });
    if (how === "transport") own.opts.onDead("surface stdio transport closed");
    else run.lose.get("spare.invalid")!();
    await waitFor(() => run.on("spare-2.invalid") !== undefined);
    expect(own.closed).toBe(true);
    expect(primary.closed).toBe(false);
    const again = run.on("spare-2.invalid")!;
    expect(again.tasks.map((t) => t.id)).toEqual(["prepare", "heavy"]);
    primary.report({ "_ci-setup": "ok", prepare: "ok", light: "ok" });
    again.report({ "_ci-setup": "ok", prepare: "ok", heavy: "ok" });
    expect(await run.outcome).toBe(0);
  }, 60_000);
});
