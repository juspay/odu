import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  controlCoreSurface,
  type DaemonHomePaths,
  gateIdentity,
} from "@kolu/surface-daemon";
import {
  buildSurfaceFace,
  unenrolledStreamCall,
  type UnaryEffect,
} from "@kolu/surface/client";
import { composeSurfaceContracts } from "@kolu/surface/define";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import {
  DIAL_READY_MS,
  dialService,
  readServiceCell,
  type ServiceConnection,
} from "@odu/service-client/dial";
import {
  admitService,
  skewNote,
  handshakeTimedOut,
  SERVICE_HANDSHAKE_MS,
  type RowNeeds,
  type ServiceBuild,
  type ServiceCell,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import {
  errorMessage,
  firstFrame,
  NoAnswerWithin,
} from "@odu/execution/common/effectEdge";
import { readProcessIdentity } from "./processIdentity";
import {
  bakedBuild,
  spawnWebDaemon,
  webHome,
  webStderrLog,
} from "./webDaemonLaunch";
import { serviceBind, serviceOrigin } from "@odu/service-client/endpoint";
import type { Rpc, RpcGroup } from "effect/rpc";

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
  baked: ServiceBuild;
  needs: RowNeeds;
  upgrade: boolean;
  spawn: () => Effect.Effect<void, Error>;
  readyMs?: number;
  drainMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Read the service cell, or `null` when nothing usable answers. */
export async function readService(
  origin: string,
  group?: RpcGroup.RpcGroup<Rpc.Any>,
): Promise<ServiceCell | null> {
  let connection: Awaited<ReturnType<typeof dialService>>;
  try {
    connection = await dialService(origin, dialGroup(group));
  } catch {
    return null;
  }
  try {
    return await Effect.runPromise(readServiceCell(connection.client));
  } catch {
    return null;
  } finally {
    await connection[Symbol.asyncDispose]();
  }
}

/** The refusal a running service's cell earns, or `null` when this build can
 *  speak to it. */
export function contractVerdict(
  cell: ServiceCell,
  origin: string,
  needs: RowNeeds,
): string | null {
  const verdict = admitService(cell, origin, needs);
  return verdict.kind === "adopt" ? null : verdict.message;
}

export async function adoptOrRefuse<
  C extends Pick<ServiceConnection, "client" | typeof Symbol.asyncDispose>,
>(
  connection: C,
  origin: string,
  opts: {
    needs: RowNeeds;
    handshakeMs?: number;
    warn?: (line: string) => void;
    warned?: Set<string>;
  },
): Promise<C> {
  const handshakeMs = opts.handshakeMs ?? SERVICE_HANDSHAKE_MS;
  let cell: ServiceCell | undefined;
  try {
    cell = await firstFrame(
      unenrolledStreamCall(connection.client.surface.service.get, undefined),
      { deadlineMs: handshakeMs },
    );
  } catch (err) {
    await connection[Symbol.asyncDispose]();
    throw new Error(
      err instanceof NoAnswerWithin
        ? `odu: ${handshakeTimedOut(origin, handshakeMs)}`
        : `odu: something answered on ${origin} but published no service cell ` +
            `(${errorMessage(err)}) — not an odu service this build can use`,
    );
  }
  if (cell === undefined) {
    await connection[Symbol.asyncDispose]();
    throw new Error(
      `odu: something answered on ${origin} but published no service cell ` +
        "(the cell stream ended empty) — not an odu service this build can use",
    );
  }
  const refusal = contractVerdict(cell, origin, opts.needs);
  if (refusal !== null) {
    await connection[Symbol.asyncDispose]();
    throw new Error(refusal);
  }
  const note = skewNote(cell, origin, opts.needs);
  const instance = `${cell.identity.pid}:${cell.identity.startedAt}`;
  if (note !== null && opts.warned?.has(instance) !== true) {
    opts.warned?.add(instance);
    (opts.warn ?? ((line) => process.stderr.write(`${line}\n`)))(note);
  }
  return connection;
}

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

const PORT_PROBE_MS = 1_000;

async function whoeverIsListening(origin: string): Promise<number | null> {
  let bind: { host: string; port: number };
  try {
    bind = serviceBind(origin);
  } catch {
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

function gateFree(home: DaemonHomePaths): boolean {
  const identity = gateIdentity(home.gatePath);
  if (identity === undefined) return true;
  return readProcessIdentity(identity.pid) === undefined;
}

function buildMatches(running: ServiceBuild, baked: ServiceBuild): boolean {
  return (
    baked.buildId !== null &&
    running.buildId !== null &&
    running.buildId === baked.buildId
  );
}

type Decision =
  | { kind: "adopt"; cell: ServiceCell }
  | { kind: "upgrade"; pid: number }
  | { kind: "refuse"; message: string }
  | { kind: "spawn" };

const adopted = (cell: ServiceCell): EnsureOutcome => ({
  ok: true,
  action: "adopted",
  origin: cell.identity.origin,
  pid: cell.identity.pid,
  build: cell.build,
  protocolVersion: cell.identity.protocolVersion,
});

async function decide(
  opts: EnsureOptions,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  readyMs: number,
): Promise<Decision> {
  const running = await readService(opts.origin);
  if (running !== null) {
    const verdict = contractVerdict(running, opts.origin, opts.needs);
    const compatible = verdict === null;
    const sameBuild = buildMatches(running.build, opts.baked);
    if (!opts.upgrade || (compatible && sameBuild)) {
      if (verdict !== null) return { kind: "refuse", message: verdict };
      return { kind: "adopt", cell: running };
    }
    return { kind: "upgrade", pid: running.identity.pid };
  }

  if (!gateFree(opts.home)) {
    const cell = await untilValue(
      () => readService(opts.origin),
      readyMs,
      pollMs,
      sleep,
    );
    if (cell !== null) {
      const refusal = contractVerdict(cell, opts.origin, opts.needs);
      if (refusal !== null) return { kind: "refuse", message: refusal };
      return { kind: "adopt", cell };
    }
    const holder = gateIdentity(opts.home.gatePath);
    return {
      kind: "refuse",
      message:
        `odu: something holds the web service's gate (${opts.home.gatePath}` +
        `${holder === undefined ? "" : `, pid ${holder.pid}`}) but nothing is ` +
        `answering on ${opts.origin}. It may be wedged; stop it and try again.`,
    };
  }

  const occupiedPort = await whoeverIsListening(opts.origin);
  if (occupiedPort !== null) {
    return {
      kind: "refuse",
      message:
        `odu: cannot serve ${opts.origin} — another program is already ` +
        `listening on port ${occupiedPort} and it is not an odu service. ` +
        "odu's web service has ONE address so every face can find it; it will " +
        "not move to a random one. Stop that program, or move odu with " +
        "$ODU_WEB_ORIGIN.",
    };
  }
  return { kind: "spawn" };
}

export async function ensureService(
  opts: EnsureOptions,
): Promise<EnsureOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const pollMs = opts.pollMs ?? 100;
  const readyMs = opts.readyMs ?? 60_000;
  const drainMs = opts.drainMs ?? 15_000;

  const decision = await decide(opts, sleep, pollMs, readyMs);
  switch (decision.kind) {
    case "adopt":
      return adopted(decision.cell);
    case "refuse":
      return { ok: false, message: decision.message };
    case "upgrade": {
      const cleared = await clearTheGate({
        origin: opts.origin,
        home: opts.home,
        pid: decision.pid,
        drainMs,
        pollMs,
        sleep,
      });
      if (!cleared.ok) return cleared;
      return spawnAndVerify(opts, sleep, pollMs, readyMs, "upgraded");
    }
    case "spawn":
      return spawnAndVerify(opts, sleep, pollMs, readyMs, "spawned");
  }
}

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
  let said: string | null = null;
  try {
    await drain(opts.home);
  } catch (err) {
    said = errorMessage(err);
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
      return seen !== null && seen.readiness.state === "ready" ? seen : null;
    },
    readyMs,
    pollMs,
    sleep,
  );
  if (cell === null) {
    const said = webStderrLog(opts.home.dir).tail();
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

export async function connectOrStart(
  origin: string = serviceOrigin(),
  opts: {
    needs: RowNeeds;
    allowStart?: boolean;
    group?: RpcGroup.RpcGroup<Rpc.Any>;
    authorization?: (origin: string) => Promise<Record<string, string>>;
    warned?: Set<string>;
  },
): Promise<ServiceConnection> {
  const allowStart = opts.allowStart ?? origin === serviceOrigin();
  const headers = opts.authorization === undefined ? {} : await opts.authorization(origin);
  const existing = await dialExisting(origin, allowStart, opts.group, headers);
  const adopt = {
    needs: opts.needs,
    ...(opts.warned === undefined ? {} : { warned: opts.warned }),
  };
  if (existing !== null) return adoptOrRefuse(existing, origin, adopt);
  const outcome = await ensureService({
    origin,
    home: webHome(origin),
    baked: bakedBuild(),
    needs: opts.needs,
    upgrade: false,
    spawn: spawnWebDaemon,
  });
  if (!outcome.ok) {
    throw new Error(outcome.message);
  }
  return adoptOrRefuse(
    await dialService(outcome.origin, dialOptions(opts.group, headers)),
    outcome.origin,
    adopt,
  );
}

async function dialExisting(
  origin: string,
  allowStart: boolean,
  group?: RpcGroup.RpcGroup<Rpc.Any>,
  headers: Record<string, string> = {},
): Promise<ServiceConnection | null> {
  try {
    return await dialService(origin, {
      readyMs: ABSENCE_PROBE_MS,
      ...dialOptions(group, headers),
    });
  } catch (err) {
    if ((await whoeverIsListening(origin)) !== null) {
      return await dialService(origin, dialOptions(group, headers));
    }
    if (!allowStart) throw err;
    return null;
  }
}

const ABSENCE_PROBE_MS = DIAL_READY_MS / 10;

function dialGroup(group: RpcGroup.RpcGroup<Rpc.Any> | undefined): {
  group?: RpcGroup.RpcGroup<Rpc.Any>;
} {
  return group === undefined ? {} : { group };
}

function dialOptions(
  group: RpcGroup.RpcGroup<Rpc.Any> | undefined,
  headers: Record<string, string> = {},
): {
  group?: RpcGroup.RpcGroup<Rpc.Any>;
  headers?: Record<string, string>;
} {
  return {
    ...dialGroup(group),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}
