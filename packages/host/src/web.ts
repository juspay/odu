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
 * with `ODU_WEB_ORIGIN` moves its gate too (`@odu/service-client/socket`'s
 * `webAppNamespace`, which `./webDaemonLaunch` reads its home from).
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

import { spawnSync } from "node:child_process";
import {
  claimPidGate,
  daemonMain,
  type DaemonExit,
  type Logger,
  stderrLogger,
} from "@kolu/surface-daemon";
import { parseAllowedOrigins } from "@kolu/surface/ws-origin";
import { serveSurfaceApp } from "@kolu/surface-app/serve";
import {
  readPublicOrigin,
  serviceBind,
  serviceMcpUrl,
  serviceOrigin,
} from "@odu/service-client/endpoint";
import { stateRoot } from "@odu/run-history/paths";
import { Effect, Exit, Layer, Scope } from "effect";
import {
  closeHost,
  mountPlugin,
  offered,
  openHost,
  provide,
  rowReport,
  settled,
  standing,
} from "@olai/effect-cordis";
import { readProcessIdentity, selfProcessIdentity } from "@odu/launch/processIdentity";
import { mcpGetRoute, mcpRoute, RouteTransport, serveServiceMcpInProcess } from "./mcpRoute";
import {
  LOCAL_ADMISSION,
  localBroker,
  NOBODY_ADMISSION,
  PrincipalBroker,
} from "@odu/cordis/principal";
import { authRow, readGithubConfig, signInPageHtml } from "@odu/auth/server";
import { AUTH_AGENT, AUTH_ANONYMOUS_TAGS, AUTH_KEY } from "@odu/auth/surface";
import {
  admissionDispatch,
  admissionStore,
  connectionLayer,
  doorGate,
  doorRoute,
  gatedHandlers,
  liveDispatch,
  UPGRADE_HEADERS,
} from "./principal";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { SERVICE_MCP_PATH } from "@odu/service-client/endpoint";
import { servingOptions } from "./serving";
import { CI_AGENT, ciRow, CI_KEY } from "@odu/ci/row";
import { cacheRow } from "@odu/cache/server";
import { CACHE_AGENT, CACHE_KEY } from "@odu/cache/surface";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import {
  BoundOrigin,
  Build,
  Bundle,
  DaemonHome,
  Log,
  type HttpRoutes,
  type Row,
  type RowAgent,
  type RowRoutes,
  NixStore,
  PublicOrigin,
  RootToken,
  Routes,
  Shutdown,
  StateDir,
} from "@odu/cordis/services";
import {
  assertPackaged,
  bakedBuild,
  spawnWebDaemon,
  webHome,
} from "@odu/launch/webDaemonLaunch";
import {
  clearTheGate,
  ensureService,
  type EnsureOutcome,
  readService,
} from "@odu/launch/webLauncher";



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
  const { host: bindHost, port } = serviceBind(origin);
  const log = tenure.log;
  const controller = new AbortController();
  // ONE Origin allowlist, read once, applied at both doors — the websocket and
  // `/mcp`. There is deliberately no Host allowlist: the service answers to
  // whatever name it is reached by (an SSH forward, a tailnet name, a proxy),
  // and the Origin check compares a browser's Origin against that same Host.
  const allowedOrigins = parseAllowedOrigins(process.env.ODU_WEB_ALLOWED_ORIGINS);
  // The address a BUCKET is published at, when a proxy stands in front. Read
  // here rather than in `@odu/service` because this is the one place that reads
  // an environment, and refused HERE rather than concatenated there: a value
  // with a path would build a substituter URL nobody asked for.
  /** An environment variable's value, or `null` when it is unset or blank. A
   *  blank `$ODU_ROOT_TOKEN=` is the same absence as no variable at all, and
   *  reading it as a real token would make an empty string a credential. */
  const configured = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? null : trimmed;
  };
  const published = readPublicOrigin(process.env);
  if (!published.ok) {
    process.stderr.write(`odu: ${published.message}\n`);
    return 1;
  }
  // THE DOOR'S CONFIGURATION — read here because the host is the one place that
  // reads an environment, and refused here when it is half set: a daemon whose
  // sign-in silently switched off because one variable was misspelled would be
  // a door that looks shut and is not.
  const github = readGithubConfig(process.env, {
    publicOrigin: published.origin,
    boundOrigin: origin,
  });
  if (github.kind === "refused") {
    process.stderr.write(`${github.message}\n`);
    return 1;
  }

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

  // ── THE ROSTER ──────────────────────────────────────────────────────────
  //
  // EVERY ROW, NAMED ONCE, HERE — and this file is a root, which is what makes
  // that legal: a root names every row, a row names only itself, and the host
  // is the one package that composes them. A row record carries the word its
  // surface is served under, the plugin it mounts, and what an agent is told
  // about it. The runs' row is a plugin like any other — `ciRow` builds the
  // rooted bundle in its own `apply` and OFFERS it, which is why `key` is null
  // (its members keep the bare `surface/runs/...` tags) while `plugin` is not.
  const ROWS: ReadonlyArray<Row> = [
    { name: CI_KEY, key: null, plugin: ciRow, agent: CI_AGENT },
    {
      name: CACHE_KEY,
      key: CACHE_KEY,
      plugin: cacheRow,
      agent: CACHE_AGENT,
    },
    // THE DOOR, when this daemon has one. A GitHub App configured means the row
    // is mounted, and with none configured nothing asks who is calling — which
    // is loopback mode, unchanged.
    ...(github.kind === "config"
      ? [
          {
            name: AUTH_KEY,
            key: AUTH_KEY,
            plugin: authRow(github.config),
            agent: AUTH_AGENT,
          },
        ]
      : []),
  ];
  // THE ROOT ROW, read off its own record rather than off its POSITION: `key:
  // null` is what makes a row the root, and a roster that grew a row above this
  // one would otherwise hand the `/mcp` door the wrong surface as its core.
  const coreAgent = (): RowAgent => {
    const root = ROWS.find((row) => row.key === null);
    if (root === undefined) throw new Error("odu: the roster has no root row");
    return root.agent;
  };

  // ── THE HOST ────────────────────────────────────────────────────────────
  //
  // One Cordis context for the tenure, and the rows mounted on it. The host
  // PROVIDES the facts — the state root, the bound and public origins, the
  // build, the logger, the store URI, the way to end, the composed bundle and
  // the router mount — and each SIBLING row is a plugin that names what it
  // needs. Nothing below this line reads an environment.
  const run = standing();
  const host = await run(openHost);
  const build = bakedBuild();
  // THE ROUTE LAYERS, collected for this tenure and read once, at bind, so
  // `layers` is this list and dies with the tenure. The LIST is here rather than
  // in `@odu/cordis` for the same reason the roster is: the tag and the
  // interface a row registers into are shared vocabulary, a mutable list is one
  // daemon's.
  const layers: RowRoutes[] = [];
  const routes: HttpRoutes = {
    add: (layer) => {
      layers.push(layer);
      return () => {
        const at = layers.indexOf(layer);
        if (at !== -1) layers.splice(at, 1);
      };
    },
    layers: () => layers,
  };
  /** The `/mcp` adapter, once the rows are composed; `null` before that, and on
   *  every path that never reached a listener. */
  let mcp: Awaited<ReturnType<typeof serveServiceMcpInProcess>> | null = null;
  let closed = false;
  const closeHostOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await run(closeHost(host));
  };

  const scope = Scope.makeUnsafe();
  try {
    // THE PRINCIPAL BROKER, before any row, built from the DOOR FACT: a row that
    // knows how to sign somebody in registers its resolver on this in its own
    // `apply`; with none registered, this daemon is either the local owner
    // (loopback mode) or nobody at all (a door that is not answering) — the two
    // arms `localBroker` states.
    const hasDoor = github.kind === "config";
    const principals = localBroker({ door: hasDoor });
    // The per-request admission the MCP door's dispatch reads. One per tenure:
    // the composition root makes it, and the adapter is built once over it. Its
    // FALLBACK is the absent-resolver rule again, for a call outside any request.
    const admissions = admissionStore(hasDoor ? NOBODY_ADMISSION : LOCAL_ADMISSION);
    await run(provide(host, PrincipalBroker, () => principals));
    await run(provide(host, StateDir, () => stateRoot(process.env)));
    await run(provide(host, RootToken, () => configured(process.env.ODU_ROOT_TOKEN)));
    await run(provide(host, NixStore, () => configured(process.env.ODU_CACHE_STORE)));
    await run(provide(host, DaemonHome, () => home.dir));
    await run(provide(host, BoundOrigin, () => origin));
    await run(provide(host, PublicOrigin, () => published.origin));
    await run(provide(host, Build, () => build));
    await run(provide(host, Log, () => log));
    await run(provide(host, Shutdown, () => () => controller.abort()));
    await run(provide(host, Routes, () => routes));

    // EVERY ROW IS A PLUGIN, and the runs' row OWNS ITS BUNDLE: its `apply`
    // builds the runtime and `offer`s it, the cache row is held PENDING on that
    // offer until it arrives, and mounting both + `settled` is the whole boot.
    // The host neither constructs a row nor closes one — a bundle built here
    // would be a runtime with no owner to tear it down, which is the bug this
    // shape removes.
    for (const row of ROWS) await run(mountPlugin(host, row.plugin));
    // SETTLED, not merely mounted: a row provides services its siblings may
    // name, and mounting returns as soon as a fibre exists rather than once its
    // `apply` has finished.
    await run(settled(host, ROWS.map((row) => row.name)));
    const report = await run(rowReport(host, ROWS.map((row) => row.name)));
    const broken = [...report].filter(([, row]) => row.state !== "running");
    if (broken.length > 0) {
      process.stderr.write(
        `odu: ${broken
          .map(([name, row]) =>
            row.state === "failed"
              ? `the "${name}" row failed to start${row.fault === undefined ? "" : `: ${row.fault}`}`
              : `the "${name}" row is ${row.state}${
                  row.state === "waiting" && row.missing !== undefined
                    ? ` on ${row.missing.join(", ")}`
                    : ""
                }`,
          )
          .join("; ")}.\n` +
          "odu: refusing to serve half a surface — a missing row answers " +
          "`unknown verb` to every member it owns, which reads as a build skew " +
          "rather than as the fault it is.\n",
      );
      return 1;
    }

    // The runtime the runs' row offered, read once the rows have settled. A
    // host that is not a plugin reads a service with `offered`.
    const runtime = offered(host, Bundle);
    if (runtime === undefined) {
      process.stderr.write("odu: the ci row offered no runtime — refusing to serve\n");
      return 1;
    }

    // THE SERVED HANDLERS, WITH THE DOOR IN FRONT OF THEM — and only the
    // SERVED ones: the control socket `daemonMain` opens is owner-only and
    // already local, so it keeps the ungated record.
    //
    // READ AT EVERY ACCEPT, not frozen at bind: `runtime.handlers` is a live
    // getter, and a row's mount replaces the record. `serving.ts` says the
    // generation is read at each accept for exactly this reason, so the gated
    // record is memoised on the IDENTITY of the record it wraps.
    const anonymousTags = hasDoor ? new Set(Object.keys(AUTH_ANONYMOUS_TAGS)) : new Set<string>();
    let gated: { readonly source: SurfaceHandlers; readonly handlers: SurfaceHandlers } | null =
      null;
    const served = (): { group: typeof runtime.group; handlers: SurfaceHandlers } => {
      const source = runtime.handlers;
      if (gated === null || gated.source !== source) {
        gated = { source, handlers: gatedHandlers(source, anonymousTags) };
      }
      return { group: runtime.group, handlers: gated.handlers };
    };

    // THE `/mcp` DOOR — the composed bundle's, so it is the TRANSPORT's and is
    // built here rather than by any one row: an adapter that served one row
    // would have to be told what the others are. The adapter and its transport
    // are one pair for the listener's life (an MCP `Server` binds exactly one
    // transport, and re-making them per request would rebuild the expose walk
    // and the resource pusher on every call). The DISPATCH behind it reads the
    // served record per call, for the reason above.
    const transport = new RouteTransport();
    mcp = await serveServiceMcpInProcess({
      path: SERVICE_MCP_PATH,
      dispatch: admissionDispatch(
        liveDispatch(() => served().handlers),
        admissions,
      ),
      version: build.oduVersion,
      transport,
      core: coreAgent(),
      siblings: Object.fromEntries(
        ROWS.filter((row) => row.key !== null).map((row) => [row.key as string, row.agent]),
      ),
    });
    const agentRoutes = Layer.merge(
      Layer.merge(
        mcpRoute(transport, allowedOrigins, SERVICE_MCP_PATH, {
          store: admissions,
          broker: principals,
        }),
        mcpGetRoute(SERVICE_MCP_PATH),
      ),
      // THE DOOR FACT, the HOST'S OWN — whether this daemon has a door is a fact
      // about its composition, and it changes with `auth`, not with the runs.
      // The browser asks once before it draws anything.
      doorRoute(hasDoor),
    );
    const composed = routes.layers().reduce((all, one) => Layer.merge(all, one), agentRoutes);

    let bound: string;
    try {
      bound = await Effect.runPromise(
        serveSurfaceApp(
          // The parts and their assembly live in `./serving`: this function owns
          // the gate, the lifetime and the teardown around the listener.
          servingOptions({
            live: served,
            dist,
            host: bindHost,
            port,
            allowedOrigins,
            routes: composed,
            // THE DOOR ITSELF. `cookie` and `authorization` are the two headers a
            // connection is read under; the per-connection services provide the
            // principal its lease admits (and close the socket when it ends); the
            // middleware answers an anonymous `/mcp` with 401 and an anonymous
            // browser with the server-rendered sign-in page.
            upgradeHeaders: UPGRADE_HEADERS,
            services: (connection) => connectionLayer(principals, connection),
            middleware: doorGate({
              broker: principals,
              mcpPath: SERVICE_MCP_PATH,
              signInPage: () =>
                signInPageHtml(),
            }),
          }),
        ).pipe(Scope.provide(scope)),
      );
    } catch (err) {
      process.stderr.write(
        `odu: could not bind ${origin} — ${(err as Error).message}\n` +
          "Another program is on that port. odu's web service has ONE address so " +
          "every face can find it; it will not move to a random one.\n",
      );
      return 1;
    }

    const exit = await daemonMain({
      home,
      // Pre-claimed above, so the spine adopts this claim rather than racing for
      // a second one.
      gate,
      processIdentity: selfProcessIdentity(),
      readProcessIdentity,
      group: runtime.group,
      handlers: runtime.handlers,
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
    // THE LISTENER FIRST, THEN THE ROWS: a row's cleanup closes a database and
    // stops a poller, and doing that under a listener still accepting would
    // answer a call out of a runtime nobody drives any more.
    await mcp?.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await closeHostOnce();
    gate.release();
  }
}

/** The daemon `odu web --background` spawns: quiet, and ended only by `drain`. */
export async function webDaemonCommand(): Promise<number> {
  standOnSolidGround();
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

/**
 * LET GO OF WHOEVER'S DIRECTORY THIS WAS.
 *
 * A daemon inherits the working directory of the command that first needed it —
 * somebody's checkout, a fixture, a temp dir — and then OUTLIVES it. That is
 * the whole point of a singleton, and it makes the inherited cwd a liability:
 * when that directory is removed, the kernel cannot resolve a working directory
 * for anything the daemon forks, and EVERY spawn fails with `ENOENT` naming the
 * program rather than the directory. It is a spectacular error to read —
 * `posix_spawn '/…/gh'` for a `gh` that is right there, mode 755, executable
 * from any other process on the machine.
 *
 * Found through `odu protect`, which is the shortest path to it: eight
 * assertions failing with "the $ODU_GH_BIN seam was bypassed" because the
 * daemon had been started from a test fixture that the test then deleted.
 * Nothing about that is specific to tests — a person who runs `odu run` in a
 * worktree and then removes the worktree gets the same daemon.
 *
 * `/` because it is the one directory that is always there, and because a
 * daemon has no business holding a reference to any other.
 */
function standOnSolidGround(): void {
  try {
    process.chdir("/");
  } catch {
    // A cwd that cannot be changed is not a reason to refuse to serve; the
    // spawns that would have failed will fail with their own message.
  }
}
