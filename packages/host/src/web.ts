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
import {
  authRowRecord,
  readGithubConfig,
  signInPageHtml,
  type GithubConfigReading,
} from "@odu/auth/server";
import { cloudflareRowRecord, readCloudflareConfig } from "@odu/cloudflare/server";
import { TAGS_OPEN_TO_A_SESSIONLESS_CONNECTION } from "@odu/auth/surface";
import {
  admissionDispatch,
  admissionStore,
  connectionLayer,
  doorGate,
  doorRoute,
  rowsRoute,
  gatedHandlers,
  liveDispatch,
  UPGRADE_HEADERS,
} from "./principal";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { SERVICE_MCP_PATH } from "@odu/service-client/endpoint";
import { bucketDomainGate } from "./bucketDomain";
import { reservedClaims } from "./reserved";
import { servingOptions } from "./serving";
import { ciRowRecord } from "@odu/ci/row";
import { cacheRowRecord, readCacheStores, storeConfigMessage } from "@odu/cache/server";
import { CACHE_KEY } from "@odu/cache/surface";
import type { RowNeeds } from "@odu/service-client/surface";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import {
  BoundOrigin,
  BucketDomains,
  Build,
  Bundle,
  CacheGrants,
  CachePurge,
  DaemonHome,
  Log,
  Metrics,
  type HttpRoutes,
  type ClaimedRoutes,
  type Row,
  type RowRoutes,
  type RowAgent,
  NixStore,
  PublicOrigin,
  grantsBroker,
  purgeBroker,
  RootToken,
  RowContracts,
  Routes,
  Shutdown,
  StateDir,
} from "@odu/cordis/services";
import { metricsBroker } from "@odu/cordis/metrics";
import {
  METRICS_AGENT,
  METRICS_KEY,
  METRICS_ROW,
  oduMetricsSurface,
} from "@odu/cordis/metricsSurface";
import { metricsFragment } from "./metricsFragment";
import { metricsRoute } from "./metricsRoute";
import { openMetricsTokens } from "./metricsTokens";
import { installUnhandledGuard, unhandledReading } from "./unhandled";
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



function exitCodeOf(exit: DaemonExit): number {
  switch (exit.kind) {
    case "already-running":
      return 0;
    case "shutdown":
      return exit.reason === "runtime-fault" ? 1 : 0;
    case "serve-failed":
      return 1;
  }
}

export interface Tenure {
  log: Logger;
  onGateHeldElsewhere: (pid: number) => Promise<number> | number;
  onServing: (origin: string, pid: number) => void;
  endingSignals?: readonly NodeJS.Signals[];
}

type GithubReading = Exclude<GithubConfigReading, { kind: "refused" }>;
type CloudflareReading = Exclude<ReturnType<typeof readCloudflareConfig>, { kind: "refused" }>;
type CacheStoresReading = Exclude<ReturnType<typeof readCacheStores>, { kind: "refused" }>;

interface HostConfig {
  readonly dist: string;
  readonly origin: string;
  readonly home: ReturnType<typeof webHome>;
  readonly bindHost: string;
  readonly port: number;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly publicOrigin: string | null;
  readonly github: GithubReading;
  readonly cloudflare: CloudflareReading;
  readonly cacheStores: CacheStoresReading;
}

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

function readHostConfig():
  | { kind: "config"; config: HostConfig }
  | { kind: "refused"; message: string } {
  assertPackaged();
  const dist = process.env.ODU_WEB_DIST as string;
  const origin = serviceOrigin();
  const home = webHome(origin);
  const { host: bindHost, port } = serviceBind(origin);
  const allowedOrigins = parseAllowedOrigins(process.env.ODU_WEB_ALLOWED_ORIGINS);
  const published = readPublicOrigin(process.env);
  if (!published.ok) return { kind: "refused", message: `odu: ${published.message}` };
  const github = readGithubConfig(process.env, {
    publicOrigin: published.origin,
    boundOrigin: origin,
  });
  if (github.kind === "refused") return { kind: "refused", message: github.message };
  const cloudflare = readCloudflareConfig(process.env);
  if (cloudflare.kind === "refused") return { kind: "refused", message: cloudflare.message };
  const cacheStores = readCacheStores(process.env);
  if (cacheStores.kind === "refused") {
    return { kind: "refused", message: storeConfigMessage(cacheStores.refusal) };
  }
  return {
    kind: "config",
    config: {
      dist,
      origin,
      home,
      bindHost,
      port,
      allowedOrigins,
      publicOrigin: published.origin,
      github,
      cloudflare,
      cacheStores,
    },
  };
}

function buildRoster(config: HostConfig): ReadonlyArray<Row> {
  const { github, cloudflare } = config;
  return [
    ciRowRecord,
    cacheRowRecord(config.cacheStores.stores),
    ...(github.kind === "config" ? [authRowRecord(github.config)] : []),
    ...(cloudflare.kind === "config"
      ? [
          cloudflareRowRecord({
            token: cloudflare.config.token,
            ...(cloudflare.config.apiBase === null ? {} : { apiBase: cloudflare.config.apiBase }),
            ...(cloudflare.config.probeBase === null
              ? {}
              : { probeBase: cloudflare.config.probeBase }),
          }),
        ]
      : []),
  ];
}

