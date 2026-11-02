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
/**
 * THE SIBLINGS A DAEMON ANSWERS — `GET /_odu/rows`, filtered over the one list
 * of sibling rows (`./wire`). The roster lists every mounted sibling: the cache,
 * the door exactly when there is one, the tunnel when its token is set. A tool
 * for a row that is not there is a tool error waiting for the first agent; the
 * roster is asked, never assumed.
 *
 * ONE CASE THE ROSTER CANNOT ANSWER: `null`, a daemon that has not answered yet
 * — the bridge started before there was one, and its first dial boots it. Until
 * then it offers the cache, the row every daemon mounts unconditionally, so a
 * fresh machine's agent sees the cache's tools at `initialize` rather than only
 * after some other call happens to start the daemon. The answer, when it comes,
 * moves the roster to exactly what is mounted.
 */
export function mountedRows(rows: ReadonlyArray<string> | null): Record<string, RowAgent> {
  const here = rows ?? UNANSWERED;
  return Object.fromEntries(
    SIBLING_ROWS.filter((row) => row.key !== null && here.includes(row.key)).map((row) => [
      row.key as string,
      row.agent,
    ]),
  );
}

/** What an unanswered roster offers — see {@link mountedRows}. */
const UNANSWERED: ReadonlyArray<string> = [CACHE_KEY];
import { agentInstructions, readRows, type RowAgent } from "@odu/cordis/services";
import { CACHE_KEY } from "@odu/cache/surface";
import { buildSurfaceFace } from "@kolu/surface/client";
import { composedClients } from "@odu/cordis/compose";
import {
  connectToService,
  EVERY_ROW_NEEDS,
  SERVICE_SIBLINGS,
  SERVICE_WIRE_GROUP,
  SIBLING_ROWS,
} from "./wire";
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
  //
  // EVERY DIAL OWNS ITS CONNECTION. `client()` is the adapter's REDIAL FACTORY:
  // a dropped transport disposes the connection and calls it again, the resource
  // pusher dials its own, and `reroster` re-invokes it too. A cached connection
  // here would hand a redial the one that was just closed — a bridge that
  // outlives a daemon restart or an upgrade would stay dead, and the reader and
  // the pusher would cut each other's socket. So each call opens one and returns
  // the `dispose` that closes THAT one; the set is only for `close()`.
  const opened = new Set<ServiceConnection>();

  // THE ROSTER IS THE DAEMON'S COMPOSITION, NOT THIS FACE'S, AND IT MOVES.
  // The door and the tunnel are mounted only where they are configured; a
  // bridge that advertised their verbs everywhere would hand an agent tools the
  // server it is talking to does not have (the two-doors divergence #134
  // closed). So `GET /_odu/rows` is asked BEFORE serving — a daemon that is
  // already running is answered exactly, which is the ordinary case — and again
  // after every dial, which is what makes a bridge that STARTS the daemon
  // right: the first dial boots it, and the answer arrives a moment later.
  let rows: ReadonlyArray<string> | null = await readRows(origin);
  let served: ServedSurfaceMcp | null = null;
  let asking = false;
  const askRoster = async (): Promise<void> => {
    // One question at a time: two dials that both notice a fresh answer would
    // otherwise reroster each other for the same fact.
    if (asking) return;
    asking = true;
    try {
      const nextRows = await readRows(origin);
      // An unanswered re-ask keeps the roster already known.
      if (nextRows === null) return;
      // ONLY A ROSTER THAT MOVES IS MOVED: a reroster for the same tools would
      // invite the framework's one-generation rule for nothing. The comparison
      // is the KEY SETS, not their sizes — one sibling swapped for another is
      // still a move.
      const before = Object.keys(mountedRows(rows)).sort().join("\n");
      const after = Object.keys(mountedRows(nextRows)).sort().join("\n");
      rows = nextRows;
      if (before === after) return;
      // The move, not a second serve: the adapter re-invokes `client()` for the
      // new roster, and this call answers with a fresh connection like any
      // other. The caller is a `void`, so a refusal here is LOGGED rather than
      // left to become an unhandled rejection in a process whose only job is to
      // stay alive: `reroster` re-makes every refusal the boot composition
      // owes, and one of those can reject.
      try {
        await served?.reroster(surfacesOf(mountedRows(rows)));
      } catch (err) {
        process.stderr.write(`odu mcp: could not move the roster: ${String(err)}\n`);
      }
    } finally {
      asking = false;
    }
  };
  const surfacesOf = (siblings: Record<string, RowAgent>) =>
    Object.fromEntries(
      Object.entries(siblings).map(([key, row]) => [
        key,
        { surface: row.surface, expose: row.expose },
      ]),
    );

  /** The daemon instances this bridge has already told the agent's host are
   *  behind it — see `adoptOrRefuse`. Owned here, for this bridge's life. */
  const warned = new Set<string>();

  served = await serveSurfaceAsMcp({
    core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
    // THE SIBLINGS ARE ON THE SAME WIRE, so an agent reaches their verbs through
    // this bridge too — `cache_bucket_create` and its neighbours, and the door's
    // own verbs when the daemon has a door, under the keys the daemon mounts the
    // rows at. The rules are the rows': this face adds no authority, it forwards
    // a call.
    surfaces: surfacesOf(mountedRows(rows)),
    client: async () => {
      // ONE skew note per daemon for the bridge's life, not one per redial.
      // Every row it projects: the runs always, each sibling when mounted.
      const connection = await connectToService(origin, { needs: EVERY_ROW_NEEDS, warned });
      opened.add(connection);
      // ASKED PER DIAL, AND NOT INSIDE IT. The dial is the one thing that
      // guarantees there is a daemon to ask — but `reroster` from inside this
      // factory moves the roster while the dial that answers it is still being
      // taken, and the framework (rightly) refuses every request against the
      // two generations it then straddles. So the question is fired and not
      // awaited: the answer lands after this connection is in service, and the
      // framework re-dials for the roster it carries.
      void askRoster();
      return {
        client: {
          core: connection.client as unknown as SurfaceClientCallable,
          clients: composedClients(SERVICE_SIBLINGS, connection.dispatch),
        },
        // THE ANNOUNCEMENT the adapter builds its redial on: a daemon that died
        // or was upgraded tells this connection's transport, the adapter drops
        // the slot, and the NEXT call dials a fresh one. Without it the slot
        // stays "live" holding a dead socket, and every later call fails on it
        // — which is what the redial e2e found, with `SocketCloseError: 1000`.
        onClose: connection.onClose,
        dispose: () => {
          opened.delete(connection);
          connection.dispose();
        },
      };
    },
    // The name an MCP host sees. ONE spelling, and it is the identity of the
    // thing being served rather than a transport detail: the daemon's own `/mcp`
    // route answers with the same pair.
    serverInfo: { name: "odu", version: opts.version },
    // THE PARAGRAPHS BOTH DOORS TEACH, from the ONE composer the daemon's `/mcp`
    // route uses, read at each `initialize` so a host that connects after a
    // re-roster is told the rows it actually gets.
    instructions: () =>
      agentInstructions(
        { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE, instructions: ODU_SERVICE_MCP_INSTRUCTIONS },
        mountedRows(rows),
      ),
    ...(opts.transport === undefined ? {} : { transport: opts.transport }),
  });
  return {
    served,
    close: async () => {
      await served.close();
      for (const connection of opened) connection.dispose();
      opened.clear();
    },
  };
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

