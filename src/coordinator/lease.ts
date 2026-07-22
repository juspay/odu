/**
 * Venue lease — one run per machine, lock held for the run lifetime.
 *
 * The lock lives ON THE TARGET MACHINE (`flock` on a file there), but the
 * coordinator never runs flock over raw ssh. It dials **odu-runner** via
 * `@kolu/surface-remote` (`makeSession` + `sshConnector`) and calls the
 * lane surface's `lease.claim` / `lease.probe` / `lease.release` procedures.
 * Flock is a Nix runtime dep of odu-runner (util-linux on PATH); the agent
 * process holds the lock; agent death frees it.
 *
 *   - normal finish → lease.release + session.destroy → flock frees;
 *   - crash / SIGKILL → ssh drops → agent dies → flock frees;
 *   - half-open network → session liveness fails → lost fires → shutdown.
 *
 * `localhost` is never leased — the checkout socket already serializes local
 * runs, and there is no remote agent to dial for the lock.
 */

import { hostname, userInfo } from "node:os";
import {
  type AgentClient,
  isLocalHost,
  makeSession,
  type SessionState,
  sshConnector,
  type SshProv,
} from "@kolu/surface-remote";
import {
  DEFAULT_LEASE_LOCK,
  laneSurface,
  type LeaseHolder,
} from "../common/surface";
import { shortHost, type HostPool } from "./hosts";

export type HolderInfo = LeaseHolder;

export function leaseLockPath(): string {
  const fromEnv = process.env.ODU_LEASE_LOCK;
  return fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : DEFAULT_LEASE_LOCK;
}

/**
 * Parse a non-negative env override. Empty / non-finite / below `min` fall back
 * — `Number("")` is 0 and would busy-loop `setInterval` if taken as a real value.
 */
function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const WAIT_POLL_MS = envNumber("ODU_LEASE_WAIT_POLL_MS", 5_000, 1);
/** Bound for pin + claim RPC (includes cold nix copy of odu-runner). */
const CLAIM_TIMEOUT_MS = envNumber("ODU_LEASE_CLAIM_TIMEOUT_MS", 180_000, 1);

export interface LeaseIdentity {
  holder: string;
  run: string | null;
}

export interface LeaseHandle {
  readonly host: string;
  /** Drop the hold — release RPC + destroy the agent session. */
  release(): void;
  /**
   * Resolves when the agent session ends *without* an intentional `release()`
   * (ssh drop, agent crash, remote kill). Callers must treat this as loss of
   * exclusivity. Optional so test fakes can omit it.
   */
  readonly lost?: Promise<void>;
}

/** Outcome of one non-blocking claim attempt against a *remote* host. */
export type ClaimResult =
  | { kind: "held"; lease: LeaseHandle }
  | { kind: "busy"; heldBy: HolderInfo | null }
  | { kind: "unreachable"; error: string };

export type ProbeResult =
  | { host: string; state: "free"; heldBy: null }
  | { host: string; state: "busy"; heldBy: HolderInfo | null }
  | { host: string; state: "local"; heldBy: null }
  | { host: string; state: "unreachable"; heldBy: null; error: string };

/** Who *this* process is for holder identity — `user@short-hostname`. */
export function localHolderId(): string {
  const user = userInfo().username;
  const host = hostname().split(".")[0] ?? hostname();
  return `${user}@${host}`;
}

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

/** Parse holder file body (shared with agent; kept for tests / formatting). */
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
  return { holder: line, run: null, sinceMs: Date.now() };
}

export type LaneAgentClient = AgentClient<typeof laneSurface.contract>;

/** How the coordinator resolves odu-runner for a host (nix eval + platform). */
export type ResolveRunnerDrv = () => Promise<string>;

export interface AgentDialOpts {
  resolveDrvPath: ResolveRunnerDrv;
  onLog?: (line: string) => void;
  /** Bound for session pin + claim/probe RPC (default CLAIM_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Optional lock path override (tests / multi-tenant). */
  lockPath?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`odu: ${label} timed out after ${ms}ms`));
    }, ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Dial odu-runner on `host` via surface-remote, claim the venue lock, keep
 * the agent session for the hold lifetime.
 */
