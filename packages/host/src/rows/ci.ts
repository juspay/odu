/**
 * THE `ci` ROW — the runs. The board, the coordinators, the catalog, the
 * venues, the forge.
 *
 * A row is a `definePlugin`: it names what it needs, builds its share of the
 * daemon while that scope is open, and has everything it registered unwound in
 * reverse when the scope closes. So "close the service" is a property of
 * activation rather than a line in a `finally` somebody could reorder.
 *
 * ## What it serves, and why the ROOT
 *
 * `@odu/service`'s runtime is the wire's unprefixed CORE: its tags are bare
 * (`surface/runs/get`), which is why the browser dials it as the `core` slot,
 * the CLI mounts it with bare verb names (`odu surface run_start`) and an agent
 * sees `run_start`. That is the shape the whole contract was published in, so
 * the runs row keeps it: a row becomes a SIBLING when it is something served
 * BESIDE the runs, and the runs are what the wire is about.
 *
 * The daemon's frozen `control` fragment comes with that runtime —
 * `createOduService` mounts it, `@kolu/surface-daemon-supervisor`'s identity
 * probe looks for it there, and nothing about that changes here.
 *
 * ## What it does NOT bring
 *
 * The protocol routes and the `/mcp` door are the TRANSPORT's and are the host's
 * to assemble: the cache's routes belong to the cache row and are merged beside
 * these, and the MCP adapter serves the composed bundle rather than one row. A
 * row that carried either would have to know what its siblings are.
 */

import { Effect } from "effect";
import { definePlugin } from "@olai/effect-cordis";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import { createOduService } from "@odu/service/service";
import { oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE, ODU_SERVICE_MCP_INSTRUCTIONS } from "@odu/service-client/verbs";
import { webPorts } from "../webPorts";
import {
  BoundOrigin,
  Build,
  DaemonHome,
  Log,
  Rows,
  Shutdown,
} from "../services";

export const CI_ROW = "ci";

export const ciRow = definePlugin({
  name: CI_ROW,
  needs: [Rows, DaemonHome, BoundOrigin, Build, Log, Shutdown],
  apply: Effect.gen(function* () {
    const rows = yield* Rows;
    const home = yield* DaemonHome;
    const origin = yield* BoundOrigin;
    const build = yield* Build;
    const log = yield* Log;
    const shutdown = yield* Shutdown;

    // THE COMPOSITION, bound: the ports to the engine. The cache is NOT here —
    // it is its own row — so what this binds is exactly what a run needs.
    const { ports } = webPorts();
    const service = createOduService({
      ports,
      origin,
      home,
      build,
      log,
      // The frozen control fragment's `drain`, wired to the process's own stop.
      // A supervisor asks; the daemon decides how it ends.
      onDrain: shutdown,
    });

    // WHAT THIS ROW BUILT GOES, WHEN THIS ROW GOES — in reverse, and before the
    // listener's own scope closes.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        rows.drop(CI_ROW);
        await service.close();
      }),
    );

    rows.put(CI_ROW, {
      runtime: service.runtime as unknown as RootedSurfacesRuntime<never>,
      attach: null,
      routes: null,
      agent: {
        surface: oduServiceSurface,
        expose: ODU_SERVICE_EXPOSE,
        instructions: ODU_SERVICE_MCP_INSTRUCTIONS,
      },
      done: service.done,
    });
  }),
});
