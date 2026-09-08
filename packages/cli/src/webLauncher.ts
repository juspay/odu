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

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
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
import {
  dialService,
  readServiceCell,
  type ServiceConnection,
} from "@odu/service-client/dial";
import {
  SERVICE_CONTRACT_VERSION,
  type ServiceBuild,
  type ServiceCell,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import { readProcessIdentity } from "./processIdentity";
import {
  bakedBuild,
  spawnWebDaemon,
  webHome,
  webStderrLog,
} from "./webDaemonLaunch";
import { serviceBind, serviceOrigin } from "@odu/service-client/endpoint";

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
export async function readService(origin: string): Promise<ServiceCell | null> {
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

/**
 * How long the port probe waits for a TCP accept. Loopback, so a listener
 * answers in microseconds; the budget exists for the case where the origin is
 * NOT loopback and a packet has to travel.
 */
const PORT_PROBE_MS = 1_000;

/**
 * IS ANYTHING ACCEPTING ON THIS ADDRESS? A raw TCP connect and nothing more.
 *
 * Deliberately below the surface protocol. {@link readService} answers "is
 * there an odu service here", and it collapses two very different silences into
 * one `null`: nothing is listening, and something is listening that is not
 * ours. Those need different answers — the first is "start one", the second is
 * "the port is taken" — and no amount of surface handshaking can tell them
 * apart, because a foreign program will not speak the handshake either way.
 * The only question that separates them is the one the kernel can answer.
 */
async function whoeverIsListening(origin: string): Promise<number | null> {
  let bind: { host: string; port: number };
  try {
    bind = serviceBind(origin);
  } catch {
    // An origin that is not a URL cannot be probed, and this is not the place
    // to refuse it: the bind attempt downstream says so properly, and naming
    // the same defect twice in two wordings is worse than naming it once.
    return null;
  }
  return new Promise<number | null>((resolve) => {
    const socket = connect({ host: bind.host, port: bind.port });
    const settle = (answer: number | null): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PORT_PROBE_MS, () => settle(null));
    socket.once("connect", () => settle(bind.port));
    socket.once("error", () => settle(null));
  });
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
    const cleared = await clearTheGate({
      origin: opts.origin,
      home: opts.home,
      pid: running.identity.pid,
      drainMs,
      pollMs,
      sleep,
    });
    if (!cleared.ok) return cleared;
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

  // THE PORT BELONGS TO SOMEBODY ELSE — refused here, in a second, rather than
  // discovered in sixty.
  //
  // Nothing answered as an odu service AND no odu daemon holds the gate, so if
  // the kernel still accepts a connection at this address, the thing accepting
  // it is not odu's and never will be. Spawning into that costs the daemon a
  // failed bind (it says so, correctly, to a stderr log nobody is holding) and
  // costs the caller the entire readiness deadline followed by a sentence that
  // names no cause. Through `odu mcp` it was worse than useless: the MCP SDK's
  // own request timeout fires first, so an agent's only account of an occupied
  // port was `MCP error -32001: Request timed out`.
  //
  // A refusal, never a fallback to another port — for the same reason
  // `serveWebService` refuses: every face derives ONE address, and a service
  // that relocated would be a service nobody could find.
  const occupiedPort = await whoeverIsListening(opts.origin);
  if (occupiedPort !== null) {
    return {
      ok: false,
      message:
        `odu: cannot serve ${opts.origin} — another program is already ` +
        `listening on port ${occupiedPort} and it is not an odu service. ` +
        "odu's web service has ONE address so every face can find it; it will " +
        "not move to a random one. Stop that program, or move odu with " +
        "$ODU_WEB_ORIGIN.",
    };
  }
  return spawnAndVerify(opts, sleep, pollMs, readyMs, "spawned");
}

/**
 * CAPTURE → DRAIN → WAIT FOR THE GATE. What a takeover is, wherever it happens.
 *
 * Shared by the background launcher (which then spawns a successor) and by the
 * foreground server (which then becomes one). Nothing is signalled: a service
 * that will not drain is REPORTED, because it may be finishing a write, and the
 * gate rather than the process is what a successor has to be able to claim.
 */
export async function clearTheGate(opts: {
  origin: string;
  home: DaemonHomePaths;
  pid: number;
  drainMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const pollMs = opts.pollMs ?? 100;
  const drainMs = opts.drainMs ?? 15_000;
  // A THROW FROM THE DRAIN CALL IS NOT A FAILED DRAIN, and reading it as one
  // reported failure on the successful path. `core.drain` asks a process to
  // stop; a process that stops promptly closes the socket it would have
  // replied on, and the client sees `SocketCloseError: 1000` — a NORMAL
  // closure — where it wanted a reply. That is the drain working perfectly.
  //
  // So the transport error is kept as evidence and nothing is concluded from
  // it. Only the gate answers this question, because the gate is the thing a
  // successor actually has to claim, and it says the same word whether the
  // incumbent replied first or simply left.
  let said: string | null = null;
  try {
    await drain(opts.home);
  } catch (err) {
    said = (err as Error).message;
  }
  const drained = await until(() => gateFree(opts.home), drainMs, pollMs, sleep);
  if (!drained) {
    return {
      ok: false,
      message:
        `odu: the service on ${opts.origin} (pid ${opts.pid}) still holds its ` +
        `gate ${Math.round(drainMs / 1000)}s after being asked to drain` +
        (said === null ? "" : ` — ${said}`) +
        ". It is not being killed: it may be finishing a write. Stop it " +
        "yourself and try again.",
    };
  }
  return { ok: true };
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
    // THE DAEMON'S OWN WORDS, not a paraphrase of the silence. Nobody holds a
    // detached daemon's stderr, so it writes it to a file in its home — and
    // this launcher was pointing at that file rather than reading it, which
    // left a caller with sixty seconds and a sentence naming no cause. Absent
    // on the systemd branch, where the journal has it instead and the pointer
    // below is the right answer.
    const said = daemonSaid(opts.home.dir);
    return {
      ok: false,
      message:
        `odu: started the web service but it did not answer on ${opts.origin} ` +
        `within ${Math.round(readyMs / 1000)}s.` +
        (said === null
          ? " Its own account of why is in the journal " +
            "(`journalctl --user -u odu-web-*`)."
          : ` It said:\n${said}`),
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

/** The tail of what a spawned daemon said before it gave up, or `null` when it
 *  left nothing — which on the systemd branch is normal, because the journal
 *  has it instead.
 *
 *  The path comes from `webStderrLog`, which is the module that TELLS the spawn
 *  driver where to write it. It used to be a second string literal here with a
 *  comment asking the two to stay equal; the failure that invites is a launcher
 *  reporting silence from a daemon that said exactly why it died. */
function daemonSaid(homeDir: string): string | null {
  try {
    const text = readFileSync(webStderrLog(homeDir), "utf-8")
      .trimEnd()
      .slice(-2_000);
    return text === "" ? null : text;
  } catch {
    return null;
  }
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

/**
 * DIAL THE SERVICE, STARTING ONE IF THERE IS NONE — the seam every thin client
 * bootstraps through.
 *
 * Public odu is now a set of clients: `odu run`, `odu wait`, `odu surface`, the
 * `odu mcp` bridge. None of them owns execution, and on a fresh machine none of
 * them can do anything until a daemon exists. Two ways that could have gone,
 * and only one of them is honest:
 *
 *   - **Recover a failed dial by doing the work locally.** Never. That is the
 *     second authority the whole consolidation exists to remove, and it would
 *     reappear exactly where it is least visible — at the moment the shared
 *     service is unreachable, which is precisely when two answers about one run
 *     start to diverge.
 *   - **Start the shared service and use it.** This.
 *
 * ## Only at THIS INSTALL'S OWN origin
 *
 * `allowStart` is false whenever the caller named an origin OTHER than the one
 * this install answers to, and that is not a nicety: `--origin` is how a person
 * addresses a service somewhere else, and a mistyped one must report that
 * nothing is serving there rather than starting a daemon of our own — which
 * could not bind that address anyway, and would spend the whole readiness
 * deadline discovering it.
 *
 * **The comparison is against `serviceOrigin()`, not against the compiled-in
 * default**, and getting that wrong is a real bug this had. `ODU_WEB_ORIGIN` is
 * how a developer, and every e2e world, moves the whole service — address,
 * gate, catalog and all — and it is still THEIR singleton. Comparing against
 * `DEFAULT_SERVICE_ORIGIN` meant that anybody who set it got a face that would
 * dial but never start, so a cold machine with a moved origin had no way to
 * bootstrap at all. The rule is "did the caller ask for somewhere else", and
 * the environment is not somewhere else.
 *
 * ## The absence probe is short; the readiness wait is not
 *
 * A dial that finds nothing must fail FAST, because the common case for a
 * failure here is "there is no daemon" and the caller is about to start one.
 * Once a daemon has been started, `ensureService` waits on its readiness CELL —
 * `starting` is a service reconciling the catalog and is a reason to keep
 * waiting; silence is not. That asymmetry is why the two deadlines differ by an
 * order of magnitude instead of being one number.
 */
export async function connectOrStart(
  origin: string = serviceOrigin(),
  opts: { allowStart?: boolean } = {},
): Promise<ServiceConnection> {
  const allowStart = opts.allowStart ?? origin === serviceOrigin();
  try {
    return await dialService(origin, { readyMs: ABSENCE_PROBE_MS });
  } catch (err) {
    // SLOW IS NOT ABSENT, and only one of the two is cheap to be sure about.
    // The probe above is deliberately impatient (300ms) because its failure is
    // the ordinary first step of a bootstrap — but on a machine running its own
    // CI, a perfectly healthy daemon can miss that window, and the fall-through
    // then takes a command through a bootstrap it did not need. Under load that
    // path failed outright: `odu wait` exited 3 with an empty stdout and "All
    // fibers interrupted without error" on stderr, which is a sentence about
    // this process rather than about the service.
    //
    // Absence is a question the KERNEL answers, immediately: is anything
    // accepting on that address. When something is, this waits the full dial
    // budget for it instead of concluding it is not there.
    if ((await whoeverIsListening(origin)) !== null) {
      return await dialService(origin);
    }
    if (!allowStart) throw err;
  }
  const outcome = await ensureService({
    origin,
    home: webHome(origin),
    baked: bakedBuild(),
    upgrade: false,
    spawn: spawnWebDaemon,
  });
  if (!outcome.ok) {
    // The launcher's own sentence, carried out verbatim. It already names the
    // recovery — an upgrade, a wedged gate, a misbuilt package — and rewording
    // it here would be a second, worse account of the same fact.
    throw new Error(outcome.message);
  }
  return dialService(outcome.origin);
}

/**
 * How long a client waits to find out there is NOTHING there.
 *
 * Deliberately shorter than {@link DIAL_READY_MS}'s three seconds: this dial's
 * failure is not an error, it is the ordinary first step of a bootstrap, and
 * every second spent proving it is a second added to `odu run` on a cold
 * machine. Loopback answers in microseconds when anything is listening.
 */
const ABSENCE_PROBE_MS = 300;
