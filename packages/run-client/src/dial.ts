/**
 * `@odu/run-client/dial` — reach a live odu run over its unix socket.
 *
 * While `odu run` is up, the coordinator serves {@link oduSurface} on
 * `<checkout>/.ci/odu.sock`; this is the one way a client reaches it. Transport
 * is `@kolu/surface`'s first-class unix-socket pair, so the framing is the same
 * one every other odu transport speaks and what is served is the same typed
 * surface every other face reads.
 *
 * THE CONTRACT A CALLER MUST KNOW: {@link dialRun} answers `null` when there is
 * no run, and never rejects for one. A run's socket exists only between `odu
 * run` and settle, so absence is a checkout's ordinary steady state — a face
 * polling on a timer gets `null` on nearly every tick, and needs an answer for
 * it rather than an error path. The README argues why the package is shaped
 * that way, and how it departs from `@kolu/padi-client` in doing so.
 *
 * Be told the checkout; don't guess it. {@link runSocketPath} is pure path
 * algebra over a checkout root, and there is nothing environmental to get
 * wrong: a run's socket is a file inside the tree it is testing. What a caller
 * must supply is WHICH tree.
 */

import { join } from "node:path";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import "./asyncConnectError";
import { type OduClient, oduClientOver, oduSurface } from "./surface";

/** The run's rendezvous, relative to the checkout root. One run per checkout —
 *  justci's `.ci/pc.sock` rule, kept: the path is checkout-scoped rather than
 *  the library's per-user runtime-dir convention, so the socket sits beside the
 *  logs of the run it belongs to. */
export const SOCKET_PATH = ".ci/odu.sock";

/** The socket a live run in `checkoutRoot` serves. Pure: it does not probe, and
 *  a path it returns is a live run only if {@link dialRun} says so. */
export function runSocketPath(checkoutRoot: string): string {
  return join(checkoutRoot, SOCKET_PATH);
}

/** A dialled run: the typed face plus the link teardown. `close` is genuinely
 *  async — the link owns a `Scope` holding the protocol's dial/ping/response
 *  fibers, so dropping it unawaited leaks them. */
export interface DialedRun {
  client: OduClient;
  close: () => Promise<void>;
}

/** Dial the run live at `path`, or `null` when there is none: a dead or absent
 *  server rejects the connect with ECONNREFUSED/ENOENT, and neither is news
 *  (see the module header).
 *
 *  `path` is a socket path, not a checkout root — pass
 *  `runSocketPath(checkout)`, or take the {@link SOCKET_PATH} default to mean
 *  the process's own cwd. */
export async function dialRun(
  path: string = SOCKET_PATH,
): Promise<DialedRun | null> {
  try {
    const link = await unixSocketLink({
      group: oduSurface.group,
      socketPath: path,
    });
    return { client: oduClientOver(link.dispatch), close: link.dispose };
  } catch {
    return null;
  }
}
