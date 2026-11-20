import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { releaseOwnership } from "@odu/run-history/owner";
import { Effect } from "effect";
import { readRun } from "./wait";
import { appendEvent, expireRun } from "@odu/run-history/store";
import { createRegistry, projectRun } from "./registry";
import { REFRESH_MS } from "./service";
import {
  crashOwner,
  finalizeRun,
  makeWorld,
  registerFixtureRun,
  type World,
  writeBulkJournal,
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

    expect(registry.refresh().upserted).toEqual([]);

    writeRoster(a.handle, a.token, ["unit@x86_64-linux"]);
    writeNode(w, a.handle, a.token, { id: "unit@x86_64-linux", status: "failed" });
    const moved = registry.refresh();
    expect(moved.upserted.map((row) => row.runId)).toEqual([a.runId]);
  });

  it("tells provisioning apart from running", () => {
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
    expect(row?.unresolvedFailures).toBe(1);
  });

  it("does not call a cancelled run failed", () => {
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

    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(`${w.catalogRoot}/${run.runId}`, { recursive: true, force: true });
    const delta = registry.refresh();
    expect(delta.removed).toEqual([run.runId]);
    expect(registry.rows()).toHaveLength(0);
  });

  it("reports a crashed coordinator as owner_lost WITHOUT anything on disk moving", () => {
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

    crashOwner(run.handle, { heartbeatAt: at - OWNERSHIP_GRACE_MS - 1 });
    const moved = registry.refresh(at);
    expect(moved.upserted.map((row) => row.runId)).toEqual([run.runId]);
    expect(registry.row(run.runId)?.state).toBe("owner_lost");
    expect(projectRun(run.runId, { root: w.catalogRoot }, at)?.row.state).toBe(
      "owner_lost",
    );
  });

  it("flips to owner_lost when the GRACE expires, with no write at all", () => {
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

describe("a node's push", () => {
  const PUSHING = "unit@x86_64-linux";
  const PUSHED = "lint@x86_64-linux";
  const FAILED = "build@x86_64-linux";
  const BUCKET = "odu-main";

  const threeStates = (w: World) => {
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "c".repeat(40),
      push: {
        target: {
          substituter: "https://cache.example/odu-main",
          bucket: BUCKET,
          tokenId: "tok-1",
        },
        skipped: null,
        keyWarning: null,
      },
    });
    writeRoster(run.handle, run.token, [PUSHING, PUSHED, FAILED]);
    for (const id of [PUSHING, PUSHED, FAILED]) {
      writeNode(w, run.handle, run.token, { id, status: "ok" });
    }
    appendEvent(run.handle, run.token, {
      kind: "pushing",
      node: PUSHING,
      bucket: BUCKET,
    });
    appendEvent(run.handle, run.token, {
      kind: "pushed",
      node: PUSHED,
      bucket: BUCKET,
      paths: 7,
      present: 2,
      bytes: 4_096,
      durationMs: 1_200,
    });
    appendEvent(run.handle, run.token, {
      kind: "push_failed",
      node: FAILED,
      bucket: BUCKET,
      message: "403 from the bucket — the token is not valid for this path",
      durationMs: 300,
    });
    return run;
  };

  it("projects all three states onto the node rows, and nothing more", () => {
    const w = open();
    const run = threeStates(w);
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();

    const nodes = registry.nodes(run.runId) ?? [];
    const push = (id: string) => nodes.find((one) => one.id === id)?.push;
    expect(push(PUSHING)).toEqual({ state: "pushing" });
    expect(push(PUSHED)).toEqual({
      state: "pushed",
      stored: 5,
      present: 2,
      bytes: 4_096,
      durationMs: 1_200,
    });
    expect(push(FAILED)).toEqual({
      state: "failed",
      message: "403 from the bucket — the token is not valid for this path",
      durationMs: 300,
    });
  });

  it("leaves the push off a node that has none, rather than zeroing it", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/b", sha: "d".repeat(40) });
    writeRoster(run.handle, run.token, [PUSHED]);
    writeNode(w, run.handle, run.token, { id: PUSHED, status: "ok" });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.nodes(run.runId)?.[0]?.push).toBeUndefined();
  });

  it("sums only what LANDED on the run's answer, and names who failed", async () => {
    const w = open();
    const run = threeStates(w);

    const answer = await Effect.runPromise(
      Effect.result(readRun({ runId: run.runId }, { catalog: { root: w.catalogRoot } })),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.push).toEqual({
      target: { substituter: "https://cache.example/odu-main", bucket: BUCKET },
      skipped: null,
      keyWarning: null,
      paths: 7,
      present: 2,
      bytes: 4_096,
      failedOn: [FAILED],
    });
  });
});

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

  it("puts the finish instant on the ROW, null while the run has not finished", () => {
    const w = open();
    const at = 1_700_000_000_000;
    const run = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "b2".repeat(20),
      now: at,
    });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at + 5_000);
    expect(registry.row(run.runId)?.finishedAt).toBeNull();

    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, {
      id: "unit@x86_64-linux",
      status: "ok",
      at: at + 1_000,
    });
    finalizeRun(run.handle, run.token, "passed", [], at + 60_000);
    registry.refresh(at + 90_000);

    expect(registry.row(run.runId)?.finishedAt).toBe(at + 60_000);
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
    expect(registry.row(run.runId)?.reportingDebt).toBe(1);
    expect(registry.env(run.runId)?.owed).toEqual([
      { context: "odu/unit", lastError: "403 from api.github.com", attempts: 3 },
    ]);
  });

  it("says nothing at all about a run it has never seen", () => {
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

describe("the registry over a large catalog", () => {
  it("re-reads no journal on a warm tick, however long the journals are", () => {
    const w = open();
    const checkouts = ["/code/a", "/code/b", "/code/c"];
    for (let i = 0; i < 200; i += 1) {
      const run = registerFixtureRun(w, {
        repoRoot: checkouts[i % checkouts.length] as string,
        sha: i.toString(16).padStart(40, "0"),
      });
      writeBulkJournal(run.handle, 1_500);
      finalizeRun(run.handle, run.token, "passed");
    }
    const registry = createRegistry({ root: w.catalogRoot });
    expect(registry.refresh().upserted).toHaveLength(200);

    const began = performance.now();
    const warm = registry.refresh();
    const took = performance.now() - began;
    expect(warm).toEqual({ upserted: [], removed: [] });
    expect(registry.size()).toBe(200);
    expect(took, `a warm tick over 200 runs took ${Math.round(took)}ms`).toBeLessThan(
      REFRESH_MS,
    );
  }, 120_000);

  it("stops asking a RELEASED settled run's fence, and still follows it if it resumes", () => {
    const w = open();
    const at = Date.now();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "5e".repeat(20), now: at });
    finalizeRun(run.handle, run.token, "passed", [], at);
    releaseOwnership(run.token);
    crashOwner(run.handle, { heartbeatAt: at });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at);
    expect(registry.row(run.runId)?.state).toBe("settled");

    const later = at + OWNERSHIP_GRACE_MS + 1;
    expect(registry.refresh(later)).toEqual({ upserted: [], removed: [] });
    expect(registry.row(run.runId)?.state).toBe("settled");

    appendEvent(run.handle, run.token, {
      kind: "attempt_started",
      node: "unit@x86_64-linux",
      attempt: 2,
      placement: { platform: "x86_64-linux", host: "localhost" },
    });
    expect(registry.refresh(later).upserted.map((row) => row.runId)).toEqual([run.runId]);
    expect(registry.row(run.runId)?.state).toBe("owner_lost");
  });

  it("re-projects a run when a takeover CLAIM appears and owner.json does not move", () => {
    const w = open();
    const at = Date.now();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "ab".repeat(20), now: at });
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at);
    expect(registry.row(run.runId)?.state).toBe("provisioning");

    writeFileSync(
      join(run.handle.dir, "owner.2.claim"),
      `${JSON.stringify({
        epoch: 2,
        pid: 0x7ffffff0,
        host: hostname(),
        claimedAt: at - OWNERSHIP_GRACE_MS - 1,
        heartbeatAt: at - OWNERSHIP_GRACE_MS - 1,
        endpoint: null,
      })}\n`,
    );
    const moved = registry.refresh(at);
    expect(moved.upserted.map((row) => row.runId)).toEqual([run.runId]);
    expect(registry.row(run.runId)?.state).toBe("owner_lost");
  });

  it("follows a finalized run that resumed, and settles it again", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "cd".repeat(20) });
    writeRoster(run.handle, run.token, ["unit@x86_64-linux"]);
    writeNode(w, run.handle, run.token, { id: "unit@x86_64-linux", status: "failed" });
    finalizeRun(run.handle, run.token, "failed", ["unit@x86_64-linux"]);
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.row(run.runId)?.state).toBe("settled");

    appendEvent(run.handle, run.token, {
      kind: "attempt_started",
      node: "unit@x86_64-linux",
      attempt: 2,
      placement: { platform: "x86_64-linux", host: "localhost" },
    });
    registry.refresh();
    expect(registry.row(run.runId)?.state).toBe("running");
    expect(registry.row(run.runId)?.outcome).toBeNull();

    writeNode(w, run.handle, run.token, {
      id: "unit@x86_64-linux",
      attempt: 2,
      status: "ok",
    });
    finalizeRun(run.handle, run.token, "passed");
    registry.refresh();
    expect(registry.row(run.runId)?.state).toBe("settled");
    expect(registry.row(run.runId)?.outcome).toBe("passed");
  });

  it("reports a run retention expired on the next tick", () => {
    const w = open();
    const at = Date.now();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "ef".repeat(20), now: at });
    finalizeRun(run.handle, run.token, "passed", [], at);
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh(at);
    expect(registry.row(run.runId)?.state).toBe("settled");

    const later = at + OWNERSHIP_GRACE_MS * 4;
    expect(expireRun(run.handle, later)).toBe(true);
    expect(registry.refresh(later).upserted.map((row) => row.runId)).toEqual([run.runId]);
    expect(registry.row(run.runId)?.state).toBe("expired");
  });

  it("never publishes a directory with no manifest, and drops a row whose manifest goes", () => {
    const w = open();
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: "12".repeat(20) });
    mkdirSync(join(w.catalogRoot, "0zzzzzzzz-zzzzzzzz"));
    const registry = createRegistry({ root: w.catalogRoot });
    expect(registry.refresh().upserted.map((row) => row.runId)).toEqual([run.runId]);
    expect(registry.refresh()).toEqual({ upserted: [], removed: [] });
    expect(registry.select({}).total).toBe(1);

    rmSync(join(run.handle.dir, "manifest.json"));
    expect(registry.refresh().removed).toEqual([run.runId]);
    expect(registry.select({}).total).toBe(0);
  });
});

