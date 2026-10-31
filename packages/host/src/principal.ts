/**
 * THE DOOR, ON THE HOST'S SIDE OF IT — how a connection's principal reaches a
 * verb, and what happens to a connection that has none.
 *
 * The host owns the listener, so it owns "who is on it"; the auth row owns the
 * sessions. This module is the seam between them, and it is three things:
 *
 *   - **the connection layer** — kolu's `services(connection)` hook, which
 *     acquires a session LEASE at the upgrade and arranges its release in the
 *     same step, then provides {@link CurrentPrincipal} to that connection's
 *     handlers;
 *   - **the gate** — the wrapper around the served handler record, because the
 *     seam cannot refuse an upgrade: a connection with no session is served a
 *     daemon that answers nothing but the identity reads, and a connection
 *     whose session ended stops receiving a single further frame;
 *   - **the MCP door's per-request admission** — the HTTP leg has no
 *     per-connection service, so a Bearer-resolved admission rides an async
 *     context for exactly the request that carried it.
 *
 * ## Why the gate exists at all
 *
 * `serveSurfaceApp` accepts a socket and only then asks the app for its
 * per-connection services; there is no accept/reject hook, and no public seam
 * lets odu close a socket it was handed. So "refuse" has to mean "serve
 * nothing": every member is refused except the handful whose subject is the
 * daemon's own identity (which every client reads before it knows whether it may
 * speak at all) and the auth row's `whoami` (which is how an anonymous page
 * learns it is anonymous). A collection subscription opened before a session
 * ended is INTERRUPTED at that moment rather than left pushing, because the
 * lease's `ended` is what it watches.
 *
 * That is a deviation from the seam's ideal and it is written down in PLAN.md:
 * the lease ends the connection's traffic, the socket itself is kolu's to hold.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Layer, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http";
import type {
  SurfaceAppConnection,
  SurfaceAppHttpMiddleware,
} from "@kolu/surface-app/serve";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceHandler, SurfaceHandlers } from "@kolu/surface/server";
import {
  admissionFor,
  admissionOf,
  CurrentPrincipal,
  LOCAL_ADMISSION,
  NoPrincipal,
  type Admission,
  type Principal,
  type PrincipalBroker,
} from "@odu/cordis/principal";

/**
 * WHAT A CONNECTION MAY ASK BEFORE IT HAS A SESSION.
 *
 * Two identity reads, and one of them is `auth`'s own when that row is mounted:
 * every client asks the daemon who and what it is before it does anything else,
 * and a page cannot show a sign-in form if it cannot even ask. Nothing here
 * reads a run, a bucket or a session.
 */
export const IDENTITY_TAGS: Readonly<Record<string, true>> = {
  // The board's identity cell — the contract version a client is admitted
  // against, and the build it compares.
  "surface/service/get": true,
  // The frozen control fragment's `hello`: the supervisor's probe, and the
  // ONE control member that is safe to answer anonymously. `drain` is not.
  "surface/control/hello": true,
};

/** The admission a connection runs under, from the broker's lease. */
export function connectionLayer(
  broker: PrincipalBroker,
  connection: SurfaceAppConnection<"cookie">,
): Layer.Layer<CurrentPrincipal> {
  return Layer.effect(
    CurrentPrincipal,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const lease = broker.acquire(connection.headers);
          return { admission: admissionFor(lease), release: () => lease?.release() };
        }),
        (held) => Effect.sync(held.release),
      ),
      (held) => held.admission,
    ),
  );
}

/** Does this admission let the call through? `allowed` names the tags a
 *  connection with NO principal may still ask. */
function serves(admission: Admission, allowed: boolean): boolean {
  if (admission.principal === null) return allowed;
  return admission.live();
}

/**
 * THE SERVED HANDLER RECORD, WITH THE DOOR IN FRONT OF IT.
 *
 * Every member — a cell read, a collection subscription, a procedure — is
 * checked against the connection's admission. An ended session takes effect on
 * the NEXT call; a subscription that is already open is interrupted at the
 * moment it ends, which is what stops a board from being pushed to a tab whose
 * session was revoked.
 */
