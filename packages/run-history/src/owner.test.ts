/**
 * The ownership fence — and the one property everything else here is in
 * service of: A LIVE OWNER IS NEVER DISPLACED.
 *
 * That property is easy to get wrong because every cheap signal of death is
 * also a signal of a healthy restart. A quiet heartbeat is what a coordinator
 * doing a cold `nix copy` looks like; a missing socket is what a coordinator
 * between two `serve` calls looks like. Code that accepts either one alone
 * hands a second writer the same journal, and a fabricated `finalized` line
 * cannot be un-said. So the tests below spend most of their weight on the
 * REFUSALS — a stale heartbeat with a live pid on the same host must not be
 * enough — and on the fence itself: a superseded token answers false to
 * `stillOwner` and writes nothing thereafter.
 *
 * Every test injects `now`, `pid`, `host` and `isAlive`. Nothing here may
 * depend on the wall clock or on the machine's real hostname: a fence test
 * that passes because a random pid happened to be dead is not a test.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  claimOwnership,
  currentOwner,
  heartbeat,
  OWNERSHIP_GRACE_MS,
  releaseOwnership,
  stillOwner,
} from "./owner";
import { RUN_FILES } from "./paths";
import type { Owner } from "./schema";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A run directory nobody has ever claimed. */
function tmpRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-owner-"));
  dirs.push(dir);
  const run = join(dir, "0000000a-0001");
  mkdirSync(run, { recursive: true });
  return run;
}

const RUN_ID = "0000000a-0001";
/** A fixed instant, so "stale" and "fresh" are arithmetic rather than luck. */
const T0 = 1_700_000_000_000;
const STALE = T0 + OWNERSHIP_GRACE_MS + 1;

/** The incumbent every test starts from: pid 4242 on `box-a`, claimed at T0. */
function claimFirst(dir: string, endpoint: string | null = "/run/odu.sock") {
  const claim = claimOwnership({
    runId: RUN_ID,
    dir,
    endpoint,
    now: T0,
    pid: 4242,
    host: "box-a",
    isAlive: () => true,
  });
  if (!claim.ok) throw new Error(`fresh claim refused: ${claim.refusal.reason}`);
  return claim;
}

/** Read `owner.json` as it sits on disk — the published record, deliberately
 *  NOT through `currentOwner`, so a test can catch the two disagreeing. */
function publishedOwner(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, RUN_FILES.owner), "utf-8"));
}

describe("claimOwnership on an unowned run", () => {
  it("takes epoch 1 and publishes the owner record", () => {
    const dir = tmpRun();
    const claim = claimFirst(dir);

    expect(claim.token).toEqual({ runId: RUN_ID, dir, epoch: 1 });
    expect(claim.owner).toEqual({
      epoch: 1,
      pid: 4242,
      host: "box-a",
      claimedAt: T0,
      heartbeatAt: T0,
      endpoint: "/run/odu.sock",
    });
    // Published where a reader looks, and matching the claim file's authority.
    expect(publishedOwner(dir)).toEqual(claim.owner);
    expect(currentOwner(dir)).toEqual(claim.owner);
  });
});

