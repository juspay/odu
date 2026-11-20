import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  agentLeaseLockPath,
  type Clock,
  claimLocal,
  parseHolderBody,
  probeLocal,
} from "./leaseHold";

function fakeClock(startMs: number): Clock & {
  advance(ms: number): void;
  fire(): void;
} {
  let nowMs = startMs;
  const ticks: Array<() => void> = [];
  return {
    now: () => nowMs,
    every: (_ms, tick) => {
      ticks.push(tick);
      return {
        stop: () => {
          const i = ticks.indexOf(tick);
          if (i >= 0) ticks.splice(i, 1);
        },
      };
    },
    advance: (ms) => {
      nowMs += ms;
    },
    fire: () => {
      for (const tick of [...ticks]) tick();
    },
  };
}

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
      clock: fakeClock(1_000),
      maxHoldMs: null,
      deadManMs: 60_000,
    });
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    expect(c.hold.lockPath).toBe(lock);
    expect(c.hold.heldBy).toEqual({
      holder: "t@h",
      run: "abc#1",
      sinceMs: 1_000,
    });
    expect(c.hold.isHeld()).toBe(true);
    expect(c.hold.probe(lock)).toEqual({
      kind: "busy",
      heldBy: { holder: "t@h", run: "abc#1", sinceMs: 1_000 },
    });
    expect(c.hold.probe(`${lock}-different`)).toEqual({ kind: "not-mine" });

    const p = probeLocal(lock);
    expect(p.state).toBe("busy");
    if (p.state === "busy") {
      expect(p.heldBy?.holder).toBe("t@h");
      expect(p.heldBy?.run).toBe("abc#1");
    }

    c.hold.release();
    expect(c.hold.isHeld()).toBe(false);
    expect(c.hold.probe(lock)).toEqual({ kind: "not-mine" });
    await new Promise((r) => setTimeout(r, 200));
    expect(probeLocal(lock).state).toBe("free");
  });

  it("second concurrent claim is busy", async () => {
    const lock = tmpLock();
    const a = await claimLocal(lock, { holder: "a@h", run: null }, {
      maxHoldMs: null,
      deadManMs: 60_000,
    });
    expect(a.status).toBe("held");
    if (a.status !== "held") return;

    const b = await claimLocal(lock, { holder: "b@h", run: null }, {
      maxHoldMs: null,
      deadManMs: 60_000,
    });
    expect(b.status).toBe("busy");

    a.hold.release();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("dead-man self-releases after idle without noteActivity", async () => {
    const lock = tmpLock();
    const clock = fakeClock(1_000);
    const self = jest.fn();
    const c = await claimLocal(
      lock,
      { holder: "t@h", run: null },
      {
        clock,
        deadManMs: 45_000,
        maxHoldMs: null,
        onSelfRelease: self,
      },
    );
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    clock.advance(50_000);
    clock.fire();
    expect(self).toHaveBeenCalledWith("dead-man");
    await new Promise((r) => setTimeout(r, 200));
    expect(probeLocal(lock).state).toBe("free");
  });

  it("noteActivity resets the dead-man window", async () => {
    const lock = tmpLock();
    const clock = fakeClock(1_000);
    const self = jest.fn();
    const c = await claimLocal(
      lock,
      { holder: "t@h", run: null },
      {
        clock,
        deadManMs: 45_000,
        maxHoldMs: null,
        onSelfRelease: self,
      },
    );
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    clock.advance(40_000);
    c.hold.noteActivity();
    clock.advance(40_000);
    clock.fire();
    expect(self).not.toHaveBeenCalled();

    clock.advance(10_000);
    clock.fire();
    expect(self).toHaveBeenCalledWith("dead-man");
    c.hold.release();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("max-hold self-releases even when pulsed", async () => {
    const lock = tmpLock();
    const clock = fakeClock(1_000);
    const self = jest.fn();
    const c = await claimLocal(
      lock,
      { holder: "t@h", run: null },
      {
        clock,
        deadManMs: 45_000,
        maxHoldMs: 3_600_000,
        onSelfRelease: self,
      },
    );
    expect(c.status).toBe("held");
    if (c.status !== "held") return;

    clock.advance(3_600_000);
    c.hold.noteActivity();
    clock.fire();
    expect(self).toHaveBeenCalledWith("max-hold");
    await new Promise((r) => setTimeout(r, 200));
  });
});
