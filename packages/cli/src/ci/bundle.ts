/**
 * THE `ci` ROW — the runs. The board, the coordinators, the catalog, the
 * venues, the forge, and the rooted bundle every other row is served beside.
 *
 * ## Why this is not a `definePlugin`
 *
 * A row is a capability, and the runs are the ROOT of the composed wire: their
 * members keep the bare `surface/runs/get` tags every face was published
 * against, and `implementRootedSurfaces` takes the root surface as a
 * CONSTRUCTOR ARGUMENT rather than mounting it as a sibling. So the host builds
 * this row, and the plugin API is for the rows that are served BESIDE it.
 *
 * That is also what makes the Cordis picture honest: the cache, which IS a
 * plugin, declares `needs` and mounts itself on the bundle this function
 * returns. The bundle is provided to it as a service by the host
 * (`@odu/cordis`'s `Bundle`), so nothing reaches across a package boundary
 * outside a declared service.
 *
 * ## What it is made of
 *
 * The ports bound to the engine (`./webPorts` and the adapters beside it), the
 * service runtime that serves the runs' contract, and the frozen `control`
 * fragment `createOduService` mounts on it — which is where a supervisor's
 * identity probe looks.
 *
 * Nothing here reads an environment: every fact arrives from the host.
 */

import { createOduService, type OduService } from "@odu/service/service";
import { oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE, ODU_SERVICE_MCP_INSTRUCTIONS } from "@odu/service-client/verbs";
import type { RowAgent } from "@odu/cordis/services";
import { webPorts } from "./webPorts";

/** The facts the host hands this row. */
export interface CiFacts {
  readonly origin: string;
  readonly home: string;
  readonly build: {
    readonly oduVersion: string;
    readonly commit: string | null;
    readonly buildId: string | null;
    readonly self: string | null;
  };
  readonly log: Parameters<typeof createOduService>[0]["log"];
  /** The frozen control fragment's `drain`, wired to the process's own stop. */
  readonly shutdown: () => void;
}

export interface CiBundle {
  readonly service: OduService;
}

/** WHAT AN AGENT IS TOLD about the runs — the row's own words, beside the row
 *  rather than in the transport that composes them. */
export const CI_AGENT: RowAgent = {
  surface: oduServiceSurface,
  expose: ODU_SERVICE_EXPOSE,
  instructions: ODU_SERVICE_MCP_INSTRUCTIONS,
};

/** Build the runs' runtime. The caller owns its teardown (`service.close()`). */
export function createCiBundle(facts: CiFacts): CiBundle {
  const { ports } = webPorts();
  return {
    service: createOduService({
      ports,
      origin: facts.origin,
      home: facts.home,
      build: facts.build,
      log: facts.log,
      onDrain: facts.shutdown,
    }),
  };
}
