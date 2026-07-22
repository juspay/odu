import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentLeaseLockPath,
  claimLocal,
  parseHolderBody,
  probeLocal,
} from "./leaseHold";

const flockAvailable = (() => {
  const r = spawnSync("flock", ["--version"], { encoding: "utf8" });
  return r.error === undefined;
})();

describe("parseHolderBody", () => {
  it("parses pipe-encoded holder lines", () => {
    expect(parseHolderBody("a@b|run#1|100")).toEqual({
      holder: "a@b",
      run: "run#1",
      sinceMs: 100,
    });
  });
});

describe("agentLeaseLockPath", () => {
  it("defaults to /tmp/odu.lease", () => {
    const prev = process.env.ODU_LEASE_LOCK;
    delete process.env.ODU_LEASE_LOCK;
    expect(agentLeaseLockPath()).toBe("/tmp/odu.lease");
    expect(agentLeaseLockPath("/custom")).toBe("/custom");
    if (prev !== undefined) process.env.ODU_LEASE_LOCK = prev;
  });
});

describe.skipIf(!flockAvailable)("claimLocal / probeLocal", () => {
  const locks: string[] = [];
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    for (const lock of locks.splice(0)) {
      for (const p of [lock, `${lock}.holder`]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  });

  function tmpLock(): string {
    const lock = join(tmpdir(), `odu-lease-test-${process.pid}-${Date.now()}-${Math.random()}`);
    locks.push(lock);
    return lock;
  }

  it("claims, probes busy, releases to free", async () => {
    const lock = tmpLock();
    expect(probeLocal(lock).state).toBe("free");
    const c = await claimLocal(lock, { holder: "t@h", run: "abc#1" }, {
      nowMs: 1_000,
      maxHoldMs: 0,
      deadManMs: 60_000,
    });
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    const p = probeLocal(lock);
    expect(p.state).toBe("busy");
    if (p.state === "busy") {
      expect(p.heldBy?.holder).toBe("t@h");
      expect(p.heldBy?.run).toBe("abc#1");
    }

    c.hold.release();
    await new Promise((r) => setTimeout(r, 200));
    expect(probeLocal(lock).state).toBe("free");
  });

  it("second concurrent claim is busy", async () => {
    const lock = tmpLock();
    const a = await claimLocal(lock, { holder: "a@h", run: null }, {
      maxHoldMs: 0,
      deadManMs: 60_000,
    });
    expect(a.status).toBe("held");
    if (a.status !== "held") return;

    const b = await claimLocal(lock, { holder: "b@h", run: null }, {
      maxHoldMs: 0,
      deadManMs: 60_000,
    });
    expect(b.status).toBe("busy");

    a.hold.release();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("dead-man self-releases after idle without noteActivity", async () => {
    const lock = tmpLock();
    let clock = 1_000;
    const timers: Array<{ cb: () => void; ms: number; at: number }> = [];
    const self = vi.fn();
    const c = await claimLocal(
      lock,
      { holder: "t@h", run: null },
      {
        now: () => clock,
        nowMs: clock,
        deadManMs: 45_000,
        maxHoldMs: 0,
        setIntervalFn: ((cb: () => void, ms: number) => {
          const id = { cb, ms, at: clock + ms };
          timers.push(id);
          return id as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearIntervalFn: ((id: unknown) => {
          const i = timers.indexOf(id as (typeof timers)[0]);
          if (i >= 0) timers.splice(i, 1);
        }) as typeof clearInterval,
        onSelfRelease: self,
      },
    );
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    // Advance past dead-man without pulsing.
    clock += 50_000;
    for (const t of [...timers]) t.cb();
    expect(self).toHaveBeenCalledWith("dead-man");
    await new Promise((r) => setTimeout(r, 200));
    expect(probeLocal(lock).state).toBe("free");
  });

  it("noteActivity resets the dead-man window", async () => {
    const lock = tmpLock();
    let clock = 1_000;
    const timers: Array<{ cb: () => void }> = [];
    const self = vi.fn();
    const c = await claimLocal(
      lock,
      { holder: "t@h", run: null },
      {
        now: () => clock,
        nowMs: clock,
        deadManMs: 45_000,
        maxHoldMs: 0,
        setIntervalFn: ((cb: () => void) => {
          const id = { cb };
          timers.push(id);
          return id as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearIntervalFn: ((id: unknown) => {
          const i = timers.indexOf(id as (typeof timers)[0]);
          if (i >= 0) timers.splice(i, 1);
        }) as typeof clearInterval,
        onSelfRelease: self,
      },
    );
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    clock += 40_000;
    c.hold.noteActivity();
    clock += 40_000; // would have fired without pulse; still within 45s of pulse
    for (const t of [...timers]) t.cb();
    expect(self).not.toHaveBeenCalled();

    clock += 10_000; // now past dead-man from last pulse
    for (const t of [...timers]) t.cb();
    expect(self).toHaveBeenCalledWith("dead-man");
    c.hold.release();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("max-hold self-releases even when pulsed", async () => {
    const lock = tmpLock();
    let clock = 1_000;
    const timers: Array<{ cb: () => void }> = [];
    const self = vi.fn();
    const c = await claimLocal(
      lock,
      { holder: "t@h", run: null },
      {
        now: () => clock,
        nowMs: clock,
        deadManMs: 45_000,
        maxHoldMs: 3_600_000,
        setIntervalFn: ((cb: () => void) => {
          const id = { cb };
          timers.push(id);
          return id as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearIntervalFn: ((id: unknown) => {
          const i = timers.indexOf(id as (typeof timers)[0]);
          if (i >= 0) timers.splice(i, 1);
        }) as typeof clearInterval,
        onSelfRelease: self,
      },
    );
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    clock += 3_600_000;
    c.hold.noteActivity(); // still max-hold
    for (const t of [...timers]) t.cb();
    expect(self).toHaveBeenCalledWith("max-hold");
    await new Promise((r) => setTimeout(r, 200));
  });
});
