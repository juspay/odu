/**
 * `catalog.import` and `catalog.prune` — the catalog as operations, and ONE
 * EXECUTION PER REQUEST ID.
 *
 * Both of these used to run in the caller's own process, beside a daemon that
 * reads and writes the same files. Routed through the service there is one
 * writer, which is the point — and the price of that is a request id, so most
 * of this file is about a caller that asks twice: because its reply was lost,
 * because it retried on a timeout, because a script ran again. A repeat must
 * replay what happened, not prune a second time.
 *
 * Every fixture drives REAL FILES on both sides: a legacy `.ci` checkout laid
 * out the way the old world wrote one, and a catalog written by the catalog's
 * own writers. The whole class of bug here is a disagreement between what a
 * report says and what is on disk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { logPathFor } from "@odu/run-client/nodeId";
import { writeRunRecord } from "@odu/run-history/legacy/ledger";
import { type RunRecord, RUN_RECORD_VERSION } from "@odu/run-history/legacy/record";
import { handleFor, readExpiry, readManifest } from "@odu/run-history/store";
import type { ServiceRefused } from "@odu/service-client/surface";
import { DEFAULT_RETENTION_DAYS, importCatalog, pruneCatalog } from "./catalog";
import {
  crashOwner,
  finalizeRun,
  makeWorld,
  recordingPorts,
  registerFixtureRun,
  type World,
  writeNode,
  writeRoster,
} from "./fixture.testlib";
import { claimReceipt, digestOf, requestStore } from "./requests";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

const LEGACY_SHA = "26d2c2dabcdef0123456789012345678901234ab";
const LEGACY_NODE = "ci::unit@x86_64-linux";

let world: World | null = null;
const checkouts: string[] = [];
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
  while (checkouts.length > 0) {
    const dir = checkouts.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A checkout with the LEGACY layout: `.ci/<sha7>/runs/<seq>.json` beside
 *  `.ci/<sha7>/<platform>/<node>.log`. Nothing here is ever rewritten — the
 *  import is read-only over the checkout, which is the compatibility half of
 *  the whole feature. */
function legacyCheckout(seqs: readonly number[] = [1]): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "odu-catalog-checkout-"));
  checkouts.push(repoRoot);
  const sha7 = LEGACY_SHA.slice(0, 7);
  for (const seq of seqs) {
    const record: RunRecord = {
      version: RUN_RECORD_VERSION,
      repo: "juspay/odu",
      sha: LEGACY_SHA,
      seq,
      dirty: false,
      pipeline: "ci",
      outcome: "failed",
      startedAt: 1_700_000_000_000 + seq,
      finishedAt: 1_700_000_060_000 + seq,
      lanes: [{ platform: "x86_64-linux", host: "builder-1" }],
      nodes: [
        {
          id: LEGACY_NODE,
          name: "unit",
          status: "failed",
          exitCode: 1,
          durationMs: 500,
        },
      ],
    };
    writeRunRecord(repoRoot, sha7, record);
    const path = join(repoRoot, logPathFor(sha7, LEGACY_NODE));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "expected 1 to be 2\n");
  }
  return repoRoot;
}

function importDeps(w: World, ports = recordingPorts()) {
  return {
    ports,
    deps: {
      probeCheckout: ports.probeCheckout,
      requests: requestStore({ root: w.requestsRoot }),
      catalog: { root: w.catalogRoot },
      now: () => Date.now(),
    },
  };
}

const pruneDeps = (w: World, now: () => number = Date.now) => ({
  requests: requestStore({ root: w.requestsRoot }),
  catalog: { root: w.catalogRoot },
  now,
});

