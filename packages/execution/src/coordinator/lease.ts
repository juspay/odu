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
  type LaneClient,
  laneSurface,
  type LeaseHolder,
} from "../common/laneSurface";
import {
  asHostSlot,
  type HostPool,
  type HostSlot,
  type ResolvedPools,
  shortHost,
} from "./hosts";
import type { ResolveRunnerDrv } from "./runnerFlake";
import { type TimeoutOpts, withTimeout } from "../common/withTimeout";
import { runUnary } from "../common/effectEdge";
import {
  lineLogger,
  localhostSpawnEnv,
  pinLaneFace,
} from "./surfaceRemoteOpts";

export type HolderInfo = LeaseHolder;

export function leaseLockPath(): string {
  const fromEnv = process.env.ODU_LEASE_LOCK;
  return fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : DEFAULT_LEASE_LOCK;
}

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const WAIT_POLL_MS = envNumber("ODU_LEASE_WAIT_POLL_MS", 5_000, 1);
const CLAIM_TIMEOUT_MS = envNumber("ODU_LEASE_CLAIM_TIMEOUT_MS", 180_000, 1);

const LEASE_HANDOFF_TIMEOUT_MS = envNumber(
  "ODU_LEASE_HANDOFF_TIMEOUT_MS",
  10_000,
  1,
);

const LEASE_PULSE_TIMEOUT_MS = envNumber(
  "ODU_LEASE_PULSE_TIMEOUT_MS",
  10_000,
  1,
);

const PIN_CEILING_MS = envNumber("ODU_LEASE_PIN_CEILING_MS", 45 * 60_000, 1);

const LEASE_PULSE_MS = 2_000;

export interface LeaseIdentity {
  holder: string;
  run: string | null;
}

export interface LeaseHandle {
  readonly host: string;
  readonly slot?: number;
  release(): void;
  readonly lost?: Promise<void>;
  readonly verifyHeld?: () => Promise<boolean>;
}

export interface LeaseHandoff {
  primary: LeaseHandle;
  extras: LeaseHandle[];
}

export function leaseProbeIsOurs(
  probe:
    | { state: "free" }
    | { state: "busy"; heldBy: LeaseHolder | null }
    | { state: "error" },
  identity: LeaseIdentity,
): boolean {
  return (
    probe.state === "busy" &&
    probe.heldBy?.holder === identity.holder &&
    probe.heldBy.run === identity.run
  );
}

export async function settleLeaseHandoff(
  primary: LeaseHandle,
  extras: readonly LeaseHandle[],
): Promise<LeaseHandoff | null> {
  const candidates = [primary, ...extras];
  const alive = await Promise.all(
    candidates.map(async (lease) => {
      if (lease.verifyHeld === undefined) return true;
      try {
        return await lease.verifyHeld();
      } catch {
        return false;
      }
    }),
  );
  const held: LeaseHandle[] = [];
  for (const [index, lease] of candidates.entries()) {
    if (alive[index]) held.push(lease);
    else lease.release();
  }
  const nextPrimary = held[0];
  if (nextPrimary === undefined) return null;
  return { primary: nextPrimary, extras: held.slice(1) };
}

export type ClaimResult =
  | { kind: "held"; lease: LeaseHandle }
  | { kind: "busy"; heldBy: HolderInfo | null }
  | { kind: "unreachable"; error: string };

interface ProbeVenue {
  host: string;
  slot: number;
  slots: number;
}

export type ProbeResult = ProbeVenue &
  (
    | { state: "free"; heldBy: null }
    | { state: "busy"; heldBy: HolderInfo | null }
    | { state: "local"; heldBy: null }
    | { state: "unreachable"; heldBy: null; error: string }
  );

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

export type LaneAgentClient = LaneClient;

/** Spread the lock-path override in only when there IS one.
 *
 *  `lockPath` is `Schema.optionalKey` on both lease inputs (PLAN #17), which
 *  REJECTS a present-but-undefined key — zod.s `.optional()` tolerated it. An
 *  `AgentDialOpts` with no override would otherwise spell `lockPath: undefined`
 *  and fail its first round-trip with `Expected string, got undefined`, which is
 *  not the "use the agent default" request the caller means. The default path
 *  is the AGENT.s to choose (`ODU_LEASE_LOCK` / DEFAULT_LEASE_LOCK), so the key
 *  must be absent, not null and not guessed here. */
const lockPathKey = (lockPath: string | undefined): { lockPath?: string } =>
  lockPath === undefined ? {} : { lockPath };

