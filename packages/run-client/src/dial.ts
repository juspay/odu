/**
 * `@odu/run-client/dial` — reach a live odu run over its unix socket.
 *
 * While `odu run` is up, the coordinator serves {@link oduSurface} on
 * `<checkout>/.ci/odu.sock`; this is the one way a client reaches it. Transport
 * is `@kolu/surface`'s first-class unix-socket pair, so the framing is the same
 * one every other odu transport speaks and what is served is the same typed
 * surface every other face reads.
 *
 * THE CONTRACT A CALLER MUST KNOW: {@link dialRun} answers `null` when NOBODY
 * IS SERVING, and rejects for everything else. A run's socket exists only
 * between `odu run` and settle, so absence is a checkout's ordinary steady
 * state — a face polling on a timer gets `null` on nearly every tick, and needs
 * an answer for it rather than an error path. The README argues why the package
 * is shaped that way, and how it departs from `@kolu/padi-client` in doing so.
 *
 * The two halves of that sentence are load-bearing together. `null` is what a
 * face turns into "no run" — the last durable verdict, a quiet chip, justci's
 * one-line refusal — so a live socket that failed for some OTHER reason must
 * never arrive as `null`, or the face reports "no run" about a run that is
 * up. `unixSocketLink` exists to keep the two distinguishable (it rejects with
 * the raw socket error precisely "so a probe can tell 'nobody is serving' from
 * 'the server said no'"), and {@link ABSENT_CODES} is where this package spends
 * that distinction rather than throwing it away in a bare `catch`.
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

/** The connect failures that MEAN "nobody is serving that path", and so are
 *  the ones {@link dialRun} answers `null` for.
 *
 *  ENOENT is the common one — no socket file, because no run. ECONNREFUSED is
 *  the same fact one step later: the file outlived a coordinator that is gone.
 *  Everything else is a live problem worth a stack trace — EACCES on a socket
 *  somebody IS serving, ENOTSOCK on a path a broken checkout left behind, or a
 *  connect that succeeded and then failed to speak the wire. None of those is
 *  "no run in progress", and reporting them as one is how a face comes to say
 *  a live run is not there. */
const ABSENT_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

/** Is this dial failure the absence of a server, rather than a server that
 *  refused us? A rejection with no `code` is never absence: the link rejects
 *  with the raw socket error, so anything else came from a connect that had
 *  already succeeded. */
function isNobodyServing(err: unknown): boolean {
  const code: unknown = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ABSENT_CODES.has(code);
}

/** A dialled run: the typed face plus the link teardown. `close` is genuinely
 *  async — the link owns a `Scope` holding the protocol's dial/ping/response
 *  fibers, so dropping it unawaited leaks them. */
export interface DialedRun {
  client: OduClient;
  close: () => Promise<void>;
}

/** Dial the run live at `path`, or `null` when nothing is serving it — see
 *  {@link ABSENT_CODES} for which failures mean that and why the rest are
 *  raised.
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
  } catch (err) {
    if (isNobodyServing(err)) return null;
    throw err;
  }
}
