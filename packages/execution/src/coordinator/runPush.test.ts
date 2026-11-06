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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { handleFor, readJournal } from "@odu/run-history/store";
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
 *  the platform enters the venue claim — which is injected, like the lane. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-push-journal-"));
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  writeFileSync(
    join(dir, "justfile"),
    ['[metadata("ci")]', "default: alpha", "", "alpha:", "    true", ""].join("\n"),
  );
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [PLATFORM]: HOST }));
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
