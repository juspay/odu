/**
 * THE DOOR, ON THE HOST'S SIDE OF IT — how a connection's principal reaches a
 * verb, and what happens to a connection that has none.
 *
 * The host owns the listener, so it owns "who is on it"; the auth row owns the
 * sessions. This module is the seam between them:
 *
 *   - **the connection layer** — kolu's `services(connection)` hook, which
 *     acquires a session LEASE at the upgrade and arranges its release in the
 *     same step, then provides {@link CurrentPrincipal} to that connection's
 *     handlers. The same layer is where a lease that ENDS asks the listener to
 *     cut the socket ({@link ConnectionCloser}).
 *   - **the gate** — the wrapper around the served handler record, because the
 *     accept seam cannot refuse an upgrade: a connection with no session is
 *     served a daemon that answers nothing but the identity reads, and a
 *     connection whose session ended answers nothing at all.
 *   - **the HTTP legs** — one middleware for both: the MCP door refuses an
 *     anonymous POST with `401`, and the SHELL answers an anonymous browser
 *     with the sign-in page the server renders (so `curl /` sees it, not only
 *     a browser running the bundle). The MCP door's per-request admission rides
 *     an async context, because that adapter is Promise-shaped.
 *
 * ## The lease ends the CONNECTION (TODO: re-pin kolu)
 *
 * A session that ends must close the socket it was on — "the lease's end ends
 * what the lease admitted". `serveSurfaceApp` now hands the app a
 * `SurfaceAppConnection` whose `close(code?, reason?)` is that call (kolu
 * PR #2330); the lease's watch calls it, once, before releasing.
 *
 * Until odu re-pins kolu, the field is ABSENT at runtime — the type here says
 * optional and the call is `connection.close?.(…)` — so nothing is closed yet
 * and the re-pin is the one line that turns it on. Everything else about an
 * ended lease is already true: every member is refused, and every open
 * subscription is interrupted at the instant it ends.
 *
 * What is deliberately NOT done instead: refusing the reserved heartbeat so the
 * client's watchdog cuts the socket. `heartbeat.ts` (kolu `@kolu/surface`)
 * counts a REJECTION as alive — only a timeout fires `onStale` — so that would
 * be a cut by client tuning, seconds later, on clients that happen to run a
 * watchdog, and it would let a revoked token's socket serve every frame in
 * between. A credential ends at the server.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type {
  SurfaceAppConnection,
  SurfaceAppHttpMiddleware,
} from "@kolu/surface-app/serve";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { SERVICE_DOOR_PATH } from "@odu/cordis/services";
import type { SurfaceHandler, SurfaceHandlers } from "@kolu/surface/server";
import {
  admissionFor,
  admissionOf,
  CurrentPrincipal,
  LOCAL_ADMISSION,
  NOBODY_ADMISSION,
  NoPrincipal,
  type Admission,
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
  // THE FRAMEWORK'S THREE RESERVED MEMBERS. Serving them to an ANONYMOUS
  // connection is what keeps a sign-in page from flapping: its watchdog would
  // otherwise sever a socket it believes dead.
  "surface/system/live": true,
  "surface/system/identity": true,
  "surface/system/clockNow": true,
};

/** The request headers a websocket connection is read under, named here because
 *  the per-connection layer's type and the listener's allowlist must agree: a
 *  browser carries a session COOKIE, and the CLI and the MCP bridge carry a
 *  personal token as `Authorization: Bearer`. Nothing else off the upgrade is
 *  reachable from the connection. */
export const UPGRADE_HEADERS = ["cookie", "authorization"] as const;
export type UpgradeHeader = (typeof UPGRADE_HEADERS)[number];

/** A connection the host may close — `close()` is kolu #2330's. Optional because
 *  the pinned kolu predates it; see this module's header. */
export type DoorConnection = SurfaceAppConnection<UpgradeHeader> & {
  readonly close?: (code?: number, reason?: string) => void;
};

