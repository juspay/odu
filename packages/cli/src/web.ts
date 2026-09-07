/**
 * `odu web` — the singleton web service, and the two lifetimes it can have.
 *
 * **Serving is one function** ({@link serveWebService}); what differs is only
 * how the tenure is narrated and how it ends:
 *
 *   - **`odu web`** serves in the FOREGROUND. Ctrl-C stops it, the person can
 *     see it running, and finding the gate already held is reported rather than
 *     passed off as success — they asked to serve here, and here is taken.
 *   - **`odu web --background`** ensures a service that outlives the shell, the
 *     way it always did: adopt one, or spawn `web-daemon` and verify it answers.
 *   - **`web-daemon`** is what that spawns. Absent from the usage text because
 *     nobody should type it: it is quiet, it yields silently to a live holder,
 *     and it ends only through the control fragment's `drain`.
 *
 * The foreground being the DEFAULT is a deliberate reversal. Printing a URL and
 * exiting left a person with a server they had not watched start, could not
 * watch stop, and had no obvious way to end. Backgrounding is a real thing to
 * want; it is not the thing to assume.
 *
 * **A run outlives the server either way.** Ctrl-C reaches this process's
 * group; a coordinator is a detached group (or a transient unit) of its own, so
 * it never arrives there. Stopping the web service ends an OBSERVATION, which
 * is the same asymmetry `run_cancel` keeps.
 *
 * ## The singleton, exactly
 *
 * One per-user home (`~/.local/state/odu-web/`), one gate file in it, and one
 * fixed origin — and the home is derived FROM the origin, so moving the service
 * with `ODU_WEB_ORIGIN` moves its gate too (see {@link webAppNamespace}).
 * Concurrent launchers converge through the framework's own pid gate: every one
 * of them writes a per-pid temp file and races a single atomic `link(2)`,
 * exactly one wins, and every loser reads the gate, proves the holder is alive,
 * and yields. Not a lock — a claim that a dead holder cannot keep.
 *
 * **The gate is claimed BEFORE the port is bound**, and the ordering is the one
 * thing this file must not get wrong. `daemonMain` claims the gate itself, but
 * it does so after the caller has done whatever else it needs — so a daemon
 * that bound 18440 first and then lost the gate race would have taken the port
 * from the winner. Claiming first means a loser never binds anything.
 *
 * **A fixed port occupied by something else is a REFUSAL, never a fallback.**
 * A service that relocated on `EADDRINUSE` would answer the concurrency
 * question by making itself unfindable: the browser tab, the CLI and the MCP
 * host all derive one address, and a second service on a second port is a
 * second truth nobody asked for.
 *
 * ## Upgrading a running one
 *
 * `odu web --upgrade` is the explicit path, in either lifetime. It reads the
 * running daemon's
 * identity off the framework's frozen control fragment (`core.hello` — the one
 * contract that never versions within a protocol epoch), and when the build or
 * the contract differs it drains it (`core.drain`), waits for the gate to
 * clear, and starts this build. Capture → drain → reattach, in that order:
 * nothing is killed, the running service is asked, and the caller reattaches by
 * dialling the successor.
 */

import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import {
  claimPidGate,
  daemonMain,
  type DaemonExit,
  gateIdentity,
  type Logger,
  stderrLogger,
} from "@kolu/surface-daemon";
import { parseAllowedOrigins } from "@kolu/surface/ws-origin";
import { reportSurfaceAppEvent, serveSurfaceApp } from "@kolu/surface-app/serve";
import { runSocketPath } from "@odu/run-client/dial";
import { gitTopLevel } from "@odu/execution/common/git";
import { ODU_VERSION } from "@odu/execution/common/version";
import {
  serviceBind,
  serviceMcpUrl,
  serviceOrigin,
} from "@odu/service-client/endpoint";
import { createOduService } from "@odu/service/service";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { readProcessIdentity, selfProcessIdentity } from "./processIdentity";
import {
  mcpGetRoute,
  mcpRoute,
  RouteTransport,
  serveServiceMcpInProcess,
} from "./serviceMcp";
import { webPorts } from "./webPorts";
import {
  assertPackaged,
  bakedBuild,
  spawnWebDaemon,
  webHome,
} from "./webDaemonLaunch";
import {
  clearTheGate,
  ensureService,
  type EnsureOutcome,
  readService,
} from "./webLauncher";
import {
  allowedHostsFor,
  authorityAllowed,
  type WebAuthority,
} from "./webAuthority";



