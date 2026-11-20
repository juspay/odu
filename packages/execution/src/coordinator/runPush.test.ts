import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { handleFor, readJournal } from "@odu/run-history/store";
import { fanId, logPathFor, shortSha } from "@odu/run-client/nodeId";
import { RUN_FILES } from "@odu/run-history/paths";
import type { RunEvent } from "@odu/run-history/schema";
import {
  type NodePush,
  type NodeStatus,
  type PipelineState,
  pendingNode,
} from "@odu/run-client/surface";
import { waitFor } from "../common/scaffoldForTest";
import type { Lane, LaneOptions } from "./lane";
import type { LeaseHandle } from "./lease";
import type { ClaimOutcome } from "./runEnv";
import { type RunArgs, runCommand } from "./run";

const hasJust = spawnSync("just", ["--version"], { encoding: "utf-8" }).status === 0;

const PLATFORM = process.platform === "darwin" ? "aarch64-darwin" : "x86_64-linux";
const HOST = "builder-a.invalid";
const RUN_ID = "0000000f-0001";
const NODE = `alpha@${PLATFORM}`;
const SAID = "odu: 1 path could not be pushed to main — 413 too large";

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

function fixture(
  options: {
    pins?: readonly (string | null)[];
    branch?: string | null;
    remote?: string;
    defaultBranch?: string;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-push-journal-"));
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  writeFileSync(
    join(dir, "justfile"),
    [
      '[metadata("ci")]',
      "default: alpha",
      "",
      ...(options.pins ?? []).map((pin) =>
        pin === null ? '[metadata("odu:pin")]' : `[metadata("odu:pin=${pin}")]`,
      ),
      "alpha:",
      "    true",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [PLATFORM]: HOST }));
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", options.remote ?? "file:///nonexistent/origin.git");
  if (options.branch === null) git("checkout", "-q", "--detach");
  else if (options.branch !== undefined) git("checkout", "-q", "-b", options.branch);
  if (options.defaultBranch !== undefined) {
    // A remote-tracking ref first: `remote set-head` refuses to point at one
    // that does not exist, and a clone has both. No fetch — the origin URL
    // above is deliberately unreachable, and the coordinator's probe is
    // local too.
    git("update-ref", `refs/remotes/origin/${options.defaultBranch}`, "HEAD");
    git("remote", "set-head", "origin", options.defaultBranch);
  }

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

function plantPushToken(): void {
  const handle = handleFor(RUN_ID);
  mkdirSync(handle.dir, { recursive: true });
  writeFileSync(join(handle.dir, RUN_FILES.pushToken), "odu_run_token\n");
}

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
  runId: RUN_ID,
  push: {
    substituter: "https://cache.example.org/main",
    origin: "https://cache.example.org",
    bucket: "main",
    tokenId: "0123456789abcdef",
  },
});

function laneState(
  status: NodeStatus,
  over: { durationMs?: number | null; push?: NodePush },
): PipelineState {
  const setup = pendingNode({
    id: "_ci-setup",
    name: "_ci-setup",
    command: "",
    needs: [],
  });
  const base = pendingNode({ id: "alpha", name: "alpha", command: "true", needs: [] });
  return {
    name: "ci",
    sha7: "",
    dirty: false,
    order: ["_ci-setup", "alpha"],
    nodes: {
      "_ci-setup": { ...setup, status: "ok", exitCode: 0, startedAt: 1_000, durationMs: 1 },
      alpha: {
        ...base,
        status,
        exitCode: status === "pending" || status === "running" ? null : 0,
        startedAt: status === "pending" ? null : 1_000,
        durationMs: over.durationMs ?? null,
        ...(over.push === undefined ? {} : { push: over.push }),
      },
    },
  };
}

interface FakeLane {
  opts: LaneOptions;
  closed: boolean;
}

