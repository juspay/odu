/**
 * `odu mcp` — the service's agent face over STDIO, as a CLIENT of the daemon.
 *
 * It dials the singleton and projects what it finds, through the same
 * `oduServiceSurface` + `ODU_SERVICE_EXPOSE` the HTTP endpoint in
 * `@odu/host/mcpRoute` serves and the terminal face reads. So `run_start` is
 * one verb with one name whichever door an agent came through.
 *
 * It has no run authority of its own: every tool call goes over the wire to the
 * service, so two agents driving two bridges are two clients of one truth
 * rather than two opinions about it — and a host restarting this process kills
 * nothing.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  serveSurfaceAsMcp,
  type ServedSurfaceMcp,
  type SurfaceClientCallable,
} from "@kolu/surface-mcp";
import { AUTH_AGENT, AUTH_KEY } from "@odu/auth/surface";
import { SERVICE_DOOR_PATH } from "@odu/cordis/services";
import { CACHE_AGENT, CACHE_KEY } from "@odu/cache/surface";
import { buildSurfaceFace } from "@kolu/surface/client";
import { composedClients } from "@odu/cordis/compose";
import { connectToService, SERVICE_SIBLINGS, SERVICE_WIRE_GROUP } from "./wire";
import type { ServiceConnection } from "@odu/service-client/dial";
import { serviceOrigin } from "@odu/service-client/endpoint";
import { oduServiceSurface } from "@odu/service-client/surface";
import {
  ODU_SERVICE_EXPOSE,
  ODU_SERVICE_MCP_INSTRUCTIONS,
} from "@odu/service-client/verbs";

/**
 * `odu mcp` — the stdio BRIDGE.
 *
 * It dials the singleton and projects what it finds. It has no run authority of
 * its own: every tool call goes over the wire to the service, so two agents
 * driving two bridges are two clients of one truth rather than two opinions
 * about it — and a host restarting this process kills nothing.
 *
 * Returns the served adapter and a teardown; the caller owns the process
 * lifetime, as odu's binary does for every other command.
 */
export async function serveServiceMcpOverStdio(opts: {
  version: string;
  origin?: string;
  transport?: Transport;
}): Promise<{ served: ServedSurfaceMcp; close: () => Promise<void> }> {
  const origin = opts.origin ?? serviceOrigin();
  // ONE dial, held for the adapter's life, and re-made by the adapter's own
  // retry after a drop — `client()` is re-invoked, so a service that was
  // upgraded underneath this bridge is picked up on the next call rather than
  // leaving the bridge talking to a corpse.
  //
  // And it BOOTSTRAPS. An MCP host launches this bridge on a machine where
  // nothing has ever run odu — that is the ordinary first contact, not an edge
  // case — and a bridge that could only report "nothing is serving" would put
  // the burden of starting a daemon on an agent that has no terminal to do it
  // in. So the first dial ensures the singleton, and every re-dial after a drop
  // may ensure it again: an upgrade drains the old service, and the bridge
  // should reattach to its successor rather than to nothing.
  //
  // It never recovers a failed dial by executing locally. There is nothing here
  // to execute with: this face holds no run authority at all.
  let held: ServiceConnection | null = null;
  // THE DOOR IS THE DAEMON'S COMPOSITION, NOT THIS FACE'S. The auth row is
  // mounted only on a daemon with a door; a bridge that advertised its seven
  // verbs everywhere would hand an agent tools the server it is talking to does
  // not have — and the two doors are supposed to offer ONE vocabulary. So dial
  // first (the dial is what ensures the singleton exists), ask the host's own
  // door route, then compose. A daemon that cannot answer is composed without
  // the row: the conservative reading, and the one that never overstates.
  //
  // ASKED ONCE, AND NOT BY DIALLING. A dial here would be a second connection
  // owner — and on an occupied port it would hang where the adapter has a
  // sentence that names the port in a second. So the question is a plain GET,
  // and an unreadable answer composes the CONSERVATIVE set: a daemon that was
  // not yet running when this bridge started is composed without the door's
  // verbs for the life of the process, which costs an agent seven tools in the
  // case where it could not have used them yet anyway.
  const door = await doorMounted(origin);
  const served = await serveSurfaceAsMcp({
    core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
    // THE SIBLINGS ARE ON THE SAME WIRE, so an agent reaches their verbs through
    // this bridge too — `cache_bucket_create` and its neighbours, and the door's
    // own verbs when the daemon has a door, under the keys the daemon mounts the
    // rows at. The rules are the rows': this face adds no authority, it forwards
    // a call.
    surfaces: {
      [CACHE_KEY]: CACHE_AGENT,
      ...(door === true ? { [AUTH_KEY]: AUTH_AGENT } : {}),
    },
    client: async () => {
      const connection = held ?? (await connectToService(origin));
      held = connection;
      return {
        client: {
          core: connection.client as unknown as SurfaceClientCallable,
          clients: composedClients(SERVICE_SIBLINGS, connection.dispatch),
        },
        dispose: () => connection.dispose(),
      };
    },
    // The name an MCP host sees. ONE spelling, and it is the identity of the
    // thing being served rather than a transport detail: the daemon's own `/mcp`
    // route answers with the same pair.
    serverInfo: { name: "odu", version: opts.version },
    // THE PARAGRAPHS BOTH DOORS TEACH, composed exactly as the daemon's `/mcp`
    // route composes them (core first, then each sibling). This bridge used to
    // pass the core's alone, which was true while the cache's paragraph was
    // folded into that constant — so splitting it out made two doors teach
    // different things about the same verbs, in principle and then in fact.
    instructions: [ODU_SERVICE_MCP_INSTRUCTIONS, CACHE_AGENT.instructions].join("\n\n"),
    ...(opts.transport === undefined ? {} : { transport: opts.transport }),
  });
  return {
    served,
    close: async () => {
      await served.close();
      await held?.dispose();
    },
  };
}

/** Does the daemon this bridge is attached to have a door? Asked of the HOST's
 *  own route — the fact that changes with `auth` — and `null` when the answer
 *  cannot be read. */
async function doorMounted(origin: string): Promise<boolean | null> {
  try {
    const response = await fetch(new URL(SERVICE_DOOR_PATH, origin), {
      headers: { "cache-control": "no-cache" },
      // BOUNDED: a foreign program that accepts the socket and says nothing
      // would otherwise hold this question (and the whole bridge) open, which
      // is exactly the hang the adapter's own dial has a sentence for.
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { door?: unknown };
    return body.door === true;
  } catch {
    return null;
  }
}

/**
 * Wait until the MCP host disconnects (stdio EOF / server close) or a signal.
 *
 * The process lifetime IS the host's: this server owns stdin and stdout, and
 * nothing it started is reaped on the way out — a run outlives the face that
 * asked for it, by design, so a harness restarting this process kills no run.
 */
async function serveUntilDisconnect(server: {
  onclose?: (() => void) | undefined;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    server.onclose = shutdown;
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * `odu mcp` — the whole command.
 *
 * Serves until the host disconnects, then disposes. It holds no run authority:
 * every call goes over the wire to the singleton, so two agents driving two
 * bridges are two clients of one truth rather than two opinions about it.
 */
export async function serviceMcpCommand(opts: {
  version: string;
  origin?: string;
}): Promise<number> {
  const { served, close } = await serveServiceMcpOverStdio(opts);
  await serveUntilDisconnect(served.server);
  await close();
  return 0;
}