export function gatedHandlers(
  handlers: SurfaceHandlers,
  alsoAllowed: ReadonlySet<string> = new Set(),
): SurfaceHandlers {
  const gated: SurfaceHandlers = Object.create(null) as SurfaceHandlers;
  for (const [tag, handler] of Object.entries(handlers)) {
    const allowed = IDENTITY_TAGS[tag] === true || alsoAllowed.has(tag);
    const wrapped: SurfaceHandler = (payload) => {
      // A handler's value is a DESCRIPTION — an `Effect` or a `Stream` that
      // does nothing until it is run — so producing it before the verdict
      // reaches no state. The verdict is what decides whether it is run.
      const produced = handler(payload);
      if (Stream.isStream(produced)) {
        return Stream.unwrap(
          Effect.map(admissionOf, (admission) =>
            serves(admission, allowed)
              ? Stream.interruptWhen(produced, admission.ended)
              : Stream.die(new NoPrincipal()),
          ),
        );
      }
      return Effect.flatMap(admissionOf, (admission) =>
        serves(admission, allowed) ? produced : Effect.die(new NoPrincipal()),
      );
    };
    gated[tag] = wrapped;
  }
  return gated;
}

// ── the MCP door ────────────────────────────────────────────────────────────

/** Where the admission of the MCP request in flight is kept. One per daemon,
 *  made by the composition root — a module-level slot would be one process's
 *  state behind a door, which this tree refuses. */
export interface AdmissionStore {
  /** Run `work` with `admission` as the ambient one. */
  run<A>(admission: Admission, work: () => Promise<A>): Promise<A>;
  /** The ambient admission, if this call is inside {@link run}. */
  current(): Admission | undefined;
}

/** A fresh store. The SDK is Promise-shaped, so the per-request admission rides
 *  an async context rather than an Effect fiber. */
export function admissionStore(): AdmissionStore {
  const slot = new AsyncLocalStorage<Admission>();
  return {
    run: (admission, work) => slot.run(admission, work),
    current: () => slot.getStore(),
  };
}

/**
 * THE IN-PROCESS DISPATCH, WITH THE REQUEST'S ADMISSION PROVIDED.
 *
 * The `/mcp` adapter is built ONCE for the listener's life and dials the served
 * handlers directly, so the only place a per-request fact can enter is the
 * dispatch call itself — and that happens inside the async context the route
 * established. Absent a context (a unit test, the stdio bridge's own dial),
 * the loopback owner stands, which is the same absence rule as everywhere else.
 */
export function admissionDispatch(
  base: SurfaceDispatch,
  store: AdmissionStore,
): SurfaceDispatch {
  const ambient = (): Admission => store.current() ?? LOCAL_ADMISSION;
  return {
    unary: (tag, payload) =>
      Effect.provideService(base.unary(tag, payload), CurrentPrincipal, ambient()),
    stream: (tag, payload) =>
      Stream.provideService(base.stream(tag, payload), CurrentPrincipal, ambient()),
  };
}

/**
 * THE HTTP LEG'S REFUSAL — an anonymous `/mcp` POST never reaches the surface.
 *
 * The websocket door reads a cookie at the upgrade; this leg reads a Bearer
 * token per request. When an identity provider is mounted and the token names
 * nobody, the answer is `401` and the adapter is never entered. With no
 * resolver the local owner stands and nothing is asked — the loopback mode's
 * existing MCP clients are untouched.
 *
 * The ROUTE resolves the same header again for the admission it dispatches
 * with: one resolver, two readers, because the middleware cannot hand a service
 * to a handler (its signature adds requirements, it cannot discharge them).
 */
export function bearerGate(
  broker: PrincipalBroker,
  mcpPath: string,
): SurfaceAppHttpMiddleware {
  return <E, R>(httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      if (!broker.mounted()) return httpApp;
      if (request.url.split("?")[0] !== mcpPath) return httpApp;
      if (broker.authorize(request.headers["authorization"]) !== null) return httpApp;
      return Effect.succeed(
        HttpServerResponse.text(
          "odu: /mcp needs `Authorization: Bearer <token>` — create a personal " +
            "access token on this server's profile page, or run `odu auth login`",
          { status: 401 },
        ),
      );
    });
}

/** The principal this HTTP request carries, resolved the same way the gate
 *  resolves it. */
export function bearerPrincipal(
  broker: PrincipalBroker,
  headers: Record<string, string | undefined>,
): Principal | null {
  return broker.authorize(headers["authorization"]);
}
