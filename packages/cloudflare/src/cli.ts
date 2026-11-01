/**
 * `odu cloudflare status` — the tunnel and the names it carries, from a
 * terminal.
 *
 * The page is the product (the Tunnel panel); this is the parity verb, and it
 * is a READ: a name is set on the bucket, and this row follows. The client is
 * built over the dispatch the root hands it, the same one every row's face
 * uses.
 */

import { parseArgs } from "node:util";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { composedClients } from "@odu/cordis/compose";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { Effect } from "effect";
import { CLOUDFLARE_KEY, oduCloudflareSurface } from "./surface";

export type CloudflareClient = SurfaceClientOf<(typeof oduCloudflareSurface)["spec"]>;

/** What the root hands this face: the way to the daemon, and nothing else. */
export interface CloudflareCliPorts {
  connect(origin: string | undefined): Promise<{
    dispatch: SurfaceDispatch;
    dispose: () => Promise<void>;
  }>;
}

export const CLOUDFLARE_USAGE = `usage: odu cloudflare status [-o json]

status                        the tunnel this server made and every name it
                              carries: wiring, live, or failed with the reason.
                              The bucket page sets a name; this row follows

--origin URL names the server (default $ODU_WEB_ORIGIN or http://127.0.0.1:18440).
`;

const originOption = { type: "string" } as const;
const outputOption = { type: "string", short: "o" } as const;

export async function cloudflareCommand(
  sub: string | undefined,
  rest: string[],
  ports: CloudflareCliPorts,
): Promise<number> {
  switch (sub) {
    case "status":
      return statusCommand(rest, ports);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(CLOUDFLARE_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown cloudflare sub-command "${sub}"\n${CLOUDFLARE_USAGE}`);
      return 1;
  }
}

async function statusCommand(rest: string[], ports: CloudflareCliPorts): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  let connection: Awaited<ReturnType<CloudflareCliPorts["connect"]>>;
  try {
    connection = await ports.connect(values.origin);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  try {
    const client = composedClients(
      { [CLOUDFLARE_KEY]: oduCloudflareSurface },
      connection.dispatch,
    ).cloudflare as unknown as CloudflareClient;
    const answer = await Effect.runPromise(Effect.result(client.surface.status.read()));
    if (answer._tag === "Failure") {
      process.stderr.write(
        `odu: ${answer.failure instanceof Error ? answer.failure.message : String(answer.failure)}\n`,
      );
      return 1;
    }
    const status = answer.success;
    if (json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      `tunnel ${status.tunnel.state}` +
        (status.tunnel.name === null ? "" : ` "${status.tunnel.name}"`) +
        (status.tunnel.reason === null ? "" : ` — ${status.tunnel.reason}`) +
        "\n",
    );
    for (const route of status.routes) {
      process.stdout.write(
        `  ${route.domain}  ${route.bucket === null ? "(the server)" : route.bucket}  ` +
          `${route.state}${route.reason === null ? "" : ` — ${route.reason}`}\n`,
      );
    }
    if (status.routes.length === 0) {
      process.stdout.write("  no names yet — set one on a bucket\n");
    }
    return 0;
  } finally {
    await connection.dispose();
  }
}
