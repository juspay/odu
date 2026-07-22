/**
 * Venue lock held *inside* the odu-runner agent process.
 *
 * The coordinator never runs flock over raw ssh. It dials this agent via
 * surface-remote and calls `lease.claim` / `lease.probe` / `lease.release`.
 * Flock comes from odu-runner's Nix-wrapped PATH (`util-linux`), so builders
 * do not need a system-installed flock.
 *
 * Hold model: a child `flock -n -x <lock> -c '…; cat'` keeps the exclusive
 * lock while its stdin stays open. Release closes stdin (and kills the child);
 * agent process death drops the ssh pipe → child dies → flock frees. Same
 * crash/half-open semantics as the old bash-over-ssh design, without a
 * hand-rolled remote shell protocol.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { shellQuoteArg } from "@kolu/shell-quote";
import {
  DEFAULT_LEASE_LOCK,
  type LeaseHolder,
} from "../common/surface";

export function agentLeaseLockPath(override?: string): string {
  if (override !== undefined && override !== "") return override;
  const fromEnv = process.env.ODU_LEASE_LOCK;
  return fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : DEFAULT_LEASE_LOCK;
}

export function parseHolderBody(body: string): LeaseHolder | null {
  const line = body.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return null;
  const parts = line.split("|");
  if (parts.length >= 3) {
    const holder = parts[0] ?? "";
    const runRaw = parts[1] ?? "";
    const since = Number(parts[2]);
    if (holder === "" || !Number.isFinite(since)) return null;
    return {
      holder,
      run: runRaw === "" || runRaw === "-" ? null : runRaw,
      sinceMs: since,
    };
  }
  return { holder: line, run: null, sinceMs: Date.now() };
}

function readHolderFile(lockPath: string): LeaseHolder | null {
  const path = `${lockPath}.holder`;
  if (!existsSync(path)) return null;
  try {
    return parseHolderBody(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function flockMissingError(): string {
  return "flock(1) missing on agent PATH — odu-runner must ship util-linux";
}

/** Non-blocking probe; never holds. */
export function probeLocal(
  lockPath: string,
):
  | { state: "free"; heldBy: null }
  | { state: "busy"; heldBy: LeaseHolder | null }
  | { state: "error"; error: string } {
  const r = spawnSync("flock", ["-n", lockPath, "-c", "true"], {
    encoding: "utf8",
  });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { state: "error", error: flockMissingError() };
    }
    return { state: "error", error: r.error.message };
  }
  if (r.status === 0) {
    return { state: "free", heldBy: null };
  }
  return { state: "busy", heldBy: readHolderFile(lockPath) };
}

export interface LocalHold {
  release: () => void;
}

/**
 * Non-blocking claim. On success, keeps a child flock session until
 * `release()`. Concurrent second claim on this agent process is rejected by
 * the runner — one venue hold per runner process.
 */
export async function claimLocal(
  lockPath: string,
  identity: { holder: string; run: string | null },
  nowMs: number = Date.now(),
  settleTimeoutMs: number = 5_000,
): Promise<
  | { status: "held"; hold: LocalHold }
  | { status: "busy"; heldBy: LeaseHolder | null }
  | { status: "error"; error: string }
> {
  const holderFile = `${lockPath}.holder`;
  const run = identity.run ?? "-";
  const body = `${identity.holder}|${run}|${nowMs}`;
  // flock -c runs via the shell. Linear pipeline only (no if/then/do) —
  // write holder, announce READY, hold with cat, remove holder on exit.
  const cmd = [
    `printf '%s\\n' ${shellQuoteArg(body)} > ${shellQuoteArg(holderFile)}`,
    `printf 'READY\\n'`,
    `cat`,
    `rm -f ${shellQuoteArg(holderFile)}`,
  ].join(" && ");

  let child: ChildProcess;
  try {
    child = spawn("flock", ["-n", "-x", lockPath, "-c", cmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { status: "error", error: flockMissingError() };
    }
    return { status: "error", error: err.message ?? String(e) };
  }

  const settle = await settleClaimChild(child, settleTimeoutMs);
  if (settle.kind === "ready") {
    let released = false;
    return {
      status: "held",
      hold: {
        release: () => {
          if (released) return;
          released = true;
          try {
            child.stdin?.end();
          } catch {
            /* already closed */
          }
          setTimeout(() => {
            if (!child.killed) child.kill("SIGTERM");
          }, 500).unref?.();
          try {
            unlinkSync(holderFile);
          } catch {
            /* child may have removed it */
          }
        },
      },
    };
  }

  try {
    if (!child.killed) child.kill("SIGTERM");
  } catch {
    /* ignore */
  }

  if (settle.kind === "enoent") {
    return { status: "error", error: flockMissingError() };
  }
  if (settle.kind === "busy") {
    return { status: "busy", heldBy: readHolderFile(lockPath) };
  }
  if (settle.kind === "error") {
    return { status: "error", error: settle.message };
  }
  return {
    status: "error",
    error: "lease claim timed out waiting for flock hold",
  };
}

type Settle =
  | { kind: "ready" }
  | { kind: "busy" }
  | { kind: "enoent" }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

function settleClaimChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Settle> {
  return new Promise((resolve) => {
    let done = false;
    let stdout = "";
    const finish = (s: Settle): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };

    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (/\bREADY\b/.test(stdout)) finish({ kind: "ready" });
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") finish({ kind: "enoent" });
      else finish({ kind: "error", message: e.message });
    });

    child.on("close", (code) => {
      // flock -n failure exits non-zero without running -c (no READY).
      if (code === 0) {
        // Command finished without READY — treat as error.
        finish({
          kind: "error",
          message: "flock hold exited before READY",
        });
        return;
      }
      finish({ kind: "busy" });
    });
  });
}
