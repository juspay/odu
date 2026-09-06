/**
 * Lane resurrection: what a run does when a remote lane's link dies under it.
 *
 * A CI run that has spent four minutes on a builder should not be thrown away
 * because a laptop changed wifi networks. Holding the link open through it is
 * not available: Effect RPC's pinger ends the socket after 5–10s of silence and
 * exposes no cadence knob (`@kolu/surface`'s `src/links/wire.ts`), and the
 * runner is ephemeral by design — it dies with the pipe, and that death is what
 * frees the venue flock and reaps the recipe process trees. So survival is the
 * coordinator's job, after the fact: claim another venue and start a new lane
 * over the nodes the dead one had not finished.
 *
 * These drive the REAL `runCommand` against a throwaway repo with both ssh-
 * shaped collaborators injected (`claimVenues` and `startLane`), because every
 * rule worth pinning here is a rule about how those two interact: which tasks
 * the second lane is configured with, what happens to the first lane's `ok`
 * node and its log, how many times the run will try, and which of the two
 * signals for one ssh drop (the lane's `onDead`, the lease's `lost`) gets to
 * act on it.
 *
 * A note on the failure mode of getting this wrong: `shutdown` ends in
 * `process.exit`. A regression that routes a resurrectable lease loss back to
 * the whole-run teardown does not fail an assertion here — it takes the test
 * runner down with it, which is loud in a different way and equally
 * unmistakable.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
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

/** The budget these runs are judged against — the default, since the fixture
 *  does not set `ODU_MAX_LANE_RESURRECTIONS`. */
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
  noSnapshot: true,
  noPost: true,
  progressJson: false,
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

/**
 * A throwaway checkout whose CI DAG is a diamond stub: `alpha`, then `beta`
 * and `gamma` which both need it. That shape is the point — the retry has to
 * carry `beta` and `gamma` while dropping the `alpha` edge, and a DAG without
 * a satisfied dependency could not tell a correct filter from no filter.
 *
 * The pool names a REMOTE host so the platform enters the venue claim at all
 * (a localhost lane is deliberately out of scope for resurrection). Nothing
 * ever dials it: both `claimVenues` and `startLane` are injected.
 */
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
  // The run writes under `.ci/`; ignoring it keeps the tree clean, which a
  // remote-pool run in live-tree mode requires.
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", "file:///nonexistent/origin.git");

  const prevCwd = process.cwd();
  // Never resolved: the coordinator builds a runner resolver per platform, and
  // that construction refuses a cache-blind binary — but nothing ever calls the
  // resolver, because the lane that would is injected.
  const env: Record<string, string> = {
    ODU_HOSTS: join(dir, "hosts.json"),
    ODU_RUNNER_FLAKE: "git+file:///nonexistent",
    ODU_AGENT_SUBSTITUTERS: "https://cache.invalid",
    ODU_AGENT_TRUSTED_PUBLIC_KEYS: "cache.invalid:0000000000",
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

/** One lane-local state frame, the shape a runner publishes. */
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

/** A lane the test drives by hand: its options are the configuration under
 *  test, and its callbacks are the wire a real runner would talk over. */
interface FakeLane {
  opts: LaneOptions;
  closed: boolean;
}

interface FakeLease extends LeaseHandle {
  released: boolean;
  /** Fire the lease's `lost` — the ssh drop seen from the venue hold. */
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

/** The injected pair, plus everything the assertions read off them. */
function harness(opts: { hold?: () => Promise<void> } = {}) {
  const lanes: FakeLane[] = [];
  const leases: FakeLease[] = [];
  const claimHosts: string[] = [];

  const startLane = (laneOpts: LaneOptions): Lane => {
    const entry: FakeLane = { opts: laneOpts, closed: false };
    lanes.push(entry);
    // What a REAL lane does the moment it attaches: `nodeLog.get({ id })` opens
    // with a `snapshot` frame for every node it owns, and a fresh runner's
    // buffer is empty. Without it a fake hides what the coordinator does with a
    // snapshot — `resetLocal`, a truncating write — which is exactly where a
    // notice written into a retried node's log used to go to die.
    for (const id of ["_ci-setup", ...laneOpts.tasks.map((t) => t.id)]) {
      laneOpts.onLogFrame(id, { kind: "snapshot", text: "" });
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
    // Alternate hosts so a resurrected lane is visibly on a different box.
    const host = claimHosts.length % 2 === 0 ? HOST_A : HOST_B;
    claimHosts.push(host);
    if (claimHosts.length > 1 && opts.hold !== undefined) await opts.hold();
    const lease = fakeLease(host);
    leases.push(lease);
    return { ok: true, lanes: { [PLATFORM]: host }, leases: [lease] };
  };

  return { lanes, leases, claimHosts, deps: { startLane, claimVenues } };
}

/** Poll the checkout socket until the coordinator answers. */
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

/** Follow the fan-in `nodes` cell the way every out-of-process reader does. */
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
      // The socket closes when the run exits; that is not a failure here.
    }
  })();
  return {
    statusOf: (namepath) => latest?.nodes[`${namepath}@${PLATFORM}`]?.status,
    close: () => dialed.close().catch(() => {}),
  };
}

