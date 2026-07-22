/**
 * Venue lease — one run per machine, lock held by the run process.
 *
 * The lock lives ON THE TARGET MACHINE (`flock` on a file there), held over one
 * long-lived ssh connection: the remote side grabs the lock and sits reading
 * heartbeat bytes; the holder ticks one byte every ~10s. Every way of letting
 * go looks the same to the machine — the heartbeats stop:
 *
 *   - normal finish → connection closes → lock frees instantly;
 *   - crash / SIGKILL → the OS closes the connection → lock frees in seconds;
 *   - half-open network → the remote read times out (~40s) → lock frees;
 *   - a live-but-forgotten holder → self-release backstop (~1h).
 *
 * Because the lock is on the machine, runs from different laptops/agents contend
 * correctly with no lock server, database, or daemon anywhere. Proven in kolu's
 * production pool sidecar (`.apm/skills/ci/pu/lease.sh`); moved into the run
 * process so the lease lifetime = run lifetime (juspay/odu#54).
 *
 * `localhost` is never leased — the checkout socket already serializes local
 * runs, and flock-over-ssh has nothing to dial.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { shellQuoteArg } from "@kolu/shell-quote";
import { isLocalHost, SSH_COMMON_OPTS } from "@kolu/surface-remote";
import { shortHost, type HostPool } from "./hosts";

/** Remote lock file (and adjacent `.holder` identity file). Override via
 *  `ODU_LEASE_LOCK` for tests / multi-tenant boxes that share a namespace. */
export function leaseLockPath(): string {
  const fromEnv = process.env.ODU_LEASE_LOCK;
  return fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : "/tmp/odu.lease";
}

const HEARTBEAT_S = Number(process.env.ODU_LEASE_HEARTBEAT ?? 10);
const TTL_S = Number(process.env.ODU_LEASE_TTL ?? 40);
const MAX_HOLD_S = Number(process.env.ODU_LEASE_MAX_HOLD ?? 3600);
const WAIT_POLL_MS = Number(process.env.ODU_LEASE_WAIT_POLL_MS ?? 5_000);
const CLAIM_TIMEOUT_MS = Number(process.env.ODU_LEASE_CLAIM_TIMEOUT_MS ?? 30_000);

export interface HolderInfo {
  /** Local identity of the process holding the lock (`user@hostname`). */
  holder: string;
  /** Run label when known (`sha7` or `sha7#seq`); null if not recorded. */
  run: string | null;
  /** Epoch ms when the holder acquired (for "held for 6m" rendering). */
  sinceMs: number;
}

export interface LeaseIdentity {
  holder: string;
  run: string | null;
}

export interface LeaseHandle {
  readonly host: string;
  /** Drop the hold — closes the ssh data channel so the remote flock frees. */
  release(): void;
}

/** Outcome of one non-blocking claim attempt against a *remote* host.
 *  Localhost is not a claim outcome — pure-local pools short-circuit in
 *  `acquireFromPool` / `probeHost` before any claim protocol runs. */
export type ClaimResult =
  | { kind: "held"; lease: LeaseHandle }
  | { kind: "busy"; heldBy: HolderInfo | null }
  | { kind: "unreachable"; error: string };

export interface ProbeResult {
  host: string;
  state: "free" | "busy" | "unreachable" | "local";
  heldBy: HolderInfo | null;
  error?: string;
}

/** Who *this* process is for holder identity — `user@short-hostname`. */
export function localHolderId(): string {
  const user = userInfo().username;
  const host = hostname().split(".")[0] ?? hostname();
  return `${user}@${host}`;
}

