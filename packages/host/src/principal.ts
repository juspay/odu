import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type {
  SurfaceAppConnection,
  SurfaceAppHttpMiddleware,
} from "@kolu/surface-app/serve";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { SERVICE_DOOR_PATH, SERVICE_ROWS_PATH } from "@odu/cordis/services";
import { isReserved, type RouteClaim } from "./reserved";
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

const HOST_IDENTITY_TAGS = {
  "surface/service/get": true,
  "surface/control/hello": true,
} as const;

const FRAMEWORK_RESERVED_TAGS = {
  "surface/system/live": true,
  "surface/system/identity": true,
  "surface/system/clockNow": true,
} as const;

export const IDENTITY_TAGS: Readonly<Record<string, true>> = {
  ...HOST_IDENTITY_TAGS,
  ...FRAMEWORK_RESERVED_TAGS,
};

export const UPGRADE_HEADERS = ["cookie", "authorization"] as const;
export type UpgradeHeader = (typeof UPGRADE_HEADERS)[number];

/** A connection the host may close — `close()` is kolu #2330's, and the pin
 *  carries it. */
export type DoorConnection = SurfaceAppConnection<UpgradeHeader>;

/** A normal closure, with a reason the peer can read. Not kolu's stale-process
 *  code (4001), which RETIRES the link: a session that ended should make the
 *  client redial, present the dead cookie, and land on the sign-in page. */
const CLOSE_SESSION_ENDED = 1000;

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

function admissionAdmits(admission: Admission, withoutPrincipal: boolean): boolean {
  if (admission.principal === null) return withoutPrincipal;
  return admission.live();
}

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
            admissionAdmits(admission, allowed)
              ? Stream.interruptWhen(produced, admission.ended)
              : Stream.die(new NoPrincipal()),
          ),
        );
      }
      return Effect.flatMap(admissionOf, (admission) =>
        admissionAdmits(admission, allowed) ? produced : Effect.die(new NoPrincipal()),
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
  readonly reserved: ReadonlyArray<RouteClaim>;
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
      if (isReserved(path, options.reserved)) return httpApp;
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
