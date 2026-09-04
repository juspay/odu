import { describe, expect, it, jest } from "bun:test";
import type { Lane } from "./lane";
import type { LeaseHandle } from "./lease";
import { ExecutionRoster } from "./executionRoster";

function lane(platform: string): Lane {
  return {
    platform,
    rerun: jest.fn(async () => true),
    cancel: jest.fn(async () => true),
    drain: jest.fn(async () => ({ reason: "complete" as const })),
    close: jest.fn(),
  };
}

function lease(host: string): LeaseHandle {
  return { host, release: jest.fn() };
}

describe("ExecutionRoster", () => {
  it("routes public shard nodes to the runner that owns their local node", () => {
    const roster = new ExecutionRoster(() => {});
    const primary = lane("x86_64-linux");
    const burst = lane("x86_64-linux");
    roster.addLane(
      "x86_64-linux",
      primary,
      ["install", "e2e"],
      (id) => `${id}@x86_64-linux`,
    );
    roster.addLane(
      "x86_64-linux",
      burst,
      ["install", "e2e"],
      (id) => `e2e[2-of-2]::${id}@x86_64-linux`,
    );

    expect(roster.route("x86_64-linux", "install@x86_64-linux")).toEqual({
      lane: primary,
      localId: "install",
    });
    expect(
      roster.route(
        "x86_64-linux",
        "e2e[2-of-2]::install@x86_64-linux",
      ),
    ).toEqual({ lane: burst, localId: "install" });
  });

  it("cancels every lane and releases every lease in one platform execution", () => {
    const released: LeaseHandle[] = [];
    const roster = new ExecutionRoster((value) => {
      released.push(value);
      value.release();
    });
    const primary = lane("x86_64-linux");
    const burst = lane("x86_64-linux");
    const primaryLease = lease("ci-1");
    const burstLease = lease("ci-2");
    roster.ensure("x86_64-linux");
    roster.addLane("x86_64-linux", primary, [], (id) => id);
    roster.addLane("x86_64-linux", burst, [], (id) => id);
    roster.addLease("x86_64-linux", primaryLease);
    roster.addLease("x86_64-linux", burstLease);

    expect(roster.cancel("x86_64-linux")).toBe(true);
    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(burst.close).toHaveBeenCalledTimes(1);
    expect(released).toEqual([primaryLease, burstLease]);
    expect(primaryLease.release).toHaveBeenCalledTimes(1);
    expect(burstLease.release).toHaveBeenCalledTimes(1);
    expect(roster.accepts("x86_64-linux")).toBe(false);
  });

  it("refuses resources that arrive after a mid-claim cancellation", () => {
    const roster = new ExecutionRoster(() => {});
    roster.ensure("x86_64-linux");
    roster.cancel("x86_64-linux");
    const lateLane = lane("x86_64-linux");

    roster.addLane("x86_64-linux", lateLane, [], (id) => id);

    expect(lateLane.close).toHaveBeenCalledTimes(1);
    expect(roster.addLease("x86_64-linux", lease("ci-1"))).toBe(false);
  });
});
