/**
 * `@odu/run-client/dial` — reach a live odu run over its unix socket.
 *
 * {@link dialRun} answers `null` when nobody is serving, and rejects for
 * everything else.
 */

import { join } from "node:path";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import "./asyncConnectError";
import { type OduClient, oduClientOver, oduSurface } from "./surface";

/** The run's rendezvous, relative to the checkout root. */
export const SOCKET_PATH = ".ci/odu.sock";

/** The socket a live run in `checkoutRoot` serves. Pure: it does not probe, and
 *  a path it returns is a live run only if {@link dialRun} says so. */
export function runSocketPath(checkoutRoot: string): string {
  return join(checkoutRoot, SOCKET_PATH);
}

/** The connect failures that MEAN "nobody is serving that path", and so are
 *  the ones {@link dialRun} answers `null` for. */
const ABSENT_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

/** Is this dial failure the absence of a server, rather than a server that
 *  refused us? A rejection with no `code` is never absence. */
export function isNobodyServing(err: unknown): boolean {
  const code: unknown = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ABSENT_CODES.has(code);
}

/** A dialled run: the typed face plus the link teardown. `close` must be
 *  awaited. */
export interface DialedRun {
  client: OduClient;
  close: () => Promise<void>;
}

/** Dial the run live at `path`, or `null` when nothing is serving it; any
 *  other connect failure is raised. `path` is a socket path, not a checkout
 *  root; the default means the process's own cwd. */
export async function dialRun(
  path: string = SOCKET_PATH,
): Promise<DialedRun | null> {
  try {
    const link = await unixSocketLink({
      group: oduSurface.group,
      socketPath: path,
    });
    return { client: oduClientOver(link.dispatch), close: link.dispose };
  } catch (err) {
    if (isNobodyServing(err)) return null;
    throw err;
  }
}
