/**
 * THE SERVICE'S MCP ENDPOINT, as a route on the daemon's own listener.
 *
 * `@kolu/surface-mcp` turns `oduServiceSurface` into MCP tools and resources
 * from the same `expose` map the terminal face reads, so `run_start` is one
 * verb with one name whichever door an agent came through. This is the HTTP
 * pipe: the adapter is in-process with the surface it serves (a direct
 * dispatch, built by the composition root so the request's principal can ride
 * it),
 * so a tool call is a function call and nothing is serialised twice.
 *
 * The STDIO pipe — `odu mcp`, a bridge a host spawns — stayed in `@odu/cli`
 * (`./serviceMcp`), because it is a face rather than a part of the listener.
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
 * ## This route is a SECOND DOOR, and it is locked with the same key
 *
 * `serveSurfaceApp` gates the websocket upgrade on `Origin`, and
 * `@kolu/surface`'s own note says the upgrade is the only place a browser
 * Origin can arrive. Mounting `/mcp` beside it made that false. So the same
 * Origin decision — the framework's `isAllowedWsOrigin`, over the same
 * allowlist — runs here, plus the one thing an HTTP method needs that an
 * upgrade does not: a JSON content type. See {@link gateMcpRequest}.
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

import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { buildSurfaceFace } from "@kolu/surface/client";
import { composedClients } from "@odu/cordis/compose";
import {
  serveSurfaceAsMcp,
  type ServedSurfaceMcp,
  type SurfaceClientCallable,
} from "@kolu/surface-mcp";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { isAllowedWsOrigin } from "@kolu/surface/ws-origin";
import { agentInstructions, type RowAgent } from "@odu/cordis/services";
import { requestAdmission, type PrincipalBroker } from "@odu/cordis/principal";
import type { AdmissionStore } from "./principal";
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";
// The router's own path type (`/${string}` | "*"), so the parameter cannot be
// handed something the router would refuse.
import type { PathInput } from "effect/http/FindMyWay";

interface Message {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
}

const isMessage = (value: unknown): value is Message =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One in-flight call, from the POST that carried it. */
interface Pending {
  resolve: (reply: unknown) => void;
  /** The caller's own id, so a reply goes back wearing the id its sender used. */
  callerId: string | number;
  /** Which session claimed it — `null` for a client that echoed no session id. */
  session: string | null;
}

/** What a caller is, for the purpose of correlating its own ids. A client that
 *  echoes the session id issued at `initialize` gets one of these; one that does
 *  not shares the anonymous namespace, where only replies are correlated. */
export const MCP_SESSION_HEADER = "mcp-session-id";

/**
 * One POST in, one reply out.
 *
 * The SDK drives `onmessage` and answers through `send`; this class is the two
 * ends of that tied to one HTTP request. `ask` resolves with the reply, or with
 * `null` for a notification (a message carrying no id, which by JSON-RPC has no
 * reply and is answered `202`).
 *
 * ## Cancellation is correlated per SESSION, or it is dropped
 *
 * Inbound ids are rewritten (see the module header), which means a
 * `notifications/cancelled` naming the caller's own request id names nothing
 * this transport knows. Rewriting it needs a map from caller id to minted id —
 * and that map is only unambiguous WITHIN one client, because two clients both
 * start their ids at 1. So the id issued at `initialize` is what scopes it: a
 * client that echoes `Mcp-Session-Id` can cancel its own calls, and a client
 * that does not has its cancellation DROPPED rather than applied to whichever
 * request happened to use that number. Dropping is the only safe arm — the
 * alternative is one agent cancelling another's run wait.
 */
