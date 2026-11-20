import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  ensureCheckoutFree,
  shouldReclaimReservation,
  stopWorkIfExclusivityLost,
} from "./run";
import { acquireFromPool, type ClaimResult, type LeaseIdentity } from "./lease";
import { type CheckoutPaths, checkoutPaths } from "./socket";

const identity: LeaseIdentity = { holder: "me@desk", run: "abc1234" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(): CheckoutPaths {
  const dir = mkdtempSync(join(tmpdir(), "odu-checkout-"));
  dirs.push(dir);
  return checkoutPaths(dir);
}

describe("ensureCheckoutFree — cancel/refuse before venue claim", () => {
  it("is a no-op when no socket is live and supersede is off", async () => {
    const dial = jest.fn(async () => null);
    const cancel = jest.fn();
    const r = await ensureCheckoutFree(checkout(), false, { dial, cancel });
    expect(r).toEqual({ ok: true });
    expect(dial).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses immediately when a run is live and supersede is off", async () => {
    const dial = jest.fn(async () => ({
      client: {} as never,
      close: jest.fn(),
    }));
    const cancel = jest.fn();
    const r = await ensureCheckoutFree(checkout(), false, { dial, cancel });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refuse");
    expect(r.reason).toBe("live");
    expect(r.message).toMatch(/already in progress/);
    expect(r.message).toMatch(/--supersede/);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("supersede cancels the live run and returns ready when confirmed", async () => {
    const cancel = jest.fn(async () => ({ cancelled: true, confirmed: true }));
    const dial = jest.fn();
    const paths = checkout();
    const r = await ensureCheckoutFree(paths, true, { dial, cancel });
    expect(r).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith(paths.socketPath);
    expect(dial).not.toHaveBeenCalled();
  });

  it("supersede fails when the holder does not shut down in time", async () => {
    const cancel = jest.fn(async () => ({ cancelled: true, confirmed: false }));
    const r = await ensureCheckoutFree(checkout(), true, { cancel });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected supersede-timeout");
    expect(r.reason).toBe("supersede-timeout");
    expect(r.message).toMatch(/did not shut down/);
  });
});

describe("cancel-before-claim — single-host pool supersede (ordering)", () => {
  it("cancels then claims — never waits on the live holder's flock", async () => {
    const events: string[] = [];
    let holderBusy = true;

    const cancel = jest.fn(async () => {
      events.push("cancel");
      holderBusy = false;
      return { cancelled: true, confirmed: true };
    });

    const claim = jest.fn(
      async (_host: string, _id: LeaseIdentity): Promise<ClaimResult> => {
        events.push("claim");
        if (holderBusy) {
          return {
            kind: "busy",
            heldBy: {
              holder: "other@box",
              run: "deadbeef#1",
              sinceMs: Date.now() - 60_000,
            },
          };
        }
        return {
          kind: "held",
          lease: { host: "ci-1", release: jest.fn() },
        };
      },
    );

    const free = await ensureCheckoutFree(checkout(), true, { cancel });
    expect(free.ok).toBe(true);

    const acquired = await acquireFromPool({
      platform: "x86_64-linux",
      pool: ["ci-1"],
      identity,
      noWait: true,
      source: null,
      claim,
    });

    expect(acquired.host).toBe("ci-1");
    expect(acquired.lease).not.toBeNull();
    expect(events).toEqual(["cancel", "claim"]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("claim-before-cancel on a busy single host fails under --no-wait (deadlock shape)", async () => {
    const claim = jest.fn(
      async (): Promise<ClaimResult> => ({
        kind: "busy",
        heldBy: {
          holder: "other@box",
          run: "deadbeef#1",
          sinceMs: Date.now() - 60_000,
        },
      }),
    );

    await expect(
      acquireFromPool({
        platform: "x86_64-linux",
        pool: ["ci-1"],
        identity,
        noWait: true,
        source: null,
        claim,
      }),
    ).rejects.toThrow(/every host.*busy/);
  });
});

describe("lease-lost interrupt stop-work ordering", () => {
  it("closes lanes before settle completes when exclusivity is already gone", async () => {
    const events: string[] = [];
    let settleResolve!: () => void;
    const settle = new Promise<void>((r) => {
      settleResolve = r;
    });
    const stop = (): void => {
      events.push("stop-work");
    };

    const exclusivityLost = true;
    stopWorkIfExclusivityLost(exclusivityLost, stop);
    void settle.then(() => {
      stop();
      events.push("after-settle");
    });

    expect(events).toEqual(["stop-work"]);
    settleResolve();
    await settle;
    await Promise.resolve();
    expect(events).toEqual(["stop-work", "stop-work", "after-settle"]);
  });

  it("defers stop-work until after settle when exclusivity is still held (cancel)", async () => {
    const events: string[] = [];
    let settleResolve!: () => void;
    const settle = new Promise<void>((r) => {
      settleResolve = r;
    });
    const stop = (): void => {
      events.push("stop-work");
    };

    const exclusivityLost = false;
    stopWorkIfExclusivityLost(exclusivityLost, stop);
    void settle.then(() => {
      stop();
      events.push("after-settle");
    });

    expect(events).toEqual([]);
    settleResolve();
    await settle;
    await Promise.resolve();
    expect(events).toEqual(["stop-work", "after-settle"]);
  });
});

describe("reservation reclaim — only before the identity is observable", () => {
  it("reclaims an orphan that never served (early throw)", () => {
    expect(
      shouldReclaimReservation({
        status: "reserved",
        seq: 1,
        identityServed: false,
      }),
    ).toBe(true);
  });

  it("KEEPS the sentinel once the identity was served, even if finalize failed", () => {
    expect(
      shouldReclaimReservation({
        status: "reserved",
        seq: 1,
        identityServed: true,
      }),
    ).toBe(false);
  });

  it("has nothing to reclaim when no seq was ever reserved", () => {
    expect(shouldReclaimReservation({ status: "unreserved" })).toBe(false);
  });
});
