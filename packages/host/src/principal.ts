/**
 * A session that ends must close the socket it was on — "the lease's end ends
 * what the lease admitted". `serveSurfaceApp` hands the app a
 * `SurfaceAppConnection` whose `close(code?, reason?)` is that call (kolu
 * PR #2330, pinned); the lease's watch calls it, once, before releasing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type {
  SurfaceAppConnection,
  SurfaceAppHttpMiddleware,
} from "@kolu/surface-app/serve";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { SERVICE_DOOR_PATH, SERVICE_ROWS_PATH } from "@odu/cordis/services";
import { isReserved } from "./reserved";
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

export const IDENTITY_TAGS: Readonly<Record<string, true>> = {
  "surface/service/get": true,
  "surface/control/hello": true,
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

/** A connection the host may close — `close()` is kolu #2330's, and the pin
 *  carries it. */
export type DoorConnection = SurfaceAppConnection<UpgradeHeader>;

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
            connection.close(CLOSE_SESSION_ENDED, "the session ended");
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

function serves(admission: Admission, allowed: boolean): boolean {
  if (admission.principal === null) return allowed;
  return admission.live();
}

/**
 * An ended session takes effect on
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

export interface AdmissionStore {
  run<A>(admission: Admission, work: () => Promise<A>): Promise<A>;
  current(): Admission | undefined;
  readonly fallback: Admission;
}

export function admissionStore(fallback: Admission = LOCAL_ADMISSION): AdmissionStore {
  const slot = new AsyncLocalStorage<Admission>();
  return {
    run: (admission, work) => slot.run(admission, work),
    current: () => slot.getStore(),
    fallback,
  };
}

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

export interface DoorGateOptions {
  readonly broker: PrincipalBroker;
  readonly mcpPath: string;
  readonly signInPage: () => string;
  readonly reservedPaths: ReadonlyArray<string>;
}

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
      const lease = options.broker.acquire({ cookie: request.headers["cookie"] });
      if (lease !== null) {
        lease.release();
        return httpApp;
      }
      const signIn = (): HttpServerResponse.HttpServerResponse =>
        HttpServerResponse.text(options.signInPage(), {
          contentType: "text/html; charset=utf-8",
          status: 200,
          headers: { "cache-control": "no-store" },
        });
      // EVERYTHING THE DAEMON DOES NOT RESERVE IS THE SHELL, so for an
      // anonymous connection it is the page the server renders. The reserved
      // set is COMPOSED (`./reserved`): the host's own paths plus the claim
      // each row registers beside its routes, so a new route cannot drift
      // from the gate.
      //
      // WHY A LIST AND NOT "REPLACE THE SHELL'S ANSWER": the middleware seam
      // runs the app and may REPLACE its response only by NOT running it. The
      // static layer writes its own answer, so a mapped replacement is ignored
      // (measured: a debug build logged the replaced response and the shell
      // still went out). A short-circuit is the one mechanism the seam has, so
      // the gate must know the boundary before the request is made.
      if (isReserved(path, options.reservedPaths)) return httpApp;
      return Effect.succeed(signIn());
    });
}

export function rowsRoute(rows: ReadonlyArray<string>) {
  return HttpRouter.add("GET", SERVICE_ROWS_PATH, () =>
    Effect.orDie(
      HttpServerResponse.json(
        { rows: [...rows] },
        { headers: { "cache-control": "no-store" } },
      ),
    ),
  );
}

export function doorRoute(door: boolean) {
  return HttpRouter.add("GET", SERVICE_DOOR_PATH, () =>
    Effect.orDie(
      HttpServerResponse.json({ door }, { headers: { "cache-control": "no-store" } }),
    ),
  );
}
