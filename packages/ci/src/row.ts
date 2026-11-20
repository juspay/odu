import { Effect } from "effect";
import { definePlugin, offer } from "@olai/effect-cordis";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import { createOduService, type OduService } from "@odu/service/service";
import { CI_CONTRACT_VERSION, CI_ROW, oduServiceSurface } from "@odu/service-client/surface";
import {
  ODU_SERVICE_EXPOSE,
  ODU_SERVICE_MCP_INSTRUCTIONS,
} from "@odu/service-client/verbs";
import {
  BoundOrigin,
  CacheGrants,
  Build,
  Bundle,
  DaemonHome,
  Log,
  Metrics,
  type Row,
  type RowAgent,
  RowContracts,
  Shutdown,
} from "@odu/cordis/services";
import { runMetricsReader } from "./runMetrics";
import { webPorts } from "./webPorts";

export const CI_AGENT: RowAgent = {
  surface: oduServiceSurface,
  expose: ODU_SERVICE_EXPOSE,
  instructions: ODU_SERVICE_MCP_INSTRUCTIONS,
};

export const ciRow = definePlugin({
  name: CI_ROW,
  needs: [DaemonHome, BoundOrigin, Build, Log, Shutdown, RowContracts, Metrics, CacheGrants],
  apply: Effect.gen(function* () {
    const metrics = yield* Metrics;
    const grants = yield* CacheGrants;
    const home = yield* DaemonHome;
    const origin = yield* BoundOrigin;
    const build = yield* Build;
    const log = yield* Log;
    const shutdown = yield* Shutdown;
    const rows = yield* RowContracts;

    const { ports } = webPorts(grants, process.env);
    const service: OduService = createOduService({
      ports,
      origin,
      home,
      build,
      rows,
      log,
      onDrain: shutdown,
    });

    service.done.catch((err: unknown) => {
      log.error({ err: String(err) }, "odu web: surface runtime faulted");
      process.exit(1);
    });

    yield* offer(Bundle, () => service.runtime as unknown as RootedSurfacesRuntime<never>);

    const withdrawMetrics = metrics.add({
      name: CI_ROW,
      read: runMetricsReader({
        catalog: service.registry.catalog,
        venues: () => service.venues(),
      }),
    });

    yield* Effect.addFinalizer(() => Effect.promise(() => service.close()));
    yield* Effect.addFinalizer(() => Effect.sync(withdrawMetrics));
  }),
});

/** THIS ROW, AS THE HOST LISTS IT — the runs, the wire's ROOT, so `key` is
 *  null. */
export const ciRowRecord: Row = {
  name: CI_ROW,
  key: null,
  plugin: ciRow,
  agent: CI_AGENT,
  contract: CI_CONTRACT_VERSION,
};
