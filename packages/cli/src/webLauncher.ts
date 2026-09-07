/**
 * CONVERGING ON THE SINGLETON — adopt, spawn, or refuse, and never guess.
 *
 * `odu web` has to end in one of three places, and the whole value of this
 * module is that they stay apart:
 *
 *   - **adopted** — a service is running, this build can speak to it, and its
 *     URL is the answer. The common case, and it must be cheap: no spawn, no
 *     wait, no side effect.
 *   - **spawned** — nothing is running, so one is started and VERIFIED before a
 *     URL is printed. Not "the spawn returned": a person about to open that URL
 *     is entitled to a service that answers.
 *   - **refused** — something is there and this build cannot use it, or the
 *     port belongs to something else. An actionable sentence, never a fallback
 *     to a different port. A relocating service is an unfindable one.
 *
 * ## Readiness is VERIFIED, never polled blind
 *
 * The old shape of this problem is a launcher that sleeps and hopes. Here the
 * service publishes what it is on a cell — its pid, its origin, its contract
 * version, its storage version, and whether it has finished reconciling — and
 * this module reads that. So "ready" means the service said so, `starting`
 * means it is reconciling and the wait continues, and a dial that fails means
 * nothing is there yet. Three facts, none of them inferred from a clock.
 *
 * ## Compatibility is TWO axes, and only one of them is ordered
 *
 * `protocolVersion` is `major.minor` and it is ORDERED: a running service one
 * minor behind still speaks everything this build knows how to ask, so it is
 * adopted. `buildId` is MATCH-ONLY — there is no such thing as a newer build —
 * so a differing one is reported and never acted on unless a person asks for
 * an upgrade. That asymmetry is the framework's (`contractIsCompatible` has no
 * `buildIsNewer` beside it) and it is right: versions are a protocol claim,
 * builds are an identity.
 *
 * ## The upgrade is capture → drain → reattach
 *
 * `--upgrade` reads the running service's identity off the frozen control
 * fragment (`core.hello`, the one contract that never versions within a
 * protocol epoch — so it is readable even when the application surface is
 * skewed beyond speaking), asks it to drain (`core.drain`), waits for the GATE
 * to clear rather than for the process to look gone, and starts this build.
 * Nothing is signalled. A service that will not drain is reported, not killed:
 * it may be finishing a write.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  contractIsCompatible,
  controlCoreSurface,
  type DaemonHomePaths,
  gateIdentity,
} from "@kolu/surface-daemon";
import { buildSurfaceFace, type UnaryEffect } from "@kolu/surface/client";
import { composeSurfaceContracts } from "@kolu/surface/define";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import { dialService, readServiceCell } from "@odu/service-client/dial";
import {
  SERVICE_CONTRACT_VERSION,
  type ServiceBuild,
  type ServiceCell,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import { readProcessIdentity } from "./processIdentity";

/** The composed contract a control dial speaks: the frozen fragment under the
 *  sibling key the daemon mounts it at, which is also where the framework's own
 *  identity probe looks. */
const CONTROL = composeSurfaceContracts({ control: controlCoreSurface });

export type EnsureOutcome =
  | {
      ok: true;
      action: "adopted" | "spawned" | "upgraded";
      origin: string;
      pid: number;
      build: ServiceBuild;
      protocolVersion: string;
    }
  | { ok: false; message: string };

export interface EnsureOptions {
  origin: string;
  home: DaemonHomePaths;
  /** THIS build's identity, so the comparison is against a value rather than
   *  against the environment a launcher happens to be running in. */
  baked: ServiceBuild;
  upgrade: boolean;
  /** Start the daemon so it outlives this process. */
  spawn: () => Effect.Effect<void, Error>;
  /** How long to wait for a spawned service to say it is ready. Generous: a
   *  cold start reconciles the catalog first, and a catalog with a thousand
   *  runs takes longer than one with three. */
  readyMs?: number;
  /** How long to wait for a drained service to release its gate. */
  drainMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Read the service cell, or `null` when nothing answers. A dial that fails is
 *  ABSENCE; a dial that succeeds and then cannot read is a service that is
 *  there and broken, which is a different answer and is reported as a throw. */
async function readService(origin: string): Promise<ServiceCell | null> {
  let connection: Awaited<ReturnType<typeof dialService>>;
  try {
    connection = await dialService(origin);
  } catch {
    return null;
  }
  try {
    return await Effect.runPromise(readServiceCell(connection.client));
  } catch {
    // Connected, then said nothing readable. Not a service of ours — reported
    // as absence would be wrong, so it is reported as null here and the caller
    // distinguishes it by the gate, which a foreign program does not hold.
    return null;
  } finally {
    await connection.dispose();
  }
}

/** Ask the running daemon to drain, over the frozen control contract. */
async function drain(home: DaemonHomePaths): Promise<void> {
  const link = await unixSocketLink({
    group: CONTROL.group,
    socketPath: home.socketPath,
  });
  try {
    const face = buildSurfaceFace(CONTROL.siblings.control, link.dispatch);
    const call = face.surface.core?.drain as UnaryEffect<void, void, never>;
    await Effect.runPromise(call(undefined));
  } finally {
    await link.dispose();
  }
}

/** Is the gate free — either absent, or naming a process that is gone? The
 *  GATE rather than the port, because the gate is what a successor must be able
 *  to claim and a released port can still be in TIME_WAIT. */
function gateFree(home: DaemonHomePaths): boolean {
  const identity = gateIdentity(home.gatePath);
  if (identity === undefined) return true;
  return readProcessIdentity(identity.pid) === undefined;
}

export async function ensureService(
  opts: EnsureOptions,
): Promise<EnsureOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const pollMs = opts.pollMs ?? 100;
  const readyMs = opts.readyMs ?? 60_000;
  const drainMs = opts.drainMs ?? 15_000;