/** Compact duration for status lines (`45s`, `6m`, `2h`). */
export function formatHeldFor(sinceMs: number, nowMs = Date.now()): string {
  const sec = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export function formatHolder(info: HolderInfo, nowMs = Date.now()): string {
  const held = formatHeldFor(info.sinceMs, nowMs);
  if (info.run !== null && info.run !== "") {
    return `${info.holder} · ${info.run} · ${held}`;
  }
  return `${info.holder} · ${held}`;
}

/** Parse the remote holder file body (`holder|run|sinceMs` or legacy free text). */
export function parseHolderBody(body: string): HolderInfo | null {
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
  // Free-text fallback (older holders / manual files).
  return { holder: line, run: null, sinceMs: Date.now() };
}

/** Remote claim command (single ssh argv): non-blocking flock, write holder,
 *  wait on heartbeats from stdin. Quoting via `@kolu/shell-quote` (same leaf
 *  surface-remote uses for ssh remote argv). */
function claimRemoteScript(
  lock: string,
  identity: LeaseIdentity,
  nowMs: number,
): string {
  const holderFile = `${lock}.holder`;
  const run = identity.run ?? "-";
  const body = `${identity.holder}|${run}|${nowMs}`;
  // flock -n: busy → print BUSY + holder (if any) and exit 7.
  // On hold: write holder, print HELD, then read heartbeats until EOF/TTL/MAX.
  // stdin is ONLY the heartbeat channel (script is an ssh argv, not bash -s).
  return [
    `LOCK=${shellQuoteArg(lock)}`,
    `HOLDER=${shellQuoteArg(holderFile)}`,
    `BODY=${shellQuoteArg(body)}`,
    `TTL=${TTL_S}`,
    `MAX=${MAX_HOLD_S}`,
    `command -v flock >/dev/null 2>&1 || { echo 'NOFLOCK flock(1) missing on host'; exit 9; }`,
    `exec 9>"$LOCK" || { echo 'ERR cannot open lock'; exit 8; }`,
    `if ! flock -n 9; then`,
    `  echo BUSY`,
    `  if [ -f "$HOLDER" ]; then cat "$HOLDER"; fi`,
    `  exit 7`,
    `fi`,
    `printf '%s\\n' "$BODY" >"$HOLDER"`,
    `echo HELD`,
    `start=$(date +%s)`,
    `while true; do`,
    `  if ! read -t "$TTL" -r _; then break; fi`,
    `  now=$(date +%s)`,
    `  if [ $((now - start)) -ge "$MAX" ]; then break; fi`,
    `done`,
    `rm -f "$HOLDER"`,
  ].join("; ");
}

/** Remote probe command: non-blocking flock test + holder dump. */
function probeRemoteScript(lock: string): string {
  const holderFile = `${lock}.holder`;
  return [
    `LOCK=${shellQuoteArg(lock)}`,
    `HOLDER=${shellQuoteArg(holderFile)}`,
    `command -v flock >/dev/null 2>&1 || { echo 'NOFLOCK'; exit 9; }`,
    `if flock -n "$LOCK" -c true 2>/dev/null; then echo FREE`,
    `else echo BUSY; if [ -f "$HOLDER" ]; then cat "$HOLDER"; fi; fi`,
  ].join("; ");
}

export interface DialResult {
  /** Combined stdout (and useful stderr lines if the remote printed there). */
  stdout: string;
  /** Process exit code, or null if killed/timeout without a code. */
  code: number | null;
  /** For claim holds: the live child + a way to feed heartbeats / release. */
  hold?: {
    child: ChildProcess;
    writeHeartbeat: () => void;
    release: () => void;
  };
}

/**
 * Low-level ssh dial. `mode: "claim"` keeps the connection open for the hold
 * (stdin is the heartbeat channel); `mode: "probe"` runs to completion.
 * Injected in unit tests so we never hit a real network. Production default
 * splits transport spawn from claim-protocol settle / hold lifecycle.
 */
export type DialFn = (
  host: string,
  script: string,
  mode: "claim" | "probe",
) => Promise<DialResult>;

/** Transport only: spawn ssh with the shared dead-peer policy. */
function spawnSsh(host: string, script: string): ChildProcess {
  // Remote command is an ssh argv (not bash -s): stdin stays free for
  // claim-mode heartbeats, matching kolu's lease.sh data-channel pattern.
  // Dead-peer / BatchMode policy is the shared surface-remote receptacle —
  // not hand-rolled here (and not tied to ODU_LEASE_HEARTBEAT: that tick is
  // only for flock stdin + remote TTL, not ssh ServerAlive).
  return spawn("ssh", [...SSH_COMMON_OPTS, host, script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function attachCollectors(child: ChildProcess): {
  getStdout: () => string;
  getCombined: () => string;
} {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    getStdout: () => stdout,
    getCombined: () =>
      stdout + (stderr.trim() !== "" ? `\n${stderr}` : ""),
  };
}

/** Probe path: run remote script to completion (stdin closed). */
function dialProbe(host: string, script: string): Promise<DialResult> {
  return new Promise((resolve) => {
    const child = spawnSsh(host, script);
    const { getCombined } = attachCollectors(child);
    child.stdin?.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLAIM_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: getCombined(), code });
    });
  });
}