function harness() {
  const lanes: FakeLane[] = [];
  const startLane = (laneOpts: LaneOptions): Lane => {
    const entry: FakeLane = { opts: laneOpts, closed: false };
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
  const claimVenues = async (): Promise<ClaimOutcome> => ({
    ok: true,
    lanes: { [PLATFORM]: HOST },
    leases: [
      { host: HOST, lost: new Promise<void>(() => {}), release: () => {} },
    ],
  });
  return { lanes, deps: { startLane, claimVenues } };
}

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

const eventsOf = (): RunEvent[] =>
  readJournal(handleFor(RUN_ID)).entries.map((entry) => entry.event);

describe.if(hasJust)("the journal of a node that pushed", () => {
  it("carries the recipe's duration on `pushing`, and the client's words on the failure", async () => {
    const dir = fixture();
    plantPushToken();
    const { lanes, deps } = harness();

    const run = runCommand(runArgs(), deps);
    const outcome = run.catch((err: unknown) => err);

    try {
      await waitForLive(outcome, () => lanes.length === 1);
      const lane = lanes[0]!;
      lane.opts.onNodes(laneState("running", {}));
      await waitForLive(outcome, () =>
        eventsOf().some((e) => e.kind === "node_status" && e.status === "running"),
      );

      lane.opts.onNodes(
        laneState("running", { durationMs: 4_000, push: { state: "pushing" } }),
      );
      await waitForLive(outcome, () => eventsOf().some((e) => e.kind === "pushing"));
      const began = eventsOf().find((e) => e.kind === "pushing");
      expect(began).toEqual({
        kind: "pushing",
        node: NODE,
        bucket: "main",
        durationMs: 4_000,
      });
      expect(
        eventsOf().filter((e) => e.kind === "node_status" && e.node === NODE).length,
      ).toBe(1);

      lane.opts.onNodes(
        laneState("failed", {
          durationMs: 4_000,
          push: { state: "failed", message: SAID, durationMs: 900 },
        }),
      );
      lane.opts.onLogFrame("alpha", { kind: "end" }, "push");
      lane.opts.onLogFrame("alpha", { kind: "end" }, "recipe");

      await waitForLive(outcome, () => eventsOf().some((e) => e.kind === "push_failed"));
      expect(eventsOf().find((e) => e.kind === "push_failed")).toEqual({
        kind: "push_failed",
        node: NODE,
        bucket: "main",
        message: SAID,
        durationMs: 900,
      });

      await outcome;
      const statuses = eventsOf().filter(
        (e): e is Extract<RunEvent, { kind: "node_status" }> =>
          e.kind === "node_status" && e.node === NODE,
      );
      expect(statuses.at(-1)?.durationMs).toBe(4_000);
    } finally {
      await outcome;
      rmSync(join(dir, ".ci"), { recursive: true, force: true });
    }
  }, 60_000);
});

describe.if(hasJust)("the pin a task's environment carries", () => {
  async function pinDecision(
    options: Parameters<typeof fixture>[0],
  ): Promise<{
    env: Record<string, string>;
    setup: string;
    events: RunEvent[];
  }> {
    const dir = fixture(options);
    plantPushToken();
    const { lanes, deps } = harness();
    const run = runCommand(runArgs(), deps);
    const outcome = run.catch((err: unknown) => err);
    try {
      await waitForLive(outcome, () => lanes.length === 1);
      const lane = lanes[0]!;
      const alpha = lane.opts.tasks.find((task) => task.id === "alpha");
      expect(alpha).toBeDefined();
      const sha = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      }).stdout.trim();
      const setup = readFileSync(
        join(dir, logPathFor(shortSha(sha), fanId("_ci-setup", PLATFORM))),
        "utf-8",
      );
      lane.opts.onNodes(laneState("ok", { durationMs: 1 }));
      lane.opts.onLogFrame("alpha", { kind: "end" }, "push");
      lane.opts.onLogFrame("alpha", { kind: "end" }, "recipe");
      await outcome;
      return { env: { ...(alpha?.env ?? {}) }, setup, events: eventsOf() };
    } finally {
      await outcome;
      rmSync(join(dir, ".ci"), { recursive: true, force: true });
    }
  }

  it("names the pin when the run is on the ref the recipe asked for", async () => {
    const { env, setup } = await pinDecision({
      pins: ["main"],
      branch: "main",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBe(`acme/widget@main/${PLATFORM}`);
    expect(setup).not.toContain("not pinning");
    expect(env.ODU_CACHE_RUN).toBe(RUN_ID);
    expect(env.ODU_CACHE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("names the pin for a BARE marker when the run is on the default branch", async () => {
    const { env, setup } = await pinDecision({
      pins: [null],
      branch: "trunk",
      defaultBranch: "trunk",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBe(`acme/widget@trunk/${PLATFORM}`);
    expect(setup).not.toContain("not pinning");
  }, 60_000);

  it("says nothing at all on another ref", async () => {
    const { env, setup } = await pinDecision({
      pins: ["main"],
      branch: "feature/x",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).not.toContain("not pinning");
  }, 60_000);

  it("says nothing for a BARE marker on a branch that is not the default", async () => {
    const { env, setup } = await pinDecision({
      pins: [null],
      branch: "feature/x",
      defaultBranch: "trunk",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).not.toContain("not pinning");
  }, 60_000);

  it("names the pin with the run's OWN ref when the recipe declared several", async () => {
    const { env, setup } = await pinDecision({
      pins: ["main", "release-1.x"],
      branch: "release-1.x",
      defaultBranch: "main",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBe(`acme/widget@release-1.x/${PLATFORM}`);
    expect(setup).not.toContain("not pinning");
  }, 60_000);

  it("explains itself on the setup log when the run is on no ref", async () => {
    const { env, setup } = await pinDecision({
      pins: ["main"],
      branch: null,
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).toContain("[odu] not pinning: ");
    expect(setup).toContain("detached HEAD");
    expect(setup).toContain('recipe "alpha"');
  }, 60_000);

  it("explains itself when a BARE marker's checkout has no origin/HEAD", async () => {
    const { env, setup } = await pinDecision({
      pins: [null],
      branch: "trunk",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).toContain("[odu] not pinning: ");
    expect(setup).toContain("origin has no HEAD");
    expect(setup).toContain("git remote set-head origin -a");
    expect(setup).toContain('recipe "alpha"');
  }, 60_000);

  it("explains itself on the setup log when no origin names an owner/repo", async () => {
    const { env, setup } = await pinDecision({ pins: ["main"], branch: "main" });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).toContain("[odu] not pinning: ");
    expect(setup).toContain("github.com origin");
  }, 60_000);

  it("says why even when the node had nothing to push", async () => {
    const { setup, events } = await pinDecision({
      pins: ["main"],
      branch: null,
      remote: "https://github.com/acme/widget.git",
    });
    expect(events.some((e) => e.kind === "pushing")).toBe(false);
    expect(setup).toContain("not pinning");
  }, 60_000);

  it("puts nothing pin-shaped on a recipe that asked for none", async () => {
    const { env, setup } = await pinDecision({
      branch: "main",
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).not.toContain("not pinning");
  }, 60_000);
});