/** The exit code a daemon tenure ends with. `@kolu/surface-daemon` computes
 *  this too, but only inside `daemonProcessMain`, which owns `process.exit` —
 *  and odu's binary owns its own exit edge for every command (see `main.ts`'s
 *  `exitAfterFlush`, which exists because a large answer must drain before the
 *  process ends). Two owners of one exit is one too many, so the mapping is
 *  spelled here instead. */
function exitCodeOf(exit: DaemonExit): number {
  switch (exit.kind) {
    // Yielding to a live instance is a SUCCESS: the caller wanted a service and
    // there is one.
    case "already-running":
      return 0;
    case "shutdown":
      return exit.reason === "runtime-fault" ? 1 : 0;
    case "serve-failed":
      return 1;
  }
}

/**
 * THE DAEMON. Claims the gate, binds the listener, serves until told to stop.
 *
 * The order is: gate → service runtime → HTTP/WS listener → `daemonMain` (which
 * adds the control socket and owns the tenure). Everything started here is torn
 * down in the `finally`, because this function's return is the process's last
 * act and a live handle would keep it alive after its tenure ended — the
 * lingering-daemon class.
 */
/**
 * HOW A TENURE PRESENTS ITSELF — the only thing the two lifetimes differ in.
 *
 * A backgrounded daemon narrates to a log nobody is watching and yields quietly
 * when it finds the gate held, because a launcher racing three of them wants
 * exactly one survivor and no noise. A foreground server narrates to a PERSON
 * who is standing there, and finding the gate held means the thing they asked
 * for — serve, here, in this terminal — did not happen and must be said.
 *
 * Everything else about serving is identical, which is why it is one function.
 */
export interface Tenure {
  /** Where this tenure narrates itself. A daemon writes structured JSON to a
   *  stderr nobody reads until something goes wrong; a foreground server writes
   *  to a person's terminal, where four lines of JSON before the URL are noise
   *  standing between them and the thing they asked for. */
  log: Logger;
  /** Another process holds the gate. Answer with this command's exit code. */
  onHeld: (pid: number) => Promise<number> | number;
  /** Bound and serving, at the origin the OS actually gave us. */
  onServing: (origin: string, pid: number) => void;
  /** Signals that end this tenure. A daemon has none of its own — it is ended
   *  through the control fragment's `drain` — and a foreground server has
   *  Ctrl-C, which is the whole of its contract with the person running it. */
  stopOn?: readonly NodeJS.Signals[];
}

/**
 * SERVE. One listener, one gate, one surface — and a `Tenure` deciding only how
 * it is narrated and how it ends.
 */