export async function tryClaim(
  host: string,
  identity: LeaseIdentity,
  opts: AgentDialOpts,
): Promise<ClaimResult> {
  if (isLocalHost(host)) {
    throw new Error(
      `odu: tryClaim called on localhost (${host}) — pure-local pools short-circuit in acquireFromPool`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? CLAIM_TIMEOUT_MS;
  const session = makeSession<LaneAgentClient, SshProv>({
    connectOnce: sshConnector<typeof laneSurface.contract>({
      host,
      binary: "odu-runner",
      resolveDrvPath: opts.resolveDrvPath,
    }),
    initialConnection: "probing",
    label: `lease:${shortHost(host)}`,
    onLog: opts.onLog,
  });

  let intentionalRelease = false;

  try {
    const client = await withTimeout(
      session.pin(),
      timeoutMs,
      `lease pin ${shortHost(host)}`,
    );

    const result = await withTimeout(
      client.surface.lease.claim({
        holder: identity.holder,
        run: identity.run,
        lockPath: opts.lockPath,
      }),
      timeoutMs,
      `lease claim ${shortHost(host)}`,
    );

    if (result.status === "busy") {
      session.destroy();
      return { kind: "busy", heldBy: result.heldBy };
    }
    if (result.status === "error") {
      session.destroy();
      return { kind: "unreachable", error: result.error };
    }

    // Held — keep session; mark connected so the connect watchdog stands down.
    session.markConnected();

    const lost = new Promise<void>((resolveLost) => {
      session.onState((state: SessionState<SshProv>) => {
        if (intentionalRelease) return;
        if (state.phase === "disconnected" || state.phase === "failed") {
          resolveLost();
        }
      });
    });

    return {
      kind: "held",
      lease: {
        host,
        release: () => {
          intentionalRelease = true;
          void client.surface.lease.release({}).catch(() => {
            /* session may already be dead */
          });
          session.destroy();
        },
        lost,
      },
    };
  } catch (e) {
    intentionalRelease = true;
    session.destroy();
    return {
      kind: "unreachable",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Probe one host without holding — short-lived agent session. */
export async function probeHost(
  host: string,
  opts: AgentDialOpts,
): Promise<ProbeResult> {
  if (isLocalHost(host)) {
    return { host, state: "local", heldBy: null };
  }

  const timeoutMs = opts.timeoutMs ?? CLAIM_TIMEOUT_MS;
  const session = makeSession<LaneAgentClient, SshProv>({
    connectOnce: sshConnector<typeof laneSurface.contract>({
      host,
      binary: "odu-runner",
      resolveDrvPath: opts.resolveDrvPath,
    }),
    initialConnection: "probing",
    label: `lease-probe:${shortHost(host)}`,
    onLog: opts.onLog,
  });

  try {
    const client = await withTimeout(
      session.pin(),
      timeoutMs,
      `lease probe pin ${shortHost(host)}`,
    );
    session.markConnected();
    const result = await withTimeout(
      client.surface.lease.probe({ lockPath: opts.lockPath }),
      timeoutMs,
      `lease probe ${shortHost(host)}`,
    );
    session.destroy();
    if (result.state === "free") {
      return { host, state: "free", heldBy: null };
    }
    if (result.state === "busy") {
      return { host, state: "busy", heldBy: result.heldBy };
    }
    return {
      host,
      state: "unreachable",
      heldBy: null,
      error: result.error,
    };
  } catch (e) {
    session.destroy();
    return {
      host,
      state: "unreachable",
      heldBy: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface AcquireFromPoolOpts {
  platform: string;
  pool: HostPool;
  identity: LeaseIdentity;
  noWait: boolean;
  onLine?: (msg: string) => void;
  /** Injected claim — tests supply a fake; production uses `tryClaim`. */
  claim?: (
    host: string,
    identity: LeaseIdentity,
  ) => Promise<ClaimResult>;
  /** Production: resolve odu-runner drv for this platform (passed to tryClaim). */
  resolveDrvPath?: ResolveRunnerDrv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rotateBy?: number;
}

export interface AcquiredLane {
  host: string;
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

type ScanOnce =
  | { status: "ok"; host: string; lease: LeaseHandle | null }
  | {
      status: "busy";
      busy: { host: string; heldBy: HolderInfo | null }[];
      unreachable: { host: string; error: string }[];
    }
  | {
      status: "unreachable";
      unreachable: { host: string; error: string }[];
    };

function formatBusyDesc(
  busy: { host: string; heldBy: HolderInfo | null }[],
  nowMs: number,
): string {
  return busy
    .map((b) => {
      const who =
        b.heldBy !== null ? formatHolder(b.heldBy, nowMs) : "busy";
      return `${shortHost(b.host)} (${who})`;
    })
    .join(", ");
}

function unreachableError(
  platform: string,
  unreachable: { host: string; error: string }[],
): Error {
  const detail = unreachable
    .map((u) => `${shortHost(u.host)}: ${u.error}`)
    .join("; ");
  return new Error(
    `odu: no reachable host in ${platform} pool` +
      (detail !== "" ? ` (${detail})` : ""),
  );
}

function busyError(
  platform: string,
  busy: { host: string; heldBy: HolderInfo | null }[],
  nowMs: number,
): Error {
  return new Error(
    `odu: every host for ${platform} is busy — ${formatBusyDesc(busy, nowMs)}` +
      " (pass without --no-wait to wait in line)",
  );
}

function waitLineNote(
  busy: { host: string; heldBy: HolderInfo | null }[],
  unreachable: { host: string; error: string }[],
  nowMs: number,
  still: boolean,
): string {
  const busyDesc = formatBusyDesc(busy, nowMs);
  const unreach =
    unreachable.length > 0
      ? `; ${unreachable.map((u) => shortHost(u.host)).join(", ")} unreachable`
      : "";
  return still
    ? `still waiting — ${busyDesc}`
    : `waiting — ${busyDesc}${unreach}`;
}

function releaseAll(leases: readonly LeaseHandle[]): void {
  for (const lease of leases) lease.release();
}

async function scanPoolOnce(opts: {
  platform: string;
  pool: HostPool;
  identity: LeaseIdentity;
  onLine?: (msg: string) => void;
  claim: (
    host: string,
    identity: LeaseIdentity,
  ) => Promise<ClaimResult>;
  rotateBy: number;
}): Promise<ScanOnce> {
  const { platform, pool, identity, onLine, claim, rotateBy } = opts;

  if (pool.length === 0) {
    throw new Error(
      `odu: empty host pool for ${platform} — configure at least one host`,
    );
  }

  if (pool.every((h) => isLocalHost(h))) {
    const host = pool[0]!;
    onLine?.(`${platform}: picked ${shortHost(host)} (localhost)`);
    return { status: "ok", host, lease: null };
  }

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
      return { status: "ok", host, lease: result.lease };
    }
    if (result.kind === "busy") {
      busy.push({ host, heldBy: result.heldBy });
      continue;
    }
    unreachable.push({ host, error: result.error });
  }

  if (busy.length === 0) {
    return { status: "unreachable", unreachable };
  }
  return { status: "busy", busy, unreachable };
}

/**
 * Pick a free machine from the platform's pool, lock it, and return the hold.
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
    sleep = defaultSleep,
    now = Date.now,
    rotateBy = now(),
  } = opts;

  const claim =
    opts.claim ??
    ((h, id) => {
      if (opts.resolveDrvPath === undefined) {
        return Promise.reject(
          new Error(
            "odu: acquireFromPool needs resolveDrvPath or an injected claim",
          ),
        );
      }
      return tryClaim(h, id, {
        resolveDrvPath: opts.resolveDrvPath,
        onLog: onLine,
      });
    });

  let waited = false;
  for (;;) {
    const scan = await scanPoolOnce({
      platform,
      pool,
      identity,
      onLine,
      claim,
      rotateBy,
    });
    if (scan.status === "ok") {
      return { host: scan.host, lease: scan.lease };
    }
    if (scan.status === "unreachable") {
      throw unreachableError(platform, scan.unreachable);
    }

    if (noWait) {
      throw busyError(platform, scan.busy, now());
    }

    onLine?.(
      `${platform}: ${waitLineNote(scan.busy, scan.unreachable, now(), waited)}`,
    );
    waited = true;
    await sleep(WAIT_POLL_MS);
  }
}

export interface LeaseLanesOpts {
  pools: Record<string, HostPool>;
  platforms: readonly string[];
  identity: LeaseIdentity;
  noWait: boolean;
  onLine?: (msg: string) => void;
  claim?: AcquireFromPoolOpts["claim"];
  /**
   * Resolve odu-runner drv for a platform (used when `claim` is not
   * injected). Required for production multi-platform lease.
   */
  resolveDrvPath?: (platform: string) => ResolveRunnerDrv;
  sleep?: AcquireFromPoolOpts["sleep"];
  now?: AcquireFromPoolOpts["now"];
}

export interface LeasedLanes {
  lanes: Record<string, string>;
  leases: LeaseHandle[];
}

function venueHostKey(host: string): string {
  return shortHost(host.trim()).toLowerCase();
}

function assertNoSharedRemoteHosts(
  pools: Record<string, HostPool>,
  platforms: readonly string[],
): void {
  const owner = new Map<string, string>();
  for (const platform of platforms) {
    for (const host of pools[platform] ?? []) {
      if (isLocalHost(host)) continue;
      const key = venueHostKey(host);
      if (key === "") continue;
      const prev = owner.get(key);
      if (prev !== undefined && prev !== platform) {
        throw new Error(
          `odu: host ${shortHost(host)} is listed for both ${prev} and ${platform} — ` +
            "venue lock is per-machine, so a multi-platform run cannot claim " +
            "the same builder twice (split the pools or run one platform at a time)",
        );
      }
      owner.set(key, platform);
    }
  }
}

/**
 * Lease one host per platform that participates in the run.
 * Multi-platform is all-or-nothing (release partial holds while waiting).
 */
export async function leaseLanes(opts: LeaseLanesOpts): Promise<LeasedLanes> {
  const platforms = [...opts.platforms].sort();
  assertNoSharedRemoteHosts(opts.pools, platforms);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const rotateBy = now();
  let waited = false;

  const claimFor = (
    platform: string,
  ): ((host: string, identity: LeaseIdentity) => Promise<ClaimResult>) => {
    if (opts.claim !== undefined) return opts.claim;
    const resolve = opts.resolveDrvPath?.(platform);
    if (resolve === undefined) {
      return async () => ({
        kind: "unreachable",
        error:
          "odu: leaseLanes needs resolveDrvPath(platform) or an injected claim",
      });
    }
    return (h, id) =>
      tryClaim(h, id, {
        resolveDrvPath: resolve,
        onLog: opts.onLine,
      });
  };

  for (;;) {
    const lanes: Record<string, string> = {};
    const leases: LeaseHandle[] = [];
    let blocked:
      | {
          platform: string;
          busy: { host: string; heldBy: HolderInfo | null }[];
          unreachable: { host: string; error: string }[];
        }
      | null = null;
    let hardFail: Error | null = null;

    try {
      for (const platform of platforms) {
        const pool = opts.pools[platform];
        if (pool === undefined) {
          throw new Error(`odu: internal: no pool for platform ${platform}`);
        }
        const scan = await scanPoolOnce({
          platform,
          pool,
          identity: opts.identity,
          onLine: opts.onLine,
          claim: claimFor(platform),
          rotateBy,
        });
        if (scan.status === "ok") {
          lanes[platform] = scan.host;
          if (scan.lease !== null) leases.push(scan.lease);
          continue;
        }
        if (scan.status === "unreachable") {
          hardFail = unreachableError(platform, scan.unreachable);
          break;
        }
        blocked = {
          platform,
          busy: scan.busy,
          unreachable: scan.unreachable,
        };
        break;
      }
    } catch (e) {
      releaseAll(leases);
      throw e;
    }

    if (hardFail !== null) {
      releaseAll(leases);
      throw hardFail;
    }

    if (blocked === null) {
      return { lanes, leases };
    }

    releaseAll(leases);

    if (opts.noWait) {
      throw busyError(blocked.platform, blocked.busy, now());
    }

    const note = waitLineNote(
      blocked.busy,
      blocked.unreachable,
      now(),
      waited,
    );
    const multi =
      !waited && platforms.length > 1
        ? " (releasing other platforms until the full set is free)"
        : "";
    opts.onLine?.(`${blocked.platform}: ${note}${multi}`);
    waited = true;
    await sleep(WAIT_POLL_MS);
  }
}

/** Probe every host in the config for `odu hosts`. */
export async function probeAllHosts(
  pools: Record<string, HostPool>,
  opts: {
    resolveDrvPath: (platform: string) => ResolveRunnerDrv;
    onLog?: (line: string) => void;
  },
): Promise<{ platform: string; probe: ProbeResult }[]> {
  const out: { platform: string; probe: ProbeResult }[] = [];
  const platforms = Object.keys(pools).sort();
  await Promise.all(
    platforms.flatMap((platform) =>
      (pools[platform] ?? []).map(async (host) => {
        const probe = await probeHost(host, {
          resolveDrvPath: opts.resolveDrvPath(platform),
          onLog: opts.onLog,
        });
        out.push({ platform, probe });
      }),
    ),
  );
  out.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    return a.probe.host.localeCompare(b.probe.host);
  });
  return out;
}
