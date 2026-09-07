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
 * fixed origin. Concurrent launchers converge through the framework's own pid
 * gate: every one of them writes a per-pid temp file and races a single atomic
 * `link(2)`, exactly one wins, and every loser reads the gate, proves the
 * holder is alive, and yields. Not a lock — a claim that a dead holder cannot
 * keep.
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

import { existsSync } from "node:fs";
import { hostname } from "node:os";
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
import { dialRun } from "@odu/run-client/dial";
import { runUnary } from "@odu/execution/common/effectEdge";
import { packagedLauncher } from "@odu/execution/coordinator/launcher";
import { retryRun as retryRecordedRun } from "@odu/execution/coordinator/recovery";
import { gitBranch, gitTopLevel } from "@odu/execution/common/git";
import { ODU_VERSION } from "@odu/execution/common/version";
import { listRuns } from "@odu/run-history/store";
import {
  SERVICE_APP,
  serviceBind,
  serviceMcpUrl,
  serviceOrigin,
} from "@odu/service-client/endpoint";
import type { ServiceBuild } from "@odu/service-client/surface";
import type { CheckoutFacts, ServicePorts } from "@odu/service/ports";
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
import { ensureService, type EnsureOutcome } from "./webLauncher";

/** Where the browser bundle lives. Baked by the Nix wrapper; absent in a source
 *  run, where the service still serves its wire and simply has no page. */
const DIST_ENV = "ODU_WEB_DIST";

/** The daemon's own home — the same call the launcher makes, so the two cannot
 *  disagree about where the gate and the control socket are. */
export function webHome(): ReturnType<typeof daemonHome> {
  return daemonHome({ app: SERVICE_APP, placement: "state" });
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
 * What the service can learn about a checkout without running anything.
 *
 * The live-run question is asked of the CATALOG, not of the checkout: a socket
 * file is not a run (it outlives the coordinator that made it), and the
 * ownership record is the copy a heartbeat refreshes and a clean exit clears.
 * Asking the catalog also means the answer is a run ID a caller can address,
 * rather than "something is listening over there".
 */
export function probeCheckout(checkout: string): CheckoutFacts {
  if (!existsSync(checkout)) {
    return { isRepo: false, head: null, branch: null, liveRunId: null };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: checkout,
    encoding: "utf-8",
  });
  if (top.status !== 0) {
    return { isRepo: false, head: null, branch: null, liveRunId: null };
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf-8",
  });
  const live = listRuns({ repoRoot: checkout }).find(
    (row) => row.liveness === "owned" && row.endpoint !== null,
  );
  return {
    isRepo: true,
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: gitBranch(checkout),
    liveRunId: live?.runId ?? null,
  };
}

/** The ports the service is bound to — the ONE place the web face is wired to
 *  the engine. Everything below this line knows what a coordinator is;
 *  `@odu/service` does not. */
export function webPorts(): ServicePorts {
  const launcher = packagedLauncher();
  return {
    launch: launcher,
    retry: (request) =>
      retryRecordedRun({
        runId: request.runId,
        selector: request.selector,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
        ...(request.expectAttempt === undefined
          ? {}
          : { expectAttempt: request.expectAttempt }),
        ...(request.catalog === undefined ? {} : { catalog: request.catalog }),
        launcher,
      }),
    cancel: async ({ endpoint, scope }) => {
      const dialed = await dialRun(endpoint);
      // Nothing serving that path. An ANSWER, not a failure: the run the caller
      // named has no coordinator to stop, and saying so beats a cheerful ok.
      if (dialed === null) {
        return { ok: false, detail: "nothing is serving this run's socket" };
      }
      try {
        switch (scope.kind) {
          case "run": {
            // The reply may never arrive: this call routes into the same
            // teardown a SIGINT takes, and the coordinator may exit before it
            // flushes. The caller confirms by the socket going away, so a lost
            // ack is reported as the success it is rather than as a failure.
            await runUnary(dialed.client.surface.run.cancel({})).catch(() => ({
              ok: true,
            }));
            return { ok: true, detail: null };
          }
          case "node": {
            const result = await runUnary(
              dialed.client.surface.node.cancel({ id: scope.node }),
            );
            return result.ok
              ? { ok: true, detail: null }
              : {
                  ok: false,
                  detail: `this run has no node ${scope.node} to cancel`,
                };
          }
          case "lane": {
            const result = await runUnary(
              dialed.client.surface.lane.cancel({ platform: scope.platform }),
            );
            return result.ok
              ? { ok: true, detail: null }
              : {
                  ok: false,
                  detail: `this run has no ${scope.platform} lane to cancel`,
                };
          }
        }
      } finally {
        await dialed.close();
      }
    },
    probeCheckout,
  };
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
  const home = webHome();
  const origin = serviceOrigin();
  const { host, port } = serviceBind(origin);
  const log = stderrLogger();
  const controller = new AbortController();

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
        // Same-origin is always allowed; anything else must be named. The gate
        // runs on the RAW pre-upgrade socket, so a hostile page never gets a
        // connection to argue about — which is what stands between a web page
        // somebody visited and `run_start` on an arbitrary checkout.
        allowedOrigins: parseAllowedOrigins(process.env.ODU_WEB_ALLOWED_ORIGINS),
        // Two layers merged into one, because `routes` takes one. Merged and
        // not ordered: `HttpRouter` ranks by specificity, so both literal `/mcp`
        // routes beat the shell's `GET /*` catch-all either way round.
        routes: Layer.merge(mcpRoute(transport), mcpGetRoute()),
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
  const outcome = await ensureService({
    origin: serviceOrigin(),
    home: webHome(),
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
 * falls back to a detached process group where it is not. The same mechanism
 * odu already uses for coordinators — see `@odu/execution`'s `spawn.ts`, which
 * documents the branch.
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
  return survivableSpawnDriver({
    binPath: self,
    args: ["web-daemon"],
    // The COMPLETE child env: the detached branch layers no parent env under
    // it, and a daemon spawned with no HOME or PATH would fail in ways that
    // look like odu bugs. An allowlist rather than the whole environment, so a
    // supervisor's ambient identity does not leak into every run the daemon
    // later starts.
    env: daemonEnv(),
    unitPrefix: "odu-web",
    // odu ships raw TypeScript run by a bun wrapper, so the child must inherit
    // enough of this process's environment to be the same odu. Stated rather
    // than assumed.
    fromSource: { inheritParentEnv: true },
  }).spawn;
}

/** The env a daemon needs, named rather than inherited wholesale. */
function daemonEnv(): Record<string, string> {
  const keep = [
    "HOME",
    "PATH",
    "SHELL",
    "LANG",
    "USER",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    // odu's own locators — where the catalog is, which odu this is, which flake
    // the lane runner comes from, and where the browser bundle lives.
    "ODU_STATE_DIR",
    "ODU_SELF",
    "ODU_RUNNER_FLAKE",
    "ODU_GH_BIN",
    "ODU_HOSTS",
    "ODU_AGENT_SUBSTITUTERS",
    "ODU_AGENT_TRUSTED_PUBLIC_KEYS",
    "ODU_WEB_ORIGIN",
    "ODU_WEB_DIST",
    "ODU_WEB_ALLOWED_ORIGINS",
    "ODU_WEB_MCP_TOKEN",
    "ODU_COMMIT_HASH",
    "ODU_BUILD_ID",
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Re-exported so a caller that wants the gate's current holder does not learn
 *  a second import path. */
export { gateIdentity, runSocketPath, gitTopLevel, hostname };
