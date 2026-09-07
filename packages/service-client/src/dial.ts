/**
 * Dialling the service from OUTSIDE a browser — the generated CLI and the stdio
 * MCP bridge.
 *
 * A browser gets `connectSurface` from `@kolu/surface-app/solid`, which bundles
 * the socket, the link, the client and the liveness watchdog into one call and
 * derives the URL from the page's own origin. Nothing here duplicates that.
 * What a CLI and a bridge need is the SAME websocket route with none of the
 * page machinery: they dial once, do one thing, and exit (or, for the bridge,
 * hold one connection open for its host's lifetime).
 *
 * **The same route, deliberately.** This is not a second door with its own
 * protocol: `serviceWsUrl` is the framework's `/rpc/ws`, and the group is the
 * surface's own, so a frame this connection sends is byte-identical to one the
 * browser sends. The acceptance gate that says a start looks the same through
 * every face is only meetable if there is one wire under all of them.
 *
 * `WebSocket` is read off `globalThis` rather than imported. Node has had a
 * global `WebSocket` since 22, which is the floor odu already runs on (bun's
 * is likewise global), so an import of `ws` here would put a second websocket
 * implementation in the closure of every face — for a constructor the runtime
 * already has. A runtime without one is told so in a sentence rather than
 * failing as `undefined is not a constructor` inside the link.
 */

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

/** A dialled service, and the one thing a caller owes it. `dispose` is not
 *  optional bookkeeping: the link holds the dial, ping and response fibers, and
 *  dropping it leaks all three — which in a CLI loop is a process that never
 *  exits. */
export interface ServiceConnection {
  client: OduServiceClient;
  /** The transport-neutral dispatch under {@link ServiceConnection.client}.
   *
   *  Exposed because a face may need a DIFFERENTLY-TYPED view of the same
   *  connection: `@kolu/surface-cli` holds its client opaquely (leaves typed as
   *  callable) while everything else here wants the spec-precise face, and both
   *  are `buildSurfaceFace` over this one dispatch. Handing back the dispatch is
   *  what stops a consumer casting its way from one face to the other. */
  dispatch: SurfaceDispatch;
  /** The URL that was dialled, for an error message that has to name it. */
  url: string;
  dispose: () => Promise<void>;
}

/** The runtime's websocket constructor, or a sentence saying there is none. */
function webSocketCtor(): typeof WebSocket {
  const ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (ctor === undefined) {
    throw new Error(
      "odu: this runtime has no global WebSocket — odu's faces dial the service " +
        "over the framework's websocket route, and Node 22+/Bun provide one",
    );
  }
  return ctor;
}

/**
 * How long a dial waits for the socket to actually open before reporting that
 * nothing is serving.
 *
 * A websocket link is RESILIENT by construction: it re-dials, and it is right
 * to, because a browser tab must survive a server restart. A one-shot CLI is
 * the opposite case — it dials, does one thing and exits — and a link that
 * quietly retried forever would turn "odu web is not running" from an exit code
 * into a hang, which is the single most confusing thing a command-line tool can
 * do. So the FIRST open is bounded here and every subsequent re-dial is not.
 *
 * Three seconds because this is loopback: a service that is up answers in
 * microseconds, and a service that is starting is being waited for by
 * `odu web`, which has its own much longer readiness deadline and a cell to
 * read rather than a socket to guess at.
 */
export const DIAL_READY_MS = 3_000;

/**
 * Dial the service.
 *
 * Rejects when nothing is serving, and the rejection is what a face turns into
 * its own "nothing serving" exit. It does NOT start the service: bootstrapping
 * is `odu web`'s job and only `odu web`'s, because a face that silently spawned
 * a daemon would make every mistyped `--origin` a reason to start a second one.
 */
export async function dialService(
  origin: string = serviceOrigin(),
  opts: { readyMs?: number } = {},
): Promise<ServiceConnection> {
  const url = serviceWsUrl(origin);
  const ctor = webSocketCtor();
  const link = await websocketLink({
    group: oduServiceSurface.group,
    // A thunk, re-evaluated on every re-dial. The address does not move under
    // this process, but the link's contract is that it asks each time, and a
    // constant that pretended otherwise would be the one place a future
    // per-connection query string could not be added.
    url: () => url,
    // The server closes a socket bound to a PREVIOUS process with this code.
    // Terminal by construction: re-dialling would present the same stale
    // handshake and be closed again, forever.
    isTerminalClose: (code) => code === STALE_PROCESS_CLOSE_CODE,
    connect: (target) => new ctor(target),
  });
  const opened = await firstOpen(link, opts.readyMs ?? DIAL_READY_MS);
  if (!opened) {
    // Disposed rather than left retrying: the link owns dial, ping and response
    // fibers, and a caller about to report "nothing is serving" must not leave
    // a background reconnect loop behind it.
    await link.dispose();
    throw new Error(`odu: nothing is serving ${url} — run \`odu web\``);
  }
  return {
    client: oduServiceClientOver(link.dispatch),
    dispatch: link.dispatch,
    url,
    dispose: () => link.dispose(),
  };
}

/** Wait for the wire's FIRST open, bounded. `true` the moment it opens, `false`
 *  at the deadline; a wire that is already open answers immediately without
 *  going near a timer. */
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
      // `retired` is terminal — the server will not talk to this socket ever
      // again — so there is nothing to wait for and saying so now beats
      // burning the whole deadline on it.
      if (status === "retired") settle(false);
    });
  });
}

/**
 * The service's own account of itself, read once.
 *
 * A cell opens with a snapshot, so the first frame IS the read — and
 * `firstFrameOrThrow` treats an empty stream as a link failure rather than as a
 * silent empty, which is the difference between "the service says it is not
 * ready" and "there is no service". Used by `odu web` to verify readiness
 * before it prints a URL a person is about to open.
 */
export function readServiceCell(
  client: OduServiceClient,
): Effect.Effect<ServiceCell, unknown> {
  return firstFrameOrThrow(
    unenrolledStreamCall(client.surface.service.get, undefined),
    "odu: the service cell yielded no snapshot frame — the link answered but said nothing",
  );
}
