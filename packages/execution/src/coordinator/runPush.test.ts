/**
 * WHAT THE JOURNAL SAYS ABOUT A PUSH (PLAN 4.1), from the coordinator's own
 * seam — the half no unit of either end can reach.
 *
 * A node's push arrives on TWO wires that have no ordering between them: the
 * state cell (`onNodes` → `notePush`) and the log frames (`onLogFrame` →
 * `appendLocal`). Everything the durable record says about a push is decided
 * where those two meet, and both rules pinned here are rules about that
 * meeting:
 *
 *   - **The `pushing` line carries the RECIPE's duration.** While a closure
 *     goes up, the node stays `running` — so the coordinator writes no
 *     `node_status` (it journals a status CHANGE, and nothing changed) and the
 *     journal would otherwise learn nothing at all for the whole minute an
 *     upload takes. A page folds this journal: a recipe with no duration has a
 *     bar with no end, which left the push step with no room on the timeline
 *     and so no `pushing` segment at all.
 *   - **`push_failed` carries the client's OWN sentence**, caught off the push
 *     stream on its way to the log. This line is read by people the log is not
 *     in front of — `run_read` against a coordinator that is gone, a catalog a
 *     week later — and a message that only said "the reason is in the push
 *     log" taught them that the push half failed and never why.
 *
 * Driven like `run.resurrection.test.ts`: the REAL `runCommand` against a
 * throwaway checkout with both ssh-shaped collaborators injected, because the
 * subject is what the coordinator does with the frames a lane sends it. The
 * push TARGET is supplied the way a launcher supplies one — the token in the
 * catalog beside the run, read once and unlinked — since a run with no target
 * journals no push lines at all, which is the correct behaviour and not the
 * one under test.
 */

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
/** The sentence the push client throws and the lane writes, verbatim. The
 *  assertions below are about THIS text surviving as far as the journal. */
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

/** A throwaway checkout with ONE recipe: this is about one node's push, and a
 *  second node would only add frames to drive. The pool names a REMOTE host so
 *  the platform enters the venue claim — which is injected, like the lane.
 *
 *  The three knobs are the PIN decision's whole input (PLAN 4.2): what the
 *  recipe asked for, which ref the checkout is on, and whether the origin
 *  names an `owner/repo`. Defaults are the journal tests' world — no pin, a
 *  non-GitHub origin — so the push assertions below read unchanged. */
function fixture(
  options: { pin?: string; branch?: string | null; remote?: string } = {},
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
      ...(options.pin === undefined ? [] : [`[metadata("odu:pin=${options.pin}")]`]),
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
  // `null` is a DETACHED HEAD — a run on no ref at all, which is the one case
  // a pinning recipe cannot be answered for.
  if (options.branch === null) git("checkout", "-q", "--detach");
  else if (options.branch !== undefined) git("checkout", "-q", "-b", options.branch);

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

/**
 * The launcher's half of the push handoff: the write token, in the catalog
 * beside the run that will read and unlink it.
 *
 * Written BEFORE the run starts because that is when a launcher writes it —
 * and because a coordinator that finds no token pushes nowhere, which would
 * make every assertion below vacuously pass against a journal with no push
 * lines in it at all.
 */
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

/** One lane-local state frame, the shape a runner publishes — with this
 *  node's push step on it, which is the field under test.
 *
 *  `_ci-setup` rides every frame at `ok`, as a real lane's does once its
 *  workspace is ready: the run is not done with a platform whose setup node
 *  never went terminal, so a frame that omitted it would leave the run
 *  unsettled and the assertions below waiting on a verdict that never comes. */
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

/** The injected pair. One lane, one lease, no resurrection: a push that fails
 *  does not kill the link it arrived over. */
function harness() {
  const lanes: FakeLane[] = [];
  const startLane = (laneOpts: LaneOptions): Lane => {
    const entry: FakeLane = { opts: laneOpts, closed: false };
    lanes.push(entry);
    // What a real lane does on attach: an opening `snapshot` for every node it
    // owns, on BOTH streams.
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
    // A lease that is never lost: this run's lane does not die, and a push
    // that fails is not a link that broke.
    leases: [
      { host: HOST, lost: new Promise<void>(() => {}), release: () => {} },
    ],
  });
  return { lanes, deps: { startLane, claimVenues } };
}

/** Wait for a condition, and fail with the RUN's own error if the run ends
 *  first — a coordinator that refused at startup would otherwise surface as an
 *  anonymous poll timeout with its message swallowed. */
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
      // THE RECIPE RUNS, and the journal gets a `running` status with no
      // duration — there is none yet.
      lane.opts.onNodes(laneState("running", {}));
      await waitForLive(outcome, () =>
        eventsOf().some((e) => e.kind === "node_status" && e.status === "running"),
      );

      // THE RECIPE EXITS 0 AND THE PUSH OPENS. The node is still `running`:
      // green means warmed, and nothing is on the bucket yet. Its duration is
      // published WITH the push state, which is the only way it reaches a
      // reader before the upload ends.
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
      // …and no status line was written for it, which is the whole reason the
      // duration had to ride the push's own line.
      expect(
        eventsOf().filter((e) => e.kind === "node_status" && e.node === NODE).length,
      ).toBe(1);

      // THE PUSH FAILS, and the cell says why: the client's sentence is on
      // the `failed` arm the lane stamped, so the journal's line is a
      // straight-line copy of it rather than something read back out of a
      // log's bytes.
      lane.opts.onNodes(
        laneState("failed", {
          durationMs: 4_000,
          push: { state: "failed", message: SAID, durationMs: 900 },
        }),
      );
      lane.opts.onLogFrame("alpha", { kind: "end" }, "push");
      lane.opts.onLogFrame("alpha", { kind: "end" }, "recipe");

      await waitForLive(outcome, () => eventsOf().some((e) => e.kind === "push_failed"));
      // THE ASSERTION. Not "the reason is in the push log" — the reason.
      expect(eventsOf().find((e) => e.kind === "push_failed")).toEqual({
        kind: "push_failed",
        node: NODE,
        bucket: "main",
        message: SAID,
        durationMs: 900,
      });

      await outcome;
      // The node's own duration stayed the RECIPE's throughout: the push's
      // time is on the push, and a timing surface that silently absorbed
      // upload seconds would change what every other one means.
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

