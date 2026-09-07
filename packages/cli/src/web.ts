/**
 * `odu web` — the singleton web service, and the two halves of its life.
 *
 * `webCommand` is what a person types. It ensures a service is up, verifies it
 * is one this build can speak to, prints the URL and RETURNS — the service is a
 * daemon and outlives the shell that asked for it, which is the whole point of
 * a singleton.
 *
 * `webDaemonCommand` is what that spawns. It is not in the usage text because
 * nobody should type it: a person types `odu web`, and a supervisor types this.
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
 * `odu web --upgrade` is the explicit path. It reads the running daemon's
 * identity off the framework's frozen control fragment (`core.hello` — the one
 * contract that never versions within a protocol epoch), and when the build or
 * the contract differs it drains it (`core.drain`), waits for the gate to
 * clear, and starts this build. Capture → drain → reattach, in that order:
 * nothing is killed, the running service is asked, and the caller reattaches by
 * dialling the successor.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  claimPidGate,
  daemonHome,
  daemonMain,
  type DaemonExit,
  gateIdentity,
  stderrLogger,
} from "@kolu/surface-daemon";
import { survivableSpawnDriver } from "@kolu/surface-daemon-supervisor";
import { parseAllowedOrigins } from "@kolu/surface/ws-origin";
import { reportSurfaceAppEvent, serveSurfaceApp } from "@kolu/surface-app/serve";
import { runSocketPath } from "@odu/run-client/dial";
import {
  ODU_CHILD_ENV_KEYS,
  pickEnv,
  survivableSpawnPlan,
} from "@odu/execution/coordinator/spawn";
import { gitTopLevel } from "@odu/execution/common/git";
import { ODU_VERSION } from "@odu/execution/common/version";
import {
  DEFAULT_SERVICE_ORIGIN,
  SERVICE_APP,
  serviceBind,
  serviceMcpUrl,
  serviceOrigin,
} from "@odu/service-client/endpoint";
import type { ServiceBuild } from "@odu/service-client/surface";
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
import { ensureService, type EnsureOutcome } from "./webLauncher";
import {
  allowedHostsFor,
  authorityAllowed,
  type WebAuthority,
} from "./webAuthority";

/** Where the browser bundle lives. Baked by the Nix wrapper; absent in a source
 *  run, where the service still serves its wire and simply has no page. */
const DIST_ENV = "ODU_WEB_DIST";

/**
 * ONE GATE PER ADDRESS.
 *
 * `ODU_WEB_ORIGIN` is documented as moving the whole service, so a developer
 * can run a second odu against a scratch catalog. It moved the address and not
 * the gate: both services computed `~/.local/state/odu-web/`, so the second one
 * read a live holder there and yielded — to a daemon serving a different port
 * and a different catalog. A singleton is per-address or it is not a singleton,
 * and the two spellings of "which service am I" have to be one.
 *
 * The default origin keeps the plain namespace, so nothing about an ordinary
 * install moves. Any other origin gets its own, named by a digest of the origin
 * rather than by the port alone — `http://127.0.0.1:9000` and
 * `http://[::1]:9000` are two addresses.
 */
export function webAppNamespace(origin: string): string {
  if (origin === DEFAULT_SERVICE_ORIGIN) return SERVICE_APP;
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 12);
  return `${SERVICE_APP}-${digest}`;
}

/** The daemon's own home — the same call the launcher makes, so the two cannot
 *  disagree about where the gate and the control socket are. */
export function webHome(
  origin: string = serviceOrigin(),
): ReturnType<typeof daemonHome> {
  return daemonHome({ app: webAppNamespace(origin), placement: "state" });
}

/**
 * WHICH BUILD this is, as a pair or as nothing.
 *
 * The frozen control contract requires `commit` and `buildId` to be both
 * present or both absent, and it is right to: a supervisor recognises a running
 * daemon by its build, and a half-set identity would let one axis claim to
 * match while the other said nothing. So a half-baked wrapper reads as UNKNOWN
 * here rather than as half-known — the same rule the Nix wrapper keeps on the
 * other side, enforced again on this one, because a wrapper is a thing somebody
 * edits.
 */
export function bakedBuild(): ServiceBuild {
  const commit = process.env.ODU_COMMIT_HASH?.trim();
  const buildId = process.env.ODU_BUILD_ID?.trim();
  const both =
    commit !== undefined && commit !== "" && buildId !== undefined && buildId !== "";
  return {
    oduVersion: ODU_VERSION,
    commit: both ? (commit as string) : null,
    buildId: both ? (buildId as string) : null,
    self: process.env.ODU_SELF ?? null,
  };
}

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
export async function webDaemonCommand(): Promise<number> {
  // The origin FIRST, because the home is derived from it: one address, one
  // gate, and never two readings of `ODU_WEB_ORIGIN` that could disagree.
  const origin = serviceOrigin();
  const home = webHome(origin);
  const { host, port } = serviceBind(origin);
  const log = stderrLogger();
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
  if (gate.kind === "held") {
    log.info({ pid: gate.pid }, "odu web: a service is already running; yielding");
    return 0;
  }
  if (gate.kind === "dir-not-private") {
    process.stderr.write(
      `odu: ${gate.dir} is not a private owner-only directory — the web ` +
        "service's home must be yours alone (mode 0700)\n",
    );
    return 1;
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
        ...(process.env[DIST_ENV] === undefined
          ? {}
          : { clientDist: process.env[DIST_ENV] }),
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
      onReady: ({ socketPath, pid }) =>
        log.info({ socketPath, pid, origin: bound }, "odu web: serving"),
    });
    return exitCodeOf(exit);
  } finally {
    await mcp.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await service.close();
  }
}