describe("a live owner is never displaced", () => {
  it("refuses a second claim while the heartbeat is fresh, naming the pid and host", () => {
    const dir = tmpRun();
    claimFirst(dir);

    const second = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: T0 + 1_000,
      pid: 5555,
      host: "box-b",
      isAlive: () => false, // irrelevant: the heartbeat has not even gone stale
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("a live owner was displaced");
    expect(second.refusal.kind).toBe("held");
    // The refusal has to be actionable by a human: WHICH process, on WHICH box.
    expect(second.refusal.reason).toContain("4242");
    expect(second.refusal.reason).toContain("box-a");
    if (second.refusal.kind !== "held") throw new Error("expected a held refusal");
    expect(second.refusal.owner.epoch).toBe(1);
    // Nothing moved.
    expect(currentOwner(dir)?.epoch).toBe(1);
  });

  it("REFUSES on a stale heartbeat alone when the incumbent's pid is still alive here", () => {
    // The central test of this file. A heartbeat older than the grace is
    // EVIDENCE of death, never a verdict: a coordinator wedged on a cold `nix
    // copy` has stopped beating and is very much still writing. On the same
    // host we can ask the kernel, and the kernel's answer beats the clock's.
    const dir = tmpRun();
    claimFirst(dir);

    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 5555,
      host: "box-a", // same host — the only case where the pid check is honest
      isAlive: () => true,
    });

    expect(successor.ok).toBe(false);
    if (successor.ok) throw new Error("a live pid was displaced by a stale heartbeat");
    expect(successor.refusal.kind).toBe("held");
    expect(successor.refusal.reason).toContain("still running on this host");
    expect(successor.refusal.reason).toContain("stale heartbeat");
    // And the refusal is total: no epoch was burned on the way to it.
    expect(currentOwner(dir)?.epoch).toBe(1);
    expect(currentOwner(dir)?.pid).toBe(4242);
  });

  it("hands over at epoch 2 when the heartbeat is stale AND the pid is gone", () => {
    const dir = tmpRun();
    const first = claimFirst(dir);

    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: "/run/odu-2.sock",
      now: STALE,
      pid: 5555,
      host: "box-a",
      isAlive: () => false, // both halves of the proof are now in hand
    });

    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error(successor.refusal.reason);
    expect(successor.token.epoch).toBe(2);
    expect(successor.owner.pid).toBe(5555);
    expect(successor.owner.endpoint).toBe("/run/odu-2.sock");
    expect(publishedOwner(dir)).toEqual(successor.owner);
    // The takeover is what fences the previous writer.
    expect(stillOwner(first.token)).toBe(false);
    expect(stillOwner(successor.token)).toBe(true);
  });

  it("hands over on a DIFFERENT host on the stale heartbeat alone", () => {
    // The stated limit, tested rather than left implicit: `isAlive` can only
    // answer about processes on THIS machine, so a cross-host takeover has
    // nothing but the grace to wait out. Note `isAlive: () => true` — it is
    // deliberately not consulted here, because a pid number from another box
    // means nothing locally, and pretending otherwise would be worse than the
    // documented wait.
    const dir = tmpRun();
    claimFirst(dir);

    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 4242, // the same NUMBER, which is exactly the trap a pid file falls into
      host: "box-b",
      isAlive: () => true,
    });

    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error(successor.refusal.reason);
    expect(successor.token.epoch).toBe(2);
    expect(successor.owner.host).toBe("box-b");
  });
});

describe("stillOwner — the fence every durable write asks", () => {
  it("is true for the holder and false once the epoch has moved past it", () => {
    const dir = tmpRun();
    const first = claimFirst(dir);
    expect(stillOwner(first.token)).toBe(true);

    const second = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 5555,
      host: "box-a",
      isAlive: () => false,
    });
    expect(second.ok).toBe(true);

    // The old token is not "probably stale" — it is definitively not the owner,
    // and it finds out at its next question rather than at some notification.
    expect(stillOwner(first.token)).toBe(false);
  });

  it("is false for a token pointing at a run nobody has claimed", () => {
    // Fail-closed: a writer that cannot confirm ownership must not write.
    expect(stillOwner({ runId: RUN_ID, dir: tmpRun(), epoch: 1 })).toBe(false);
  });
});

