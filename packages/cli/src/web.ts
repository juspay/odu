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
import { join } from "node:path";
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
import { firstFrame, runUnary } from "@odu/execution/common/effectEdge";
import { packagedLauncher } from "@odu/execution/coordinator/launcher";
import {
  isSameRun,
  retryRun as retryRecordedRun,
} from "@odu/execution/coordinator/recovery";
import { survivableSpawnPlan } from "@odu/execution/coordinator/spawn";
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
import type {
  CancelOutcome,
  CancelRequest,
  CheckoutFacts,
  ServicePorts,
} from "@odu/service/ports";
import { createOduService } from "@odu/service/service";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { readProcessIdentity, selfProcessIdentity } from "./processIdentity";
import {
  allowedHostsFor,
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
    cancel: cancelThroughSocket,
    probeCheckout,
  };
}

/** How long a whole-run cancel waits for the socket to go away before it says
 *  it does not know. Teardown finalizes posted statuses and closes lanes, so it
 *  is not instant; bounded, because a caller must eventually be answered. */
const TEARDOWN_CONFIRM_MS = 10_000;

/** Has the coordinator let go of this socket? The run surface's own documented
 *  confirmation for a cancel — the ack may never flush, the socket always
 *  goes. */
async function socketGone(endpoint: string): Promise<boolean> {
  const dialed = await dialRun(endpoint).catch(() => null);
  if (dialed === null) return true;
  await dialed.close();
  return false;
}

/**
 * Reach the coordinator serving a run and stop what the caller named — after
 * proving it is that run.
 *
 * The identity check is not a nicety. `owner.json` keeps a crashed
 * coordinator's endpoint for the ownership grace, and a checkout serves one run
 * after another on one socket path, so the window where "the address the dead
 * run recorded" and "the address the live run is on" are the same string is a
 * real one. `isSameRun` is the retry policy's own comparison, reused rather
 * than re-derived: one answer to "is this the run I mean".
 */