export async function serveWebService(tenure: Tenure): Promise<number> {
  // BEFORE ANYTHING IS CLAIMED OR BOUND. A misbuilt package must not take the
  // singleton's gate, bind the port, and then serve an application with no page
  // — which is exactly what the old `ODU_WEB_DIST`-absent branch did.
  assertPackaged();
  const dist = process.env.ODU_WEB_DIST as string;
  // The origin FIRST, because the home is derived from it: one address, one
  // gate, and never two readings of `ODU_WEB_ORIGIN` that could disagree.
  const origin = serviceOrigin();
  const home = webHome(origin);
  const { host, port } = serviceBind(origin);
  const log = tenure.log;
  const controller = new AbortController();
  // ONE policy, read once, applied at both doors — the websocket and `/mcp`.
  // Two reads of one env var is how two doors end up with two answers to the
  // same question.
  const allowedOrigins = parseAllowedOrigins(process.env.ODU_WEB_ALLOWED_ORIGINS);
  const authority: WebAuthority = {
    allowedOrigins,
    allowedHosts: allowedHostsFor(origin, allowedOrigins),
  };

  // Claimed FIRST, so a launcher that lost the race never binds the port. The
  // framework's own gate: one atomic link, a liveness-proved holder, and a
  // stale gate reaped rather than waited on.
  const gate = await claimPidGate(
    home.gatePath,
    home.socketPath,
    selfProcessIdentity(),
    readProcessIdentity,
  );
  if (gate.kind === "held") return tenure.onHeld(gate.pid);
  if (gate.kind === "dir-not-private") {
    process.stderr.write(
      `odu: ${gate.dir} is not a private owner-only directory — the web ` +
        "service's home must be yours alone (mode 0700)\n",
    );
    return 1;
  }

  // Ctrl-C, for a tenure that has one. Installed AFTER the gate is claimed and
  // removed in the `finally`, so a signal can never abort a process that is not
  // yet serving and never outlive the tenure it belongs to. The handlers stop
  // the SERVER; a coordinator it started is in its own process group (see
  // `@odu/execution`'s spawn plan) and a Ctrl-C in this terminal never reaches
  // it, which is the promise "your run survives this shell" made concrete.
  const stopHandlers: (() => void)[] = [];
  for (const signal of tenure.stopOn ?? []) {
    const onSignal = (): void => controller.abort();
    process.on(signal, onSignal);
    stopHandlers.push(() => process.off(signal, onSignal));
  }

  const service = createOduService({
    ports: webPorts(),
    origin,
    home: home.dir,
    build: bakedBuild(),
    // The frozen control fragment's `drain`, wired to this process's own stop.
    // A supervisor asks; the daemon decides how it ends.
    onDrain: () => controller.abort(),
  });
  // A runtime that has faulted answers nothing while the process stays alive
  // and the socket stays open — the documented zombie. Observed and fatal.
  service.done.catch((err: unknown) => {
    log.error({ err: String(err) }, "odu web: surface runtime faulted");
    process.exit(1);
  });

  // The adapter and its transport are one pair for the listener's life: an MCP
  // `Server` binds exactly one transport, and re-making them per request would
  // rebuild the expose walk and the resource pusher on every call.
  const transport = new RouteTransport();
  const mcp = await serveServiceMcpInProcess({
    handlers: service.runtime.handlers,
    version: ODU_VERSION,
    transport,
  });

  const scope = Scope.makeUnsafe();
  let bound: string;
  try {
    bound = await Effect.runPromise(
      serveSurfaceApp({
        // LIVE, read at every accept: the rooted runtime's served set moves when
        // the control sibling mounts, and a snapshot taken at bind would serve a
        // roster that no longer matches the handlers.
        live: () => ({
          group: service.runtime.group,
          handlers: service.runtime.handlers,
        }),
        // Not optional. `serveSurfaceApp` treats a missing `clientDist` as "no
        // static route" and a nonexistent one as a 404 — it will not fail for
        // you — so the packaged contract is asserted before we get here
        // ({@link assertPackaged}) and this reads a value that is present.
        clientDist: dist,
        manifest: { name: "odu", themeColor: "#1f6feb", icons: [] },
        host,
        port,
        // Same-origin is always allowed; anything else must be named. This gate
        // runs on the RAW pre-upgrade socket, so a hostile page never gets a
        // connection to argue about — but it compares Origin against the Host
        // the request CLAIMS, which is why `services` below adds the half it
        // cannot see.
        allowedOrigins,
        // Both headers the authority decision reads, off the upgrade. A literal
        // array so the keys are a union and `connection.headers` typechecks.
        upgradeHeaders: ["host", "origin"] as const,
        // THE OTHER DOOR'S HALF OF THE SAME LOCK. `isAllowedWsOrigin` says yes
        // to a page whose Origin matches the Host it sent — and under DNS
        // rebinding both are the attacker's, so they match. The listener's own
        // authorities are the missing half, and this is the earliest point odu
        // can apply them: `serveSurfaceApp` owns the upgrade and takes no hook,
        // so the handshake completes and then this connection gets NO serving
        // stack — it reads no frame and can call nothing.
        services: (connection) =>
          authorityAllowed(
            {
              host: connection.headers.host,
              origin: connection.headers.origin,
            },
            authority,
          )
            ? Layer.empty
            : Layer.effectDiscard(
                Effect.die(
                  new Error(
                    `odu: refused a websocket claiming Host ` +
                      `"${connection.headers.host ?? "(absent)"}" — this ` +
                      `service answers to ${authority.allowedHosts.join(", ")}`,
                  ),
                ),
              ),
        // Two layers merged into one, because `routes` takes one. Merged and
        // not ordered: `HttpRouter` ranks by specificity, so both literal `/mcp`
        // routes beat the shell's `GET /*` catch-all either way round.
        routes: Layer.merge(mcpRoute(transport, authority), mcpGetRoute()),
        onEvent: reportSurfaceAppEvent,
      }).pipe(Scope.provide(scope)),
    );
  } catch (err) {
    await mcp.close();
    await service.close();
    gate.release();
    process.stderr.write(
      `odu: could not bind ${origin} — ${(err as Error).message}\n` +
        "Another program is on that port. odu's web service has ONE address so " +
        "every face can find it; it will not move to a random one.\n",
    );
    return 1;
  }

  try {
    const exit = await daemonMain({
      home,
      // Pre-claimed above, so the spine adopts this claim rather than racing for
      // a second one.
      gate,
      processIdentity: selfProcessIdentity(),
      readProcessIdentity,
      group: service.runtime.group,
      handlers: service.runtime.handlers,
      lifetime: { kind: "forever" },
      log,
      signal: controller.signal,
      onReady: ({ socketPath, pid }) => {
        log.info({ socketPath, pid, origin: bound }, "odu web: serving");
        tenure.onServing(bound, pid);
      },
    });
    return exitCodeOf(exit);
  } finally {
    for (const stop of stopHandlers) stop();
    await mcp.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await service.close();
  }
}

