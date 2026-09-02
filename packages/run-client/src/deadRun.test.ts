/**
 * The dead-run read — a `.ci` that outlived its coordinator.
 *
 * The incident this module exists for: a run started through a HOSTED
 * `odu mcp` (the server is a child of a service, e.g. olai under systemd)
 * died when the host service was restarted — systemd kills the whole cgroup
 * on stop, the `detached` spawn flag is no protection against that, and the
 * run's residue (stale run lock, stale socket, an unfinalized reservation)
 * sat in `.ci` while every face answered as if no run had ever existed.
 *
 * A clean run takes its residue away when it goes: the lock's `release()`
 * unlinks the PID file, `serveOverUnixSocket`'s `close()` removes the socket,
 * and the reservation sentinel is overwritten by the finalized record. So
 * residue is news: a lock/socket file with NO live coordinator, or a
 * reservation that never became a record, is a run that was KILLED — and the
 * answer every face owes for it is "this run died", never silence.
 *
 * These tests build the residue the way a real kill leaves it where that
 * matters, and by hand where it doesn't.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { deadRun, describeDeadRun } from "./deadRun";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-dead-"));
  dirs.push(dir);
  return dir;
}

/** The reservation sentinel exactly as `reserveNextSeq` writes it. */
function reserveSentinel(root: string, sha7: string, seq: number): string {
  const dir = join(root, ".ci", sha7, "runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${seq}.json`);
  writeFileSync(path, `${JSON.stringify({ reserved: true, seq }, null, 2)}\n`);
  return path;
}

describe("deadRun", () => {
  it("answers null for a checkout with no .ci at all (the steady state)", async () => {
    expect(await deadRun(tmpCheckout())).toBeNull();
  });

  it("answers null for a clean post-run checkout: records finalized, residue gone", async () => {
    const root = tmpCheckout();
    // A finalized (NOT reserved) record: the sentinel was overwritten, the
    // lock and socket are gone — nothing died here.
    const dir = join(root, ".ci", "9be9c7c", "runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "1.json"),
      JSON.stringify({ seq: 1, outcome: "passed" }),
    );
    expect(await deadRun(root)).toBeNull();
  });

  it("names the run an unfinalized reservation belongs to", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.sha7).toBe("abc1234");
    expect(dead!.seq).toBe(1);
    expect(dead!.evidence.reservation).toBe(true);
    expect(dead!.lastActivityAt).not.toBeNull();
  });

  it("answers null while a run is LIVE: a serving lock-holder is not a corpse", async () => {
    const root = tmpCheckout();
    // This process is the "live coordinator": its own pid in the lock.
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.run.lock"), `${process.pid}\n`);
    reserveSentinel(root, "abc1234", 3);
    expect(await deadRun(root)).toBeNull();
  });

  it("reads a stale run lock (dead pid) as the kill it is, even with no reservation", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.run.lock"), "2147483646\n"); // a dead pid
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.evidence.lock).toBe(true);
    // Killed before it could stamp its identity: no sha the files can name.
    expect(dead!.sha7).toBe("");
    expect(dead!.seq).toBeNull();
  });

  it("reads a socket FILE nobody serves as the kill it is", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    // The disk shape a SIGKILLed coordinator leaves: the socket path exists
    // and nobody answers it. (An ORDERLY close removes the file, so this
    // state has only the one origin — a kill.) The file's contents are no
    // business of the answer: the dial is allowed to throw, and must not
    // take the corpse's answer down with it.
    writeFileSync(join(ci, "odu.sock"), "");
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.evidence.socket).toBe(true);
  });

  it("last sign of life comes from the run directory's own writes", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    // A node log the dead lane was mid-write on: newer than the sentinel.
    const logDir = join(root, ".ci", "abc1234", "x86_64-linux");
    mkdirSync(logDir, { recursive: true });
    const past = Date.now() - 60_000;
    const log = join(logDir, "ci::e2e.log");
    writeFileSync(log, "half a line of output\n");
    // Pin a known clock reading: utimes BOTH writes to the same past instant,
    // so the answer is exactly that instant and nothing clock-drifted.
    const { utimesSync } = await import("node:fs");
    utimesSync(
      join(root, ".ci", "abc1234", "runs", "1.json"),
      new Date(past),
      new Date(past),
    );
    utimesSync(log, new Date(past), new Date(past));
    const dead = await deadRun(root);
    expect(Math.floor(dead!.lastActivityAt!)).toBe(past);
  });
});

describe("describeDeadRun", () => {
  it("names the run and the admission", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    const dead = (await deadRun(root))!;
    const msg = describeDeadRun(dead);
    expect(msg).toContain("abc1234#1");
    expect(msg).toContain("died with the process that started it");
  });

  it("says what it can when no run directory names the commit", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.run.lock"), "2147483646\n");
    const dead = (await deadRun(root))!;
    const msg = describeDeadRun(dead);
    expect(msg).toContain("died with the process that started it");
    expect(msg).not.toContain("#null");
  });
});
