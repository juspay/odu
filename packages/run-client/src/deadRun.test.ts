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
import { utimesSync } from "node:fs";
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

  it("names the run an unfinalized reservation belongs to — the reservation NAMES the corpse, it never proves one", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    // …by itself, a leftover sentinel is the STEADY STATE after a
    // replacement run reclaimed the residue (see the next test) — the
    // incident residue is a lock and/or socket with nobody live.
    expect(await deadRun(root)).toBeNull();
    // …with the kill's actual residue present, the sentinel names the answer:
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.sha7).toBe("abc1234");
    expect(dead!.seq).toBe(1);
    expect(dead!.evidence.reservation).toBe(true);
    expect(dead!.lastActivityAt).not.toBeNull();
  });

  it("a recovered checkout is the steady state: the tombstone stays, the corpse answer does not", async () => {
    const root = tmpCheckout();
    // The kill: residue of seq 1 with nobody answering.
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    writeFileSync(join(root, ".ci", "odu.sock"), "");
    // The recovery this PR ships: a replacement run reclaims lock + socket
    // (no supersede), reserves the NEXT ordinal, settles, finalizes it — and
    // a clean exit takes BOTH files away again (the lock's release(), the
    // serving side's close()).
    rmSync(join(root, ".ci", "odu.run.lock"), { force: true });
    rmSync(join(root, ".ci", "odu.sock"), { force: true });
    const runsDir = join(root, ".ci", "abc1234", "runs");
    writeFileSync(
      join(runsDir, "2.json"),
      JSON.stringify({ seq: 2, outcome: "passed" }),
    );
    // Seq 1's tombstone sentinel is STILL on disk — by design. It must
    // never again read as a current corpse: wait/rerun/runs facing THIS
    // state would otherwise answer "the run is not coming back" forever
    // about a checkout whose current run already settled.
    expect(await deadRun(root)).toBeNull();
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

  it("last sign of life is the dead run's OWN artifacts — never the shared `.ci/<sha7>` tree's later writes", async () => {
    const root = tmpCheckout();
    const past = Date.now() - 60_000;
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    // Pin the residue to a known clock: the sentinel, the lock, and seq 1's
    // MCP-server tee (`.ci/<sha7>/runs/1.log` — per-run, unlike the
    // commit-addressed node logs).
    for (const p of [
      join(root, ".ci", "abc1234", "runs", "1.json"),
      join(root, ".ci", "odu.run.lock"),
    ]) {
      utimesSync(p, new Date(past), new Date(past));
    }
    // …and now the LATER writes: a dirty-tree re-run of the SAME commit is
    // seq 2 — its finalized record and its node logs land in the SAME
    // `.ci/abc1234/` tree, with NOW's mtimes. The corpse is still named
    // (the lock is still dead) — the answer must NOT timestamp seq 1's
    // death with seq 2's life.
    const logDir = join(root, ".ci", "abc1234", "x86_64-linux");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "ci::e2e.log"), "the re-run's fresher output\n");
    writeFileSync(
      join(root, ".ci", "abc1234", "runs", "2.json"),
      JSON.stringify({ seq: 2, outcome: "passed" }),
    );
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(Math.floor(dead!.lastActivityAt!)).toBe(past);
  });

  it("last sign of life includes the run's own per-seq tee (runs/<seq>.log), when the launcher kept one", async () => {
    const root = tmpCheckout();
    const past = Date.now() - 60_000;
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    // The answer is the residue's newest stamp — here, the tee's. (The LOCK
    // is pinned older too, or its just-written mtime would win instead.)
    writeFileSync(join(root, ".ci", "abc1234", "runs", "1.log"), "tee\n");
    utimesSync(
      join(root, ".ci", "abc1234", "runs", "1.log"),
      new Date(past),
      new Date(past),
    );
    for (const p of [
      join(root, ".ci", "abc1234", "runs", "1.json"),
      join(root, ".ci", "odu.run.lock"),
    ]) {
      utimesSync(p, new Date(past - 10_000), new Date(past - 10_000));
    }
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(Math.floor(dead!.lastActivityAt!)).toBe(past);
  });

  it("a foreign process at the lock's PID vetoes the death — EPERM means a process EXISTS, never that the holder died", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    // PID 1 is init/launchd: ESRCH on no OS, EPERM for any test runner that
    // is not root, LIVE if it somehow is root — every one of those must veto
    // a death; none may answer a corpse.
    writeFileSync(join(ci, "odu.run.lock"), "1\n");
    expect(await deadRun(root)).toBeNull();
  });
});

describe("describeDeadRun", () => {
  it("names the run and the admission", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
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