/** The daemon `odu web --background` spawns: quiet, and ended only by `drain`. */
export async function webDaemonCommand(): Promise<number> {
  const log = stderrLogger();
  return serveWebService({
    log,
    onHeld: (pid) => {
      log.info({ pid }, "odu web: a service is already running; yielding");
      return 0;
    },
    onServing: () => {},
  });
}

/**
 * `odu web` — SERVE, HERE, until Ctrl-C.
 *
 * The default is the foreground, and that is a deliberate reversal. A command
 * that printed a URL and exited left a person with a server they had not seen
 * start, could not see stop, and had no obvious way to end — the surprise being
 * that the shell prompt came back while something was still listening.
 * Backgrounding is a real thing to want, so it has a flag; it is not the thing
 * to assume.
 *
 * **A coordinator outlives this terminal either way.** Ctrl-C ends the SERVER.
 * Runs it started are detached process groups (or transient units), so the
 * signal never reaches them, and their evidence is in the catalog rather than
 * in this process. That asymmetry is the same one `run_cancel` keeps: ending an
 * observation is not ending the work.
 */
export async function webCommand(opts: {
  upgrade: boolean;
  json: boolean;
  background: boolean;
}): Promise<number> {
  return opts.background ? backgroundWeb(opts) : foregroundWeb(opts);
}

/** A logger that says nothing until it has something wrong to say. */
function quietLogger(): Logger {
  const loud = stderrLogger();
  return {
    debug: () => {},
    info: () => {},
    warn: loud.warn,
    error: loud.error,
  };
}

/**
 * Serve in this terminal.
 *
 * The singleton still holds: if another process owns the gate, this one cannot
 * serve, and it SAYS SO instead of returning as though it had. That is the
 * difference the flag exists for — `--background` asks for "make sure one is
 * running", and bare `odu web` asks for "run one here", which are different
 * requests with different answers when one is already up.
 */
