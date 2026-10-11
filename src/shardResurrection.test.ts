/**
 * A sharded platform survives the death of its PRIMARY lane.
 *
 * `check` is sharded three ways: the primary lane runs `prepare` and shard
 * 1-of-3, two burst venues run shards 2 and 3 (each with its own copy of
 * `prepare`). The primary dies mid-shard. What must happen is what happens to
 * an unsharded platform, scoped to the primary: its lease alone is handed
 * back, a new venue is claimed, and the new primary lane re-runs `prepare`
 * (a fresh workspace) and its shard of `check` — with the same shard identity
 * — while the burst lanes, on their own venues, are left to finish. The run
 * ends green.
 */

import { afterEach, expect, it } from "bun:test";
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
afterEach(() => {
  process.chdir(originalCwd);
  for (const restore of restores.splice(0)) restore();
});

interface FakeLane {
  opts: LaneOptions;
  tasks: TaskSpec[];
  closed: boolean;
  /** Publish these statuses (and end every terminal node's log). */
  report: (statuses: Record<string, NodeStatus>) => void;
}

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

it("re-claims only the primary when it dies, and leaves the shard lanes running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odu-shard-resurrect-"));
  const catalog = mkdtempSync(join(tmpdir(), "odu-shard-resurrect-catalog-"));
  restores.push(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(catalog, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, "justfile"),
    '[metadata("ci")]\ndefault: check\n\nprepare:\n    true\n\n[metadata("odu:shard=3")]\ncheck: prepare\n    true\n',
  );
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  git("remote", "add", "origin", "file:///unused.git");
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [platform]: ["primary-a.invalid", "primary-b.invalid"] }));
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
  const lease = (host: string): LeaseHandle => ({
    host,
    lost: new Promise(() => {}),
    release: () => {
      released.add(host);
    },
  });
  const claimed: string[] = [];
  const lanes: FakeLane[] = [];

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

  const run = runCommand(
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
      runId: "shard-resurrect",
    },
    {
      claimVenues: async () => {
        const host = claimed.length === 0 ? "primary-a.invalid" : "primary-b.invalid";
        claimed.push(host);
        return { ok: true, lanes: { [platform]: host }, leases: [lease(host)] };
      },
      leaseBurstSlots: async () => [lease("burst-2.invalid"), lease("burst-3.invalid")],
      startLane,
    },
  );
  const outcome = run.catch((error: unknown) => error);

  const primaryOf = (host: string) => lanes.find((l) => l.opts.host === host && l.tasks.some((t) => t.id === "check" && t.env?.ODU_SHARD_INDEX === "0"));
  await waitFor(() => primaryOf("primary-a.invalid") !== undefined && lanes.length === 3);
  const first = primaryOf("primary-a.invalid")!;
  const shards = lanes.filter((l) => l !== first);
  expect(shards.map((l) => l.opts.host).sort()).toEqual(["burst-2.invalid", "burst-3.invalid"]);

  // prepare passes on the primary; its shard of `check` is mid-recipe; the
  // burst shards are running too.
  first.report({ "_ci-setup": "ok", prepare: "ok", check: "running" });
  for (const shard of shards) shard.report({ "_ci-setup": "ok", prepare: "ok", check: "running" });

  // THE EVENT: the primary's transport dies.
  first.opts.onDead("surface stdio transport closed: the peer stopped answering the keep-alive ping");

  // A new primary is claimed; only the dead primary's lease went back.
  await waitFor(() => claimed.length === 2 && primaryOf("primary-b.invalid") !== undefined);
  expect(released.has("primary-a.invalid")).toBe(true);
  expect(released.has("burst-2.invalid")).toBe(false);
  expect(released.has("burst-3.invalid")).toBe(false);
  expect(first.closed).toBe(true);
  for (const shard of shards) expect(shard.closed).toBe(false);

  // It re-runs `prepare` (fresh workspace) and its shard, with the shard's
  // identity intact.
  const second = primaryOf("primary-b.invalid")!;
  expect(second.tasks.map((t) => t.id)).toEqual(["prepare", "check"]);
  const check = second.tasks.find((t) => t.id === "check")!;
  expect(check.env).toMatchObject({ ODU_SHARD_INDEX: "0", ODU_SHARD_TOTAL: "3" });
  expect([...check.needs]).toEqual(["prepare"]);

  // Everyone finishes; the platform is green.
  second.report({ "_ci-setup": "ok", prepare: "ok", check: "ok" });
  for (const shard of shards) shard.report({ "_ci-setup": "ok", prepare: "ok", check: "ok" });
  expect(await outcome).toBe(0);
}, 60_000);

