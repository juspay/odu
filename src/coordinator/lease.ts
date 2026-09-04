/**
 * Venue lease — one run per declared host slot, lock held for the run lifetime.
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
/** Bound for pin + claim RPC (includes cold provisioning of odu-runner).
 *
 *  For the PIN it is an idle bound over TOTAL SILENCE, not a total-elapsed one.
 *  `@kolu/surface-remote` bounds provisioning by progress at two layers of its
 *  own — the session's pre-connected backstop
 *  (`DEFAULT_PRE_CONNECTED_LIVENESS_MS`, 20 min, re-armed on every progress
 *  line and every phase change) and each provisioning step's
 *  `progress-liveness` policy (`PROVISION_STEP_SILENCE_BASE_MS` doubling to
 *  `PROVISION_STEP_MAX_EXPIRIES`, `PROVISION_COPY_SILENCE_MS` for the copy).
 *
 *  Neither of those is TERMINAL for a `pin()` — see {@link PIN_CEILING_MS} for
 *  the `forceCycle` retry loop that is why, and for the bound that catches it.
 *  So odu's bound is the only terminal one on this path, which is exactly why it
 *  must not be removed in favour of "the framework already handles it".
 *
 *  It re-arms on ANY line the session emits, not on copy lines alone: a cap that
 *  re-armed only on `copying path` would relocate juspay/odu#84's death into
 *  `nix build`'s evaluation phase, which narrates plenty but copies nothing. */
const CLAIM_TIMEOUT_MS = envNumber("ODU_LEASE_CLAIM_TIMEOUT_MS", 180_000, 1);

/** A burst lease has finished every potentially slow operation before this
 * check: the runner exists, the RPC face is pinned, and the remote flock is
 * held. This short bound therefore classifies only a broken handoff, never a
 * cold Nix bootstrap. It closes the gap where a lease could die while the
 * batch waited for another cold candidate and still be counted in TOTAL. */
const LEASE_HANDOFF_TIMEOUT_MS = envNumber(
  "ODU_LEASE_HANDOFF_TIMEOUT_MS",
  10_000,
  1,
);

/** Steady-state ownership checks are transport liveness, not capacity
 * selection. Keep their tuning independent of the one-shot handoff barrier. */
const LEASE_PULSE_TIMEOUT_MS = envNumber(
  "ODU_LEASE_PULSE_TIMEOUT_MS",
  10_000,
  1,
);

/** Absolute ceiling on ONE pin, beside the idle bound above.
 *
 *  The idle bound alone has a hole: `forceCycle` narrates through
 *  `localProgress`, so a host that never finishes provisioning but keeps
 *  cycling emits a progress line on every cycle, re-arms
 *  {@link CLAIM_TIMEOUT_MS} forever, and hangs the run with no terminal bound
 *  at all. This is that bound, and it is deliberately generous: well above the
 *  framework's 20-minute pre-connected backstop, so it can never pre-empt
 *  legitimate cold-host provisioning (a first `nix copy` of the runner closure
 *  onto a bare box is tens of minutes of honest work). It catches only "alive,
 *  narrating, and never finishing".
 *
 *  juspay/odu#84 died of a 180s *total elapsed* cap; this is not that cap
 *  restored. The timeout message names which of the two bounds fired, so the
 *  two failures are never confused for one another. */
const PIN_CEILING_MS = envNumber("ODU_LEASE_PIN_CEILING_MS", 45 * 60_000, 1);

/** Keep a held, otherwise quiet lease RPC active inside Effect's fixed
 * five-second transport-ping cadence. */
export const LEASE_PULSE_MS = 2_000;

export interface LeaseIdentity {
  holder: string;
  run: string | null;
}

export interface LeaseHandle {
  readonly host: string;
  readonly slot?: number;
  /** Drop the hold — release RPC + destroy the agent session. */
  release(): void;
  /**
   * Resolves when the agent session ends *without* an intentional `release()`
   * (ssh drop, agent crash, remote kill). Callers must treat this as loss of
   * exclusivity. Optional so test fakes can omit it.
   */
  readonly lost?: Promise<void>;
  /** Confirm that the already-acquired remote flock still answers immediately.
   * Burst acquisition calls this only after all cold provisioning has
   * completed, immediately before committing a fixed shard total. */
  readonly verifyHeld?: () => Promise<boolean>;
}