/** A normal closure, with a reason the peer can read. Not kolu's stale-process
 *  code (4001), which RETIRES the link: a session that ended should make the
 *  client redial, present the dead cookie, and land on the sign-in page. */
const CLOSE_SESSION_ENDED = 1000;

/** The admission a connection runs under, from the broker's lease.
 *
 *  ACQUISITION AND RELEASE IN ONE STEP: the lease is taken inside
 *  `Effect.acquireRelease`, the release is arranged beside it, and an
 *  interrupted bind therefore cannot leave a lease with no owner. A lease that
 *  ENDS — logout, revocation, expiry, a role change — closes the connection
 *  through the closer and then releases, in that order: the socket goes first,
 *  because a frame arriving between the two would be served on a session that
 *  is over. */
export function connectionLayer(
  broker: PrincipalBroker,
  connection: DoorConnection,
): Layer.Layer<CurrentPrincipal> {
  return Layer.effect(
    CurrentPrincipal,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const lease = broker.acquire(connection.headers);
          const watched = lease?.watch(() => {
            // THE LEASE'S END CLOSES WHAT IT ADMITTED — see the header.
            connection.close?.(CLOSE_SESSION_ENDED, "the session ended");
          });
          return {
            admission: admissionFor(lease),
            release: () => {
              watched?.();
              lease?.release();
            },
          };
        }),
        (held) => Effect.sync(held.release),
      ),
      (held) => held.admission,
    ),
  );
}

/** Does this admission let the call through?
 *
 *  Two arms, and they are not symmetric:
 *
 *   - a connection with NO principal is answered the identity reads (and the
 *     framework's reserved members, the heartbeat among them);
 *   - a connection with a principal that has ENDED is refused EVERYTHING — the
 *     reserved members included. Nothing is served on a session that is over. */
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
  /** What a call OUTSIDE any {@link run} runs as — the composition root's
   *  choice, because only it knows whether this daemon has a door. */
  readonly fallback: Admission;
}

/** A fresh store. The SDK is Promise-shaped, so the per-request admission rides
 *  an async context rather than an Effect fiber. */
export function admissionStore(fallback: Admission = LOCAL_ADMISSION): AdmissionStore {
  const slot = new AsyncLocalStorage<Admission>();
  return {
    run: (admission, work) => slot.run(admission, work),
    current: () => slot.getStore(),
    fallback,
  };
}

/**
 * A DISPATCH OVER A HANDLER RECORD THAT IS READ PER CALL.
 *
 * The served generation is live — a row's mount replaces the record — so a
 * dispatch frozen at boot would address handlers that have since moved. The
 * in-process twin of `directDispatch` (kolu `surface/links/direct`), with the
 * record behind a thunk.
 */
export function liveDispatch(handlers: () => SurfaceHandlers): SurfaceDispatch {
  const resolve = (tag: string): SurfaceHandler => {
    const handler = handlers()[tag];
    if (handler === undefined) {
      throw new Error(
        `odu: no handler bound at "${tag}" — the served record moved under a ` +
          "dispatch built over it",
      );
    }
    return handler;
  };
  return {
    unary: (tag, payload) =>
      Effect.flatMap(Effect.yieldNow, () => resolve(tag)(payload) as Effect.Effect<unknown>),
    stream: (tag, payload) =>
      Stream.unwrap(Effect.map(Effect.yieldNow, () => resolve(tag)(payload) as Stream.Stream<unknown>)),
  };
}

/**
 * THE IN-PROCESS DISPATCH, WITH THE REQUEST'S ADMISSION PROVIDED.
 *
 * The `/mcp` adapter is built ONCE for the listener's life and dials the served
 * handlers directly, so the only place a per-request fact can enter is the
 * dispatch call itself — and that happens inside the async context the route
 * established. Outside one, the store's FALLBACK stands: the local owner in
 * loopback mode, and nobody on a daemon with a door.
 */
