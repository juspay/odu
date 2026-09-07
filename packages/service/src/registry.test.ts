/**
 * The BOARD, against real catalog files.
 *
 * The class of bug this projection can have is a disagreement with the records
 * it projects, so every fixture here is written by the catalog's own writers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createRegistry, projectRun } from "./registry";
import {
  finalizeRun,
  makeWorld,
  registerFixtureRun,
  type World,
  writeNode,
  writeRoster,
} from "./fixture.testlib";

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
});
