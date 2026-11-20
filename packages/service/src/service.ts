import { hostname } from "node:os";
import { isAbsolute } from "node:path";
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
  HOST_CONTRACT_VERSION,
  type ServiceBuild,
  type ServiceCell,
  type ServiceIdentity,
  ServiceRefused,
  UNKNOWN_SERVICE,
  type VenueReading,
} from "@odu/service-client/surface";
import { RUN_RECORD_FORMAT } from "@odu/run-history/schema";
import {
  isCommitPrefix,
  type LogTail,
  type RunRow,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import { cancelRun } from "./cancel";
import { importCatalog, pruneCatalog } from "./catalog";
import { readLog, readRecipeTail } from "./logs";
import { checkoutSource } from "./checkout";
import { nodesSource } from "./nodes";
import { callerOf } from "./caller";
import { may, principalOf, type Principal } from "@odu/cordis/principal";
import type { ServicePorts } from "./ports";
import { reconcileRequests } from "./reconcile";
import { everyAfter, slowTickReporter } from "./poller";
import { createRegistry, type RunRegistry } from "./registry";
import { onceOnly, requestStore } from "./requests";
import { digestOf, optionalPart } from "@odu/run-history/receipts";
import { retryRun } from "./retry";
import { startRun } from "./start";
import { readRun, waitForRun } from "./wait";

export const REFRESH_MS = 250;

export interface ServiceOptions {
  ports: ServicePorts;
  origin: string;
  home: string;
  build: ServiceBuild;
  rows: Readonly<Record<string, string>>;
  catalog?: CatalogOptions;
  requestsRoot?: string;
  onDrain: () => void | Promise<void>;
  refreshMs?: number;
  now?: () => number;
  log?: { warn: (fields: Record<string, unknown>, message: string) => void };
}

export interface OduService {
  runtime: RootedSurfacesRuntime<(typeof oduServiceSurface)["spec"]>;
  registry: RunRegistry;
  refresh: () => void;
  venues: () => VenueReading;
  close: () => Promise<void>;
  done: Promise<void>;
}

export function notAbsolute(
  verb: string,
  checkout: string,
): ServiceRefused | null {
  if (isAbsolute(checkout)) return null;
  return new ServiceRefused({
    code: "checkout_refused",
    message:
      `odu: "${checkout}" is not an absolute path — ${verb} takes the ` +
      "ABSOLUTE path of a checkout, because the service's working directory " +
      "is not the caller's and never was",
  });
}

export function createOduService(opts: ServiceOptions): OduService {
  const now = opts.now ?? Date.now;
  const catalog = opts.catalog ?? {};
  const registry = createRegistry(catalog);
  const requests = requestStore(
    opts.requestsRoot === undefined ? {} : { root: opts.requestsRoot },
  );
  const startedAt = now();

  const adminOnly = (): Effect.Effect<Principal, ServiceRefused> =>
    Effect.flatMap(principalOf, (principal) =>
      may(principal, "admin")
        ? Effect.succeed(principal)
        : Effect.fail(
            new ServiceRefused({
              code: "not_permitted",
              message:
                principal.kind === "user"
                  ? `odu: protect.apply writes branch protection with this daemon's ` +
                    `credential, so it needs an admin — ${principal.login} is a ${principal.role}`
                  : "odu: protect.apply writes branch protection with this daemon's credential, so it needs an admin",
              suggestion: ["odu", "surface", "auth", "user_whoami"],
            }),
          ),
    );

  const rows = new Map<string, RunRow>();
  const tails = new Map<string, LogTail>();
  const watched = new Set<string>();

  const identity: ServiceIdentity = {
    pid: process.pid,
    startedAt,
    home: opts.home,
    origin: opts.origin,
    catalog: registry.catalog,
    protocolVersion: HOST_CONTRACT_VERSION,
    storageVersion: RUN_RECORD_FORMAT,
    rows: { ...opts.rows },
  };
  const serviceStore = inMemoryStore<ServiceCell>({
    ...UNKNOWN_SERVICE,
    identity,
    build: opts.build,
    readiness: { state: "starting", since: startedAt, reconciled: 0 },
  });

  const venueStore = inMemoryStore<VenueReading>(null);

  const runtime = implementRootedSurfaces(
    oduServiceSurface,
    {},
    {
      cells: { service: { store: serviceStore }, venues: { store: venueStore } },
      collections: {
        runs: {
          readAll: () => rows,
          upsert: (key, value) => {
            rows.set(key, value);
          },
          remove: (key) => {
            rows.delete(key);
          },
        },
        logTails: {
          readAll: () => tails,
          readOne: (key) => tails.get(key) ?? readRecipeTail(key, catalog) ?? undefined,
          upsert: (key, value) => {
            tails.set(key, value);
          },
          remove: (key) => {
            tails.delete(key);
          },
          holders: (key) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                watched.add(key);
                const tail = readRecipeTail(key, catalog);
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
            poll: () => {},
          }),
        },
        checkout: {
          source: checkoutSource({
            registry,
            poll: () => {},
          }),
        },
      },
      procedures: {
        run: {
          start: ({ input }) =>
            Effect.flatMap(principalOf, (principal) =>
              Effect.tap(
                startRun(
                  input,
                  {
                    launch: opts.ports.launch,
                    probeCheckout: opts.ports.probeCheckout,
                    moveCheckout: opts.ports.moveCheckout,
                    cancel: opts.ports.cancel,
                    push: opts.ports.push,
                    requests,
                    catalog,
                    host: hostname(),
                    now,
                  },
                  principal,
                ),
                () => Effect.sync(refresh),
              ),
            ),
          wait: ({ input }) => waitForRun(input, { catalog }),
          read: ({ input }) => readRun(input, { catalog }),
          retry: ({ input }) =>
            Effect.tap(
              retryRun(input, { retry: opts.ports.retry, catalog }),
              () => Effect.sync(refresh),
            ),
          list: ({ input }) =>
            Effect.suspend(() => {
              if (input.checkout !== undefined) {
                const bad = notAbsolute("run.list", input.checkout);
                if (bad !== null) return Effect.fail(bad);
              }
              if (input.sha !== undefined && !isCommitPrefix(input.sha)) {
                return Effect.fail(
                  new ServiceRefused({
                    code: "bad_input",
                    message:
                      `odu: "${input.sha}" is not a commit prefix — run.list's ` +
                      "`sha` takes at least 7 hex digits",
                  }),
                );
              }
              if (input.seq !== undefined && input.sha === undefined) {
                return Effect.fail(
                  new ServiceRefused({
                    code: "bad_input",
                    message:
                      "odu: run.list's `seq` numbers the runs of ONE commit — " +
                      "name the commit with `sha` as well",
                  }),
                );
              }
              return Effect.succeed(registry.select(input));
            }),
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
        catalog: {
          import: ({ input }) =>
            Effect.tap(
              importCatalog(input, {
                probeCheckout: opts.ports.probeCheckout,
                requests,
                catalog,
                now,
              }),
              () => Effect.sync(refresh),
            ),
          prune: ({ input }) =>
            Effect.tap(
              pruneCatalog(input, { requests, catalog, now }),
              () => Effect.sync(refresh),
            ),
        },
        pipeline: {
          read: ({ input }) =>
            Effect.suspend(() => {
              const bad = notAbsolute("pipeline.read", input.checkout);
              if (bad !== null) return Effect.fail(bad);
              const outcome = opts.ports.pipeline({
                checkout: input.checkout,
                ...(input.root === undefined ? {} : { root: input.root }),
              });
              return outcome.ok
                ? Effect.succeed({
                    checkout: input.checkout,
                    name: outcome.facts.name,
                    tasks: outcome.facts.tasks,
                    mermaid: outcome.facts.mermaid,
                  })
                : Effect.fail(
                    new ServiceRefused({
                      code: "pipeline_refused",
                      message: outcome.message,
                    }),
                  );
            }),
        },
        venue: {
          probe: ({ input }) =>
            Effect.flatMap(principalOf, (principal) =>
              Effect.flatMap(
                Effect.promise(() => {
                  const keep = (reading: VenueReading): void => {
                    venueStore.set(reading);
                    runtime.ctx.cells.venues.set(reading);
                  };
                  const mine = input.hostsFile === undefined;
                  return opts.ports.probeVenues({
                    platforms: input.platforms ?? [],
                    caller: callerOf(input, principal),
                    ...(mine
                      ? {
                          onReading: (partial) =>
                            keep({
                              at: now(),
                              platforms: [...(input.platforms ?? [])],
                              ...partial,
                            }),
                        }
                      : {}),
                  });
                }),
                (outcome) => {
                  if (!outcome.ok) {
                    return Effect.fail(
                      new ServiceRefused({
                        code: "no_venue",
                        message: outcome.message,
                        suggestion: ["odu", "ci", "hosts"],
                      }),
                    );
                  }
                  const answer = {
                    source: outcome.source,
                    warnings: outcome.warnings,
                    rows: outcome.rows,
                  };
                  if (input.hostsFile === undefined) {
                    const reading: VenueReading = {
                      at: now(),
                      platforms: [...(input.platforms ?? [])],
                      ...answer,
                    };
                    venueStore.set(reading);
                    runtime.ctx.cells.venues.set(reading);
                  }
                  return Effect.succeed(answer);
                },
              ),
            ),
          hold: ({ input }) =>
            Effect.flatMap(
              Effect.suspend(() => {
                const bad = notAbsolute("venue.hold", input.checkout);
                if (bad !== null) return Effect.fail(bad);
                return Effect.flatMap(principalOf, (principal) =>
                  Effect.promise(() =>
                  onceOnly(
                    requests,
                    {
                      requestId: input.requestId,
                      kind: "venue.hold",
                      digest: digestOf([
                        input.checkout,
                        [...(input.platforms ?? [])].join(","),
                        optionalPart(input.hostsFile),
                        input.noWait ?? false,
                      ]),
                      now: now(),
                    },
                    () =>
                      opts.ports.holdVenue({
                        checkout: input.checkout,
                        platforms: input.platforms ?? [],
                        caller: callerOf(input, principal),
                        noWait: input.noWait ?? false,
                      }),
                  ),
                  ),
                );
              }),
              (answered) => {
                if (!answered.ok) return Effect.fail(answered.refusal);
                const outcome = answered.value;
                return outcome.ok
                  ? Effect.succeed({
                      results: outcome.results,
                      replayed: answered.replayed,
                    })
                  : Effect.fail(
                      new ServiceRefused({
                        code: "no_venue",
                        message: outcome.message,
                        suggestion: ["odu", "ci", "hosts"],
                      }),
                    );
              },
            ),
          release: ({ input }) =>
            Effect.flatMap(
              Effect.suspend(() => {
                const bad = notAbsolute("venue.release", input.checkout);
                if (bad !== null) return Effect.fail(bad);
                return Effect.flatMap(principalOf, (principal) =>
                  Effect.promise(() =>
                  onceOnly(
                    requests,
                    {
                      requestId: input.requestId,
                      kind: "venue.release",
                      digest: digestOf([
                        input.checkout,
                        [...(input.platforms ?? [])].join(","),
                        optionalPart(input.hostsFile),
                      ]),
                      now: now(),
                    },
                    () =>
                      opts.ports.releaseVenue({
                        checkout: input.checkout,
                        platforms: input.platforms ?? [],
                        caller: callerOf(input, principal),
                      }),
                  ),
                  ),
                );
              }),
              (answered) =>
                answered.ok
                  ? Effect.succeed({
                      released: answered.value.results,
                      replayed: answered.replayed,
                    })
                  : Effect.fail(answered.refusal),
            ),
        },
        protect: {
          apply: ({ input }) =>
            Effect.flatMap(adminOnly(), (principal) =>
            Effect.flatMap(
              Effect.suspend(() => {
                const bad = notAbsolute("protect.apply", input.checkout);
                if (bad !== null) return Effect.fail(bad);
                if (input.dryRun === true) {
                  return Effect.promise(async () => ({
                    ok: true as const,
                    replayed: false,
                    value: await opts.ports.protect({
                      checkout: input.checkout,
                      ...(input.branch === undefined ? {} : { branch: input.branch }),
                      platforms: input.platforms ?? [],
                      caller: callerOf(input, principal),
                      dryRun: true,
                      create: input.create ?? false,
                    }),
                  }));
                }
                return Effect.promise(() =>
                  onceOnly(
                    requests,
                    {
                      requestId: input.requestId,
                      kind: "protect.apply",
                      digest: digestOf([
                        input.checkout,
                        optionalPart(input.branch),
                        [...(input.platforms ?? [])].join(","),
                        optionalPart(input.hostsFile),
                        input.create ?? false,
                      ]),
                      now: now(),
                    },
                    () =>
                      opts.ports.protect({
                        checkout: input.checkout,
                        ...(input.branch === undefined
                          ? {}
                          : { branch: input.branch }),
                        platforms: input.platforms ?? [],
                        caller: callerOf(input, principal),
                        dryRun: false,
                        create: input.create ?? false,
                      }),
                  ),
                );
              }),
              (answered) => {
                if (!answered.ok) return Effect.fail(answered.refusal);
                const outcome = answered.value;
                return outcome.ok
                  ? Effect.succeed({
                      ...outcome.facts,
                      dryRun: input.dryRun ?? false,
                      replayed: answered.replayed,
                    })
                  : Effect.fail(
                      new ServiceRefused({
                        code: outcome.code,
                        message: outcome.message,
                        ...(outcome.suggestion === undefined
                          ? {}
                          : { suggestion: outcome.suggestion }),
                      }),
                    );
              },
            ),
            ),
        },
      },
    },
  );

  runtime.mount(
    "control",
    controlCoreSurface,
    controlCoreFragment({
      stateRoot: opts.home,
      surfaceVersion: HOST_CONTRACT_VERSION,
      startedAt,
      commit: opts.build.commit ?? "",
      buildId: opts.build.buildId ?? "",
      onDrain: () => {
        serviceStore.set({
          ...serviceStore.get(),
          readiness: { ...serviceStore.get().readiness, state: "draining", since: now() },
        });
        runtime.ctx.cells.service.set(serviceStore.get());
        return opts.onDrain();
      },
    }),
  );

  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const reportSlow = slowTickReporter(
    refreshMs,
    ({ durationMs, runs }) =>
      opts.log?.warn(
        { durationMs: Math.round(durationMs), runs },
        "odu web: a catalog refresh outran its interval; the board lags, RPCs do not",
      ),
  );

  const revokedPushTokens = new Set<string>();
  const stillServed = (row: RunRow): boolean =>
    row.endpoint !== null && row.state === "settled" && registry.ownerAliveOf(row.runId);
  const revokeFinishedPushTokens = (rows: readonly RunRow[]): void => {
    for (const row of rows) {
      if (row.state === "provisioning" || row.state === "running") continue;
      if (stillServed(row)) continue;
      const tokenId = registry.pushTokenOf(row.runId);
      if (tokenId === null || revokedPushTokens.has(tokenId)) continue;
      revokedPushTokens.add(tokenId);
      opts.ports.push.revoke(tokenId);
    }
  };

  const refresh = (): void => {
    const delta = registry.refresh(now());
    revokeFinishedPushTokens(delta.upserted);
    for (const row of delta.upserted) runtime.ctx.collections.runs.upsert(row.runId, row);
    for (const runId of delta.removed) runtime.ctx.collections.runs.remove(runId);
    for (const key of watched) {
      const tail = readRecipeTail(key, catalog);
      if (tail === null) continue;
      const held = tails.get(key);
      if (held !== undefined && held.text === tail.text && held.complete === tail.complete) {
        continue;
      }
      runtime.ctx.collections.logTails.upsert(key, tail);
    }
  };

  const reconciled = reconcileRequests({ requests, catalog, now: now(), host: hostname() });
  refresh();
  serviceStore.set({
    ...serviceStore.get(),
    readiness: { state: "ready", since: now(), reconciled },
  });
  runtime.ctx.cells.service.set(serviceStore.get());

  const stopPolling = everyAfter(() => {
    const began = performance.now();
    refresh();
    const ended = performance.now();
    reportSlow(ended - began, registry.size(), ended);
  }, refreshMs);

  return {
    runtime,
    registry,
    refresh,
    venues: () => venueStore.get(),
    close: async () => {
      stopPolling();
      await runtime.close();
    },
    done: runtime.done,
  };
}
