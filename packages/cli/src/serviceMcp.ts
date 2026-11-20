import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  serveSurfaceAsMcp,
  type ServedSurfaceMcp,
  type SurfaceClientCallable,
} from "@kolu/surface-mcp";
export function mountedRows(rows: ReadonlyArray<string> | null): Record<string, RowAgent> {
  const here = rows ?? UNANSWERED;
  return Object.fromEntries(
    SIBLING_ROWS.filter((row) => row.key !== null && here.includes(row.key)).map((row) => [
      row.key as string,
      row.agent,
    ]),
  );
}

const UNANSWERED: ReadonlyArray<string> = [CACHE_KEY, METRICS_KEY];
import { agentInstructions, readRows, type RowAgent } from "@odu/cordis/services";
import { CACHE_KEY } from "@odu/cache/surface";
import { METRICS_KEY } from "@odu/cordis/metricsSurface";
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

export async function serveServiceMcpOverStdio(opts: {
  version: string;
  origin?: string;
  transport?: Transport;
}): Promise<{ served: ServedSurfaceMcp; close: () => Promise<void> }> {
  const origin = opts.origin ?? serviceOrigin();
  const opened = new Set<ServiceConnection>();

  let rows: ReadonlyArray<string> | null = await readRows(origin);
  let served: ServedSurfaceMcp | null = null;
  let asking = false;
  const askRoster = async (): Promise<void> => {
    if (asking) return;
    asking = true;
    try {
      const nextRows = await readRows(origin);
      if (nextRows === null) return;
      const before = Object.keys(mountedRows(rows)).sort().join("\n");
      const after = Object.keys(mountedRows(nextRows)).sort().join("\n");
      rows = nextRows;
      if (before === after) return;
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

  const warned = new Set<string>();

  served = await serveSurfaceAsMcp({
    core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
    surfaces: surfacesOf(mountedRows(rows)),
    client: async () => {
      const connection = await connectToService(origin, { needs: EVERY_ROW_NEEDS, warned });
      opened.add(connection);
      // `reroster` from inside this factory moves the roster while the dial
      // that answers it is still being taken, and the framework refuses every
      // request against the two generations it then straddles — so the
      // question is fired and not awaited.
      void askRoster();
      return {
        client: {
          core: connection.client as unknown as SurfaceClientCallable,
          clients: composedClients(SERVICE_SIBLINGS, connection.dispatch),
        },
        // The adapter builds its redial on this: a daemon that died or was
        // upgraded tells this connection's transport, the adapter drops the
        // slot, and the NEXT call dials a fresh one. Without it the slot stays
        // "live" holding a dead socket, and every later call fails on it.
        onClose: connection.onClose,
        dispose: () => {
          opened.delete(connection);
          connection.dispose();
        },
      };
    },
    serverInfo: { name: "odu", version: opts.version },
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

export async function serviceMcpCommand(opts: {
  version: string;
  origin?: string;
}): Promise<number> {
  const { served, close } = await serveServiceMcpOverStdio(opts);
  await serveUntilDisconnect(served.server);
  await close();
  return 0;
}