export function admissionDispatch(
  base: SurfaceDispatch,
  store: AdmissionStore,
): SurfaceDispatch {
  const ambient = (): Admission => store.current() ?? store.fallback;
  return {
    unary: (tag, payload) =>
      Effect.provideService(base.unary(tag, payload), CurrentPrincipal, ambient()),
    stream: (tag, payload) =>
      Stream.provideService(base.stream(tag, payload), CurrentPrincipal, ambient()),
  };
}

// ── the HTTP legs ───────────────────────────────────────────────────────────

export interface DoorGateOptions {
  readonly broker: PrincipalBroker;
  /** Where the MCP endpoint is mounted. */
  readonly mcpPath: string;
  /** The paths that serve the SHELL. A browser arriving at one of these with no
   *  session meets the server-rendered sign-in page. */
  readonly shellPaths: ReadonlyArray<string>;
  /** That page, as the row renders it. */
  readonly signInPage: () => string;
}

/**
 * THE HTTP LEGS' DOOR.
 *
 * Three answers, and none of them reaches a handler it should not:
 *
 *   - the MCP endpoint, with no Bearer, is `401` and the adapter is never
 *     entered (the route resolves the same header again for its dispatch —
 *     one resolver, two readers, because a middleware cannot hand a service to
 *     a handler);
 *   - a SHELL path, with no live session, is the sign-in page the SERVER renders
 *     — which is what makes `curl /` prove the door, rather than only a browser
 *     running the bundle;
 *   - everything else (assets, `/auth/…`, the cache's paths) is untouched: the
 *     sign-in page needs no bundle, and the cache's protocol has its own
 *     per-bucket credentials.
 *
 * With no door configured this middleware does nothing at all.
 */
export function doorGate(options: DoorGateOptions): SurfaceAppHttpMiddleware {
  return <E, R>(httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      if (!options.broker.hasDoor()) return httpApp;
      const path = request.url.split("?")[0] ?? request.url;
      if (path === options.mcpPath) {
        if (options.broker.authorize(request.headers["authorization"]) !== null) return httpApp;
        return Effect.succeed(
          HttpServerResponse.text(
            "odu: /mcp needs `Authorization: Bearer <token>` — create a personal " +
              "access token on this server's profile page, or run `odu auth login`",
            { status: 401 },
          ),
        );
      }
      if (!options.shellPaths.includes(path)) return httpApp;
      // THE RAW HEADER, untouched: the cookie's NAME and its grammar are the
      // auth row's, and its resolver parses them. The host asks "does this
      // connection carry a session" and never learns what a cookie is called.
      const lease = options.broker.acquire({ cookie: request.headers["cookie"] });
      if (lease !== null) {
        lease.release();
        return httpApp;
      }
      return Effect.succeed(
        HttpServerResponse.text(options.signInPage(), {
          contentType: "text/html; charset=utf-8",
          status: 200,
          headers: { "cache-control": "no-store" },
        }),
      );
    });
}

// ── the door fact, on its own route ─────────────────────────────────────────

/** The paths that serve the SHELL. The SPA is hash-routed, so these two are all
 *  a browser navigates to; the bundle's assets ride under `/assets/`. */
export const SHELL_PATHS: ReadonlyArray<string> = ["/", "/index.html"];

/**
 * WHETHER THIS DAEMON HAS A DOOR — the HOST'S OWN fact.
 *
 * It was on the runs' service cell, and that was the wrong owner: the fact
 * changes with `auth`, not with the runs, and it made `ci`, `service` and
 * `service-client` spell another row's word. It lives here instead, on the
 * listener the host owns, and the browser asks once before it draws anything.
 */
export function doorRoute(door: boolean) {
  return HttpRouter.add("GET", SERVICE_DOOR_PATH, () =>
    Effect.orDie(
      // `door`, not `mounted`: this is the BOOT fact — whether the daemon was
      // configured with sign-in — and a running row's state is not the page's
      // question.
      HttpServerResponse.json({ door }, { headers: { "cache-control": "no-store" } }),
    ),
  );
}