export class RouteTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  /** Calls in flight, by the id THIS transport minted. */
  readonly #waiting = new Map<string, Pending>();
  /** `session\0callerId` → the minted id, for a cancellation to find. */
  readonly #byCaller = new Map<string, string>();
  #next = 0;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    // Every waiter resolved rather than abandoned: a POST left hanging on a
    // closed transport is a client that waits forever, which is worse than a
    // null answer it can retry.
    for (const [, pending] of this.#waiting) pending.resolve(null);
    this.#waiting.clear();
    this.#byCaller.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as Message).id;
    // A message with no id is a server-initiated notification. On a half-duplex
    // pipe there is nowhere for it to go, and dropping it is the honest answer
    // — which is exactly why this endpoint advertises no subscriptions.
    if (id === undefined || id === null) return;
    const pending = this.#settle(String(id));
    if (pending === undefined) return;
    pending.resolve({ ...(message as object), id: pending.callerId });
  }

  /**
   * Hand one client message to the server and wait for its reply.
   *
   * `signal` is the CALLER's own withdrawal — an HTTP request that went away.
   * It ends the observation: the SDK is told the request was cancelled (so a
   * handler watching for it stops), the waiter is released, and nothing about
   * the run itself is touched.
   */
  ask(
    message: unknown,
    ctx: { session?: string | null; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const session = ctx.session ?? null;
    const id = (message as Message).id;
    if (id === undefined || id === null) {
      this.#notify(message as Message, session);
      return Promise.resolve(null);
    }
    this.#next += 1;
    const minted = `odu-${this.#next}`;
    const callerKey = `${session ?? ""}\0${String(id)}`;
    return new Promise<unknown>((resolve) => {
      this.#waiting.set(minted, { resolve, callerId: id, session });
      if (session !== null) this.#byCaller.set(callerKey, minted);
      const withdraw = (): void => {
        const pending = this.#settle(minted);
        if (pending === undefined) return;
        this.#cancel(minted, "the caller disconnected");
        pending.resolve(null);
      };
      if (ctx.signal !== undefined) {
        if (ctx.signal.aborted) withdraw();
        else ctx.signal.addEventListener("abort", withdraw, { once: true });
      }
      this.onmessage?.({ ...(message as object), id: minted } as JSONRPCMessage);
    });
  }

  /** Take a call out of flight, by the id this transport minted. */
  #settle(minted: string): Pending | undefined {
    const pending = this.#waiting.get(minted);
    if (pending === undefined) return undefined;
    this.#waiting.delete(minted);
    if (pending.session !== null) {
      this.#byCaller.delete(
        `${pending.session}\0${String(pending.callerId)}`,
      );
    }
    return pending;
  }

  /** Tell the server a request was cancelled, in its own vocabulary. */
  #cancel(minted: string, reason: string): void {
    this.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: minted, reason },
    } as unknown as JSONRPCMessage);
  }

  /**
   * A notification from the client. `notifications/cancelled` is the one that
   * has to be translated, because it names an id this transport rewrote.
   */
  #notify(message: Message, session: string | null): void {
    if (message.method !== "notifications/cancelled") {
      this.onmessage?.(message as unknown as JSONRPCMessage);
      return;
    }
    const params = (message as { params?: { requestId?: unknown } }).params;
    const named = params?.requestId;
    if (session === null || (typeof named !== "string" && typeof named !== "number")) {
      // No session, so no way to tell whose request id this is. DROPPED — see
      // the class header: cancelling the wrong caller's call is worse than not
      // cancelling at all.
      return;
    }
    const minted = this.#byCaller.get(`${session}\0${String(named)}`);
    if (minted === undefined) return;
    const pending = this.#settle(minted);
    this.#cancel(minted, "the client cancelled the request");
    pending?.resolve(null);
  }
}

/** What this odu build calls itself to an MCP host. */
export function mcpServerInfo(version: string): { name: string; version: string } {
  return { name: "odu", version };
}

/**
 * THE COMPOSED BUNDLE'S MCP door, over an in-process dispatch.
 *
 * One adapter over the whole composed wire — the runs as the unprefixed core,
 * every sibling under its key — so `run_start` and `cache_bucket_create` are the
 * same two names an agent sees on a bridge and a person sees in `odu surface`.
 * The tool names come from the framework's own derivation, and the exposure maps
 * are the ROWS' (each row hands its own at boot): the transport composes, and
 * knows what none of them mean.
 *
 * The adapter's client is the composed handlers called DIRECTLY — no socket, no
 * second serialisation, no second copy of the state to keep in step.
 */