  const running = await readService(opts.origin);
  if (running !== null) {
    const compatible = contractIsCompatible(
      SERVICE_CONTRACT_VERSION,
      running.identity.protocolVersion,
    );
    // MATCH-ONLY, never ordered: there is no such thing as a newer build, so a
    // difference is reported and acted on only when a person asks for an
    // upgrade. Two UNKNOWN identities never match — an off-nix daemon and an
    // off-nix client are not the same build, they are two builds nobody can
    // name — which is why the null case answers false rather than true.
    const mine = opts.baked;
    const sameBuild =
      mine.buildId !== null &&
      running.build.buildId !== null &&
      running.build.buildId === mine.buildId;
    if (!opts.upgrade || (compatible && sameBuild)) {
      if (!compatible) {
        return {
          ok: false,
          message:
            `odu: the service on ${opts.origin} speaks contract ` +
            `${running.identity.protocolVersion}; this build speaks ` +
            `${SERVICE_CONTRACT_VERSION}. Run \`odu web --upgrade\` to drain it ` +
            "and start this build.",
        };
      }
      return {
        ok: true,
        action: "adopted",
        origin: running.identity.origin,
        pid: running.identity.pid,
        build: running.build,
        protocolVersion: running.identity.protocolVersion,
      };
    }
    // CAPTURE: what is running, read before anything is asked of it.
    try {
      await drain(opts.home);
    } catch (err) {
      return {
        ok: false,
        message:
          `odu: the service on ${opts.origin} (pid ${running.identity.pid}) ` +
          `would not drain — ${(err as Error).message}. It is not being killed: ` +
          "it may be finishing a write. Stop it yourself and run `odu web` again.",
      };
    }
    const drained = await until(() => gateFree(opts.home), drainMs, pollMs, sleep);
    if (!drained) {
      return {
        ok: false,
        message:
          `odu: the service on ${opts.origin} accepted a drain but still holds ` +
          `its gate after ${Math.round(drainMs / 1000)}s (pid ` +
          `${running.identity.pid}). Nothing was killed.`,
      };
    }
    return spawnAndVerify(opts, sleep, pollMs, readyMs, "upgraded");
  }

  // Nothing answered. The gate tells the two silences apart: a HELD gate means a
  // daemon is coming up (it claims the gate before it binds), and waiting is
  // right. A free gate means there is nothing, and starting one is right.
  if (!gateFree(opts.home)) {
    const cell = await untilValue(
      () => readService(opts.origin),
      readyMs,
      pollMs,
      sleep,
    );
    if (cell !== null) {
      return {
        ok: true,
        action: "adopted",
        origin: cell.identity.origin,
        pid: cell.identity.pid,
        build: cell.build,
        protocolVersion: cell.identity.protocolVersion,
      };
    }
    const holder = gateIdentity(opts.home.gatePath);
    return {
      ok: false,
      message:
        `odu: something holds the web service's gate (${opts.home.gatePath}` +
        `${holder === undefined ? "" : `, pid ${holder.pid}`}) but nothing is ` +
        `answering on ${opts.origin}. It may be wedged; stop it and try again.`,
    };
  }
  return spawnAndVerify(opts, sleep, pollMs, readyMs, "spawned");
}

async function spawnAndVerify(
  opts: EnsureOptions,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  readyMs: number,
  action: "spawned" | "upgraded",
): Promise<EnsureOutcome> {
  const spawned = await Effect.runPromise(Effect.result(opts.spawn()));
  if (spawned._tag === "Failure") {
    return {
      ok: false,
      message: `odu: could not start the web service — ${String(spawned.failure)}`,
    };
  }
  const cell = await untilValue(
    async () => {
      const seen = await readService(opts.origin);
      // `starting` is a real state, not a gap: the service reconciles the
      // catalog before it claims to know the board, and a caller told "ready"
      // during that window would read a partial one.
      return seen !== null && seen.readiness.state === "ready" ? seen : null;
    },
    readyMs,
    pollMs,
    sleep,
  );
  if (cell === null) {
    return {
      ok: false,
      message:
        `odu: started the web service but it did not answer on ${opts.origin} ` +
        `within ${Math.round(readyMs / 1000)}s. Its own account of why is in ` +
        "the journal (`journalctl --user -u odu-web-*`) or on stderr.",
    };
  }
  return {
    ok: true,
    action,
    origin: cell.identity.origin,
    pid: cell.identity.pid,
    build: cell.build,
    protocolVersion: cell.identity.protocolVersion,
  };
}

/** Poll a predicate to a deadline. */
async function until(
  ask: () => boolean,
  deadlineMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (ask()) return true;
    if (Date.now() >= end) return false;
    await sleep(pollMs);
  }
}

/** Poll for a value to a deadline. */
async function untilValue<T>(
  ask: () => Promise<T | null>,
  deadlineMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | null> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const value = await ask();
    if (value !== null) return value;
    if (Date.now() >= end) return null;
    await sleep(pollMs);
  }
}
