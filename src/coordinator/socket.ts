/**
 * The in-band introspection rendezvous: while `odu run` is live, the
 * coordinator serves the fan-in surface on `.ci/odu.sock`, and
 * `odu status` / `logs` / `attach` dial it.
 *
 * Transport is `@kolu/surface`'s first-class unix-socket pair
 * (`serveOverUnixSocket` / `unixSocketLink`) — same base64-newline framing
 * as every other odu transport, and unlike justci's `.ci/pc.sock`, what is
 * served is the same typed surface every other face speaks. odu keeps the
 * checkout-scoped path (one run per checkout, like justci) rather than the
 * library's per-user runtime-dir convention, and translates the library's
 * structured outcomes into odu-flavored verdicts: `already-served` IS the
 * one-run-per-checkout lock, and a dial failure IS "no run in progress".
 *
 * Both library entry points below assume Node's async-connect-error contract,
 * which Bun does not always honor — importing `asyncConnectError` (for its
 * side effect) restores it. This is odu's single unix-socket seam, so the
 * import here covers every dial and serve in the repo.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { serveOverUnixSocket } from "@kolu/surface/unix-socket";
import "../common/asyncConnectError";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { type OduClient, oduClientOver, oduSurface } from "../common/surface";
import { RUN_LOCK_PATH } from "./checkoutLock";

export type { OduClient };

export const SOCKET_PATH = ".ci/odu.sock";

/** The two per-checkout coordinator paths, derived TOGETHER from the checkout
 *  root — never one from the other. `ensureCheckoutFree` SIGTERMs whoever holds
 *  the run lock, so a lock path inferred from a relative socket path is a kill
 *  aimed at whatever checkout the process happens to be cwd'd into (that is how
 *  odu's own suite once killed the run executing it). Taking a root makes the
 *  pair unambiguous at every call site. */
export function checkoutPaths(repoRoot: string): {
  socketPath: string;
  lockPath: string;
} {
  return {
    socketPath: join(repoRoot, SOCKET_PATH),
    lockPath: join(repoRoot, RUN_LOCK_PATH),
  };
}

/** Serve the fan-in surface on the unix socket; refuses when another run is
 *  live in this checkout (one run per checkout — justci's `.ci/pc.sock` rule).
 *  The library reclaims a provably-stale socket left by a crashed coordinator
 *  and refuses to serve from a world-readable directory, so `.ci` is
 *  tightened to owner-only first (it holds nothing but this run's logs).
 *
 *  The served value is now the `{ group, handlers }` pair `implementSurface`
 *  hands back, and it is TYPED — the `any` this parameter used to be existed
 *  only because oRPC's router had no nameable shape. A tag carries its own
 *  route, so there is nothing to re-prefix at the mount site. */
export async function serveSocket(
  served: {
    group: RpcGroup.RpcGroup<Rpc.Any>;
    handlers: SurfaceHandlers;
  },
  path: string = SOCKET_PATH,
): Promise<() => void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is a no-op on a pre-existing dir (a prior run already
  // created `.ci` under the umask), and the library refuses non-private dirs.
  chmodSync(dir, 0o700);

  const listener = await serveOverUnixSocket({
    socketPath: path,
    group: served.group,
    handlers: served.handlers,
  });
  const { outcome } = listener;
  switch (outcome.kind) {
    case "listening":
      return () => listener.close();
    case "already-served":
      throw new Error(
        `odu: a run is already in progress in this checkout (${path} is live)`,
      );
    case "dir-not-private":
      throw new Error(
        `odu: refusing to serve ${path} — ${outcome.dir} is not an owner-only directory`,
      );
    case "not-a-socket":
      throw new Error(
        `odu: ${path} exists but is not a socket — remove it manually`,
      );
    case "probe-failed":
      throw new Error(
        `odu: could not probe ${path} (${outcome.code ?? "unknown error"})`,
      );
    case "bind-failed":
      throw new Error(`odu: could not bind ${path}: ${String(outcome.err)}`);
  }
}

/** Dial the socket of a live run, or `null` when no run is in progress (a
 *  dead/absent server rejects with ECONNREFUSED/ENOENT). The non-exiting
 *  variant: the MCP face turns "no live run" into a structured tool result
 *  rather than a process exit. */
export async function tryDialSocket(
  path: string = SOCKET_PATH,
): Promise<DialedSocket | null> {
  try {
    // The link owns a `Scope` holding the protocol's dial/ping/response
    // fibers, so `close()` is genuinely async now — dropping it unawaited
    // leaks them. Every call site awaits.
    const link = await unixSocketLink({
      group: oduSurface.group,
      socketPath: path,
    });
    return { client: oduClientOver(link.dispatch), close: link.dispose };
  } catch {
    return null;
  }
}

/** A dialled fan-in socket: the typed face plus the link teardown. */
export interface DialedSocket {
  client: OduClient;
  close: () => Promise<void>;
}

/** Dial the socket of a live run. Exits with the justci-parity message when
 *  no run is in progress. */
export async function dialSocket(
  path: string = SOCKET_PATH,
): Promise<DialedSocket> {
  const dialed = await tryDialSocket(path);
  if (dialed !== null) return dialed;
  process.stderr.write(
    `odu: no run in progress in this checkout (no live socket at ${path})\n`,
  );
  process.exit(1);
}
