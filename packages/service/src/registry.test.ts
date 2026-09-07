/**
 * The BOARD, against real catalog files.
 *
 * The class of bug this projection can have is a disagreement with the records
 * it projects, so every fixture here is written by the catalog's own writers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createRegistry, projectRun } from "./registry";
import {
  crashOwner,
  finalizeRun,
  makeWorld,
  registerFixtureRun,
  type World,
  writeDebt,
  writeLane,
  writeNode,
  writePhase,
  writeRoster,
} from "./fixture.testlib";
import { OWNERSHIP_GRACE_MS } from "@odu/run-history/owner";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

describe("the run registry", () => {
  it("discovers a run nobody told it about", () => {
    // The whole reason the board reads the CATALOG rather than being notified:
    // a run started by `odu run` in a terminal, before this service existed,
    // appears on the first refresh without anything having announced it.
    const w = open();
    registerFixtureRun(w, { repoRoot: "/code/app", sha: "a".repeat(40) });
    const registry = createRegistry({ root: w.catalogRoot });
    const delta = registry.refresh();
    expect(delta.upserted).toHaveLength(1);
    expect(registry.rows()).toHaveLength(1);
  });

  it("re-folds only the runs whose files moved", () => {
    const w = open();
    const a = registerFixtureRun(w, { repoRoot: "/code/a", sha: "a".repeat(40) });
    registerFixtureRun(w, { repoRoot: "/code/b", sha: "b".repeat(40) });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();

    // Nothing has changed, so nothing is republished. A projection that
    // re-emitted every row each tick would wake every open board four times a
    // second to redraw what it already has.
    expect(registry.refresh().upserted).toEqual([]);

    writeRoster(a.handle, a.token, ["unit@x86_64-linux"]);
    writeNode(w, a.handle, a.token, { id: "unit@x86_64-linux", status: "failed" });
    const moved = registry.refresh();
    expect(moved.upserted.map((row) => row.runId)).toEqual([a.runId]);
  });

  it("tells provisioning apart from running", () => {
    // A run holding a checkout while a cold box finishes a `nix copy` has no
    // lane behind it. Reporting "running" about a run with nothing running is
    // how a multi-minute provision reads as a hang.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "c".repeat(40) });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.row(run.runId)?.state).toBe("provisioning");

    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "ok" });
    registry.refresh();
    expect(registry.row(run.runId)?.state).toBe("running");
  });

  it("carries the branch the run was started on, not the checkout's today", () => {
    const w = open();
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "d".repeat(40),
      branch: "feature/x",
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.row(run.runId)?.branch).toBe("feature/x");
  });

  it("reports a record with no branch as null rather than guessing", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "e".repeat(40) });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.row(run.runId)?.branch).toBeNull();
  });

  it("counts unresolved failures and keeps them counted after settlement", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "f".repeat(40) });
    writeRoster(run.handle, run.token, ["unit@x86_64-linux", "e2e@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "failed" });
    writeNode(w, run.handle, run.token, { id: "e2e@x86_64-linux", status: "ok" });
    finalizeRun(run.handle, run.token, "failed", ["unit@x86_64-linux"]);

    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const row = registry.row(run.runId);
    expect(row?.state).toBe("settled");
    expect(row?.settled).toBe(true);
    expect(row?.passed).toBe(false);
    expect(row?.outcome).toBe("failed");
    // Still red. Settling does not resolve a failure — it stops new ones.
    expect(row?.unresolvedFailures).toBe(1);
  });

  it("does not call a cancelled run failed", () => {
    // `passed: false` covers two different endings, and reporting a cancelled
    // run as failed sends somebody looking for a test that broke.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "1".repeat(40) });
    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "cancelled" });
    finalizeRun(run.handle, run.token, "incomplete");

    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.row(run.runId)?.outcome).toBe("incomplete");
    expect(registry.row(run.runId)?.unresolvedFailures).toBe(0);
  });

  it("orders the board newest first", () => {
    const w = open();
    const older = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "2".repeat(40),
      now: 1_000_000,
      runId: "0aaaaaaaa-aaaaaaaa",
    });
    const newer = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "3".repeat(40),
      now: 2_000_000,
      runId: "0bbbbbbbb-bbbbbbbb",
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.rows().map((row) => row.runId)).toEqual([
      newer.runId,
      older.runId,
    ]);
  });

  it("gives a node its own log key rather than three fields to reassemble", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "4".repeat(40) });
    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, {
      id: "unit@x86_64-linux",
      attempt: 2,
      status: "failed",
      log: "boom",
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const node = registry.nodes(run.runId)?.[0];
    expect(node?.attempt).toBe(2);
    expect(node?.logKey).toBe(`${run.runId}/unit~40x86_64-linux/2`);
  });

  it("shows a rostered node that never started as pending, at attempt 0", () => {
    // Attempt 0 is not a fabricated attempt 1: naming evidence that does not
    // exist is worse than saying there is none.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "5".repeat(40) });
    writeRoster(run.handle, run.token, ["unit@x86_64-linux", "e2e@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "ok" });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const nodes = registry.nodes(run.runId) ?? [];
    expect(nodes.map((n) => [n.id, n.status, n.attempt])).toEqual([
      ["unit@x86_64-linux", "ok", 1],
      ["e2e@x86_64-linux", "pending", 0],
    ]);
    expect(nodes[1]?.logKey).toBe("");
  });

  it("projects a run the registry has not seen, identically", () => {
    // A detail view opened on a run that arrived between refreshes reads the
    // same fold, so the two paths cannot disagree about which attempt a node is
    // on.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "6".repeat(40) });
    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "failed" });

    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const direct = projectRun(run.runId, { root: w.catalogRoot });
    expect(direct?.row.state).toBe(registry.row(run.runId)?.state);
    expect(direct?.nodes).toEqual(registry.nodes(run.runId) ?? []);
  });

  it("drops a run whose directory is gone", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "7".repeat(40) });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.rows()).toHaveLength(1);

    // Retention, or a person with `rm`. Either way the board must stop showing
    // it rather than keep a row nothing backs.
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(`${w.catalogRoot}/${run.runId}`, { recursive: true, force: true });
    const delta = registry.refresh();
    expect(delta.removed).toEqual([run.runId]);
    expect(registry.rows()).toHaveLength(0);
  });

  it("reports a crashed coordinator as owner_lost WITHOUT anything on disk moving", () => {
    // The bug this pins: a dead coordinator stops writing, so it stops moving
    // the very files a "did anything change?" check reads. Fingerprinting only
    // the files left such a row saying `provisioning` for ever — the one state
    // a crashed run must not be reported in — while `projectRun`, which reads
    // straight through, said `owner_lost` about the same run.
    const w = open();
    const at = Date.now();
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "e".repeat(40),
      now: at,
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at);
    expect(registry.row(run.runId)?.state).toBe("provisioning");

    // The coordinator dies. Its heartbeat is now as old as the grace, and
    // NOTHING in the run directory changes from here on.
    crashOwner(run.handle, { heartbeatAt: at - OWNERSHIP_GRACE_MS - 1 });
    const moved = registry.refresh(at);
    expect(moved.upserted.map((row) => row.runId)).toEqual([run.runId]);
    expect(registry.row(run.runId)?.state).toBe("owner_lost");
    // And the board now agrees with the read-through projection, which is the
    // property that was actually broken.
    expect(projectRun(run.runId, { root: w.catalogRoot }, at)?.row.state).toBe(
      "owner_lost",
    );
  });

  it("flips to owner_lost when the GRACE expires, with no write at all", () => {
    // Time alone, which is the harder half: the record was written by a process
    // that is gone, and the only thing that changes between these two refreshes
    // is the clock.
    const w = open();
    const at = Date.now();
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "f".repeat(40),
      now: at,
    });
    crashOwner(run.handle, { heartbeatAt: at });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at);
    expect(registry.row(run.runId)?.state).toBe("provisioning");

    const later = at + OWNERSHIP_GRACE_MS + 1;
    expect(registry.refresh(later).upserted.map((r) => r.runId)).toEqual([run.runId]);
    expect(registry.row(run.runId)?.state).toBe("owner_lost");
  });
});

/**
 * THE RUN ENVIRONMENT — where the work is placed, read from the catalog.
 *
 * The bug this whole section pins is an ABSENCE: the coordinator journalled
 * `lane` and `phase` lines from the beginning and `foldJournal` fell through to
 * `default: break` on both, so nothing on disk could answer "which lane is on
 * which box". That is why `odu status` dialled the checkout's `.ci/odu.sock` —
 * the live coordinator was the only thing that could be asked, so one public
 * command had to keep a run authority of its own. Answered from the journal,
 * the same question outlives the coordinator that once had to be alive for it.
 */