/**
 * `odu web` — ensure a service, print where it is, return.
 *
 * The whole command is `ensureService` plus wording. Everything about
 * converging on a singleton — adopt, spawn, wait for readiness, refuse — lives
 * in `./webLauncher`, because that is the part a test has to be able to drive
 * without a terminal.
 */
export async function webCommand(opts: {
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

/**
 * Start the daemon so it OUTLIVES this process.
 *
 * The framework's own survivable-spawn driver, not a bare `detached: true`:
 * under cgroup-v2 a detached child does not survive its session, so the driver
 * re-launches into its own transient user service where one is available and
 * falls back to a detached process group where it is not.
 *
 * **WHICH branch is odu's decision, not the driver's**, and it is the same
 * decision a coordinator gets. The driver's own gate is `INVOCATION_ID`;
 * {@link survivableSpawnPlan} is richer — it honours `ODU_NO_SYSTEMD_RUN` and
 * probes for a session bus that actually exists — so it decides and the driver
 * is told, exactly as `@odu/execution`'s `coordinatorSpawnConfig` does. Passing
 * `fromSource` unconditionally, as this used to, forced the detached branch
 * even inside a systemd service, where detaching escapes nothing: the daemon
 * stays in the launching unit's cgroup and dies with it, having promised the
 * opposite.
 *
 * `inheritParentEnv` is FALSE on that branch. This is a packaged launch — the
 * binary is a Nix wrapper that carries its own environment — so the child needs
 * {@link daemonEnv} and nothing layered under it. The opposite is what a
 * coordinator needs, and the two differ for a reason: a coordinator is a
 * developer's shell made durable, a daemon must not inherit an orchestrator's
 * ambient identity and pass it to every run it later starts.
 */
function spawnWebDaemon(): Effect.Effect<void, Error> {
  const self = process.env.ODU_SELF;
  if (self === undefined || self === "") {
    return Effect.fail(
      new Error(
        "odu: ODU_SELF is not set, so odu cannot re-launch itself as a daemon. " +
          "The Nix wrapper bakes it; a source run should start the daemon by " +
          "hand (`bun src/main.ts web-daemon`).",
      ),
    );
  }
  const plan = survivableSpawnPlan(process.env, process.platform, "odu-web");
  return survivableSpawnDriver(
    webDaemonSpawnConfig(self, plan, process.env, webHome().dir),
  ).spawn;
}

/**
 * The four values odu supplies to the framework's mechanism, plus the launch
 * mode. Pure and exported for the same reason `coordinatorSpawnConfig` is: this
 * is the WHOLE of odu's contribution to how the daemon starts, and it is what a
 * suite can pin on a machine with no systemd.
 */
export function webDaemonSpawnConfig(
  self: string,
  plan: ReturnType<typeof survivableSpawnPlan>,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Parameters<typeof survivableSpawnDriver>[0] {
  return {
    binPath: self,
    args: ["web-daemon"],
    // On the systemd branch this OVERLAYS the transient unit's manager env via
    // `--setenv`; on the detached branch it is the COMPLETE child env, with no
    // parent layered under it. Either way it must name everything odu reads,
    // which is why the list below is long rather than clever.
    env: daemonEnv(env),
    unitPrefix: "odu-web",
    ...(plan.mechanism === "detached"
      ? { fromSource: { inheritParentEnv: false } as const }
      : {}),
    // Nobody holds a detached child's stderr, so a daemon that dies before it
    // can log has nowhere to say why. Under systemd the unit's own journal has
    // it and the driver ignores this.
    stderrLog: join(homeDir, "web-daemon.stderr.log"),
  };
}

/**
 * What only the WEB daemon needs, on top of what every odu child needs.
 *
 * Four locators for the service itself and the pair that names this build. A
 * coordinator has no use for any of them, which is why they are here and not in
 * `ODU_CHILD_ENV_KEYS`.
 */
const WEB_DAEMON_ENV_KEYS = [
  "ODU_WEB_ORIGIN",
  "ODU_WEB_DIST",
  "ODU_WEB_ALLOWED_ORIGINS",
  "ODU_WEB_MCP_TOKEN",
  "ODU_COMMIT_HASH",
  "ODU_BUILD_ID",
] as const;

/**
 * The env a daemon runs with, named rather than inherited wholesale.
 *
 * On the detached branch this is the COMPLETE environment, and this daemon's
 * job includes starting coordinators that shell out to `nix` and `git` — so
 * anything they need has to be named or the failure appears four layers away,
 * as a run that will not provision, in a process nobody is watching. That is
 * not hypothetical: it is what happened, and it happened because this list and
 * the coordinator's were two lists. There is one now
 * ({@link ODU_CHILD_ENV_KEYS}), and this adds only what is genuinely the web
 * face's.
 */
export function daemonEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return pickEnv(source, [...ODU_CHILD_ENV_KEYS, ...WEB_DAEMON_ENV_KEYS]);
}

/** Re-exported so a caller that wants the gate's current holder does not learn
 *  a second import path. */
export { gateIdentity, runSocketPath, gitTopLevel, hostname };
