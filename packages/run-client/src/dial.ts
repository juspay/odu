/**
 * `@odu/run-client/dial` — reach a live odu run over its unix socket.
 *
 * While `odu run` is up, the coordinator serves {@link oduSurface} on
 * `<checkout>/.ci/odu.sock`; this is the one way a client reaches it. Transport
 * is `@kolu/surface`'s first-class unix-socket pair, so the framing is the same
 * one every other odu transport speaks and what is served is the same typed
 * surface every other face reads.
 *
 * ── Absence is a STATE, not an error ────────────────────────────────────────
 *
 * This is where odu differs from the package it is modelled on
 * (`@kolu/padi-client`). padi's socket belongs to a per-host DAEMON that is
 * meant to be up, so `connectPadi` REJECTS when it cannot reach one — being
 * down is news. odu's socket belongs to a RUN: it is created when the run
 * starts, and it is gone the moment the run settles. Sock-absent is the
 * ordinary steady state of a checkout, and the great majority of the time.
 *
 * So {@link dialRun} returns `null` rather than rejecting, and a face is
 * expected to treat that as "no run in progress" — odu's CLI turns it into
 * justci's one-line refusal, its MCP face into a structured `{ run: false }`
 * tool result, and a downstream dashboard into the last durable verdict (or
 * nothing at all). A client that dials on a timer will get `null` on nearly
 * every tick; that is the design, not a degraded mode.
 *
 * The consequence for the SURFACE half is stated on `NodeLogMessageSchema`: a
 * client is routinely a different build from the coordinator it dials, so the
 * wire is frozen and an added union arm is a one-way compatibility step. There
 * is deliberately no version handshake here — odu's surface carries no `hello`
 * sibling, and inventing a gate this package cannot enforce on the serving side
 * would be a promise it does not keep.
 *
 * ── Finding the socket ──────────────────────────────────────────────────────
 *
 * Be told the checkout; don't guess it. {@link runSocketPath} is pure path
 * algebra over a checkout root — no probing — and it is exactly right, because
 * unlike padi's runtime-dir digest there is nothing environmental to get wrong:
 * a run's socket is a file inside the tree it is testing. What a caller must
 * supply is WHICH tree.
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

/** Dial the run live in this checkout, or `null` when there is none — a
 *  dead/absent server rejects the connect with ECONNREFUSED/ENOENT, and this
 *  package's whole position is that neither is news (see the module header).
 *
 *  `path` is a socket path, not a checkout root: pass
 *  `runSocketPath(checkout)`, or the {@link SOCKET_PATH} default to mean the
 *  process's own cwd. */
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
