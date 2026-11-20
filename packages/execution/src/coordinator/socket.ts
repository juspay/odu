/**
 * `serveOverUnixSocket` assumes Node's async-connect-error contract, which Bun
 * does not always honor — importing `asyncConnectError` (for its side effect)
 * restores it.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "@kolu/log";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { serveOverUnixSocket } from "@kolu/surface/unix-socket";
import type { Rpc, RpcGroup } from "effect/rpc";
import "@odu/run-client/asyncConnectError";
import {
  type DialedRun,
  dialRun,
  SOCKET_PATH,
  runSocketPath,
} from "@odu/run-client/dial";
import { RUN_LOCK_PATH } from "./checkoutLock";

export function checkoutPaths(repoRoot: string): {
  socketPath: string;
  lockPath: string;
} {
  return {
    socketPath: runSocketPath(repoRoot),
    lockPath: join(repoRoot, RUN_LOCK_PATH),
  };
}

export function socketLogger(onLine: (line: string) => void): Logger {
  const quiet = (): void => {};
  const loud = (obj: Record<string, unknown>, msg: string): void => {
    const err = obj.err;
    onLine(err === undefined ? `odu: ${msg}` : `odu: ${msg}: ${String(err)}`);
  };
  return { debug: quiet, info: quiet, warn: loud, error: loud };
}

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

export function noRunInProgressMessage(path: string): string {
  return `odu: no run in progress in this checkout (no live socket at ${path})\n`;
}

export function feedDroppedMessage(awaited: string): string {
  return `odu: lost the connection to the run before ${awaited} — it may still be going (check \`odu ci status\`)\n`;
}

export async function dialRunOrExit(
  path: string = SOCKET_PATH,
): Promise<DialedRun> {
  const dialed = await dialRun(path);
  if (dialed !== null) return dialed;
  process.stderr.write(noRunInProgressMessage(path));
  process.exit(1);
}
