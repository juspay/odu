/**
 * THE `ci` ROW — the runs, as the daemon mounts it. The board's data, the
 * coordinators, the catalog, the venues, the forge — and the ROOTED BUNDLE every
 * sibling row is served beside.
 *
 * ## The runs are the ROOT, and they are still a plugin
 *
 * The runs' members keep the bare `surface/runs/get` tags every face was
 * published against, so `implementRootedSurfaces` takes their surface as a
 * CONSTRUCTOR ARGUMENT rather than mounting it as a sibling. That is kolu's
 * construction detail, not Cordis's: a plugin can build the runtime inside its
 * own `apply` and, since this package is in the `ci` row, the rest of the row's
 * machinery comes with it.
 *
 * ## It OFFERS the bundle, and closes itself
 *
 * `offer(Bundle, provision)` is effect-cordis's root door, callable from inside
 * an `apply`; its provision becomes available when this row is ACTIVE, and
 * `settled()` is the door for "a row that provides while it applies wakes its
 * dependents". So the host mounts `ci` and `cache` together and waits: the cache
 * is held PENDING on `Bundle` until this row offers it, and then mounts itself.
 *
 * The runtime's teardown is this row's finalizer — the caller owns nothing. A
 * host that built the bundle instead would own a runtime it had no way to
 * close, which is exactly the bug this shape removes.
 */

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
  Build,
  Bundle,
  DaemonHome,
  Log,
  type Row,
  type RowAgent,
  RowContracts,
  Shutdown,
} from "@odu/cordis/services";
import { webPorts } from "./webPorts";

/** WHAT AN AGENT IS TOLD about the runs — the row's own words, beside the row. */
export const CI_AGENT: RowAgent = {
  surface: oduServiceSurface,
  expose: ODU_SERVICE_EXPOSE,
  instructions: ODU_SERVICE_MCP_INSTRUCTIONS,
};

export const ciRow = definePlugin({
  name: CI_ROW,
  needs: [DaemonHome, BoundOrigin, Build, Log, Shutdown, RowContracts],
  apply: Effect.gen(function* () {
    const home = yield* DaemonHome;
    const origin = yield* BoundOrigin;
    const build = yield* Build;
    const log = yield* Log;
    const shutdown = yield* Shutdown;
    // Every mounted row's own version, published on the identity cell as the
    // host composed it. The runs carry it; they do not read it.
    const rows = yield* RowContracts;

    // THE COMPOSITION, bound: the ports to the engine. Everything the runs must
    // CAUSE — launch, retry, cancel, the checkout probe, the pipeline, the
    // venues, the forge — arrives here, and the engine knows none of it.
    const { ports } = webPorts();
    const service: OduService = createOduService({
      ports,
      origin,
      home,
      build,
      rows,
      log,
      // The frozen control fragment's `drain`, wired to the process's own stop.
      onDrain: shutdown,
    });

    // A runtime that has faulted answers nothing while the process stays alive
    // and the socket stays open — the documented zombie. Observed and fatal;
    // nothing else in the process can see it.
    service.done.catch((err: unknown) => {
      log.error({ err: String(err) }, "odu web: surface runtime faulted");
      process.exit(1);
    });

    // THE BUNDLE, for the rows served beside this one. Offered before the
    // finalizer is registered, so a sibling can mount while this activation is
    // still starting and `settled()` has something to wait for.
    yield* offer(Bundle, () => service.runtime as unknown as RootedSurfacesRuntime<never>);

    yield* Effect.addFinalizer(() => Effect.promise(() => service.close()));
  }),
});

/**
 * THIS ROW, AS THE HOST LISTS IT — the runs, the wire's ROOT, so `key` is null. One value the row owns: its word on
 * the wire, its plugin, what an agent is told and its own contract version,
 * read off its own modules. The host composes these records and names none of
 * their parts.
 */
export const ciRowRecord: Row = {
  name: CI_ROW,
  key: null,
  plugin: ciRow,
  agent: CI_AGENT,
  contract: CI_CONTRACT_VERSION,
};
