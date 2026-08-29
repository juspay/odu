/**
 * THIS checkout's end of the run rendezvous — the two halves only odu has:
 * SERVING the fan-in surface on `.ci/odu.sock` while `odu run` is live, and
 * REFUSING in odu's own words when a face finds no run there.
 *
 * Reaching a live run is `@odu/run-client/dial`'s, in this repo and out of it;
 * {@link dialRunOrExit} only adds the exit a one-shot command wants.
 *
 * Transport is `@kolu/surface`'s `serveOverUnixSocket` — same base64-newline
 * framing as every other odu transport, and unlike justci's `.ci/pc.sock`, what
 * is served is the same typed surface every other face speaks. odu keeps the
 * checkout-scoped path (one run per checkout, like justci) rather than the
 * library's per-user runtime-dir convention, and translates the library's
 * structured outcomes into odu-flavored verdicts: `already-served` IS the
 * one-run-per-checkout lock, and a dial failure IS "no run in progress".
 *
 * `serveOverUnixSocket` assumes Node's async-connect-error contract, which Bun
 * does not always honor — importing `asyncConnectError` (for its side effect)
 * restores it. `@odu/run-client/dial` installs the same shim for itself, so
 * between the two every unix-socket dial and serve in this repo is covered.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "@kolu/log";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { serveOverUnixSocket } from "@kolu/surface/unix-socket";
import "@odu/run-client/asyncConnectError";
import {
  type DialedRun,
  dialRun,
  SOCKET_PATH,
  runSocketPath,
} from "@odu/run-client/dial";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { RUN_LOCK_PATH } from "./checkoutLock";

/** The two per-checkout coordinator paths, derived TOGETHER from the checkout
 *  root — never one from the other. `ensureCheckoutFree` SIGTERMs whoever holds
 *  the run lock, so a lock path inferred from a relative socket path is a kill
 *  aimed at whatever checkout the process happens to be cwd'd into (that is how
 *  odu's own suite once killed the run executing it). Taking a root makes the
 *  pair unambiguous at every call site.
 *
 *  The socket half is `@odu/run-client`'s own path algebra, so the place a
 *  coordinator BINDS and the place a foreign client DIALS are one formula. */
export function checkoutPaths(repoRoot: string): {
  socketPath: string;
  lockPath: string;
} {
  return {
    socketPath: runSocketPath(repoRoot),
    lockPath: join(repoRoot, RUN_LOCK_PATH),
  };
}

/** odu's plug for the transport's listener-lifetime seam, which juspay/kolu#2101
 *  N3 made REQUIRED precisely so no caller can serve a socket nobody is watching
 *  the health of. The two tiers are not the same event:
 *
 *   - `warn`/`error` — a post-listen listener fault. The socket IS `attach` /
 *     `status` / every agent read, so a coordinator whose listener died while
 *     the lanes run on is exactly the comatose-and-silent shape #2101 was made
 *     of. Straight to the operator feed.
 *   - `info`/`debug` — bound, closed, and a peer dying mid-frame. Routine by
 *     construction: every `odu status` dial ends in a peer close, so routing
 *     these to the feed would bury the tier above in noise from healthy runs.
 *
 *  The division of voice matches kaval's wrapper: the transport narrates the
 *  LISTENER, {@link serveSocket} below owns the BIND-TIME verdicts (they are
 *  `outcome` values, and the odu-flavored advice for each is not the
 *  transport's vocabulary). */
export function socketLogger(onLine: (line: string) => void): Logger {
  const quiet = (): void => {};
  const loud = (obj: Record<string, unknown>, msg: string): void => {
    const err = obj.err;
    onLine(err === undefined ? `odu: ${msg}` : `odu: ${msg}: ${String(err)}`);
  };
  return { debug: quiet, info: quiet, warn: loud, error: loud };
}

/** Serve the fan-in surface on the unix socket; refuses when another run is
 *  live in this checkout (one run per checkout — justci's `.ci/pc.sock` rule).
 *  The library reclaims a provably-stale socket left by a crashed coordinator
 *  and refuses to serve from a world-readable directory, so `.ci` is
 *  tightened to owner-only first (it holds nothing but this run's logs).
 *
 *  The served value is the `{ group, handlers }` pair `implementSurface` hands
 *  back, and it is TYPED — a tag carries its own route, so there is nothing to
 *  re-prefix at the mount site.
 *
 *  `log` is required for the same reason the transport requires it — see
 *  {@link socketLogger}. Both call sites pass a path, so it takes one too. */
export async function serveSocket(
  served: {
    group: RpcGroup.RpcGroup<Rpc.Any>;
    handlers: SurfaceHandlers;
  },
  path: string,
  log: Logger,
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
    log,
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

/** The shared no-run refusal string — CLI wait/rerun and `dialRunOrExit` all
 *  cite the same wording so agents match one phrase. */
export function noRunInProgressMessage(path: string): string {
  return `odu: no run in progress in this checkout (no live socket at ${path})\n`;
}

/** {@link dialRun}, for a face that has nothing to say without a run: exits
 *  with the justci-parity message instead of handing back `null`.
 *
 *  Dying is a one-shot command's decision, never a library's — which is the
 *  whole reason this wrapper is here and not in the package. */
export async function dialRunOrExit(
  path: string = SOCKET_PATH,
): Promise<DialedRun> {
  const dialed = await dialRun(path);
  if (dialed !== null) return dialed;
  process.stderr.write(noRunInProgressMessage(path));
  process.exit(1);
}