describe("heartbeat", () => {
  it("refreshes the holder's stamp, keeping its epoch and endpoint", () => {
    const dir = tmpRun();
    const first = claimFirst(dir);

    expect(heartbeat(first.token, T0 + 20_000)).toBe(true);
    const owner = currentOwner(dir);
    expect(owner?.heartbeatAt).toBe(T0 + 20_000);
    expect(owner?.claimedAt).toBe(T0); // the claim instant is history, not liveness
    expect(owner?.epoch).toBe(1);
    expect(owner?.endpoint).toBe("/run/odu.sock");
  });

  it("returns false once fenced, and does NOT resurrect the old epoch", () => {
    // The failure this rules out: a fenced coordinator whose heartbeat timer
    // fires once more and writes `owner.json` back to its own epoch. The
    // successor would then be fenced by its predecessor's corpse.
    const dir = tmpRun();
    const first = claimFirst(dir);
    const second = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 5555,
      host: "box-a",
      isAlive: () => false,
    });
    if (!second.ok) throw new Error(second.refusal.reason);

    expect(heartbeat(first.token, STALE + 5_000)).toBe(false);

    const owner = currentOwner(dir);
    expect(owner?.epoch).toBe(2);
    expect(owner?.pid).toBe(5555);
    expect(owner?.heartbeatAt).toBe(STALE); // untouched by the fenced beat
    expect(stillOwner(second.token)).toBe(true);
  });
});

describe("releaseOwnership", () => {
  it("drops the endpoint but KEEPS the epoch, so the run is not free for the taking", () => {
    const dir = tmpRun();
    const first = claimFirst(dir);

    releaseOwnership(first.token, T0 + 30_000);

    const owner = currentOwner(dir);
    expect(owner?.endpoint).toBeNull(); // the live surface is gone…
    expect(owner?.epoch).toBe(1); // …the record is not
    expect(stillOwner(first.token)).toBe(true);

    // And a fresh caller arriving right after the release is still refused: a
    // clean exit is not an invitation, it is a fresh heartbeat. Anything that
    // wants this run has to prove a takeover like everybody else.
    const other = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: T0 + 30_100,
      pid: 5555,
      host: "box-b",
      isAlive: () => false,
    });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("a released run was claimed without a takeover");
    expect(other.refusal.kind).toBe("held");
  });

  it("does nothing for a token that has already been fenced", () => {
    const dir = tmpRun();
    const first = claimFirst(dir);
    const second = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: "/run/odu-2.sock",
      now: STALE,
      pid: 5555,
      host: "box-a",
      isAlive: () => false,
    });
    if (!second.ok) throw new Error(second.refusal.reason);

    releaseOwnership(first.token, STALE + 1_000);

    // A stale writer must not be able to close the successor's live surface.
    expect(currentOwner(dir)?.endpoint).toBe("/run/odu-2.sock");
    expect(currentOwner(dir)?.epoch).toBe(2);
  });
});

describe("currentOwner reads the claim files, not just owner.json", () => {
  it("reports the highest epoch even when owner.json is behind a claim", () => {
    // The crash this models: a successor wins `owner.2.claim` with
    // O_CREAT|O_EXCL and is killed before it can publish `owner.json`. A reader
    // that trusted the published file alone would report epoch 1 — and the next
    // claimant would then take epoch 2 a SECOND time, believing it had won a
    // race it had already lost.
    const dir = tmpRun();
    claimFirst(dir);
    const orphan: Owner = {
      epoch: 2,
      pid: 777,
      host: "box-c",
      claimedAt: T0,
      heartbeatAt: T0,
      endpoint: null,
    };
    writeFileSync(
      join(dir, "owner.2.claim"),
      `${JSON.stringify(orphan, null, 2)}\n`,
    );

    expect(publishedOwner(dir)).toMatchObject({ epoch: 1 }); // still behind
    expect(currentOwner(dir)).toEqual(orphan); // the claim IS the ownership

    // So the next takeover goes to 3, never re-issuing 2.
    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 8888,
      host: "box-d", // a different host from the orphan: the heartbeat alone
      isAlive: () => true,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error(successor.refusal.reason);
    expect(successor.token.epoch).toBe(3);
    expect(currentOwner(dir)?.epoch).toBe(3);
    expect(publishedOwner(dir)).toMatchObject({ epoch: 3 });
  });
});
