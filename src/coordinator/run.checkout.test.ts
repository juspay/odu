/**
 * Checkout-lock prelude + cancel-before-venue-lease ordering.
 *
 * Regression for the single-host supersede deadlock: a live run holds the only
 * remote flock; if the CLI leased first it would wait forever and never cancel
 * the holder. `ensureCheckoutFree` must run (and cancel when superseding)
 * before any `leaseLanes` / `acquireFromPool` claim.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyInterruptStopWork, ensureCheckoutFree } from "./run";
import { acquireFromPool, type ClaimResult, type LeaseIdentity } from "./lease";

const identity: LeaseIdentity = { holder: "me@desk", run: "abc1234" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A socket path *outside* the checkout. `ensureCheckoutFree` derives the run
 *  lock from the socket's dirname, so a relative `.ci/odu.sock` here would
 *  resolve to this repo's real `.ci/odu.run.lock` — and the supersede path
 *  SIGTERMs whatever holds it. odu runs its own suite on a localhost lane, so
 *  that holder is the very run executing this test: it killed itself mid-run.
 *  Mocking `cancel` is not enough; the lock signal is a separate step. */
function sockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-checkout-"));
  dirs.push(dir);
  return join(dir, "odu.sock");
}

describe("ensureCheckoutFree — cancel/refuse before venue claim", () => {
  it("is a no-op when no socket is live and supersede is off", async () => {
    const dial = vi.fn(async () => null);
    const cancel = vi.fn();
    const r = await ensureCheckoutFree(sockPath(), false, { dial, cancel });
    expect(r).toEqual({ ok: true });
    expect(dial).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses immediately when a run is live and supersede is off", async () => {
    const dial = vi.fn(async () => ({
      client: {} as never,
      close: vi.fn(),
    }));
    const cancel = vi.fn();
    const r = await ensureCheckoutFree(sockPath(), false, { dial, cancel });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refuse");
    expect(r.reason).toBe("live");
    expect(r.message).toMatch(/already in progress/);
    expect(r.message).toMatch(/--supersede/);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("supersede cancels the live run and returns ready when confirmed", async () => {
    const cancel = vi.fn(async () => ({ cancelled: true, confirmed: true }));
    const dial = vi.fn();
    const sock = sockPath();
    const r = await ensureCheckoutFree(sock, true, { dial, cancel });
    expect(r).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith(sock);
    // Supersede path does not need a separate dial — cancel owns the probe.
    expect(dial).not.toHaveBeenCalled();
  });

  it("supersede fails when the holder does not shut down in time", async () => {
    const cancel = vi.fn(async () => ({ cancelled: true, confirmed: false }));
    const r = await ensureCheckoutFree(sockPath(), true, { cancel });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected supersede-timeout");
    expect(r.reason).toBe("supersede-timeout");
    expect(r.message).toMatch(/did not shut down/);
  });
});

describe("cancel-before-claim — single-host pool supersede (ordering)", () => {
  /**
   * Models the deadlock the reorder fixes: one remote host, held by the live
   * run until cancel fires. Claim-before-cancel waits forever; cancel-then-claim
   * succeeds. This is the unit stand-in for CLI `odu run --supersede` on a
   * pool of one.
   */
  it("cancels then claims — never waits on the live holder's flock", async () => {
    const events: string[] = [];
    let holderBusy = true;

    const cancel = vi.fn(async () => {
      events.push("cancel");
      holderBusy = false;
      return { cancelled: true, confirmed: true };
    });

    const claim = vi.fn(
      async (_host: string, _id: LeaseIdentity): Promise<ClaimResult> => {
        events.push("claim");
        if (holderBusy) {
          // In production this would spin in acquireFromPool's wait loop —
          // return busy once and let noWait surface the failure if ordering
          // is wrong (cancel never ran).
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
          lease: { host: "ci-1", release: vi.fn() },
        };
      },
    );

    // Prelude first (as orchestrate does), then venue claim.
    const checkout = await ensureCheckoutFree(sockPath(), true, { cancel });
    expect(checkout.ok).toBe(true);

    const acquired = await acquireFromPool({
      platform: "x86_64-linux",
      pool: ["ci-1"],
      identity,
      noWait: true,
      claim,
    });

    expect(acquired.host).toBe("ci-1");
    expect(acquired.lease).not.toBeNull();
    expect(events).toEqual(["cancel", "claim"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });

  it("claim-before-cancel on a busy single host fails under --no-wait (deadlock shape)", async () => {
    // Documents the pre-fix failure mode: leasing while the prior run still
    // holds the only box fails/waits — supersede cancel never runs if ordered
    // after the lease.
    const claim = vi.fn(
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
        claim,
      }),
    ).rejects.toThrow(/every host.*busy/);
  });
});

describe("lease-lost interrupt stop-work ordering", () => {
  /**
   * Models `shutdown(..., { exclusivityLost: true })`: the remote flock is
   * already free, so lanes/holds must stop before status settle drains. The
   * cancel path keeps exclusivity during settle and only stops after.
   */
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
    applyInterruptStopWork("before-settle", exclusivityLost, stop);
    void settle.then(() => {
      applyInterruptStopWork("after-settle", exclusivityLost, stop);
      events.push("after-settle");
    });

    // settle still pending — stop-work must already have run (fail-closed).
    expect(events).toEqual(["stop-work"]);
    settleResolve();
    await settle;
    // microtask for the .then chain
    await Promise.resolve();
    // second stop is idempotent-intent; after-settle always invokes stop
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
    applyInterruptStopWork("before-settle", exclusivityLost, stop);
    void settle.then(() => {
      applyInterruptStopWork("after-settle", exclusivityLost, stop);
      events.push("after-settle");
    });

    expect(events).toEqual([]);
    settleResolve();
    await settle;
    await Promise.resolve();
    expect(events).toEqual(["stop-work", "after-settle"]);
  });
});