function coreAgentOf(rows: ReadonlyArray<Row>): RowAgent {
  const root = rows.find((row) => row.key === null);
  if (root === undefined) throw new Error("odu: the roster has no root row");
  return root.agent;
}

async function tearDown(parts: {
  readonly stopHandlers: ReadonlyArray<() => void>;
  readonly mcp: { close: () => unknown } | null;
  readonly metricsMounted: { drop: () => Promise<void> } | null;
  readonly scope: Scope.Closeable;
  readonly closeHost: () => Promise<void>;
  readonly gate: { release: () => void };
}): Promise<void> {
  for (const stop of parts.stopHandlers) stop();
  await parts.mcp?.close();
  await parts.metricsMounted?.drop();
  await Effect.runPromise(Scope.close(parts.scope, Exit.void));
  await parts.closeHost();
  parts.gate.release();
}

export async function serveWebService(tenure: Tenure): Promise<number> {
  const reading = readHostConfig();
  if (reading.kind === "refused") {
    process.stderr.write(`${reading.message}\n`);
    return 1;
  }
  const config = reading.config;
  const { dist, origin, home, bindHost, port, allowedOrigins, github } = config;
  const log = tenure.log;
  const controller = new AbortController();

  const gate = await claimPidGate(
    home.gatePath,
    home.socketPath,
    selfProcessIdentity(),
    readProcessIdentity,
  );
  if (gate.kind === "held") return tenure.onGateHeldElsewhere(gate.pid);
  if (gate.kind === "dir-not-private") {
    process.stderr.write(
      `odu: ${gate.dir} is not a private owner-only directory — the web ` +
        "service's home must be yours alone (mode 0700)\n",
    );
    return 1;
  }

  const stopHandlers: (() => void)[] = [];
  for (const signal of tenure.endingSignals ?? []) {
    const onSignal = (): void => controller.abort();
    process.on(signal, onSignal);
    stopHandlers.push(() => process.off(signal, onSignal));
  }

  const unhandled = installUnhandledGuard({ log });
  stopHandlers.push(unhandled.remove);

  const ROWS: ReadonlyArray<Row> = buildRoster(config);

  const run = standing();
  const host = await run(openHost);
  const build = bakedBuild();
  const layers: ClaimedRoutes[] = [];
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
  let mcp: Awaited<ReturnType<typeof serveServiceMcpInProcess>> | null = null;
  let metricsMounted: { drop: () => Promise<void> } | null = null;
  let closed = false;
  const closeHostOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await run(closeHost(host));
  };

  const scope = Scope.makeUnsafe();
  try {
    const hasDoor = github.kind === "config";
    const principals = localBroker({ door: hasDoor });
    const admissions = admissionStore(hasDoor ? NOBODY_ADMISSION : LOCAL_ADMISSION);
    const purges = purgeBroker();
    const grants = grantsBroker();
    const metrics = metricsBroker();
    stopHandlers.push(
      metrics.add({ name: "host/unhandled", read: () => unhandledReading(unhandled) }),
    );
    const rootToken = configured(process.env.ODU_ROOT_TOKEN);
    const stateDir = stateRoot(process.env);
    const metricsTokens = openMetricsTokens(stateDir);
    await run(provide(host, PrincipalBroker, () => principals));
    await run(provide(host, CachePurge, () => purges));
    await run(provide(host, StateDir, () => stateDir));
    await run(provide(host, RootToken, () => rootToken));
    await run(provide(host, CacheGrants, () => grants));
    await run(provide(host, NixStore, () => configured(process.env.ODU_CACHE_STORE)));
    await run(provide(host, DaemonHome, () => home.dir));
    await run(provide(host, BoundOrigin, () => origin));
    await run(provide(host, PublicOrigin, () => config.publicOrigin));
    await run(provide(host, Build, () => build));
    await run(provide(host, Log, () => log));
    await run(provide(host, Shutdown, () => () => controller.abort()));
    await run(provide(host, Routes, () => routes));
    await run(provide(host, Metrics, () => metrics));
    await run(
      provide(host, RowContracts, () => ({
        ...Object.fromEntries(ROWS.map((row) => [row.name, row.contract])),
        [METRICS_ROW.name]: METRICS_ROW.contract,
      })),
    );

    for (const row of ROWS) await run(mountPlugin(host, row.plugin));
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

    const runtime = offered(host, Bundle);
    if (runtime === undefined) {
      process.stderr.write("odu: the ci row offered no runtime — refusing to serve\n");
      return 1;
    }
    metricsMounted = runtime.mount(
      METRICS_KEY,
      oduMetricsSurface,
      metricsFragment({ tokens: metricsTokens, rootToken }),
    );
    const anonymousTags = hasDoor
      ? new Set(Object.keys(TAGS_OPEN_TO_A_SESSIONLESS_CONNECTION))
      : new Set<string>();
    let gated: { readonly source: SurfaceHandlers; readonly handlers: SurfaceHandlers } | null =
      null;
    const served = (): { group: typeof runtime.group; handlers: SurfaceHandlers } => {
      const source = runtime.handlers;
      if (gated === null || gated.source !== source) {
        gated = { source, handlers: gatedHandlers(source, anonymousTags) };
      }
      return { group: runtime.group, handlers: gated.handlers };
    };

    const transport = new RouteTransport();
    mcp = await serveServiceMcpInProcess({
      path: SERVICE_MCP_PATH,
      dispatch: admissionDispatch(
        liveDispatch(() => served().handlers),
        admissions,
      ),
      version: build.oduVersion,
      transport,
      core: coreAgentOf(ROWS),
      siblings: {
        ...Object.fromEntries(
          ROWS.filter((row) => row.key !== null).map((row) => [row.key as string, row.agent]),
        ),
        [METRICS_KEY]: METRICS_AGENT,
      },
    });
    const agentRoutes = Layer.merge(
      Layer.merge(
        Layer.merge(
          mcpRoute(transport, allowedOrigins, SERVICE_MCP_PATH, {
            store: admissions,
            broker: principals,
          }),
          mcpGetRoute(SERVICE_MCP_PATH),
        ),
        doorRoute(hasDoor),
      ),
      Layer.merge(
        rowsRoute([
          ...ROWS.map((row) => row.key).filter((key): key is string => key !== null),
          METRICS_KEY,
        ]),
        metricsRoute({ sources: metrics, rootToken, tokens: metricsTokens }),
      ),
    );
    const composed = routes
      .layers()
      .reduce<RowRoutes>((all, one) => Layer.merge(all, one.layer), agentRoutes);

    let bound: string;
    try {
      bound = await Effect.runPromise(
        serveSurfaceApp(
          servingOptions({
            handlersPerAccept: served,
            dist,
            host: bindHost,
            port,
            allowedOrigins,
            routes: composed,
            upgradeHeaders: UPGRADE_HEADERS,
            services: (connection) => connectionLayer(principals, connection),
            middleware: (app) =>
              bucketDomainGate(() => offered(host, BucketDomains))(
                doorGate({
                  broker: principals,
                  mcpPath: SERVICE_MCP_PATH,
                  signInPage: () => signInPageHtml(),
                  reserved: reservedClaims(routes.layers()),
                })(app),
              ),
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
    await tearDown({
      stopHandlers,
      mcp,
      metricsMounted,
      scope,
      closeHost: closeHostOnce,
      gate,
    });
  }
}

/** The daemon `odu web --background` spawns: quiet, and ended only by `drain`. */
export async function webDaemonCommand(): Promise<number> {
  detachFromInheritedCwd();
  const log = stderrLogger();
  return serveWebService({
    log,
    onGateHeldElsewhere: (pid) => {
      log.info({ pid }, "odu web: a service is already running; yielding");
      return 0;
    },
    onServing: () => {},
  });
}

/**
 * `odu web` — SERVE, HERE, until Ctrl-C.
 */
export async function webCommand(opts: {
  upgrade: boolean;
  json: boolean;
  background: boolean;
  /** WHAT THE BOARD THIS COMMAND HANDS OUT READS — declared by the root, which
   *  names the rows; a running daemon a major behind on any of them is refused
   *  here with the upgrade sentence. */
  needs: RowNeeds;
}): Promise<number> {
  return opts.background ? backgroundWeb(opts) : foregroundWeb(opts);
}

function quietLogger(): Logger {
  const loud = stderrLogger();
  return {
    debug: () => {},
    info: () => {},
    warn: loud.warn,
    error: loud.error,
  };
}

function rowEventPrefix(key: string): string {
  return `odu ${key}:`;
}

export function foregroundLogger(sink: Logger = stderrLogger()): Logger {
  return {
    debug: () => {},
    info: (fields, message, ...rest) => {
      if (typeof message !== "string") return;
      if (!message.startsWith(rowEventPrefix(CACHE_KEY))) return;
      sink.info(fields, message, ...rest);
    },
    warn: sink.warn,
    error: sink.error,
  };
}

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
    log: foregroundLogger(),
    endingSignals: ["SIGINT", "SIGTERM"],
    onGateHeldElsewhere: async (pid) => {
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

async function backgroundWeb(opts: {
  upgrade: boolean;
  json: boolean;
  needs: RowNeeds;
}): Promise<number> {
  const origin = serviceOrigin();
  const outcome = await ensureService({
    origin,
    home: webHome(origin),
    baked: bakedBuild(),
    needs: opts.needs,
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


function detachFromInheritedCwd(): void {
  try {
    process.chdir("/");
  } catch {
  }
}
