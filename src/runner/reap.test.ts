/**
 * Falsifiability for the group reaper — real child process groups, real
 * signals. The reaper is the one owner of "how does a recipe tree die", so
 * these pin the whole contract: TERM first, bounded grace, KILL survivors,
 * both async (`reap`) and on the synchronous process-exit sweep
 * (`reapAllSync`).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGroupReaper } from "./reap";

/** A TERM-ignoring group member: the shell shrugs off SIGTERM and respawns
 *  its sleep children, so only SIGKILL ends it. */
const STUBBORN = "trap '' TERM; while :; do sleep 0.05; done";

const spawnGroup = (script: string): ChildProcess =>
  spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("group reaper", () => {
  it("reaps a TERM-honoring group without needing the escalation", async () => {
    const reaper = createGroupReaper({ graceMs: 60_000 });
    const child = spawnGroup("sleep 30");
    const pid = child.pid as number;
    reaper.track(pid);
    reaper.reap(pid);
    // Dies on the SIGTERM itself — the far-away SIGKILL never has to fire.
    await until(() => !alive(pid));
  });

  it("escalates a TERM-ignoring group to SIGKILL after the grace", async () => {
    const reaper = createGroupReaper({ graceMs: 200 });
    const child = spawnGroup(STUBBORN);
    const pid = child.pid as number;
    reaper.track(pid);
    reaper.reap(pid);
    // Still alive right after: SIGTERM alone did not kill it (that survival
    // is exactly the production leak this module exists to close).
    expect(alive(pid)).toBe(true);
    await until(() => !alive(pid));
  });

  it("treats reap of an already-gone group as a no-op", async () => {
    const reaper = createGroupReaper({ graceMs: 200 });
    const child = spawnGroup("true");
    const pid = child.pid as number;
    reaper.track(pid);
    await until(() => !alive(pid));
    expect(() => reaper.reap(pid)).not.toThrow();
  });

  it("reapAllSync SIGKILLs TERM-ignoring survivors before returning", async () => {
    const reaper = createGroupReaper({ graceMs: 300 });
    const stubborn = spawnGroup(STUBBORN);
    const meek = spawnGroup("sleep 30");
    for (const child of [stubborn, meek]) {
      reaper.track(child.pid as number);
    }
    reaper.reapAllSync();
    // SIGKILL was delivered synchronously; the pids may linger a beat as
    // zombies until the event loop reaps them, then they are gone for good.
    await until(() => !alive(stubborn.pid as number));
    await until(() => !alive(meek.pid as number));
  });
});