async function cancelThroughSocket(
  request: CancelRequest,
): Promise<CancelOutcome> {
  const dispatched = await dispatchCancel(request);
  if (dispatched.kind !== "await-teardown") return dispatched;
  // The whole-run case, and the connection is CLOSED before this: the caller
  // confirms teardown by the socket going away, and a dial this process is
  // still holding open is not a socket that has gone away.
  const deadline = Date.now() + TEARDOWN_CONFIRM_MS;
  for (;;) {
    if (await socketGone(request.endpoint)) {
      return { kind: "cancelled", detail: null };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return dispatched.acked
    ? {
        // It said yes. Teardown finalizes posted statuses and closes lanes, and
        // a slow one is not a failed one.
        kind: "cancelled",
        detail: "the coordinator accepted the cancel and is still shutting down",
      }
    : {
        kind: "unresolved",
        detail:
          "the coordinator did not answer and its socket is still up after " +
          `${Math.round(TEARDOWN_CONFIRM_MS / 1000)}s`,
      };
}

/** Dial, prove it is the right run, mutate, and let go. `await-teardown` is the
 *  whole-run arm, which cannot be settled from this side of the connection. */
async function dispatchCancel({
  endpoint,
  runId,
  expect,
  scope,
}: CancelRequest): Promise<
  CancelOutcome | { kind: "await-teardown"; acked: boolean }
> {
  const dialed = await dialRun(endpoint);
  // Nothing serving that path. An ANSWER, not a failure: the run the caller
  // named has no coordinator to stop, and saying so beats a cheerful ok.
  if (dialed === null) {
    return { kind: "declined", detail: "nothing is serving this run's socket" };
  }
  try {
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    if (state === undefined || !isSameRun(expect, state)) {
      return {
        kind: "declined",
        detail:
          `the coordinator on this checkout's socket is not run ${runId} — ` +
          "that run's coordinator is gone and another has taken the checkout, " +
          "so nothing was cancelled",
      };
    }
    switch (scope.kind) {
      case "run": {
        // The reply may never arrive: this call routes into the same teardown a
        // SIGINT takes, and the coordinator may exit before it flushes. So the
        // ack is not what is believed — the socket is — and this arm carries the
        // ack out only as a tiebreaker for the case where the socket stays up.
        const acked = await runUnary(dialed.client.surface.run.cancel({}))
          .then(() => true)
          .catch(() => false);
        return { kind: "await-teardown", acked };
      }
      case "node": {
        const result = await runUnary(
          dialed.client.surface.node.cancel({ id: scope.node }),
        );
        return result.ok
          ? { kind: "cancelled", detail: null }
          : {
              kind: "declined",
              detail: `this run has no node ${scope.node} to cancel`,
            };
      }
      case "lane": {
        const result = await runUnary(
          dialed.client.surface.lane.cancel({ platform: scope.platform }),
        );
        return result.ok
          ? { kind: "cancelled", detail: null }
          : {
              kind: "declined",
              detail: `this run has no ${scope.platform} lane to cancel`,
            };
      }
    }
  } catch (err) {
    // A node or lane cancel whose reply was lost. Those do NOT tear the socket
    // down, so there is no second signal to confirm them by — and a mutation
    // with no confirmation is exactly what `unresolved` is for.
    return {
      kind: "unresolved",
      detail: `the call to the coordinator failed — ${(err as Error).message}`,
    };
  } finally {
    await dialed.close();
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
  const home = webHome();
  const origin = serviceOrigin();
  const { host, port } = serviceBind(origin);
  const log = stderrLogger();
  const controller = new AbortController();
  // Read once and used by BOTH doors — the websocket upgrade and `/mcp`. Two
  // reads of one env var is how two doors end up with two policies.
  const allowedOrigins = parseAllowedOrigins(process.env.ODU_WEB_ALLOWED_ORIGINS);

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
        allowedOrigins,
        // Two layers merged into one, because `routes` takes one. Merged and
        // not ordered: `HttpRouter` ranks by specificity, so both literal `/mcp`
        // routes beat the shell's `GET /*` catch-all either way round.
        //
        // `/mcp` carries the SAME policy: `serveSurfaceApp`'s origin gate runs
        // at the websocket upgrade and nowhere else, so an HTTP route added
        // beside it is a second door and has to be locked with the same key.
        routes: Layer.merge(
          mcpRoute(transport, {
            allowedOrigins,
            allowedHosts: allowedHostsFor(origin, allowedOrigins),
          }),
          mcpGetRoute(),
        ),
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
 * The env a daemon needs, named rather than inherited wholesale.
 *
 * Long on purpose. This is the COMPLETE environment of a detached daemon, and
 * that daemon's job includes starting coordinators that shell out to `nix` and
 * `git` — so anything those need to work has to be named here or the failure
 * appears much later, as a run that cannot provision, in a process nobody was
 * watching. The rule for what belongs: a variable odu reads, a variable the
 * platform needs to find its own directories, or a variable the toolchain a run
 * depends on reads. Not an orchestrator's ambient identity, which is the whole
 * reason this is a list and not `process.env`.
 */
export function daemonEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const keep = [
    "HOME",
    "PATH",
    "SHELL",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "TERM",
    "TZ",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    // What a coordinator this daemon starts needs to reach the store, the
    // caches and the certificates. A daemon with none of these looks fine until
    // the first run tries to provision a lane.
    "NIX_PATH",
    "NIX_REMOTE",
    "NIX_CONFIG",
    "NIX_SSL_CERT_FILE",
    "SSL_CERT_FILE",
    "LOCALE_ARCHIVE",
    // odu's own locators — where the catalog is, which odu this is, which flake
    // the lane runner comes from, and where the browser bundle lives.
    "ODU_STATE_DIR",
    "ODU_SELF",
    "ODU_RUNNER_FLAKE",
    "ODU_GH_BIN",
    "ODU_HOSTS",
    "ODU_AGENT_SUBSTITUTERS",
    "ODU_AGENT_TRUSTED_PUBLIC_KEYS",
    "ODU_NO_SYSTEMD_RUN",
    "ODU_LINGER_IDLE_MS",
    "ODU_WEB_ORIGIN",
    "ODU_WEB_DIST",
    "ODU_WEB_ALLOWED_ORIGINS",
    "ODU_WEB_MCP_TOKEN",
    "ODU_COMMIT_HASH",
    "ODU_BUILD_ID",
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Re-exported so a caller that wants the gate's current holder does not learn
 *  a second import path. */
export { gateIdentity, runSocketPath, gitTopLevel, hostname };
