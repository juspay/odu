/**
 * THE `ci` ROW — the runs. The board, the coordinators, the catalog, the
 * venues, the forge, and the `/mcp` door onto all of it.
 *
 * A row is a `definePlugin`: it names what it needs, builds its share of the
 * daemon while that scope is open, and has everything it registered unwound in
 * reverse when the scope closes. So the two things this file used to have to
 * remember — "close the service", "close the MCP adapter" — are now properties
 * of activation rather than lines in a `finally` somebody could reorder.
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
 */

import { Layer } from "effect";
import { Effect } from "effect";
import { definePlugin } from "@olai/effect-cordis";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import { cacheRoutes } from "@odu/cache/routes";
import { createOduService } from "@odu/service/service";
import {
  mcpGetRoute,
  mcpRoute,
  RouteTransport,
  serveServiceMcpInProcess,
} from "../mcpRoute";
import { webPorts } from "../webPorts";
import {
  AllowedOrigins,
  BoundOrigin,
  Build,
  DaemonHome,
  Log,
  NixStore,
  PublicOrigin,
  RootToken,
  Rows,
  Shutdown,
  StateDir,
} from "../services";

export const CI_ROW = "ci";

export const ciRow = definePlugin({
  name: CI_ROW,
  needs: [
    Rows,
    StateDir,
    RootToken,
    NixStore,
    DaemonHome,
    BoundOrigin,
    PublicOrigin,
    AllowedOrigins,
    Build,
    Log,
    Shutdown,
  ],
  apply: Effect.gen(function* () {
    const rows = yield* Rows;
    const stateDir = yield* StateDir;
    const rootToken = yield* RootToken;
    const store = yield* NixStore;
    const allowedOrigins = yield* AllowedOrigins;
    const home = yield* DaemonHome;
    const origin = yield* BoundOrigin;
    const publicOrigin = yield* PublicOrigin;
    const build = yield* Build;
    const log = yield* Log;
    const shutdown = yield* Shutdown;

    // THE COMPOSITION, bound: the ports to the engine, plus (until the cache is
    // its own row) the cache this daemon serves and administers. The state root
    // is the HOST's fact and travels in rather than being re-derived here.
    const { ports, cache } = webPorts({ stateDir, rootToken, store });
    const service = createOduService({
      ports,
      origin,
      ...(publicOrigin === null ? {} : { publicOrigin }),
      home,
      build,
      log,
      // The frozen control fragment's `drain`, wired to the process's own stop.
      // A supervisor asks; the daemon decides how it ends.
      onDrain: shutdown,
    });

    // The adapter and its transport are one pair for the listener's life: an
    // MCP `Server` binds exactly one transport, and re-making them per request
    // would rebuild the expose walk and the resource pusher on every call.
    const transport = new RouteTransport();
    const mcp = yield* Effect.promise(() =>
      serveServiceMcpInProcess({
        handlers: service.runtime.handlers,
        version: build.oduVersion,
        transport,
      }),
    );

    // WHAT THIS ROW BUILT GOES, WHEN THIS ROW GOES — in reverse, and before the
    // listener's own scope closes. The database handle is this process's, and a
    // tenure that ended is a tenure whose SQLite connection must not outlive
    // it.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        rows.drop(CI_ROW);
        await mcp.close();
        await service.close();
        cache.close();
      }),
    );

    rows.put(CI_ROW, {
      runtime: service.runtime as unknown as RootedSurfacesRuntime<never>,
      mount: null,
      // The `/mcp` door, and — until the cache is its own row — the cache's
      // protocol routes. Both are the ROW's, which is the point of a row
      // contributing routes at all: the host merges them and knows what
      // neither is.
      routes: Layer.merge(
        Layer.merge(mcpRoute(transport, allowedOrigins), mcpGetRoute()),
        cacheRoutes(cache),
      ),
      done: service.done,
    });
  }),
});