describe("catalog.import", () => {
  it("brings a checkout's legacy records into the catalog the SERVICE serves", async () => {
    // Which is the point of routing it through the daemon at all: a caller
    // cannot import into a catalog nobody is serving and then wonder why the
    // board never showed the runs.
    const w = open();
    const checkout = legacyCheckout();
    const { deps } = importDeps(w);
    const answer = await run(
      importCatalog({ checkout, requestId: "i-1" }, deps),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.imported).toHaveLength(1);
    expect(answer.success.imported[0]?.ref).toBe("26d2c2d#1");
    expect(answer.success.imported[0]?.reason).toBeNull();
    expect(answer.success.catalog).toBe(w.catalogRoot);
    expect(answer.success.replayed).toBe(false);
    // And the run is really there, addressable by the id the report named.
    const runId = answer.success.imported[0]?.runId ?? "";
    expect(readManifest(handleFor(runId, { root: w.catalogRoot }))).not.toBeNull();
  });

  it("skips a record it already imported, and says why", async () => {
    // The run id is derived from the source record's identity, so a second pass
    // finds the directory rather than doubling a checkout's history.
    const w = open();
    const checkout = legacyCheckout();
    const { deps } = importDeps(w);
    await run(importCatalog({ checkout, requestId: "i-2a" }, deps));
    const again = await run(
      importCatalog({ checkout, requestId: "i-2b" }, deps),
    );
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.imported).toEqual([]);
    expect(again.success.skipped).toHaveLength(1);
    expect(again.success.skipped[0]?.reason).toContain("already in the catalog");
    // A FRESH request id, so this is a real second pass rather than a replay.
    expect(again.success.replayed).toBe(false);
  });

  it("replays a repeated request id rather than importing twice", async () => {
    const w = open();
    const checkout = legacyCheckout([1]);
    const { deps } = importDeps(w);
    const first = await run(importCatalog({ checkout, requestId: "i-3" }, deps));
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;

    // A second record appears in the checkout between the two calls. A replay
    // must report what the FIRST call did — anything else would be a fresh
    // pass wearing a receipt's clothes.
    legacyCheckoutAppend(checkout, 2);
    const again = await run(importCatalog({ checkout, requestId: "i-3" }, deps));
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.replayed).toBe(true);
    expect(again.success.imported.map((r) => r.ref)).toEqual(
      first.success.imported.map((r) => r.ref),
    );
    // And the second record was NOT imported by the replay.
    expect(again.success.imported).toHaveLength(1);
  });

  it("refuses a repeated id that names a different import", async () => {
    const w = open();
    const { deps } = importDeps(w);
    const a = legacyCheckout();
    const b = legacyCheckout();
    await run(importCatalog({ checkout: a, requestId: "i-4" }, deps));
    const other = await run(importCatalog({ checkout: b, requestId: "i-4" }, deps));
    expect(other._tag).toBe("Failure");
    if (other._tag !== "Failure") return;
    expect((other.failure as ServiceRefused).code).toBe("request_conflict");
  });

  it("refuses a relative path, because the daemon's cwd is not the caller's", async () => {
    const w = open();
    const { deps } = importDeps(w);
    const answer = await run(
      importCatalog({ checkout: "../app", requestId: "i-5" }, deps),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("checkout_refused");
    expect((answer.failure as ServiceRefused).message).toContain("absolute");
  });

  it("refuses a path that is not a repository, and replays that refusal", async () => {
    const w = open();
    const { deps } = importDeps(
      w,
      recordingPorts({
        checkout: () => ({ isRepo: false, head: null, branch: null, liveRunId: null }),
      }),
    );
    const answer = await run(
      importCatalog({ checkout: "/code/not-a-repo", requestId: "i-6" }, deps),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("checkout_refused");

    // A refusal is an ANSWER, and it is recorded: repeating the request gets
    // the same sentence rather than a fresh probe of a world that has moved.
    const again = await run(
      importCatalog({ checkout: "/code/not-a-repo", requestId: "i-6" }, deps),
    );
    expect(again._tag).toBe("Failure");
    if (again._tag !== "Failure") return;
    expect((again.failure as ServiceRefused).code).toBe("checkout_refused");
  });

  it("writes nothing for a dry run, and says the report is one", async () => {
    const w = open();
    const checkout = legacyCheckout();
    const { deps } = importDeps(w);
    const answer = await run(
      importCatalog({ checkout, dryRun: true, requestId: "i-7" }, deps),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.dryRun).toBe(true);
    expect(answer.success.imported).toHaveLength(1);
    const runId = answer.success.imported[0]?.runId ?? "";
    expect(readManifest(handleFor(runId, { root: w.catalogRoot }))).toBeNull();
  });
});