it.each(["transport", "lease"] as const)("re-places a shard lane whose %s dies, and leaves the others running", async (how) => {
  const dir = mkdtempSync(join(tmpdir(), "odu-shard-resurrect-"));
  const catalog = mkdtempSync(join(tmpdir(), "odu-shard-resurrect-catalog-"));
  restores.push(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(catalog, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, "justfile"),
    '[metadata("ci")]\ndefault: check\n\nprepare:\n    true\n\n[metadata("odu:shard=3")]\ncheck: prepare\n    true\n',
  );
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  git("remote", "add", "origin", "file:///unused.git");
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [platform]: ["primary-a.invalid", "primary-b.invalid"] }));
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
    return {
      host,
      lost,
      release: () => {
        released.add(host);
      },
    };
  };
  let burstCalls = 0;
  const claimed: string[] = [];
  const lanes: FakeLane[] = [];

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

  const run = runCommand(
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
      runId: `shard-lane-resurrect-${how}`,
    },
    {
      claimVenues: async () => {
        const host = claimed.length === 0 ? "primary-a.invalid" : "primary-b.invalid";
        claimed.push(host);
        return { ok: true, lanes: { [platform]: host }, leases: [lease(host)] };
      },
      leaseBurstSlots: async () => {
        burstCalls += 1;
        return burstCalls === 1
          ? [lease("burst-2.invalid"), lease("burst-3.invalid")]
          : [lease("burst-4.invalid")];
      },
      startLane,
    },
  );
  const outcome = run.catch((error: unknown) => error);

  const onHost = (host: string) => lanes.find((l) => l.opts.host === host);
  await waitFor(() => lanes.length === 3);
  const primary = lanes.find((l) => l.opts.host === "primary-a.invalid")!;
  const doomed = onHost("burst-2.invalid")!;
  const survivor = onHost("burst-3.invalid")!;
  primary.report({ "_ci-setup": "ok", prepare: "ok", check: "running" });
  doomed.report({ "_ci-setup": "ok", prepare: "ok", check: "running" });
  survivor.report({ "_ci-setup": "ok", prepare: "ok", check: "running" });

  // THE EVENT: one shard lane's transport dies, or its venue lease is lost.
  if (how === "transport") doomed.opts.onDead("surface stdio transport closed");
  else lose.get("burst-2.invalid")!();

  // That shard alone is re-placed: its venue goes back, a new burst slot is
  // claimed, and the whole shard closure starts there (a fresh workspace).
  await waitFor(() => onHost("burst-4.invalid") !== undefined);
  expect(released.has("burst-2.invalid")).toBe(true);
  expect(doomed.closed).toBe(true);
  expect(primary.closed).toBe(false);
  expect(survivor.closed).toBe(false);
  expect(claimed).toEqual(["primary-a.invalid"]);
  const replaced = onHost("burst-4.invalid")!;
  expect(replaced.tasks.map((t) => t.id)).toEqual(["prepare", "check"]);
  expect(replaced.tasks.find((t) => t.id === "check")!.env).toMatchObject({
    ODU_SHARD_INDEX: doomed.tasks.find((t) => t.id === "check")!.env!.ODU_SHARD_INDEX,
    ODU_SHARD_TOTAL: "3",
  });

  for (const lane of [primary, survivor, replaced]) lane.report({ "_ci-setup": "ok", prepare: "ok", check: "ok" });
  expect(await outcome).toBe(0);
}, 60_000);