export interface AgentDialOpts {
  resolveDrvPath: ResolveRunnerDrv;
  onLog?: (line: string) => void;
  timeoutMs?: number;
  failFastDisconnect?: boolean;
  lockPath?: string;
  slot?: HostSlot;
}

export function slotLockPath(base: string, slot: HostSlot): string {
  return slot.slot === 0 ? base : `${base}.${slot.slot}`;
}

function storePathName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dash = base.indexOf("-");
  return dash > 0 ? base.slice(dash + 1) : base;
}

const COPY_PATH_RE = /copying path '([^']*)'/;

export function copyProgress(): {
  observe: (line: string) => void;
  note: () => string;
  done: () => void;
} {
  let seen: Set<string> | null = new Set<string>();
  let last: string | null = null;
  return {
    observe: (line) => {
      if (seen === null) return;
      if (!line.includes("copying path")) return;
      const match = COPY_PATH_RE.exec(line);
      if (match === null) return;
      const path = match[1] ?? "";
      last = path;
      seen.add(path);
    },
    done: () => {
      seen = null;
      last = null;
    },
    note: () =>
      seen === null || seen.size === 0
        ? ""
        : ` (still copying the runner closure — ${seen.size} store path${
            seen.size === 1 ? "" : "s"
          } so far, last ${last === null ? "?" : storePathName(last)})`,
  };
}

function provisionSink(onLog?: (line: string) => void): {
  log: ReturnType<typeof lineLogger>;
  pin: TimeoutOpts;
  done: () => void;
} {
  const progress = copyProgress();
  let bump: (() => void) | null = null;
  return {
    log: lineLogger((line) => {
      progress.observe(line);
      bump?.();
      onLog?.(line);
    }),
    pin: {
      heartbeat: (b) => {
        bump = b;
      },
      note: progress.note,
      ceilingMs: PIN_CEILING_MS,
    },
    done: () => {
      bump = null;
      progress.done();
    },
  };
}