export function serveServiceMcpInProcess(opts: {
  /** The served surface, called through the dispatch the composition root
   *  provides — so a per-request fact (the Bearer principal) can ride the call,
   *  and so this door carries no second dispatch of its own. */
  dispatch: SurfaceDispatch;
  version: string;
  transport: Transport;
  /** WHERE the endpoint is mounted. The HOST passes it, because this package
   *  names no row: the constant lives in the contract the runs are, and a
   *  no-row package that imported it would be importing a row outside a root. */
  path: PathInput;
  /** The wire's unprefixed floor. */
  core: RowAgent | null;
  /** Every sibling, keyed by the segment its names take. */
  siblings: Readonly<Record<string, RowAgent>>;
}): Promise<ServedSurfaceMcp> {
  const dispatch = opts.dispatch;
  const keys = Object.keys(opts.siblings);
  const surfaces = Object.fromEntries(
    keys.map((key) => [key, opts.siblings[key]!.surface]),
  );
  // ONE builder for the sibling client map, shared with every other face
  // (`@odu/cordis/compose`): a second derivation of the tag prefix is a
  // second thing that can be wrong.
  const clients = composedClients(surfaces, dispatch);
  return serveSurfaceAsMcp({
    ...(opts.core === null
      ? {}
      : {
          core: {
            surface: opts.core.surface,
            expose: opts.core.expose,
          },
        }),
    surfaces: Object.fromEntries(
      keys.map((key) => [
        key,
        { surface: opts.siblings[key]!.surface, expose: opts.siblings[key]!.expose },
      ]),
    ),
    client: () => ({
      ...(opts.core === null
        ? {}
        : {
            core: buildSurfaceFace(
              opts.core.surface,
              dispatch,
            ) as unknown as SurfaceClientCallable,
          }),
      clients,
    }),
    serverInfo: mcpServerInfo(opts.version),
    // Each row's own words, composed at the moment a host asks — a paragraph a
    // missing row contributed would be a sentence about a surface this serve
    // does not carry. ONE composer, shared with the stdio bridge: the two doors
    // had already drifted by a paragraph once.
    instructions: () => agentInstructions(opts.core, opts.siblings),
    transport: opts.transport,
  });
}

/** A bearer token the route requires, when one is configured. Loopback, the
 *  Host check and the Origin gate are the primary fence; this is for an operator
 *  who has chosen to expose the port through a proxy and wants a second one. */
export const MCP_TOKEN_ENV = "ODU_WEB_MCP_TOKEN";

function authorized(headers: Record<string, string | undefined>): boolean {
  const required = process.env[MCP_TOKEN_ENV]?.trim();
  if (required === undefined || required === "") return true;
  const offered = headers["authorization"];
  return offered === `Bearer ${required}`;
}

export type McpGateVerdict =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * MAY THIS POST REACH THE SURFACE?
 *
 * The Origin decision is the framework's `isAllowedWsOrigin`, the same one the
 * websocket upgrade runs, so the two doors cannot drift apart. No Host is
 * refused: the service answers to whatever name it was reached by. What is
 * added here is the one check an HTTP method needs and an upgrade does not:
 *
 * **The content type must be JSON.** A cross-origin `fetch` with
 * `content-type: application/json` is not a CORS-"simple" request, so a browser
 * must preflight it and this endpoint answers no preflight. The three types a
 * form CAN post without one (`text/plain`, `multipart/form-data`,
 * `application/x-www-form-urlencoded`) are refused here — which closes the
 * form-POST door, the one that carries no `Origin` for the other checks to
 * reason about. A cross-site page does not have to READ the reply, so CORS's
 * read protection is no protection at all against the mutation.
 */