/**
 * Claim path: settle once HELD/BUSY/error appears; on HELD keep the child
 * as a hold session (stdin heartbeats + release). Protocol settle and hold
 * lifecycle live here — not in the transport spawn.
 */
function dialClaim(host: string, script: string): Promise<DialResult> {
  return new Promise((resolve) => {
    const child = spawnSsh(host, script);
    const { getStdout, getCombined } = attachCollectors(child);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        stdout: getStdout(),
        code: null,
      });
    }, CLAIM_TIMEOUT_MS);

    const trySettle = (): void => {
      if (settled) return;
      const stdout = getStdout();
      if (
        /\bHELD\b/.test(stdout) ||
        /\bBUSY\b/.test(stdout) ||
        /\bNOFLOCK\b/.test(stdout) ||
        /\bERR\b/.test(stdout)
      ) {
        settled = true;
        clearTimeout(timer);
        if (/\bHELD\b/.test(stdout)) {
          const hb = setInterval(() => {
            try {
              child.stdin?.write("\n");
            } catch {
              // ignore — release/close will end the interval
            }
          }, HEARTBEAT_S * 1000);
          hb.unref?.();
          resolve({
            stdout,
            code: 0,
            hold: {
              child,
              writeHeartbeat: () => {
                try {
                  child.stdin?.write("\n");
                } catch {
                  /* ignore */
                }
              },
              release: () => {
                clearInterval(hb);
                try {
                  child.stdin?.end();
                } catch {
                  /* ignore */
                }
                // Give the remote a moment to see EOF; then ensure death.
                setTimeout(() => {
                  if (!child.killed) child.kill("SIGTERM");
                }, 500).unref?.();
              },
            },
          });
        } else {
          child.kill("SIGTERM");
          resolve({ stdout, code: 7 });
        }
      }
    };

    child.stdout?.on("data", () => trySettle());
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: getCombined(),
        code,
      });
    });
  });
}

const defaultDial: DialFn = (host, script, mode) =>
  mode === "probe" ? dialProbe(host, script) : dialClaim(host, script);

function parseBusyHolder(stdout: string): HolderInfo | null {
  // After the BUSY line, the holder body (if any).
  const lines = stdout.split(/\r?\n/);
  const busyIdx = lines.findIndex((l) => l.trim() === "BUSY");
  if (busyIdx < 0) return null;
  const rest = lines
    .slice(busyIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l !== "" && l !== "BUSY" && l !== "HELD")
    .join("\n");
  return parseHolderBody(rest);
}

/** Try to claim one remote host. Callers must not pass localhost — pure-local
 *  pools are gated in `acquireFromPool` before claim. */
