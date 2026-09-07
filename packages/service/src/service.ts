/**
 * The SERVICE RUNTIME — one implementation of `oduServiceSurface`, served
 * through every door.
 *
 * There is exactly one of these per daemon, and every face is a client of it:
 * the browser over the framework's websocket, the generated CLI over the same
 * websocket, an HTTP agent through the MCP adapter on `/mcp`, and the `odu mcp`
 * stdio bridge over its own dial. None of them carries domain logic, because
 * all of it is here — which is what makes "the same run looks the same through
 * every face" a property of the code rather than a claim about it.
 *
 * **A ROOTED bundle, and the shape is load-bearing.** The service surface is
 * the unprefixed CORE, so its wire tags are bare (`surface/runs/get`) — which is
 * why a browser dials it with `connectSurface`, the CLI mounts it with bare verb
 * names (`odu surface run_start`), and an agent sees `run_start` rather than
 * `app_run_start`. The daemon's frozen control fragment is mounted as the
 * SIBLING `control`, which is exactly where `@kolu/surface-daemon-supervisor`'s
 * identity probe looks for it. One group, two doors, no adapter between them.
 *
 * **The registry owns the clock; the surface owns the publish.** A single
 * poller re-projects the catalog and drives `ctx` — so a run started by
 * `odu run` in a terminal appears on every open board within a tick, without
 * anything having told the service about it. The alternative (re-reading the
 * catalog inside each collection read) would put a disk walk on the path of
 * every subscribe and every publish.
 */

import { hostname } from "node:os";
import {
  controlCoreFragment,
  controlCoreSurface,
} from "@kolu/surface-daemon/control-core";
import {
  implementRootedSurfaces,
  inMemoryStore,
  type RootedSurfacesRuntime,
} from "@kolu/surface/server";
import type { CatalogOptions } from "@odu/run-history/store";
import {
  oduServiceSurface,
  SERVICE_CONTRACT_VERSION,
  type ServiceBuild,
  type ServiceCell,
  type ServiceIdentity,
  UNKNOWN_SERVICE,
} from "@odu/service-client/surface";
import { RUN_RECORD_FORMAT } from "@odu/run-history/schema";
import type { LogTail, RunRow } from "@odu/service-client/surface";
import { Effect } from "effect";
import { cancelRun } from "./cancel";
import { readLog, readTail } from "./logs";
import { nodesSource } from "./nodes";
import type { ServicePorts } from "./ports";
import { reconcileRequests } from "./reconcile";
import { createRegistry, type RunRegistry } from "./registry";
import { requestStore } from "./requests";
import { retryRun } from "./retry";
import { startRun } from "./start";
import { waitForRun } from "./wait";

/** How often the catalog is re-projected. Fast enough that a board feels live,
 *  slow enough that an idle daemon watching a hundred settled runs costs three
 *  `stat`s each per tick and nothing else. */
export const REFRESH_MS = 250;

export interface ServiceOptions {
  ports: ServicePorts;
  /** WHERE the daemon is bound — the OS's answer, not the request, so a
   *  caller reading the identity cell learns the address that actually works. */
  origin: string;
  /** The daemon's on-disk home (gate + control socket live under it). */
  home: string;
  build: ServiceBuild;
  catalog?: CatalogOptions;
  /** The service's own state root (request receipts). Injected for tests. */
  requestsRoot?: string;
  /** Called when the frozen control fragment's `drain` is invoked — the
   *  supervisor's half of a live upgrade. The daemon aborts its own controller
   *  here; nothing else in this package knows how a process ends. */
  onDrain: () => void | Promise<void>;
  refreshMs?: number;
  now?: () => number;
}

export interface OduService {
  runtime: RootedSurfacesRuntime<(typeof oduServiceSurface)["spec"]>;
  registry: RunRegistry;
  /** Re-project the catalog once, out of band — what a mutation calls so its
   *  own effect is on the board before it answers. */
  refresh: () => void;
  /** Stop the poller and release the runtime. */
  close: () => Promise<void>;
  /** Structural wiring death. A serving site must observe it and treat a
   *  rejection as fatal — a runtime that has faulted answers nothing while the
   *  process stays alive and the socket stays open. */
  done: Promise<void>;
}

