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
import type { PathInput } from "effect/http/FindMyWay";

interface Message {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
}

const isMessage = (value: unknown): value is Message =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface Pending {
  resolve: (reply: unknown) => void;
  callerId: string | number;
  session: string | null;
}

export const MCP_SESSION_HEADER = "mcp-session-id";

class MintedIds {
  readonly #waiting = new Map<string, Pending>();
  readonly #bySession = new Map<string, string>();
  #next = 0;

  mint(pending: Pending): string {
    this.#next += 1;
    const minted = `odu-${this.#next}`;
    this.#waiting.set(minted, pending);
    if (pending.session !== null) {
      this.#bySession.set(MintedIds.#key(pending.session, pending.callerId), minted);
    }
    return minted;
  }

  settle(minted: string): Pending | undefined {
    const pending = this.#waiting.get(minted);
    if (pending === undefined) return undefined;
    this.#waiting.delete(minted);
    if (pending.session !== null) {
      this.#bySession.delete(MintedIds.#key(pending.session, pending.callerId));
    }
    return pending;
  }

  scopedTo(session: string | null, callerId: unknown): string | undefined {
    if (session === null) return undefined;
    if (typeof callerId !== "string" && typeof callerId !== "number") return undefined;
    return this.#bySession.get(MintedIds.#key(session, callerId));
  }

  drain(): ReadonlyArray<Pending> {
    const all = [...this.#waiting.values()];
    this.#waiting.clear();
    this.#bySession.clear();
    return all;
  }

  static #key(session: string, callerId: string | number): string {
    return `${session}\0${String(callerId)}`;
  }
}

export class RouteTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  readonly #ids = new MintedIds();

  async start(): Promise<void> {}

  async close(): Promise<void> {
    for (const pending of this.#ids.drain()) pending.resolve(null);
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as Message).id;
    if (id === undefined || id === null) return;
    const pending = this.#ids.settle(String(id));
    if (pending === undefined) return;
    pending.resolve({ ...(message as object), id: pending.callerId });
  }

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
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const minted = this.#ids.mint({ resolve, callerId: id, session });
    const withdraw = (): void => {
      const pending = this.#ids.settle(minted);
      if (pending === undefined) return;
      this.#cancel(minted, "the caller disconnected");
      pending.resolve(null);
    };
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) withdraw();
      else ctx.signal.addEventListener("abort", withdraw, { once: true });
    }
    this.onmessage?.({ ...(message as object), id: minted } as JSONRPCMessage);
    return promise;
  }

  #cancel(minted: string, reason: string): void {
    this.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: minted, reason },
    } as unknown as JSONRPCMessage);
  }

  #notify(message: Message, session: string | null): void {
    if (message.method !== "notifications/cancelled") {
      this.onmessage?.(message as unknown as JSONRPCMessage);
      return;
    }
    const params = (message as { params?: { requestId?: unknown } }).params;
    const minted = this.#ids.scopedTo(session, params?.requestId);
    if (minted === undefined) return;
    const pending = this.#ids.settle(minted);
    this.#cancel(minted, "the client cancelled the request");
    pending?.resolve(null);
  }
}

export function mcpServerInfo(version: string): { name: string; version: string } {
  return { name: "odu", version };
}

export function serveServiceMcpInProcess(opts: {
  dispatch: SurfaceDispatch;
  version: string;
  transport: Transport;
  path: PathInput;
  core: RowAgent | null;
  siblings: Readonly<Record<string, RowAgent>>;
}): Promise<ServedSurfaceMcp> {
  const dispatch = opts.dispatch;
  const keys = Object.keys(opts.siblings);
  const surfaces = Object.fromEntries(
    keys.map((key) => [key, opts.siblings[key]!.surface]),
  );
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
    instructions: () => agentInstructions(opts.core, opts.siblings),
    transport: opts.transport,
  });
}

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

function requiresPreflightContentType(headers: Record<string, string | undefined>): boolean {
  const offered = (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  return offered !== "application/json";
}

function originAllowed(
  headers: Record<string, string | undefined>,
  allowedOrigins: readonly string[],
): boolean {
  return isAllowedWsOrigin({
    origin: headers["origin"],
    host: headers["host"],
    allowedOrigins,
  });
}

export function gateMcpRequest(
  headers: Record<string, string | undefined>,
  allowedOrigins: readonly string[],
): McpGateVerdict {
  if (requiresPreflightContentType(headers)) {
    return {
      ok: false,
      status: 415,
      message:
        "odu: /mcp takes application/json — a JSON-RPC message, posted by " +
        "something that meant to talk to odu",
    };
  }
  if (!originAllowed(headers, allowedOrigins)) {
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

export function mcpRoute(
  transport: RouteTransport,
  allowedOrigins: readonly string[],
  path: PathInput,
  door: {
    readonly store: AdmissionStore;
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
        const opened = message.method === "initialize";
        const session = opened
          ? randomUUID()
          : (request.headers[MCP_SESSION_HEADER] ?? null);
        const reply = yield* Effect.callback<unknown>((resume) => {
          const withdraw = new AbortController();
          void door.store
            .run(admission, () =>
              transport.ask(message, { session, signal: withdraw.signal }),
            )
            .then((value) => resume(Effect.succeed(value)));
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