async function foregroundWeb(opts: {
  upgrade: boolean;
  json: boolean;
}): Promise<number> {
  const origin = serviceOrigin();
  if (opts.upgrade) {
    const running = await readService(origin);
    if (running !== null) {
      const cleared = await clearTheGate({
        origin,
        home: webHome(origin),
        pid: running.identity.pid,
      });
      if (!cleared.ok) {
        process.stderr.write(`${cleared.message}\n`);
        return 1;
      }
    }
  }
  return serveWebService({
    // QUIET unless something is wrong. The spine's routine narration —
    // "listener bound", "daemon listening" — is what a supervisor reads out of
    // a file later; a person watching a terminal wants the URL and the way to
    // stop it, and anything else is in the way. Warnings and faults still come
    // through, because those are the lines they need most.
    log: quietLogger(),
    stopOn: ["SIGINT", "SIGTERM"],
    onHeld: async (pid) => {
      const running = await readService(origin);
      process.stderr.write(
        running === null
          ? `odu: something holds the web service's gate (pid ${pid}) but ` +
            `nothing is answering on ${origin}. Nothing is serving here.\n` +
            "It may be wedged; stop it and try again.\n"
          : `odu: a web service is already running at ${running.identity.origin} ` +
            `(pid ${running.identity.pid}). This terminal is NOT serving it.\n` +
            `  open it            ${running.identity.origin}\n` +
            "  replace it         odu web --upgrade\n" +
            "  leave it running   odu web --background\n",
      );
      return 1;
    },
    onServing: (bound, pid) => {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, action: "serving", origin: bound, pid }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`${bound}\n`);
      process.stderr.write(
        `odu · serving in this terminal (pid ${pid}) — Ctrl-C stops it\n` +
          `odu · MCP (Streamable HTTP): ${serviceMcpUrl(bound)}\n` +
          "odu · runs you start keep going after this stops\n" +
          "odu · to leave a service running instead: odu web --background\n",
      );
    },
  });
}

/**
 * `odu web --background` — ensure a service, print where it is, return.
 *
 * The whole command is `ensureService` plus wording. Everything about
 * converging on a singleton — adopt, spawn, wait for readiness, refuse — lives
 * in `./webLauncher`, because that is the part a test has to be able to drive
 * without a terminal.
 */
async function backgroundWeb(opts: {
  upgrade: boolean;
  json: boolean;
}): Promise<number> {
  const origin = serviceOrigin();
  const outcome = await ensureService({
    origin,
    home: webHome(origin),
    baked: bakedBuild(),
    upgrade: opts.upgrade,
    spawn: spawnWebDaemon,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  }
  if (!outcome.ok) {
    process.stderr.write(`${outcome.message}\n`);
    return 1;
  }
  process.stdout.write(`${outcome.origin}\n`);
  process.stderr.write(
    `odu · ${describe(outcome)}\n` +
      `odu · MCP (Streamable HTTP): ${serviceMcpUrl(outcome.origin)}\n` +
      `odu · build ${outcome.build.oduVersion}${
        outcome.build.buildId === null ? "" : ` (${outcome.build.buildId})`
      }\n`,
  );
  return 0;
}

function describe(outcome: Extract<EnsureOutcome, { ok: true }>): string {
  switch (outcome.action) {
    case "adopted":
      return `reused the service already running (pid ${outcome.pid})`;
    case "spawned":
      return `started the service (pid ${outcome.pid}) — it will outlive this shell`;
    case "upgraded":
      return `drained the previous service and started this build (pid ${outcome.pid})`;
  }
}


/** Re-exported so a caller that wants the gate's current holder — or any of the
 *  launch facts that now live in `./webDaemonLaunch` — does not learn a second
 *  import path for something it already reaches `./web` for. */
export { gateIdentity, runSocketPath, gitTopLevel, hostname };
export {
  assertPackaged,
  bakedBuild,
  daemonEnv,
  webAppNamespace,
  webDaemonSpawnConfig,
  webHome,
} from "./webDaemonLaunch";
