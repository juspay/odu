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

function tmpRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-owner-"));
  dirs.push(dir);
  const run = join(dir, "0000000a-0001");
  mkdirSync(run, { recursive: true });
  return run;
}

const RUN_ID = "0000000a-0001";
const T0 = 1_700_000_000_000;
const STALE = T0 + OWNERSHIP_GRACE_MS + 1;

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
      isAlive: () => false,
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("a live owner was displaced");
    expect(second.refusal.kind).toBe("held");
    expect(second.refusal.reason).toContain("4242");
    expect(second.refusal.reason).toContain("box-a");
    if (second.refusal.kind !== "held") throw new Error("expected a held refusal");
    expect(second.refusal.owner.epoch).toBe(1);
    expect(currentOwner(dir)?.epoch).toBe(1);
  });

  it("REFUSES on a stale heartbeat alone when the incumbent's pid is still alive here", () => {
    const dir = tmpRun();
    claimFirst(dir);

    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 5555,
      host: "box-a",
      isAlive: () => true,
    });

    expect(successor.ok).toBe(false);
    if (successor.ok) throw new Error("a live pid was displaced by a stale heartbeat");
    expect(successor.refusal.kind).toBe("held");
    expect(successor.refusal.reason).toContain("still running on this host");
    expect(successor.refusal.reason).toContain("stale heartbeat");
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
      isAlive: () => false,
    });

    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error(successor.refusal.reason);
    expect(successor.token.epoch).toBe(2);
    expect(successor.owner.pid).toBe(5555);
    expect(successor.owner.endpoint).toBe("/run/odu-2.sock");
    expect(publishedOwner(dir)).toEqual(successor.owner);
    expect(stillOwner(first.token)).toBe(false);
    expect(stillOwner(successor.token)).toBe(true);
  });

  it("hands over on a DIFFERENT host on the stale heartbeat alone", () => {
    const dir = tmpRun();
    claimFirst(dir);

    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 4242,
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

    expect(stillOwner(first.token)).toBe(false);
  });

  it("is false for a token pointing at a run nobody has claimed", () => {
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
    expect(owner?.claimedAt).toBe(T0);
    expect(owner?.epoch).toBe(1);
    expect(owner?.endpoint).toBe("/run/odu.sock");
  });

  it("returns false once fenced, and does NOT resurrect the old epoch", () => {
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
    expect(owner?.heartbeatAt).toBe(STALE);
    expect(stillOwner(second.token)).toBe(true);
  });
});

describe("releaseOwnership", () => {
  it("drops the endpoint but KEEPS the epoch, so the run is not free for the taking", () => {
    const dir = tmpRun();
    const first = claimFirst(dir);

    releaseOwnership(first.token, T0 + 30_000);

    const owner = currentOwner(dir);
    expect(owner?.endpoint).toBeNull();
    expect(owner?.epoch).toBe(1);
    expect(stillOwner(first.token)).toBe(true);

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

    expect(currentOwner(dir)?.endpoint).toBe("/run/odu-2.sock");
    expect(currentOwner(dir)?.epoch).toBe(2);
  });
});

describe("currentOwner reads the claim files, not just owner.json", () => {
  it("reports the highest epoch even when owner.json is behind a claim", () => {
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

    expect(publishedOwner(dir)).toMatchObject({ epoch: 1 });
    expect(currentOwner(dir)).toEqual(orphan);

    const successor = claimOwnership({
      runId: RUN_ID,
      dir,
      endpoint: null,
      now: STALE,
      pid: 8888,
      host: "box-d",
      isAlive: () => true,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error(successor.refusal.reason);
    expect(successor.token.epoch).toBe(3);
    expect(currentOwner(dir)?.epoch).toBe(3);
    expect(publishedOwner(dir)).toMatchObject({ epoch: 3 });
  });
});