describe("the run environment", () => {
  it("folds the lanes and the phase the journal has always carried", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "8".repeat(40) });
    writePhase(run.handle, run.token, "lanes");
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "leased",
      host: "builder-1",
      pool: ["builder-1", "builder-2"],
      hostsSource: "/code/app/.ci/hosts.toml",
    });
    writeLane(run.handle, run.token, {
      platform: "aarch64-darwin",
      state: "claiming",
      host: null,
      pool: ["mac-1"],
      hostsSource: "/code/app/.ci/hosts.toml",
    });

    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const env = registry.env(run.runId);
    expect(env?.phase).toBe("lanes");
    // Platform order, so two reads of one journal paint the same matrix.
    expect(env?.lanes).toEqual([
      { state: "claiming", platform: "aarch64-darwin", pool: ["mac-1"] },
      { state: "leased", platform: "x86_64-linux", host: "builder-1" },
    ]);
    expect(env?.hostsSource).toBe("/code/app/.ci/hosts.toml");
  });

  it("republishes a lane's whole state, so the newest line wins", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "9".repeat(40) });
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "claiming",
      host: null,
      pool: ["builder-1", "builder-2"],
    });
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "leased",
      host: "builder-2",
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.env(run.runId)?.lanes).toEqual([
      { state: "leased", platform: "x86_64-linux", host: "builder-2" },
    ]);
  });

  it("still folds an OLD lane line that carries no pool or hosts file", () => {
    // The compatibility case the journal schema's `optionalKey` exists for. The
    // reader SKIPS a line it cannot parse and counts it, so a required `pool`
    // would not have failed loudly — it would have silently erased every lane
    // of every run written before the field existed. An empty pool reads
    // honestly as "not recorded" and a null source says the same; neither is a
    // claim that the lane had no candidates.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "a1".repeat(20) });
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "claiming",
      host: null,
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const env = registry.env(run.runId);
    expect(env?.lanes).toEqual([
      { state: "claiming", platform: "x86_64-linux", pool: [] },
    ]);
    expect(env?.hostsSource).toBeNull();
  });

  it("keeps the hosts file a newer line omits", () => {
    // A mixed journal — old lines, then new — must not lose the source it has
    // just learned to a later line that simply does not carry one.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "a2".repeat(20) });
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "claiming",
      host: null,
      pool: ["builder-1"],
      hostsSource: "/etc/odu/hosts.toml",
    });
    writeLane(run.handle, run.token, {
      platform: "aarch64-darwin",
      state: "claiming",
      host: null,
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.env(run.runId)?.hostsSource).toBe("/etc/odu/hosts.toml");
  });

  it("reports a leased lane with no host as still claiming", () => {
    // A TORN record: the state says the lane landed and the field naming the
    // machine is missing. Reported as the weaker claim, because the alternative
    // is telling a reader the work is on a machine that nothing in the journal
    // names.
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "a3".repeat(20) });
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "leased",
      host: null,
      pool: ["builder-1"],
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.env(run.runId)?.lanes).toEqual([
      { state: "claiming", platform: "x86_64-linux", pool: ["builder-1"] },
    ]);
  });

  it("calls a run with no journalled phase provisioning until work starts", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "a4".repeat(20) });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.env(run.runId)?.phase).toBe("provisioning");

    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "ok" });
    registry.refresh();
    // Never `no_lanes` — that is the coordinator's own word for "the selection
    // matched nothing", and inferring it from a silent record would invent a
    // reason the journal never gave.
    expect(registry.env(run.runId)?.phase).toBe("lanes");
  });

  it("stops the elapsed clock at the verdict", () => {
    const w = open();
    const at = 1_700_000_000_000;
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "b1".repeat(20),
      now: at,
    });
    const registry = createRegistry({ root: w.catalogRoot });

    // Still going: the clock is the reader's, so it advances between two reads
    // with nothing on disk having moved.
    registry.refresh(at + 5_000);
    expect(registry.env(run.runId, at + 5_000)?.elapsedMs).toBe(5_000);
    expect(registry.env(run.runId, at + 90_000)?.elapsedMs).toBe(90_000);

    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, {
      id: "unit@x86_64-linux",
      status: "ok",
      at: at + 1_000,
    });
    finalizeRun(run.handle, run.token, "passed", [], at + 60_000);
    registry.refresh(at + 90_000);

    // Settled. A settled run's age must not be a function of when somebody
    // looked at it, so this is the same number a week from now.
    expect(registry.env(run.runId, at + 90_000)?.elapsedMs).toBe(60_000);
    expect(registry.env(run.runId, at + 9_000_000)?.elapsedMs).toBe(60_000);
  });

  it("derives the commit link once, and says null for a local-only checkout", () => {
    const w = open();
    const sha = "c1".repeat(20);
    const linked = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha,
      repo: "juspay/odu",
    });
    const local = registerFixtureRun(w, {
      repoRoot: "/code/local",
      sha: "c2".repeat(20),
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.env(linked.runId)?.commitUrl).toBe(
      `https://github.com/juspay/odu/commit/${sha}`,
    );
    // Not an empty string and not a URL that 404s: a checkout with no GitHub
    // remote has no forge page, and saying so is the answer.
    expect(registry.env(local.runId)?.commitUrl).toBeNull();
  });

  it("itemises the reporting debt the row only counts", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "d1".repeat(20) });
    writeDebt(run.handle, run.token, {
      context: "odu/unit",
      lastError: "403 from api.github.com",
      attempts: 3,
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    // The count tells an operator something is wrong; this tells them which
    // context and why.
    expect(registry.row(run.runId)?.reportingDebt).toBe(1);
    expect(registry.env(run.runId)?.owed).toEqual([
      { context: "odu/unit", lastError: "403 from api.github.com", attempts: 3 },
    ]);
  });

  it("says nothing at all about a run it has never seen", () => {
    // `undefined`, not `UNKNOWN_ENV`: "no such run here" and "a run whose
    // environment is not established yet" call for opposite next moves.
    const w = open();
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.env("0zzzzzzzz-zzzzzzzz")).toBeUndefined();
  });

  it("gives the read-through projection the same environment", () => {
    const w = open();
    const at = 1_700_000_000_000;
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "e1".repeat(20),
      repo: "juspay/odu",
      now: at,
    });
    writePhase(run.handle, run.token, "lanes");
    writeLane(run.handle, run.token, {
      platform: "x86_64-linux",
      state: "leased",
      host: "builder-1",
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at + 1_000);
    const direct = projectRun(run.runId, { root: w.catalogRoot }, at + 1_000);
    expect(direct?.env).toEqual(registry.env(run.runId, at + 1_000));
  });
});
