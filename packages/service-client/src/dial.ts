import { unenrolledStreamCall } from "@kolu/surface/client";
import { firstFrameOrThrow } from "@kolu/surface/first-frame";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { websocketLink } from "@kolu/surface/links/websocket";
import { STALE_PROCESS_CLOSE_CODE } from "@kolu/surface-app";
import { Effect } from "effect";
import { serviceOrigin, serviceWsUrl } from "./endpoint";
import {
  oduServiceClientOver,
  type OduServiceClient,
  oduServiceSurface,
  type ServiceCell,
} from "./surface";

/** A dialled service. */
export interface ServiceConnection {
  client: OduServiceClient;
  /** The transport-neutral dispatch under {@link ServiceConnection.client}. */
  dispatch: SurfaceDispatch;
  /** The URL that was dialled, for an error message that has to name it. */
  url: string;
  /**
   * Subscribe to this connection's transport LEAVING `open` — a daemon that
   * died, was upgraded, or dropped the socket.
   */
  onClose: (cb: () => void) => () => void;
  dispose: () => Promise<void>;
}

type WebSocketCtor = new (
  url: string,
  options?: { headers: Record<string, string> },
) => WebSocket;

function webSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (ctor === undefined) {
    throw new Error(
      "odu: this runtime has no global WebSocket — odu's faces dial the service " +
        "over the framework's websocket route, and Node 22+/Bun provide one",
    );
  }
  return ctor;
}

function connectWithHeaders(
  ctor: WebSocketCtor,
  url: string,
  headers: Record<string, string>,
): WebSocket {
  return Object.keys(headers).length === 0 ? new ctor(url) : new ctor(url, { headers });
}

/**
 * How long a dial waits for the socket to actually open before reporting that
 * nothing is serving.
 */
export const DIAL_READY_MS = 3_000;

/**
 * Dial the service.
 *
 * Rejects when nothing is serving, and the rejection is what a face turns into
 * its own "nothing serving" exit.
 */
export async function dialService(
  origin: string = serviceOrigin(),
  opts: {
    readyMs?: number;
    /**
     * THE TAGS THIS FACE WILL ADDRESS — the composed wire, when the daemon
     * serves more than one row. Absent means "the core and nothing else",
     * which is what a single-surface client is.
     */
    group?: typeof oduServiceSurface.group;
    /**
     * REQUEST HEADERS THE UPGRADE CARRIES — `Authorization: Bearer <token>`
     * when this machine (or `$ODU_TOKEN`) holds one for that origin. Absent
     * means "no credential", which is loopback and is unconditional there.
     */
    headers?: Record<string, string>;
  } = {},
): Promise<ServiceConnection> {
  const url = serviceWsUrl(origin);
  const ctor = webSocketCtor();
  const headers = opts.headers ?? {};
  const link = await websocketLink({
    group: opts.group ?? oduServiceSurface.group,
    url: () => url,
    isTerminalClose: (code) => code === STALE_PROCESS_CLOSE_CODE,
    connect: (target) => connectWithHeaders(ctor, target, headers),
  });
  const opened = await firstOpen(link, opts.readyMs ?? DIAL_READY_MS);
  if (!opened) {
    await link.dispose();
    throw new Error(`odu: nothing is serving ${url} — run \`odu web --background\``);
  }
  return {
    client: oduServiceClientOver(link.dispatch),
    dispatch: link.dispatch,
    url,
    onClose: (cb) =>
      link.wire.onStatus((status) => {
        if (status === "closed" || status === "retired") cb();
      }),
    dispose: () => link.dispose(),
  };
}

function firstOpen(
  link: { wire: { status: () => string; onStatus: (cb: (s: string) => void) => () => void } },
  deadlineMs: number,
): Promise<boolean> {
  if (link.wire.status() === "open") return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const settle = (value: boolean): void => {
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const timer = setTimeout(() => settle(false), deadlineMs);
    const off = link.wire.onStatus((status) => {
      if (status === "open") settle(true);
      if (status === "retired") settle(false);
    });
  });
}

/** The service's own account of itself, read once. */
export function readServiceCell(
  client: OduServiceClient,
): Effect.Effect<ServiceCell, unknown> {
  return firstFrameOrThrow(
    unenrolledStreamCall(client.surface.service.get, undefined),
    "odu: the service cell yielded no snapshot frame — the link answered but said nothing",
  );
}