describe("registry.select", () => {
  function board(w: World) {
    const at = 1_700_000_000_000;
    const make = (i: number, repoRoot: string, sha: string, seq: number) =>
      registerFixtureRun(w, {
        repoRoot,
        sha,
        seq,
        now: at + i * 1_000,
        runId: `0${(at + i * 1_000).toString(36)}-0000000${i}`,
      }).runId;
    return {
      a1: make(1, "/code/a", `abcdef1${"0".repeat(33)}`, 1),
      b1: make(2, "/code/b", `abcdef1${"0".repeat(33)}`, 1),
      a2: make(3, "/code/a", `abcdef1${"0".repeat(33)}`, 2),
      a3: make(4, "/code/a", `1234567${"0".repeat(33)}`, 1),
    };
  }

  it("returns every run, newest first, when nothing filters", () => {
    const w = open();
    const ids = board(w);
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const all = registry.select({});
    expect(all.rows.map((r) => r.runId)).toEqual([ids.a3, ids.a2, ids.b1, ids.a1]);
    expect(all.total).toBe(4);
  });

  it("filters by checkout, commit prefix and seq, ANDed", () => {
    const w = open();
    const ids = board(w);
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    expect(registry.select({ checkout: "/code/a" }).rows.map((r) => r.runId)).toEqual([
      ids.a3,
      ids.a2,
      ids.a1,
    ]);
    expect(registry.select({ sha: "ABCDEF1" }).rows.map((r) => r.runId)).toEqual([
      ids.a2,
      ids.b1,
      ids.a1,
    ]);
    expect(
      registry.select({ sha: "abcdef1", seq: 1 }).rows.map((r) => r.runId),
    ).toEqual([ids.b1, ids.a1]);
    expect(
      registry.select({ checkout: "/code/a", sha: "abcdef1", seq: 1 }).rows.map((r) => r.runId),
    ).toEqual([ids.a1]);
    expect(registry.select({ checkout: "/code/nowhere" })).toEqual({ rows: [], total: 0 });
  });

  it("cuts rows at limit and still counts every match", () => {
    const w = open();
    const ids = board(w);
    const registry = createRegistry({ root: w.catalogRoot });
    registry.refresh();
    const one = registry.select({ checkout: "/code/a", limit: 1 });
    expect(one.rows.map((r) => r.runId)).toEqual([ids.a3]);
    expect(one.total).toBe(3);
  });
});
