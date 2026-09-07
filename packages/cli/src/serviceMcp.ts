/**
 * The SERVICE's agent face — one projection, two pipes.
 *
 * `@kolu/surface-mcp` turns `oduServiceSurface` into MCP tools and resources
 * from the same `expose` map the terminal face reads, so `run_start` is one
 * verb with one name whichever door an agent came through. What differs between
 * the two pipes is only the pipe:
 *
 *   - **HTTP** — a route on the web service's own listener, at `/mcp`. The
 *     adapter is in-process with the surface it serves (`directDispatch`), so a
 *     tool call is a function call and nothing is serialised twice.
 *   - **stdio** — `odu mcp`, for a host that spawns a subprocess. It DIALS the
 *     singleton and projects what it finds; it starts no coordinator and holds
 *     no run authority of its own, which is what makes a harness restarting it
 *     harmless.
 *
 * ## Why the transport is hand-rolled, and what it is
 *
 * `serveSurfaceAsMcp` takes a `Transport` because the shape of the pipe is the
 * embedder's business. The SDK's `StreamableHTTPServerTransport` writes
 * directly to a Node `ServerResponse`, and this listener's HTTP leg is an
 * Effect `HttpRouter` whose handlers ANSWER with a response rather than write
 * one — so the two would be two writers of one socket.
 *
 * `RouteTransport` below is the same shape olai's MCP plugin uses against this
 * adapter, and it is a conformant Streamable HTTP endpoint for the half that
 * matters: a client POSTs a JSON-RPC message and gets the reply as
 * `application/json`, which the transport spec permits in place of an SSE
 * stream. `initialize` is answered by the SDK's own `Protocol`, so the
 * handshake is real. What is deliberately absent:
 *
 *   - **No `Mcp-Session-Id`.** The spec makes it optional, and this endpoint
 *     makes no session requirement of a client — so issuing an id a client then
 *     has to echo would be a rule with nothing behind it.
 *   - **`GET /mcp` answers 405.** Also permitted: this server pushes nothing.
 *     Resource-updated notifications have nowhere to go on a half-duplex pipe,
 *     which is why an agent that wants to WATCH uses `run_wait` (bounded and
 *     resumable) rather than a subscription.
 *
 * ## Concurrent callers cannot collide on a JSON-RPC id
 *
 * Two agents posting to one endpoint both start their ids at 1, and a transport
 * keyed on the caller's id would answer the second with "already in flight" —
 * or, worse, hand one caller the other's reply. So an inbound id is REWRITTEN
 * to one this endpoint mints and rewritten back on the way out. The caller sees
 * its own id; the transport sees a unique one; neither has to know about the
 * other.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  serveSurfaceAsMcp,
  type ServedSurfaceMcp,
  type SurfaceClientCallable,
} from "@kolu/surface-mcp";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { dialService } from "@odu/service-client/dial";
import { SERVICE_MCP_PATH, serviceOrigin } from "@odu/service-client/endpoint";
import { oduServiceSurface } from "@odu/service-client/surface";
import {
  ODU_SERVICE_EXPOSE,
  ODU_SERVICE_MCP_INSTRUCTIONS,
} from "@odu/service-client/verbs";
import { Effect } from "effect";
import { serveUntilDisconnect } from "./mcp";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type { HttpServerRequest } from "effect/unstable/http";

/** A JSON-RPC message, at the shape this transport reads. */
interface Message {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
}

const isMessage = (value: unknown): value is Message =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * One POST in, one reply out.
 *
 * The SDK drives `onmessage` and answers through `send`; this class is the two
 * ends of that tied to one HTTP request. `ask` resolves with the reply, or with
 * `null` for a notification (a message carrying no id, which by JSON-RPC has no
 * reply and is answered `202`).
 */
export class RouteTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  /** Replies in flight, by the id THIS transport minted. */
  readonly #waiting = new Map<string, (reply: unknown) => void>();
  /** The caller's own id, by the minted one — so a reply goes back wearing the
   *  id its sender used. */
  readonly #callerId = new Map<string, string | number>();
  #next = 0;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    // Every waiter resolved rather than abandoned: a POST left hanging on a
    // closed transport is a client that waits forever, which is worse than a
    // null answer it can retry.
    for (const [, resolve] of this.#waiting) resolve(null);
    this.#waiting.clear();
    this.#callerId.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as Message).id;
    // A message with no id is a server-initiated notification. On a half-duplex
    // pipe there is nowhere for it to go, and dropping it is the honest answer
    // — which is exactly why this endpoint advertises no subscriptions.
    if (id === undefined || id === null) return;
    const key = String(id);
    const waiter = this.#waiting.get(key);
    if (waiter === undefined) return;
    this.#waiting.delete(key);
    const caller = this.#callerId.get(key);
    this.#callerId.delete(key);
    waiter(caller === undefined ? message : { ...message, id: caller });
  }

  ask(message: unknown): Promise<unknown> {
    const id = (message as Message).id;
    if (id === undefined || id === null) {
      this.onmessage?.(message as JSONRPCMessage);
      return Promise.resolve(null);
    }
    this.#next += 1;
    const minted = `odu-${this.#next}`;
    this.#callerId.set(minted, id);
    return new Promise<unknown>((resolve) => {
      this.#waiting.set(minted, resolve);
      this.onmessage?.({ ...(message as object), id: minted } as JSONRPCMessage);
    });
  }
}

/** What this odu build calls itself to an MCP host. */
export function mcpServerInfo(version: string): { name: string; version: string } {
  return { name: "odu", version };
}

/**
 * The service's MCP bundle, over an in-process dispatch.
 *
 * The daemon serves the surface and hosts the adapter, so the adapter's client
 * is the surface's own handlers called directly: no socket, no second
 * serialisation, and no second copy of the state to keep in step.
 */