/** A node's terminal verdict is withheld until its log ends, so an `end` frame
 *  in these tests is not decoration: without it a node reported `ok` never
 *  reaches `ok` on the fan-in. */
const laneFrame = (frame: NodeLogFrame): NodeLogFrame => frame;

/** Wait for a condition, and fail with the RUN's own error if the run ends
 *  first. A coordinator that refused at startup (a misbuilt binary, an
 *  unparseable justfile) would otherwise surface as an anonymous poll timeout
 *  twenty seconds later, with the actual message swallowed by the promise
 *  nobody looked at. */
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

/** Wait for the run to end — but only for a bounded while. A run whose lanes
 *  are hand-driven never settles once an assertion has stopped driving them,
 *  and a `finally` that waited forever would replace the assertion's message
 *  with a bare suite timeout. */
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

describe.if(hasJust)("a remote primary lane that dies mid-run", () => {
  it("re-claims a venue and retries only the unfinished nodes", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const { lanes, leases, claimHosts, deps } = harness();

    const run = runCommand(runArgs(), deps);
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

      // alpha finishes and its log is complete; beta is mid-recipe; gamma has
      // not started.
      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "running",
          beta: "pending",
          gamma: "pending",
        }),
      );
      first.opts.onLogFrame("alpha", laneFrame({ kind: "append", text: "ALPHA OUTPUT\n" }));
      first.opts.onNodes(
        laneState({
          "_ci-setup": "ok",
          alpha: "ok",
          beta: "running",
          gamma: "pending",
        }),
      );
      first.opts.onLogFrame("alpha", laneFrame({ kind: "end" }));
      await waitFor(() => nodes.statusOf("alpha") === "ok", 20_000);
      expect(nodes.statusOf("beta")).toBe("running");

      // THE EVENT: the ssh link dies with beta still running.
      first.opts.onDead("ssh pipe died");

      // A second venue is claimed, on the other box, and the dead lane's own
      // lease is handed back rather than held through the retry.
      await waitFor(() => lanes.length === 2, 20_000);
      expect(claimHosts).toEqual([HOST_A, HOST_B]);
      expect(leases[0]!.released).toBe(true);
      expect(first.closed).toBe(true);

      // THE ASSERTION. Only the unfinished work, and `needs` filtered to it —
      // the runner's `configure` validates the DAG it is handed and rejects a
      // dependency it was never given, so an unfiltered `needs: ["alpha"]`
      // would be refused outright.
      const second = lanes[1]!;
      expect(second.opts.host).toBe(HOST_B);
      expect(second.opts.tasks.map((t) => t.id)).toEqual(["beta", "gamma"]);
      expect(second.opts.tasks.map((t) => [...t.needs])).toEqual([[], []]);

      // The finished node keeps its verdict AND its output; the interrupted one
      // goes back to pending with the interruption written into its log.
      //
      // WAITED FOR, not sampled. `lanes[1]` existing is an in-process fact,
      // while `nodes` is a real socket subscriber whose frames arrive a tick
      // or two behind — so sampling here is a coin flip weighted by how busy
      // the coordinator's event loop happens to be, and it lands tails often
      // enough to be seen on an unmodified tree. Waiting does not weaken the
      // assertion: a `beta` that was wrongly left `running` (or a re-run
      // `alpha`) never reaches these values, so the wait fails rather than
      // passing late.
      await waitFor(() => nodes.statusOf("alpha") === "ok", 20_000);
      await waitFor(() => nodes.statusOf("beta") === "pending", 20_000);
      const sha7 = sha7Of(dir);
      const logOf = (node: string): string =>
        readFileSync(join(dir, ".ci", sha7, PLATFORM, `${node}.log`), "utf-8");
      expect(logOf("alpha")).toContain("ALPHA OUTPUT");
      // The interruption is narrated where it SURVIVES. A node's log is
      // addressed by commit and the successor lane opens it with a `snapshot`
      // that resets the file, so `_ci-setup` — coordinator-owned, never reset
      // by a lane — is the one place this platform's venue story is told.
      await waitFor(
        () => logOf("_ci-setup").includes("reclaiming a venue"),
        20_000,
      );
      expect(logOf("_ci-setup")).toContain("(attempt 1 of 2)");
      expect(logOf("_ci-setup")).toContain(
        "[odu] cut off mid-recipe, re-running from the start: beta",
      );
      expect(logOf("beta")).toBe("");

      // The retry lane finishes the run.
      second.opts.onNodes(
        laneState({ "_ci-setup": "ok", beta: "ok", gamma: "ok" }),
      );
      second.opts.onLogFrame("beta", laneFrame({ kind: "end" }));
      second.opts.onLogFrame("gamma", laneFrame({ kind: "end" }));

      expect(await outcome).toBe(0);
    } finally {
      await nodes.close();
      await settleOrGiveUp(outcome);
    }
  }, 60_000);

  it("does not re-run a node whose ok verdict was still in flight", async () => {
    // A node's terminal status is withheld until its log ends, so a node that
    // FINISHED with its tail still on the wire reads `running` on the fan-in.
    // The retry set is read off those statuses — so unless the held verdicts
    // are published first, the one node that actually passed is exactly the one
    // a resurrection would run again, throwing its output away in the process.
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
      );
      // `ok` reported, log NOT ended: the verdict gate holds it, so the fan-in
      // still says `running` — which is exactly the trap.
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

      // WAIT for it, do not sample it. `lanes.length === 2` is an in-process
      // fact; `nodes` is a real socket subscriber, so the published verdict
      // arrives a tick or two behind it and how far behind depends on how busy
      // the coordinator's event loop is. Sampling here passed while the
      // coordinator did little else per transition and became a coin flip once
      // it also wrote a durable record.
      //
      // This does not weaken the assertion: if the resurrection had wrongly
      // re-run `alpha`, its status would go back to pending/running and stay
      // there, so the wait fails instead of passing late.
      await waitFor(() => nodes.statusOf("alpha") === "ok", 20_000);
      expect(lanes[1]!.opts.tasks.map((t) => t.id)).toEqual(["beta", "gamma"]);
      expect(
        readFileSync(
          join(dir, ".ci", sha7Of(dir), PLATFORM, "alpha.log"),
          "utf-8",
        ),
      ).toContain("ALPHA OUTPUT");

      lanes[1]!.opts.onNodes(
        laneState({ "_ci-setup": "ok", beta: "ok", gamma: "ok" }),
      );
      lanes[1]!.opts.onLogFrame("beta", laneFrame({ kind: "end" }));
      lanes[1]!.opts.onLogFrame("gamma", laneFrame({ kind: "end" }));
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
      // Three lanes in total: the original plus MAX_RESURRECTIONS retries.
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

      // No fourth lane: the run stops asking for boxes and says so.
      const code = await outcome;
      expect(code).not.toBe(0);
      expect(lanes.length).toBe(MAX_RESURRECTIONS + 1);

      const sha7 = sha7Of(dir);
      const timings = readFileSync(
        join(dir, ".ci", sha7, "timings.jsonl"),
        "utf-8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { node: string; status: string });
      const statusOf = (node: string): string | undefined =>
        timings.find((t) => t.node === `${node}@${PLATFORM}`)?.status;
      expect(statusOf("alpha")).toBe("errored");
      expect(statusOf("beta")).toBe("skipped");
      expect(statusOf("gamma")).toBe("skipped");

      const setupLog = readFileSync(
        join(dir, ".ci", sha7, PLATFORM, "_ci-setup.log"),
        "utf-8",
      );
      expect(setupLog).toContain(
        `gave up after ${MAX_RESURRECTIONS} lane resurrections`,
      );
      expect(
        readFileSync(join(dir, ".ci", sha7, PLATFORM, "alpha.log"), "utf-8"),
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

      // THE EVENT: the venue hold's ssh session dies. This used to shut the
      // whole run down with exit 1 — `process.exit` from inside the
      // coordinator. It must instead go and claim another box: the flock is
      // already free on the builder, so there is nothing to fail closed about.
      leases[0]!.die();
      await waitFor(() => lanes.length === 2, 20_000);
      expect(claimHosts).toEqual([HOST_A, HOST_B]);

      // ONE ssh drop is often BOTH signals. The lane's own death for the
      // episode already resurrected is a no-op — not a second retry, and not a
      // second box.
      first.opts.onDead("ssh pipe died");
      await new Promise((r) => setTimeout(r, 150));
      expect(lanes.length).toBe(2);
      expect(claimHosts.length).toBe(2);

      const second = lanes[1]!;
      second.opts.onNodes(
        laneState({ "_ci-setup": "ok", alpha: "ok", beta: "ok", gamma: "ok" }),
      );
      for (const id of ["alpha", "beta", "gamma"]) {
        second.opts.onLogFrame(id, laneFrame({ kind: "end" }));
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
      // The retry claim is now queueing for a box, exactly as the startup claim
      // can be — and an operator drops the lane.
      await waitFor(() => leases.length === 0 || leases[0]!.released, 20_000);
      const ack = await runUnary(
        dialed.client.surface.lane.cancel({ platform: PLATFORM }),
      );
      expect(ack.ok).toBe(true);

      // The claim returns a box nobody will use now. It must go straight back,
      // and the cancel the claim deferred must land.
      releaseHold();
      const code = await outcome;
      expect(code).not.toBe(0);
      expect(lanes.length).toBe(1);
      expect(leases.length).toBe(2);
      expect(leases[1]!.released).toBe(true);

      const sha7 = sha7Of(dir);
      const timings = readFileSync(
        join(dir, ".ci", sha7, "timings.jsonl"),
        "utf-8",
      )
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