export function createOduService(opts: ServiceOptions): OduService {
  const now = opts.now ?? Date.now;
  const catalog = opts.catalog ?? {};
  const registry = createRegistry(catalog);
  const requests = requestStore(
    opts.requestsRoot === undefined ? {} : { root: opts.requestsRoot },
  );
  const startedAt = now();

  // ── the two derived stores the surface publishes from ──
  //
  // Held here rather than read through on every access, because a collection's
  // `readAll` runs on every subscribe AND every publish: a `readAll` that
  // walked the catalog would turn one run's status change into a full re-read
  // per open tab.
  const rows = new Map<string, RunRow>();
  const tails = new Map<string, LogTail>();
  /** Log keys somebody is actually subscribed to. The framework's per-key
   *  `holders` seam puts a key in here for the life of one subscription and
   *  takes it out when that subscription's scope closes — so the poller re-reads
   *  the logs being watched and no others, and an unwatched attempt costs
   *  nothing at all. */
  const watched = new Set<string>();

  const identity: ServiceIdentity = {
    pid: process.pid,
    startedAt,
    home: opts.home,
    origin: opts.origin,
    catalog: registry.catalog,
    protocolVersion: SERVICE_CONTRACT_VERSION,
    storageVersion: RUN_RECORD_FORMAT,
  };
  const serviceStore = inMemoryStore<ServiceCell>({
    ...UNKNOWN_SERVICE,
    identity,
    build: opts.build,
    readiness: { state: "starting", since: startedAt, reconciled: 0 },
  });

  const runtime = implementRootedSurfaces(
    oduServiceSurface,
    {},
    {
      cells: { service: { store: serviceStore } },
      collections: {
        runs: {
          readAll: () => rows,
          // PERSISTENCE ONLY — the framework wraps these to publish. The
          // registry is the authority on what a row says; these are how the
          // poller's answer reaches subscribers.
          upsert: (key, value) => {
            rows.set(key, value);
          },
          remove: (key) => {
            rows.delete(key);
          },
        },
        logTails: {
          readAll: () => tails,
          // A tail is read from disk on demand: the key space is every attempt
          // of every run, and materialising it would be a directory walk per
          // subscribe. `readAll` answers what is being WATCHED, which is what a
          // key listing of a live view honestly is.
          readOne: (key) => tails.get(key) ?? readTail(key, catalog) ?? undefined,
          upsert: (key, value) => {
            tails.set(key, value);
          },
          remove: (key) => {
            tails.delete(key);
          },
          // The subscription's own lifetime, handed to us by the framework: a
          // key is watched for exactly as long as somebody is subscribed to it.
          holders: (key) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                watched.add(key);
                const tail = readTail(key, catalog);
                if (tail !== null) tails.set(key, tail);
              }),
              () =>
                Effect.sync(() => {
                  watched.delete(key);
                  tails.delete(key);
                }),
            ),
        },
      },
      streams: {
        nodes: {
          source: nodesSource({
            registry,
            // The poller owns the clock. A subscription asks for a refresh and
            // gets whatever the last tick produced — one catalog walk per tick
            // rather than one per open detail view.
            poll: () => {},
          }),
        },
      },
      procedures: {
        run: {
          start: ({ input }) =>
            Effect.tap(
              startRun(input, {
                launch: opts.ports.launch,
                probeCheckout: opts.ports.probeCheckout,
                requests,
                catalog,
                host: hostname(),
                now,
              }),
              // The board must already show the run this call just started
              // before the answer leaves: an agent that starts a run and
              // immediately reads the board is the ordinary case, and "I just
              // created it and it is not there" is the one thing a projection
              // must never say.
              () => Effect.sync(refresh),
            ),
          wait: ({ input }) => waitForRun(input, { catalog }),
          retry: ({ input }) =>
            Effect.tap(
              retryRun(input, { retry: opts.ports.retry, catalog }),
              () => Effect.sync(refresh),
            ),
          cancel: ({ input }) =>
            Effect.tap(
              cancelRun(input, {
                cancel: opts.ports.cancel,
                requests,
                catalog,
                now,
              }),
              () => Effect.sync(refresh),
            ),
        },
        log: { read: ({ input }) => readLog(input, { catalog }) },
      },
    },
  );

  // The daemon spine's frozen identity/drain fragment, mounted as the sibling
  // the supervisor's probe looks for. `surfaceVersion` is THIS surface's
  // contract version, which is what a converging supervisor compares — so a
  // daemon speaking an older contract is recycled rather than adopted.
  runtime.mount(
    "control",
    controlCoreSurface,
    controlCoreFragment({
      stateRoot: opts.home,
      surfaceVersion: SERVICE_CONTRACT_VERSION,
      startedAt,
      commit: opts.build.commit ?? "",
      buildId: opts.build.buildId ?? "",
      onDrain: () => {
        // Say so on the wire BEFORE the process starts going away, so a browser
        // that is watching sees `draining` rather than a socket that closed.
        serviceStore.set({
          ...serviceStore.get(),
          readiness: { ...serviceStore.get().readiness, state: "draining", since: now() },
        });
        runtime.ctx.cells.service.set(serviceStore.get());
        return opts.onDrain();
      },
    }),
  );

  /** Re-project the catalog and publish what moved. */
  const refresh = (): void => {
    const delta = registry.refresh(now());
    for (const row of delta.upserted) runtime.ctx.collections.runs.upsert(row.runId, row);
    for (const runId of delta.removed) runtime.ctx.collections.runs.remove(runId);
    for (const key of watched) {
      const tail = readTail(key, catalog);
      if (tail === null) continue;
      const held = tails.get(key);
      // Only when the bytes actually moved: a tail that is identical is not
      // news, and publishing one would wake every open log view every tick.
      if (held !== undefined && held.text === tail.text && held.complete === tail.complete) {
        continue;
      }
      runtime.ctx.collections.logTails.upsert(key, tail);
    }
  };

  // ── startup: reconcile, then say ready ──
  //
  // A caller that read the board during this window would see a partial catalog
  // with no way to tell — which is why `starting` is a state on the wire rather
  // than a gap before the first frame.
  const reconciled = reconcileRequests({ requests, catalog, now: now(), host: hostname() });
  refresh();
  serviceStore.set({
    ...serviceStore.get(),
    readiness: { state: "ready", since: now(), reconciled },
  });
  runtime.ctx.cells.service.set(serviceStore.get());

  const timer = setInterval(refresh, opts.refreshMs ?? REFRESH_MS);
  // The poller must not hold the process open on its own: the daemon's lifetime
  // is the gate's and the listener's, and a bare interval would keep it alive
  // after both were closed — the lingering-daemon class.
  timer.unref?.();

  return {
    runtime,
    registry,
    refresh,
    close: async () => {
      clearInterval(timer);
      await runtime.close();
    },
    done: runtime.done,
  };
}