export interface LeaseHandoff {
  /** The first surviving lane after the final ownership check. */
  primary: LeaseHandle;
  /** Remaining lanes, in their original stable order. */
  extras: LeaseHandle[];
}

/** A busy lock proves OUR lease only when its durable holder identity agrees.
 * Merely seeing `busy` can mistake a different run that won a release race for
 * the hold this coordinator thought it still owned. */
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

/**
 * Recheck a group of held slots together at an ownership handoff. A primary
 * acquired before its peers can disappear while a legitimately cold peer is
 * still provisioning. The first survivor becomes primary; failed handles are
 * released and omitted from the returned capacity.
 */
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

/** Outcome of one non-blocking claim attempt against a *remote* host. */
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
  /** Bound for session pin + claim/probe RPC (default CLAIM_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Optional capacity has alternatives: on the first real disconnect, give
   *  this candidate up instead of waiting through the session retry cycle. */
  failFastDisconnect?: boolean;
  /** Optional lock path override (tests / multi-tenant). */
  lockPath?: string;
  /** Capacity slot being claimed. Multi-slot hosts use a distinct lock path;
   *  single-slot/legacy hosts retain the historical lock path byte-for-byte. */
  slot?: HostSlot;
}

export function slotLockPath(base: string, slot: HostSlot): string {
  // Slot zero is the historic single-capacity venue. Its identity must not
  // change when an operator raises or lowers the declared capacity.
  return slot.slot === 0 ? base : `${base}.${slot.slot}`;
}

/** `/nix/store/<hash>-git-2.55.0-doc` → `git-2.55.0-doc`; anything else
 *  verbatim. Only for naming the path a stalled copy was last on. */
function storePathName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dash = base.indexOf("-");
  return dash > 0 ? base.slice(dash + 1) : base;
}

/**
 * What the runner-closure copy has done so far, read off the session's own log
 * lines — `nix` narrates each store path it pushes (`copying path '/nix/store/…'
 * to 'ssh-ng://host'`).
 *
 * DIAGNOSIS ONLY — it bounds nothing (see {@link CLAIM_TIMEOUT_MS}). What it
 * buys is the sentence at the end of a timeout: `lease pin … timed out` reads as
 * "unreachable machine", and on a cold box that is the wrong diagnosis — the
 * machine was in fact receiving a few hundred megabytes of closure
 * (juspay/odu#84).
 *
 * Paths are counted DISTINCT, not per narration line: provisioning copies each
 * path twice on a cold host — once pulling it into the local store, once
 * shipping it to the remote — so counting lines would report a 300-path closure
 * as 600 and turn the diagnosis into a number nobody can reconcile with `nix
 * path-info`.
 */
const COPY_PATH_RE = /copying path '([^']*)'/;