export function gateMcpRequest(
  headers: Record<string, string | undefined>,
  allowedOrigins: readonly string[],
): McpGateVerdict {
  const contentType = (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return {
      ok: false,
      status: 415,
      message:
        "odu: /mcp takes application/json — a JSON-RPC message, posted by " +
        "something that meant to talk to odu",
    };
  }
  if (
    !isAllowedWsOrigin({
      origin: headers["origin"],
      host: headers["host"],
      allowedOrigins,
    })
  ) {
    return {
      ok: false,
      status: 403,
      message:
        `odu: ${headers["origin"]} is not allowed to drive this service. Set ` +
        "ODU_WEB_ALLOWED_ORIGINS if it should be.",
    };
  }
  return { ok: true };
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
export function mcpRoute(
  transport: RouteTransport,
  allowedOrigins: readonly string[],
  path: PathInput,
  door: {
    /** Where this request's admission rides to the dispatch. */
    readonly store: AdmissionStore;
    /** The host's broker — the one resolver for a Bearer credential. */
    readonly broker: PrincipalBroker;
  },
) {
  return HttpRouter.add(
    "POST",
    path,
    (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const gate = gateMcpRequest(request.headers, allowedOrigins);
        if (!gate.ok) {
          return HttpServerResponse.text(gate.message, { status: gate.status });
        }
        if (!authorized(request.headers)) {
          return HttpServerResponse.text("unauthorized", { status: 401 });
        }
        // THE SECOND DOOR'S OWN LOCK. The middleware already refuses an
        // anonymous POST when an identity provider is mounted; resolving it
        // again here is what the DISPATCH needs, because the adapter is built
        // once and the admission has to ride this one request. One resolver,
        // two readers — see `@odu/host/principal`.
        const principal = door.broker.authorize(request.headers["authorization"]);
        if (principal === null) {
          return HttpServerResponse.text(
            "odu: /mcp needs `Authorization: Bearer <token>`",
            { status: 401 },
          );
        }
        const admission = requestAdmission(principal);
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
        const message = body.success;
        // A session id is MINTED at the handshake and echoed by a client that
        // wants its own cancellations to work. It is a correlation namespace,
        // not a credential — nothing is authorised by it — which is why it is
        // issued freely and why a client that ignores it still works for
        // everything except cancelling.
        const opened = message.method === "initialize";
        const session = opened
          ? randomUUID()
          : (request.headers[MCP_SESSION_HEADER] ?? null);
        const reply = yield* Effect.callback<unknown>((resume) => {
          const withdraw = new AbortController();
          // THE ADMISSION RIDES THE ASK. The SDK is Promise-shaped, so the
          // request's principal enters the dispatch through the async context
          // this call establishes — and only for as long as this call runs.
          void door.store
            .run(admission, () =>
              transport.ask(message, { session, signal: withdraw.signal }),
            )
            .then((value) => resume(Effect.succeed(value)));
          // The HTTP request went away — the tab closed, the agent gave up,
          // the process was killed. That ends the OBSERVATION: the adapter
          // cancels the in-flight call (which the surface runs under the MCP
          // request's own signal, so the fiber is interrupted) and the run
          // carries on. Without this the poll ran to its full deadline with
          // nobody left to answer.
          return Effect.sync(() => withdraw.abort());
        });
        const answer =
          reply === null
            ? HttpServerResponse.empty({ status: 202 })
            : yield* Effect.orDie(HttpServerResponse.json(reply));
        return opened
          ? HttpServerResponse.setHeader(
              answer,
              "mcp-session-id",
              session as string,
            )
          : answer;
      }),
  );
}

/** `GET /mcp` — this server pushes nothing, and says so rather than opening a
 *  stream that would never carry a frame. */
export function mcpGetRoute(path: PathInput) {
  return HttpRouter.add(
    "GET",
    path,
    Effect.sync(() =>
      HttpServerResponse.text(
        "odu's MCP endpoint answers POSTed JSON-RPC and pushes nothing — " +
          "use run_wait to watch a run",
        { status: 405 },
      ),
    ),
  );
}