/**
 * WHO DECIDES A PIN (PLAN 4.2) — the coordinator, and nothing downstream.
 *
 * The lane is handed a finished name on `TaskSpec.env` or it is handed
 * nothing; it compares no refs and resolves no remote. That is asserted from
 * the only seam where it is visible: the tasks a lane is configured with.
 * A lane that derived the name itself would derive it on a COPY of the
 * checkout, on a machine that may have fetched since — and a wrong pin name
 * does not fail, it holds the wrong closure open while the right one is let
 * go.
 *
 * And when there is no name to hand down, the REASON stays here too — on
 * `_ci-setup`'s log beside this run's push line, not as prose shipped to a
 * lane to be printed back.
 */
describe.if(hasJust)("the pin a task's environment carries", () => {
  /** Start a run and read the pin decision from BOTH its readers: the task
   *  environment a lane is configured with (the name), and `_ci-setup`'s
   *  durable log (the sentence, when this run cannot answer a recipe's pin).
   *
   *  The node is driven to `ok` with NO push state at all — the shape a node
   *  publishes when its `result*` paths were already sent by an earlier
   *  recipe, which is the typical shape of a DAG and the case where a
   *  lane-side sentence went silent. Driving it to a terminal also matters for
   *  the lock: an abandoned coordinator would hold the checkout's run lock
   *  against the next case in this file. */
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
      // The setup node's durable log, where this run states its push policy.
      // Written when provisioning opens — before the lane exists — so it is
      // already on disk by the time the lane shows up here.
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
      // Read while the journal still exists: the cleanup below takes `.ci`,
      // and this run's state dir is inside it.
      return { env: { ...(alpha?.env ?? {}) }, setup, events: eventsOf() };
    } finally {
      await outcome;
      rmSync(join(dir, ".ci"), { recursive: true, force: true });
    }
  }

  it("names the pin when the run is on the ref the recipe asked for", async () => {
    const { env, setup } = await pinDecision({
      pin: "main",
      branch: "main",
      remote: "https://github.com/acme/widget.git",
    });
    // THE SAME SHAPE `.github/actions/push/pin-name.sh` derives, system and
    // all: a run and a workflow pushing the same commit must re-point ONE
    // pin, and a matrix's second job must not evict the first's closure.
    expect(env.ODU_CACHE_PIN).toBe(`acme/widget@main/${PLATFORM}`);
    expect(setup).not.toContain("not pinning");
    // Provenance rides the same wire, from the facts the coordinator already
    // holds — the lane reads git for neither.
    expect(env.ODU_CACHE_RUN).toBe(RUN_ID);
    expect(env.ODU_CACHE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("says nothing at all on another ref", async () => {
    const { env, setup } = await pinDecision({
      pin: "main",
      branch: "feature/x",
      remote: "https://github.com/acme/widget.git",
    });
    // Not a skip, not a sentence: the pin belongs to the other ref, and a
    // feature branch reporting "not pinning" every run would train a reader
    // to ignore the line that matters.
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).not.toContain("not pinning");
  }, 60_000);

  it("explains itself on the setup log when the run is on no ref", async () => {
    const { env, setup } = await pinDecision({
      pin: "main",
      branch: null,
      remote: "https://github.com/acme/widget.git",
    });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    // ON THE RUN'S OWN NODE, beside its push line — and naming the recipe,
    // because a run with twenty of them must say WHICH one asked.
    expect(setup).toContain("[odu] not pinning: ");
    expect(setup).toContain("detached HEAD");
    expect(setup).toContain('recipe "alpha"');
  }, 60_000);

  it("explains itself on the setup log when no origin names an owner/repo", async () => {
    const { env, setup } = await pinDecision({ pin: "main", branch: "main" });
    expect(env.ODU_CACHE_PIN).toBeUndefined();
    expect(setup).toContain("[odu] not pinning: ");
    expect(setup).toContain("github.com origin");
  }, 60_000);

  it("says why even when the node had nothing to push", async () => {
    // THE DEFECT THIS PINS. The sentence used to ride to the lane and be said
    // by the push step — so a node whose `result*` paths an earlier recipe
    // already sent (nothing to send, no step, no line) explained nothing,
    // which is the ordinary shape of a DAG. This node publishes NO push at
    // all and the run still says why it pinned nothing.
    const { setup, events } = await pinDecision({
      pin: "main",
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