export function copyProgress(): {
  /** Feed one log line. Returns nothing: no consumer asks "did this line advance
   *  the copy?" — the pin heartbeat fires on any line. The distinct-path dedupe
   *  is asserted through {@link note}. */
  observe: (line: string) => void;
  /** Timeout-message suffix; empty when nothing was ever copied (the genuinely
   *  unreachable case, which must not claim a copy was in flight). */
  note: () => string;
  /** No further note will be asked for — release the path set and make
   *  `observe` a no-op. See {@link provisionSink}, the only caller. */
  done: () => void;
} {
  let seen: Set<string> | null = new Set<string>();
  let last: string | null = null;
  return {
    observe: (line) => {
      if (seen === null) return;
      // Cheap reject first: this runs on every session line, and only a
      // vanishing fraction of them are copy narration.
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

/**
 * The session-line sink every provisioning dial shares, wired once.
 *
 * Both dials that pin a lane face (`tryClaim`, `probeHost`) need the same three
 * things off one line stream: the copy diagnosis, the pin's liveness bump, and
 * the caller's own sink — plus the pin's two bounds (idle + ceiling). Wiring
 * that at each call site is how the liveness policy comes to exist twice and
 * drift on the subtle half (which deadline a bump extends).
 *
 * ANY line is the liveness signal (see {@link CLAIM_TIMEOUT_MS}); `copyProgress`
 * rides along purely to make the timeout message a diagnosis. The bump reaches
 * only the pin's deadline: the claim/probe RPC that follows is a separate
 * `withTimeout` with no heartbeat, and a bump after the pin settles is a no-op
 * inside `withTimeout` itself. Wired unconditionally (not only when a caller
 * passes `onLog`), because the deadline must not depend on whether anyone is
 * listening.
 *
 * The diagnosis half is SCOPED TO THE PIN, via `done()`. This sink stays the
 * session's `log` for the whole lease lifetime — hours on a held lane — but
 * `note` and the `bump` have no reader once the pin settles. Left armed it
 * would run a match over every session line of the run and grow a store-path
 * `Set` nobody will ever read. `done()` drops both, so the rest of the run
 * pays only `onLog?.(line)`.
 */
function provisionSink(onLog?: (line: string) => void): {
  log: ReturnType<typeof lineLogger>;
  pin: TimeoutOpts;
  /** Call once the pin's `withTimeout` has settled, either way. */
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

/**
 * Dial odu-runner on `host` via surface-remote, claim the venue lock, keep
 * the agent session for the hold lifetime.
 */
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
  // The session log is read as well as forwarded — see `provisionSink`, which
  // owns the diagnosis + liveness wiring both dials share.
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
    // `.finally` and not a post-await line: the pin's diagnosis must be
    // released on the throw path too, and this session's log outlives it.
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

    // Held — keep session; mark connected so the connect watchdog stands down.
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
          // The session state owns transport failure and supplies the useful
          // diagnosis. Its disconnect transition calls markLost above.
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
  const venue = opts.slot ?? { host, slot: 0, slots: 1 };
  if (isLocalHost(host)) {
    return { ...venue, state: "local", heldBy: null };
  }

  const timeoutMs = opts.timeoutMs ?? CLAIM_TIMEOUT_MS;
  // Same cold-store bounds as `tryClaim`, from the same sink: probing a host
  // that has never seen odu-runner provisions the whole closure, so the pin
  // deadline tracks liveness rather than total elapsed.
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
  /** The hosts file this pool was declared in, named in the locality refusal;
   *  `null` for a config assembled in code. Required (not optional) so the
   *  `"hosts config"` fallback is a caller's stated choice, never a forgotten
   *  field — a pool and its provenance travel together (`ResolvedPools`). */
  source: string | null;
  onLine?: (msg: string) => void;
  /** Injected claim — tests supply a fake; production uses `tryClaim`. */
  claim?: (
    host: string,
    identity: LeaseIdentity,
    slot?: HostSlot,
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

function rotatePool(pool: HostPool, by: number): (string | HostSlot)[] {
  if (pool.length === 0) return [];
  const offset = ((by % pool.length) + pool.length) % pool.length;
  return [...pool.slice(offset), ...pool.slice(0, offset)];
}

/**
 * The wait between polls — and, while the run is waiting in line, the ONLY
 * thing keeping this process alive.
 *
 * The timer must stay ref'd. `leaseLanes` gives back the holds it already took
 * before it sleeps, and those holds owned the ssh/runner children — the only
 * ref'd handles the run had. Unref this and the event loop is empty for the
 * duration of the wait, so Bun exits 0 and the run reports success without
 * ever running (invisible under interactive progress, which keeps stdin ref'd,
 * and fatal under `--progress=json`, which does not).
 *
 * Nothing is leaked by keeping it: exactly one sleep is outstanding at a time,
 * and the loop only reaches here when it intends to still be here afterwards.
 * The unref'd timer above (`withTimeout`) is a different animal — a deadline on
 * an in-flight RPC that has ref'd handles of its own, and that must not be the
 * reason a finished run lingers.
 */
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

/** One poll of a pool's *availability*: is a host in it free right now. Pool
 *  legality (non-empty, no localhost-beside-remotes) is a property of the
 *  declared value, not of the world, and is judged once per run at the lease
 *  entry points — see `assertPoolsScannable`. This function may assume both. */
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

  // Pure-local pool (every member is localhost): no remote claim, no flock —
  // the checkout socket already serializes local runs. A pool that MIXES
  // localhost with remotes never reaches here (`assertPoolsScannable` refused
  // it at the lease entry), so this is the only shape in which localhost is
  // ever picked: an explicit whole-pool decision, never an implicit fallback
  // (juspay/odu#46, #54).
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
    // Every member here is remote: a mixed pool was refused above, and a
    // pure-local one returned above. Localhost as a lease-exempt entry beside
    // busy remotes was the always-free overflow of juspay/odu#54 — it is now
    // unrepresentable at this point rather than special-cased.
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

  // Legality first, once, over the one pool this call leases — never per poll.
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
  /** The declared pools AND the file they came from, as one value — the
   *  refusals name that file, and a separately-threaded `source` is one a
   *  caller can forget. */
  pools: ResolvedPools;
  platforms: readonly string[];
  identity: LeaseIdentity;
  noWait: boolean;
  /** Narration sink, told WHICH lane each line belongs to. A multi-platform
   *  lease interleaves two hosts' `nix copy` output on one stream, and the
   *  coordinator now files these lines under that lane's `_ci-setup@<platform>`
   *  log (juspay/odu#84) — which it can only do if the platform travels with the
   *  line rather than being guessed from its text. */
  onLine?: (msg: string, platform: string) => void;
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

export interface BurstLeaseOpts {
  platform: string;
  pool: HostPool;
  identity: LeaseIdentity;
  /** Additional slots only; the primary lane is claimed separately. */
  limit: number;
  /** Slot keys already owned by this run (`host#slot`). */
  exclude?: ReadonlySet<string>;
  /** Physical hosts already used by the run. Candidates on other machines are
   *  tried first; stacking begins only after every host is represented. */
  occupiedHosts?: ReadonlySet<string>;
  onLine?: (msg: string) => void;
  claim?: AcquireFromPoolOpts["claim"];
  resolveDrvPath?: ResolveRunnerDrv;
}

export function hostSlotKey(host: string, slot: number): string {
  return `${host.trim().toLowerCase()}#${slot}`;
}

/** Opportunistically claim bounded burst capacity. Busy and unreachable
 *  slots reduce the shard total instead of blocking the whole CI run; every
 *  returned handle is a real lease and therefore participates in fail-closed
 *  lease-loss handling. Pool order is already physical-host-first. */
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
  // Stable host-spread order: the first slot from each not-yet-used machine,
  // then remaining capacity. This is also the concurrency order below.
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
      // Recheck after the slowest candidate in this batch. An early candidate
      // may die while a legitimately cold peer is still provisioning.
      const verified = await Promise.all(
        results.map(async ({ slot, result }) => {
          if (result.kind !== "held" || result.lease.verifyHeld === undefined) {
            return { slot, result };
          }
          let held = false;
          try {
            held = await result.lease.verifyHeld();
          } catch {
            // A rejected ownership check is a broken optional slot.
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

/** Does this pool mix localhost with remotes — the shape the lease seam
 *  refuses? Exported so a read-only face can SURFACE an illegal pool without
 *  refusing over it: `odu hosts` never leases, so refusing there would be
 *  juspay/odu#66 wearing an inventory hat. But the operator should learn it
 *  from the command whose whole job is showing the inventory, rather than from
 *  the first run that tries to claim that platform. */
export function isMixedPool(pool: HostPool): boolean {
  return (
    pool.some((h) => isLocalHost(asHostSlot(h).host)) &&
    pool.some((h) => !isLocalHost(asHostSlot(h).host))
  );
}

/**
 * Refuse a pool that mixes localhost with remotes. Localhost is lease-exempt
 * (checkout socket serializes local runs); in a multi-host scan that made it
 * an always-free overflow — busy remotes were skipped the moment a local
 * entry appeared. Pure-local (typically a sole `"localhost"`) and pure-remote
 * pools are both fine; mixing is illegal in any pool a run leases.
 *
 * Enforced at the lease seam (`leaseLanes` / `acquireFromPool` entry, via
 * `assertPoolsScannable`), over exactly the platforms a run claims — never at
 * parse time and never over the whole resolved map, both of which refuse runs
 * that never touch the offending pool (juspay/odu#66): a resolved map still
 * carries platforms a selector (`odu run fmt@aarch64-darwin`) or an
 * OS-disabled recipe drops before any lease.
 */
function assertPoolLocality(
  source: string | null,
  platform: string,
  pool: HostPool,
): void {
  if (!isMixedPool(pool)) return;
  // A `--host` pin is a pool of one — pure by construction — so a mixed pool
  // always came from the hosts file, and `source` names it. The fallback only
  // covers a config assembled in code rather than read from disk.
  const where = source === null ? "hosts config" : source;
  throw new Error(
    `odu: ${where}: host pool for "${platform}" must not mix localhost with remote hosts` +
      ` (got ${JSON.stringify(pool)}; use a pure-local or pure-remote pool)`,
  );
}

/**
 * Every static rule a pool must satisfy before this run may claim from it:
 * non-empty, and never localhost mixed with remotes. Judged ONCE per run at
 * each lease entry point, beside `assertNoSharedRemoteHosts` — these are
 * properties of declared inventory, not of who happens to be busy, so they do
 * not belong in `scanPoolOnce`'s poll loop. In the loop the refusal was
 * conditional on the weather: `leaseLanes` breaks on the first blocked
 * platform of an alphabetically sorted list, so a mixed pool on a LATER
 * platform was never reached while an earlier box stayed busy — with the
 * default `noWait: false` the operator got a silent indefinite wait instead of
 * a refusal, decided by alphabetical order and unrelated load.
 *
 * Scope is exactly the pools the run leases (juspay/odu#66): `platforms` here
 * is `leaseLanes`' `platformsToClaim`, and `acquireFromPool` passes its one
 * pool. Judging any wider — at parse time, or over the whole resolved map —
 * refuses runs that never touch the offending pool, which is the defect #66
 * fixed.
 */
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

/** Validate the whole set before independent platform claims begin.
 *
 * A caller that starts platforms as soon as each becomes ready must still
 * reject a remote host listed under two platforms before either side takes
 * its lock. Keeping this preflight at the lease seam preserves that invariant
 * without forcing ready platforms through the old all-platform wait barrier. */
export function assertLeasePools(
  pools: ResolvedPools,
  platforms: readonly string[],
): void {
  assertNoSharedRemoteHosts(pools.hosts, platforms);
  assertPoolsScannable(pools.hosts, platforms, pools.source);
}

/**
 * Lease one host slot per platform that participates in the run.
 * Multi-platform is all-or-nothing (release partial holds while waiting).
 */
export async function leaseLanes(opts: LeaseLanesOpts): Promise<LeasedLanes> {
  const platforms = [...opts.platforms].sort();
  assertLeasePools(opts.pools, platforms);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const rotateBy = now();
  let waited = false;

  /** This lane's slice of the narration sink — every line the scan or the ssh
   *  session emits while claiming `platform` is attributed to it. */
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
    const resolve = opts.resolveDrvPath?.(platform);
    if (resolve === undefined) {
      return async () => ({
        kind: "unreachable",
        error:
          "odu: leaseLanes needs resolveDrvPath(platform) or an injected claim",
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
      (pools[platform] ?? []).map(async (entry) => {
        const slot = asHostSlot(entry);
        const probe = await probeHost(slot.host, {
          resolveDrvPath: opts.resolveDrvPath(platform),
          onLog: opts.onLog,
          slot,
        });
        out.push({ platform, probe });
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