export function failFastOptionalDisconnect<T>(
  pin: Promise<T>,
  observePhase: (listener: (phase: string) => void) => void,
  host: string,
): Promise<T> {
  return Promise.race([
    pin,
    new Promise<never>((_, reject) => {
      observePhase((phase) => {
        if (phase !== "disconnected" && phase !== "failed") return;
        reject(
          new Error(
            `odu: optional burst connection to ${shortHost(host)} ${phase} before its lease was ready`,
          ),
        );
      });
    }),
  ]);
}

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
  const sink = provisionSink(opts.onLog);
  const session = makeSession<AgentClient, SshProv>({
    connectOnce: sshConnector({
      surface: laneSurface,
      host,
      binary: "odu-runner",
      resolveDrvPath: opts.resolveDrvPath,
      localEnv: localhostSpawnEnv(),
    }),
    initialConnection: "probing",
    label: `lease:${shortHost(host)}`,
    // makeSession takes a structured Logger (kolu#1876+); adapt the line sink.
    log: sink.log,
  });

  let intentionalRelease = false;

  try {
    const pin = pinLaneFace(session);
    const ready = opts.failFastDisconnect
      ? failFastOptionalDisconnect(
          pin,
          (listener) => {
            session.onState((state: SessionState<SshProv>) =>
              listener(state.phase),
            );
          },
          host,
        )
      : pin;
    const client = await withTimeout(
      ready,
      timeoutMs,
      `lease pin ${shortHost(host)}`,
      sink.pin,
    ).finally(sink.done);

    const lockPath =
      opts.slot === undefined
        ? opts.lockPath
        : slotLockPath(opts.lockPath ?? leaseLockPath(), opts.slot);
    const result = await withTimeout(
      runUnary(
        client.surface.lease.claim({
          holder: identity.holder,
          run: identity.run,
          ...lockPathKey(lockPath),
        }),
      ),
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

    session.markConnected();

    let pulse: ReturnType<typeof setInterval> | undefined;
    let pulseInFlight = false;
    let lostResolved = false;
    let resolveLost: () => void = () => {};
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    const markLost = (): void => {
      if (intentionalRelease || lostResolved) return;
      lostResolved = true;
      if (pulse !== undefined) clearInterval(pulse);
      resolveLost();
    };
    session.onState((state: SessionState<SshProv>) => {
      if (state.phase === "disconnected" || state.phase === "failed") {
        markLost();
      }
    });

    const probeOurs = async (
      timeoutMs: number,
      operation: string,
    ): Promise<boolean> => {
      const probe = await withTimeout(
        runUnary(client.surface.lease.probe(lockPathKey(lockPath))),
        timeoutMs,
        `${operation} ${shortHost(host)}`,
      );
      return leaseProbeIsOurs(probe, identity);
    };
    pulse = setInterval(() => {
      if (intentionalRelease || lostResolved || pulseInFlight) return;
      pulseInFlight = true;
      void probeOurs(LEASE_PULSE_TIMEOUT_MS, "lease pulse")
        .then((ours) => {
          if (!ours) markLost();
        })
        .catch(() => {
        })
        .finally(() => {
          pulseInFlight = false;
        });
    }, LEASE_PULSE_MS);
    pulse.unref?.();

    return {
      kind: "held",
      lease: {
        host,
        slot: opts.slot?.slot ?? 0,
        verifyHeld: async () => {
          try {
            return await probeOurs(
              LEASE_HANDOFF_TIMEOUT_MS,
              "lease handoff",
            );
          } catch {
            return false;
          }
        },
        release: () => {
          intentionalRelease = true;
          if (pulse !== undefined) clearInterval(pulse);
          void runUnary(client.surface.lease.release({})).catch(() => {
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

export async function probeHost(
  host: string,
  opts: AgentDialOpts,
): Promise<ProbeResult> {
  const venue = opts.slot ?? { host, slot: 0, slots: 1 };
  if (isLocalHost(host)) {
    return { ...venue, state: "local", heldBy: null };
  }

  const timeoutMs = opts.timeoutMs ?? CLAIM_TIMEOUT_MS;
  const sink = provisionSink(opts.onLog);
  const session = makeSession<AgentClient, SshProv>({
    connectOnce: sshConnector({
      surface: laneSurface,
      host,
      binary: "odu-runner",
      resolveDrvPath: opts.resolveDrvPath,
      localEnv: localhostSpawnEnv(),
    }),
    initialConnection: "probing",
    label: `lease-probe:${shortHost(host)}`,
    log: sink.log,
  });

  try {
    const client = await withTimeout(
      pinLaneFace(session),
      timeoutMs,
      `lease probe pin ${shortHost(host)}`,
      sink.pin,
    ).finally(sink.done);
    session.markConnected();
    const lockPath =
      opts.slot === undefined
        ? opts.lockPath
        : slotLockPath(opts.lockPath ?? leaseLockPath(), opts.slot);
    const result = await withTimeout(
      runUnary(client.surface.lease.probe(lockPathKey(lockPath))),
      timeoutMs,
      `lease probe ${shortHost(host)}`,
    );
    session.destroy();
    if (result.state === "free") {
      return { ...venue, state: "free", heldBy: null };
    }
    if (result.state === "busy") {
      return { ...venue, state: "busy", heldBy: result.heldBy };
    }
    return {
      ...venue,
      state: "unreachable",
      heldBy: null,
      error: result.error,
    };
  } catch (e) {
    session.destroy();
    return {
      ...venue,
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
  source: string | null;
  onLine?: (msg: string) => void;
  claim?: (
    host: string,
    identity: LeaseIdentity,
    slot?: HostSlot,
  ) => Promise<ClaimResult>;
  resolveDrvPath?: ResolveRunnerDrv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rotateBy?: number;
}

export interface AcquiredLane {
  host: string;
  lease: LeaseHandle | null;
}

function rotatePool(pool: HostPool, by: number): (string | HostSlot)[] {
  if (pool.length === 0) return [];
  const offset = ((by % pool.length) + pool.length) % pool.length;
  return [...pool.slice(offset), ...pool.slice(0, offset)];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type ScanOnce =
  | { status: "ok"; venue: HostSlot; lease: LeaseHandle | null }
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
    slot?: HostSlot,
  ) => Promise<ClaimResult>;
  rotateBy: number;
}): Promise<ScanOnce> {
  const { platform, pool, identity, onLine, claim, rotateBy } = opts;

  if (pool.every((h) => isLocalHost(asHostSlot(h).host))) {
    const venue = asHostSlot(pool[0]!);
    const host = venue.host;
    onLine?.(`${platform}: picked ${shortHost(host)} (localhost)`);
    return { status: "ok", venue, lease: null };
  }

  const order = rotatePool(pool, rotateBy);
  const busy: { host: string; heldBy: HolderInfo | null }[] = [];
  const unreachable: { host: string; error: string }[] = [];

  for (const entry of order) {
    const venue = asHostSlot(entry);
    const host = venue.host;
    const result = await claim(host, identity, venue);
    if (result.kind === "held") {
      const busyNote =
        busy.length > 0
          ? `   (${busy.map((b) => shortHost(b.host)).join(", ")} busy)`
          : "";
      onLine?.(
        `${platform}: picked ${shortHost(host)}${busyNote}`,
      );
      return { status: "ok", venue, lease: result.lease };
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
    ((h, id, slot) => {
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
        slot,
      });
    });

  assertPoolsScannable({ [platform]: pool }, [platform], opts.source);

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
      return {
        host: scan.venue.host,
        lease: scan.lease,
      };
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
  pools: ResolvedPools;
  platforms: readonly string[];
  identity: LeaseIdentity;
  noWait: boolean;
  onLine?: (msg: string, platform: string) => void;
  claim?: AcquireFromPoolOpts["claim"];
  resolveDrvPath?: ResolveRunnerDrv;
  sleep?: AcquireFromPoolOpts["sleep"];
  now?: AcquireFromPoolOpts["now"];
}

export interface LeasedLanes {
  lanes: Record<string, string>;
  leases: LeaseHandle[];
}

export interface BurstLeaseOpts {
  platform: string;
  pool: HostPool;
  identity: LeaseIdentity;
  limit: number;
  exclude?: ReadonlySet<string>;
  occupiedHosts?: ReadonlySet<string>;
  onLine?: (msg: string) => void;
  claim?: AcquireFromPoolOpts["claim"];
  resolveDrvPath?: ResolveRunnerDrv;
}

export function hostSlotKey(host: string, slot: number): string {
  return `${host.trim().toLowerCase()}#${slot}`;
}

export async function leaseBurstSlots(
  opts: BurstLeaseOpts,
): Promise<LeaseHandle[]> {
  if (opts.limit <= 0 || opts.pool.length === 0) return [];
  assertPoolsScannable(
    { [opts.platform]: opts.pool },
    [opts.platform],
    null,
  );
  if (opts.pool.some((entry) => isLocalHost(asHostSlot(entry).host))) return [];
  const claim =
    opts.claim ??
    ((host: string, identity: LeaseIdentity, slot?: HostSlot) => {
      if (opts.resolveDrvPath === undefined) {
        return Promise.resolve<ClaimResult>({
          kind: "unreachable",
          error: "odu: leaseBurstSlots needs resolveDrvPath or injected claim",
        });
      }
      return tryClaim(host, identity, {
        resolveDrvPath: opts.resolveDrvPath,
        onLog: opts.onLine,
        failFastDisconnect: true,
        slot,
      });
    });
  const excluded = opts.exclude ?? new Set<string>();
  const occupied = new Set(
    [...(opts.occupiedHosts ?? [])].map((host) => host.trim().toLowerCase()),
  );
  const leases: LeaseHandle[] = [];
  const candidates = opts.pool
    .map(asHostSlot)
    .filter((slot) => !excluded.has(hostSlotKey(slot.host, slot.slot)));
  const spread: HostSlot[] = [];
  const stacked: HostSlot[] = [];
  const seenHosts = new Set(occupied);
  for (const slot of candidates) {
    const host = slot.host.trim().toLowerCase();
    if (!seenHosts.has(host)) {
      spread.push(slot);
      seenHosts.add(host);
    } else {
      stacked.push(slot);
    }
  }
  const remaining = [...spread, ...stacked];
  try {
    while (leases.length < opts.limit && remaining.length > 0) {
      const batch = remaining.splice(0, opts.limit - leases.length);
      const results = await Promise.all(
        batch.map(async (slot) => {
          try {
            return {
              slot,
              result: await claim(slot.host, opts.identity, slot),
            };
          } catch (error) {
            return {
              slot,
              result: {
                kind: "unreachable" as const,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
      );
      const verified = await Promise.all(
        results.map(async ({ slot, result }) => {
          if (result.kind !== "held" || result.lease.verifyHeld === undefined) {
            return { slot, result };
          }
          let held = false;
          try {
            held = await result.lease.verifyHeld();
          } catch {
          }
          if (held) return { slot, result };
          result.lease.release();
          opts.onLine?.(
            `${opts.platform}: skipped broken burst slot ${shortHost(slot.host)}#${slot.slot + 1} during handoff`,
          );
          return {
            slot,
            result: {
              kind: "unreachable" as const,
              error: "burst lease stopped answering during handoff",
            },
          };
        }),
      );
      for (const { slot, result } of verified) {
        if (result.kind !== "held") continue;
        leases.push(result.lease);
        occupied.add(slot.host.trim().toLowerCase());
        opts.onLine?.(
          `${opts.platform}: burst slot ${shortHost(slot.host)}#${slot.slot + 1}`,
        );
      }
    }
    return leases;
  } catch (error) {
    releaseAll(leases);
    throw error;
  }
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
    for (const entry of pools[platform] ?? []) {
      const host = asHostSlot(entry).host;
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

export function isMixedPool(pool: HostPool): boolean {
  return (
    pool.some((h) => isLocalHost(asHostSlot(h).host)) &&
    pool.some((h) => !isLocalHost(asHostSlot(h).host))
  );
}

function assertPoolLocality(
  source: string | null,
  platform: string,
  pool: HostPool,
): void {
  if (!isMixedPool(pool)) return;
  const where = source === null ? "hosts config" : source;
  throw new Error(
    `odu: ${where}: host pool for "${platform}" must not mix localhost with remote hosts` +
      ` (got ${JSON.stringify(pool)}; use a pure-local or pure-remote pool)`,
  );
}

export function assertPoolsScannable(
  pools: Record<string, HostPool>,
  platforms: readonly string[],
  source: string | null,
): void {
  for (const platform of platforms) {
    const pool = pools[platform];
    if (pool === undefined || pool.length === 0) {
      throw new Error(
        `odu: empty host pool for ${platform} — configure at least one host`,
      );
    }
    assertPoolLocality(source, platform, pool);
  }
}

export function assertLeasePools(
  pools: ResolvedPools,
  platforms: readonly string[],
): void {
  assertNoSharedRemoteHosts(pools.hosts, platforms);
  assertPoolsScannable(pools.hosts, platforms, pools.source);
}

export async function leaseLanes(opts: LeaseLanesOpts): Promise<LeasedLanes> {
  const platforms = [...opts.platforms].sort();
  assertLeasePools(opts.pools, platforms);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const rotateBy = now();
  let waited = false;

  const lineFor =
    (platform: string) =>
    (msg: string): void =>
      opts.onLine?.(msg, platform);

  const claimFor = (
    platform: string,
  ): ((
    host: string,
    identity: LeaseIdentity,
    slot?: HostSlot,
  ) => Promise<ClaimResult>) => {
    if (opts.claim !== undefined) return opts.claim;
    const resolve = opts.resolveDrvPath;
    if (resolve === undefined) {
      return async () => ({
        kind: "unreachable",
        error:
          "odu: leaseLanes needs resolveDrvPath or an injected claim",
      });
    }
    return (h, id, slot) =>
      tryClaim(h, id, {
        resolveDrvPath: resolve,
        onLog: lineFor(platform),
        slot,
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
        const pool = opts.pools.hosts[platform];
        if (pool === undefined) {
          throw new Error(`odu: internal: no pool for platform ${platform}`);
        }
        const scan = await scanPoolOnce({
          platform,
          pool,
          identity: opts.identity,
          onLine: lineFor(platform),
          claim: claimFor(platform),
          rotateBy,
        });
        if (scan.status === "ok") {
          lanes[platform] = scan.venue.host;
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
    opts.onLine?.(`${blocked.platform}: ${note}${multi}`, blocked.platform);
    waited = true;
    await sleep(WAIT_POLL_MS);
  }
}

export async function probeAllHosts(
  pools: Record<string, HostPool>,
  opts: {
    resolveDrvPath: ResolveRunnerDrv;
    onLog?: (line: string) => void;
    onProbe?: (answered: { platform: string; probe: ProbeResult }) => void;
  },
): Promise<{ platform: string; probe: ProbeResult }[]> {
  const out: { platform: string; probe: ProbeResult }[] = [];
  const platforms = Object.keys(pools).sort();
  await Promise.all(
    platforms.flatMap((platform) =>
      (pools[platform] ?? []).map(async (entry) => {
        const slot = asHostSlot(entry);
        const probe = await probeHost(slot.host, {
          resolveDrvPath: opts.resolveDrvPath,
          onLog: opts.onLog,
          slot,
        });
        out.push({ platform, probe });
        opts.onProbe?.({ platform, probe });
      }),
    ),
  );
  out.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if (a.probe.host !== b.probe.host) {
      return a.probe.host.localeCompare(b.probe.host);
    }
    return a.probe.slot - b.probe.slot;
  });
  return out;
}