describe("catalog.prune", () => {
  const OLD = 1_600_000_000_000;
  const NOW = OLD + 400 * 24 * 60 * 60 * 1000;

  /** A run that finished long ago — old enough for any retention window. */
  function ancientRun(w: World, sha: string) {
    const fixture = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha,
      now: OLD,
    });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"], OLD);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "ok",
      at: OLD,
    });
    finalizeRun(fixture.handle, fixture.token, "passed", [], OLD + 1_000);
    return fixture;
  }

  it("expires a finished run past the window, as a tombstone", async () => {
    // Expiry is a tombstone rather than an `rm -rf`: an agent holding a
    // month-old id deserves to be told the run existed and its evidence aged
    // out, which is a different answer from the one a typo gets.
    const w = open();
    const old = ancientRun(w, "a".repeat(40));
    const answer = await run(
      pruneCatalog({ requestId: "p-1" }, pruneDeps(w, () => NOW)),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.expired).toEqual([old.runId]);
    expect(answer.success.retentionDays).toBe(30);
    expect(answer.success.replayed).toBe(false);
    expect(readExpiry(handleFor(old.runId, { root: w.catalogRoot }))).not.toBeNull();
  });

  it("keeps a run whose owner is still writing, with the reason", async () => {
    const w = open();
    registerFixtureRun(w, { repoRoot: "/code/app", sha: "b".repeat(40), now: OLD });
    const answer = await run(
      pruneCatalog({ requestId: "p-2" }, pruneDeps(w, () => NOW)),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.expired).toEqual([]);
    // Carried with the reason, so "why is this still here" is answerable
    // without a second call.
    expect(answer.success.kept[0]?.reason).toBe("still running");
  });

  it("keeps an un-finalized run whose coordinator died, and says so", async () => {
    // Its evidence is the ONLY account of how it ended, which is precisely when
    // it is worth most.
    const w = open();
    const orphan = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "c".repeat(40),
      now: OLD,
    });
    crashOwner(orphan.handle, { heartbeatAt: OLD });
    const answer = await run(
      pruneCatalog({ requestId: "p-3" }, pruneDeps(w, () => NOW)),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.expired).toEqual([]);
    expect(answer.success.kept[0]?.reason).toContain("never finalized");
  });

  it("does NOT prune twice for a repeated request id", async () => {
    // The property the whole receipt machinery is here for. A second run
    // becomes eligible between the two calls, and the replay must not touch it
    // — a replay reports what happened, it does not do more work under an id
    // that has already been answered.
    const w = open();
    const first = ancientRun(w, "d".repeat(40));
    const deps = pruneDeps(w, () => NOW);
    const one = await run(pruneCatalog({ requestId: "p-4" }, deps));
    expect(one._tag).toBe("Success");
    if (one._tag !== "Success") return;
    expect(one.success.expired).toEqual([first.runId]);

    const second = ancientRun(w, "e".repeat(40));
    const again = await run(pruneCatalog({ requestId: "p-4" }, deps));
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.replayed).toBe(true);
    expect(again.success.expired).toEqual([first.runId]);
    // The run that appeared in between still has all of its evidence.
    expect(readExpiry(handleFor(second.runId, { root: w.catalogRoot }))).toBeNull();
  });

  it("refuses a repeated id that names a different window", async () => {
    const w = open();
    const deps = pruneDeps(w, () => NOW);
    await run(pruneCatalog({ requestId: "p-5" }, deps));
    const other = await run(
      pruneCatalog({ retentionDays: 7, requestId: "p-5" }, deps),
    );
    expect(other._tag).toBe("Failure");
    if (other._tag !== "Failure") return;
    expect((other.failure as ServiceRefused).code).toBe("request_conflict");
  });

  it("changes nothing for a dry run, and reports what a real pass would do", async () => {
    const w = open();
    const old = ancientRun(w, "f".repeat(40));
    const answer = await run(
      pruneCatalog({ dryRun: true, requestId: "p-6" }, pruneDeps(w, () => NOW)),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.dryRun).toBe(true);
    expect(answer.success.expired).toEqual([old.runId]);
    expect(readExpiry(handleFor(old.runId, { root: w.catalogRoot }))).toBeNull();
  });

  it("honours a narrower window than the default", async () => {
    const w = open();
    const at = Date.now();
    const recent = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "1".repeat(40),
      now: at - 10 * 24 * 60 * 60 * 1000,
    });
    writeRoster(recent.handle, recent.token, ["unit@x86_64-linux"], at);
    finalizeRun(recent.handle, recent.token, "passed", [], at - 9 * 24 * 60 * 60 * 1000);
    crashOwner(recent.handle, { heartbeatAt: at - 10 * 24 * 60 * 60 * 1000 });

    const deps = pruneDeps(w);
    // Inside the default 30-day window, so the default pass keeps it.
    const wide = await run(pruneCatalog({ requestId: "p-7" }, deps));
    expect(wide._tag).toBe("Success");
    if (wide._tag !== "Success") return;
    expect(wide.success.expired).toEqual([]);

    const narrow = await run(
      pruneCatalog({ retentionDays: 7, requestId: "p-8" }, deps),
    );
    expect(narrow._tag).toBe("Success");
    if (narrow._tag !== "Success") return;
    expect(narrow.success.retentionDays).toBe(7);
    expect(narrow.success.expired).toEqual([recent.runId]);
  });

  it("finishes a prune a crash left in flight, rather than refusing it", async () => {
    // The asymmetry with `run.start`, and the reason for it: a start that may
    // have spawned a coordinator must never be re-issued, because a second
    // start is a second run. A prune has no such hazard — expiry is a tombstone
    // and an already-tombstoned run is skipped — so an unfinished claim is
    // finished rather than left as an unresolved mutation somebody has to go
    // and investigate.
    const w = open();
    const old = ancientRun(w, "2".repeat(40));
    const store = requestStore({ root: w.requestsRoot });
    // A claim with no recorded answer: the process that made it died before it
    // could write one.
    claimReceipt(store, {
      requestId: "p-9",
      kind: "cancel",
      digest: digestOf([DEFAULT_RETENTION_DAYS, false]),
      plannedRunId: "",
      now: NOW,
    });
    const answer = await run(
      pruneCatalog(
        { requestId: "p-9" },
        { requests: store, catalog: { root: w.catalogRoot }, now: () => NOW },
      ),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.replayed).toBe(false);
    expect(answer.success.expired).toEqual([old.runId]);
  });

  it("refuses a request id outside the grammar before claiming anything", async () => {
    const w = open();
    const answer = await run(
      pruneCatalog({ requestId: "../escape" }, pruneDeps(w, () => NOW)),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("bad_input");
  });
});

/** Add another legacy record to an existing checkout, mid-test. */
function legacyCheckoutAppend(repoRoot: string, seq: number): void {
  const sha7 = LEGACY_SHA.slice(0, 7);
  writeRunRecord(repoRoot, sha7, {
    version: RUN_RECORD_VERSION,
    repo: "juspay/odu",
    sha: LEGACY_SHA,
    seq,
    dirty: false,
    pipeline: "ci",
    outcome: "passed",
    startedAt: 1_700_000_100_000 + seq,
    finishedAt: 1_700_000_160_000 + seq,
    lanes: [{ platform: "x86_64-linux", host: "builder-1" }],
    nodes: [
      {
        id: LEGACY_NODE,
        name: "unit",
        status: "ok",
        exitCode: 0,
        durationMs: 500,
      },
    ],
  });
}