export function serveServiceMcpInProcess(opts: {
  handlers: SurfaceHandlers;
  version: string;
  transport: Transport;
}): Promise<ServedSurfaceMcp> {
  const face = buildSurfaceFace(
    oduServiceSurface,
    directDispatch({ handlers: opts.handlers }),
  ) as unknown as SurfaceClientCallable;
  return serveSurfaceAsMcp({
    core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
    client: () => ({ core: face }),
    serverInfo: mcpServerInfo(opts.version),
    instructions: ODU_SERVICE_MCP_INSTRUCTIONS,
    transport: opts.transport,
  });
}

/** A bearer token the route requires, when one is configured. Loopback and the
 *  origin gate are the primary fence; this is for an operator who has chosen to
 *  expose the port through a proxy and wants a second one. */
export const MCP_TOKEN_ENV = "ODU_WEB_MCP_TOKEN";

function authorized(headers: Record<string, string | undefined>): boolean {
  const required = process.env[MCP_TOKEN_ENV]?.trim();
  if (required === undefined || required === "") return true;
  const offered = headers["authorization"];
  return offered === `Bearer ${required}`;
}

/**
 * The `/mcp` routes, as a layer `serveSurfaceApp` merges beside the shell.
 *
 * Merged rather than ordered: `HttpRouter` ranks by specificity, so this
 * literal path beats the shell's `GET /*` catch-all whichever way round they go
 * in.
 */
// The return type is INFERRED, deliberately. `ReturnType<typeof HttpRouter.add>`
// instantiates the layer's type parameters at their unconstrained defaults, so
// the requirement lands as `Request<"Requires", unknown>` — which
// `serveSurfaceApp`'s `routes` correctly refuses, since an unknown per-request
// service is one nothing at that seam could discharge. Letting inference run
// resolves it to `never`, which is the truth: this route needs only the request
// the router already provides.
export function mcpRoute(transport: RouteTransport) {
  return HttpRouter.add(
    "POST",
    SERVICE_MCP_PATH,
    (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
      if (!authorized(request.headers)) {
        return HttpServerResponse.text("unauthorized", { status: 401 });
      }
      const body = yield* Effect.result(request.json);
      if (body._tag === "Failure") {
        return yield* Effect.orDie(
          HttpServerResponse.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "the body is not JSON" },
            },
            { status: 400 },
          ),
        );
      }
      // Refused HERE rather than handed on. The SDK's `Protocol` reports a
      // non-object body to `onerror` and sends NOTHING, which through a
      // half-duplex transport hangs the POST until the client gives up.
      if (!isMessage(body.success)) {
        return yield* Effect.orDie(
          HttpServerResponse.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "a JSON-RPC message is an object" },
            },
            { status: 400 },
          ),
        );
      }
        const reply = yield* Effect.promise(() => transport.ask(body.success));
        return reply === null
          ? HttpServerResponse.empty({ status: 202 })
          : yield* Effect.orDie(HttpServerResponse.json(reply));
      }),
  );
}

/** `GET /mcp` — this server pushes nothing, and says so rather than opening a
 *  stream that would never carry a frame. */
export function mcpGetRoute() {
  return HttpRouter.add(
    "GET",
    SERVICE_MCP_PATH,
    Effect.sync(() =>
      HttpServerResponse.text(
        "odu's MCP endpoint answers POSTed JSON-RPC and pushes nothing — " +
          "use run_wait to watch a run",
        { status: 405 },
      ),
    ),
  );
}

/**
 * `odu mcp` — the stdio BRIDGE.
 *
 * It dials the singleton and projects what it finds. It has no run authority of
 * its own: every tool call goes over the wire to the service, so two agents
 * driving two bridges are two clients of one truth rather than two opinions
 * about it — and a host restarting this process kills nothing.
 *
 * Returns the served adapter and a teardown; the caller owns the process
 * lifetime, as odu's binary does for every other command.
 */
export async function serveServiceMcpOverStdio(opts: {
  version: string;
  origin?: string;
  transport?: Transport;
}): Promise<{ served: ServedSurfaceMcp; close: () => Promise<void> }> {
  const origin = opts.origin ?? serviceOrigin();
  // ONE dial, held for the adapter's life, and re-made by the adapter's own
  // retry after a drop — `client()` is re-invoked, so a service that was
  // upgraded underneath this bridge is picked up on the next call rather than
  // leaving the bridge talking to a corpse.
  let held: Awaited<ReturnType<typeof dialService>> | null = null;
  const served = await serveSurfaceAsMcp({
    core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
    client: async () => {
      const connection = await dialService(origin);
      held = connection;
      return {
        client: {
          core: connection.client as unknown as SurfaceClientCallable,
        },
        dispose: () => connection.dispose(),
      };
    },
    serverInfo: mcpServerInfo(opts.version),
    instructions: ODU_SERVICE_MCP_INSTRUCTIONS,
    ...(opts.transport === undefined ? {} : { transport: opts.transport }),
  });
  return {
    served,
    close: async () => {
      await served.close();
      await held?.dispose();
    },
  };
}

/**
 * `odu mcp --service` — the whole command.
 *
 * Serves until the host disconnects, then disposes. It holds no run authority:
 * every call goes over the wire to the singleton, so two agents driving two
 * bridges are two clients of one truth rather than two opinions about it.
 */
export async function serviceMcpCommand(opts: {
  version: string;
  origin?: string;
}): Promise<number> {
  const { served, close } = await serveServiceMcpOverStdio(opts);
  await serveUntilDisconnect(served.server);
  await close();
  return 0;
}