export async function tryClaim(
  host: string,
  identity: LeaseIdentity,
  dial: DialFn = defaultDial,
  nowMs: number = Date.now(),
): Promise<ClaimResult> {
  if (isLocalHost(host)) {
    throw new Error(
      `odu: tryClaim called on localhost (${host}) — pure-local pools short-circuit in acquireFromPool`,
    );
  }

  const script = claimRemoteScript(leaseLockPath(), identity, nowMs);
  let result: DialResult;
  try {
    result = await dial(host, script, "claim");
  } catch (e) {
    return {
      kind: "unreachable",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (/\bHELD\b/.test(result.stdout) && result.hold !== undefined) {
    const hold = result.hold;
    return {
      kind: "held",
      lease: {
        host,
        release: () => hold.release(),
      },
    };
  }
  if (/\bBUSY\b/.test(result.stdout)) {
    return { kind: "busy", heldBy: parseBusyHolder(result.stdout) };
  }
  if (/\bNOFLOCK\b/.test(result.stdout)) {
    return {
      kind: "unreachable",
      error: `flock(1) missing on ${host} — install util-linux flock on the builder`,
    };
  }
  const detail = result.stdout.trim() || `exit ${result.code ?? "?"}`;
  return {
    kind: "unreachable",
    error: `could not lease ${host}: ${detail}`,
  };
}

/** Probe one host without holding. */
export async function probeHost(
  host: string,
  dial: DialFn = defaultDial,
): Promise<ProbeResult> {
  if (isLocalHost(host)) {
    return { host, state: "local", heldBy: null };
  }
  const script = probeRemoteScript(leaseLockPath());
  let result: DialResult;
  try {
    result = await dial(host, script, "probe");
  } catch (e) {
    return {
      host,
      state: "unreachable",
      heldBy: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (/\bFREE\b/.test(result.stdout)) {
    return { host, state: "free", heldBy: null };
  }
  if (/\bBUSY\b/.test(result.stdout)) {
    return {
      host,
      state: "busy",
      heldBy: parseBusyHolder(result.stdout),
    };
  }
  if (/\bNOFLOCK\b/.test(result.stdout)) {
    return {
      host,
      state: "unreachable",
      heldBy: null,
      error: `flock(1) missing on ${host}`,
    };
  }
  return {
    host,
    state: "unreachable",
    heldBy: null,
    error: result.stdout.trim() || `exit ${result.code ?? "?"}`,
  };
}

export interface AcquireFromPoolOpts {
  platform: string;
  pool: HostPool;
  identity: LeaseIdentity;
  /** Fail immediately when every candidate is busy (default: wait in line). */
  noWait: boolean;
  onLine?: (msg: string) => void;
  /** Injected claim — tests supply a fake; production uses `tryClaim`. */
  claim?: (
    host: string,
    identity: LeaseIdentity,
  ) => Promise<ClaimResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Rotate the scan start to reduce stampede on slot 0. */
  rotateBy?: number;
}

export interface AcquiredLane {
  host: string;
  /** Null for localhost (no remote lock). */
  lease: LeaseHandle | null;
}

function rotatePool(pool: HostPool, by: number): string[] {
  if (pool.length === 0) return [];
  const offset = ((by % pool.length) + pool.length) % pool.length;
  return [...pool.slice(offset), ...pool.slice(0, offset)];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Pick a free machine from the platform's pool, lock it, and return the hold.
 * Scans the pool (rotated) until one claim succeeds; when every reachable host
 * is busy, waits and retries — unless `noWait`, which fails immediately.
 * Unreachable hosts are skipped (reported) but never block the wait forever if
 * at least one host was merely busy; if *every* host is unreachable, fail loud.
 */
export async function acquireFromPool(
  opts: AcquireFromPoolOpts,
): Promise<AcquiredLane> {
  const {
    platform,
    pool,
    identity,
    noWait,
    onLine,
    claim = (h, id) => tryClaim(h, id),
    sleep = defaultSleep,
    now = Date.now,
    rotateBy = now(),
  } = opts;

  if (pool.length === 0) {
    throw new Error(
      `odu: empty host pool for ${platform} — configure at least one host`,
    );
  }

  // Pure-local pool (after hosts.parsePool: never mixed with remotes): no
  // remote lock, no claim protocol. Sole localhost is the common case.
  if (pool.every((h) => isLocalHost(h))) {
    const host = pool[0]!;
    onLine?.(`${platform}: picked ${shortHost(host)} (localhost)`);
    return { host, lease: null };
  }

  let waited = false;
  for (;;) {
    const order = rotatePool(pool, rotateBy);
    const busy: { host: string; heldBy: HolderInfo | null }[] = [];
    const unreachable: { host: string; error: string }[] = [];

    for (const host of order) {
      const result = await claim(host, identity);
      if (result.kind === "held") {
        const busyNote =
          busy.length > 0
            ? `   (${busy.map((b) => shortHost(b.host)).join(", ")} busy)`
            : "";
        onLine?.(
          `${platform}: picked ${shortHost(host)}${busyNote}`,
        );
        return { host, lease: result.lease };
      }
      if (result.kind === "busy") {
        busy.push({ host, heldBy: result.heldBy });
        continue;
      }
      unreachable.push({ host, error: result.error });
    }

    // Full scan done with no claim.
    if (busy.length === 0) {
      // Nothing was merely busy — every candidate failed hard.
      const detail = unreachable
        .map((u) => `${shortHost(u.host)}: ${u.error}`)
        .join("; ");
      throw new Error(
        `odu: no reachable host in ${platform} pool` +
          (detail !== "" ? ` (${detail})` : ""),
      );
    }

    const busyDesc = busy
      .map((b) => {
        const who =
          b.heldBy !== null ? formatHolder(b.heldBy, now()) : "busy";
        return `${shortHost(b.host)} (${who})`;
      })
      .join(", ");

    if (noWait) {
      throw new Error(
        `odu: every host for ${platform} is busy — ${busyDesc}` +
          " (pass without --no-wait to wait in line)",
      );
    }

    if (!waited) {
      onLine?.(
        `${platform}: waiting — ${busyDesc}` +
          (unreachable.length > 0
            ? `; ${unreachable.map((u) => shortHost(u.host)).join(", ")} unreachable`
            : ""),
      );
      waited = true;
    } else {
      onLine?.(`${platform}: still waiting — ${busyDesc}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

export interface LeaseLanesOpts {
  pools: Record<string, HostPool>;
  /** Platforms that actually have tasks this run (others are not leased). */
  platforms: readonly string[];
  identity: LeaseIdentity;
  noWait: boolean;
  onLine?: (msg: string) => void;
  claim?: AcquireFromPoolOpts["claim"];
  sleep?: AcquireFromPoolOpts["sleep"];
  now?: AcquireFromPoolOpts["now"];
}

export interface LeasedLanes {
  /** Final platform → single host map for the run. */
  lanes: Record<string, string>;
  leases: LeaseHandle[];
}

/** Lease one host per platform that participates in the run. */
export async function leaseLanes(opts: LeaseLanesOpts): Promise<LeasedLanes> {
  const lanes: Record<string, string> = {};
  const leases: LeaseHandle[] = [];
  try {
    for (const platform of [...opts.platforms].sort()) {
      const pool = opts.pools[platform];
      if (pool === undefined) {
        throw new Error(`odu: internal: no pool for platform ${platform}`);
      }
      const acquired = await acquireFromPool({
        platform,
        pool,
        identity: opts.identity,
        noWait: opts.noWait,
        onLine: opts.onLine,
        claim: opts.claim,
        sleep: opts.sleep,
        now: opts.now,
      });
      lanes[platform] = acquired.host;
      if (acquired.lease !== null) leases.push(acquired.lease);
    }
  } catch (e) {
    for (const lease of leases) lease.release();
    throw e;
  }
  return { lanes, leases };
}

/** Probe every host in the config for `odu hosts`. */
export async function probeAllHosts(
  pools: Record<string, HostPool>,
  dial: DialFn = defaultDial,
): Promise<{ platform: string; probe: ProbeResult }[]> {
  const out: { platform: string; probe: ProbeResult }[] = [];
  const platforms = Object.keys(pools).sort();
  await Promise.all(
    platforms.flatMap((platform) =>
      (pools[platform] ?? []).map(async (host) => {
        const probe = await probeHost(host, dial);
        out.push({ platform, probe });
      }),
    ),
  );
  // Stable order: platform, then host as declared.
  out.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    return a.probe.host.localeCompare(b.probe.host);
  });
  return out;
}
