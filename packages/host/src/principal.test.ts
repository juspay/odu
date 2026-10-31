/**
 * THE DOOR, FROM THE HOST'S SIDE — the gate in front of the handlers, the two
 * HTTP legs, and the absence rule that makes the switch safe.
 *
 * `serveSurfaceApp` cannot refuse an upgrade, so a connection with no session is
 * served a daemon that answers NOTHING but the identity reads: this suite pins
 * that, and the rule that makes it safe — a session that ENDS takes effect on
 * the next call and INTERRUPTS every subscription already open.
 *
 * The third thing here is the one the round-1 review called the PR's most
 * serious: with a door CONFIGURED and no resolver registered, a caller is
 * nobody. A door whose row is restarting must refuse, never fall open onto the
 * local owner.
 */

import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SurfaceHandler, SurfaceHandlers } from "@kolu/surface/server";
import {
  admissionFor,
  CurrentPrincipal,
  localBroker,
  makeLease,
  NOBODY_ADMISSION,
  type Admission,
  type PrincipalBroker,
} from "@odu/cordis/principal";
import {
  admissionDispatch,
  admissionStore,
  connectionLayer,
  doorGate,
  gatedHandlers,
  liveDispatch,
  type DoorConnection,
} from "./principal";

const MEMBER = { kind: "user", login: "srid", role: "member" } as const;

/** The three shapes a connection sends: an identity read, an ordinary member,
 *  and a subscription that never finishes on its own. */
const handlers: SurfaceHandlers = {
  "surface/service/get": () => Effect.succeed("identity"),
  "surface/runs/get": () => Effect.succeed("runs"),
  "surface/runs/deltas": () => Stream.never,
};

/** The gated record, with the shape each member produced narrowed. A handler's
 *  value is one of two forms, and the gate must preserve which. */
function gated() {
  const served = gatedHandlers(handlers);
  const effectOf = (tag: string): SurfaceHandler => (payload) => {
    const produced = served[tag]!(payload);
    if (Stream.isStream(produced)) throw new Error(`${tag} is a stream`);
    return produced;
  };
  const streamOf = (tag: string): SurfaceHandler => (payload) => {
    const produced = served[tag]!(payload);
    if (!Stream.isStream(produced)) throw new Error(`${tag} is not a stream`);
    return produced;
  };
  return {
    identity: effectOf("surface/service/get"),
    runs: effectOf("surface/runs/get"),
    deltas: streamOf("surface/runs/deltas"),
  };
}

function run<A>(effect: Effect.Effect<A, unknown>, admission: Admission) {
  return Effect.runPromise(Effect.exit(Effect.provideService(effect, CurrentPrincipal, admission)));
}

describe("the gate", () => {
  it("lets an anonymous connection read the identity and nothing else", async () => {
    const served = gated();
    const nobody = admissionFor(null);
    expect(Exit.isSuccess(await run(served.identity(undefined) as Effect.Effect<unknown>, nobody))).toBe(
      true,
    );
    expect(Exit.isFailure(await run(served.runs(undefined) as Effect.Effect<unknown>, nobody))).toBe(
      true,
    );
  });

  it("serves a signed-in connection, and refuses it the moment the session ends", async () => {
    const served = gated();
    const { lease, end } = makeLease(MEMBER);
    const admission = admissionFor(lease);
    expect(Exit.isSuccess(await run(served.runs(undefined) as Effect.Effect<unknown>, admission))).toBe(
      true,
    );
    end();
    expect(Exit.isFailure(await run(served.runs(undefined) as Effect.Effect<unknown>, admission))).toBe(
      true,
    );
  });

  it("interrupts an open subscription when the session ends", async () => {
    const served = gated();
    const { lease, end } = makeLease(MEMBER);
    const admission = admissionFor(lease);
    // While the session lives the stream never completes, so a bounded collect
    // answers `none` rather than an end.
    const live = await Effect.runPromise(
      Effect.provideService(
        Effect.timeoutOption(
          Stream.runCollect(served.deltas(undefined) as Stream.Stream<unknown>),
          "50 millis",
        ),
        CurrentPrincipal,
        admission,
      ),
    );
    expect(Option.isNone(live)).toBe(true);

    // Ended, the SAME stream is INTERRUPTED rather than left pushing — the
    // distinction between a timeout (`none`) and an interruption (a Failure)
    // is the whole assertion.
    end();
    const after = await Effect.runPromise(
      Effect.exit(
        Effect.provideService(
          Effect.timeoutOption(
            Stream.runCollect(served.deltas(undefined) as Stream.Stream<unknown>),
            "1 second",
          ),
          CurrentPrincipal,
          admission,
        ),
      ),
    );
    expect(Exit.isFailure(after)).toBe(true);
  });
});

describe("the absence rule", () => {
  it("is the local owner with NO door, and nobody with one", () => {
    const loopback = localBroker();
    expect(loopback.hasDoor()).toBe(false);
    expect(loopback.acquire({})?.principal).toEqual({ kind: "local" });
    expect(loopback.authorize(undefined)).toEqual({ kind: "local" });

    // A door is CONFIGURED and the row has not registered (it is starting, or
    // it failed). The daemon must refuse, never fall open.
    const door = localBroker({ door: true });
    expect(door.hasDoor()).toBe(true);
    expect(door.mounted()).toBe(false);
    expect(door.acquire({})).toBeNull();
    expect(door.authorize(undefined)).toBeNull();
  });
});

/** A request the middleware can read: headers and path are the only fields this
 *  seam touches. */
const request = (headers: Record<string, string>, url: string) =>
  ({ headers, url }) as unknown as HttpServerRequest.HttpServerRequest;

/** Run an app through the middleware and read its status. The app answers 299 —
 *  a status nothing else uses — so "the middleware intervened" and "the app was
 *  reached" cannot be confused. */
async function through(
  broker: PrincipalBroker,
  headers: Record<string, string>,
  url = "/",
): Promise<number> {
  const app = Effect.succeed(HttpServerResponse.text("served", { status: 299 }));
  const gate = doorGate({
    broker,
    mcpPath: "/mcp",
    shellPaths: ["/", "/index.html"],
    signInPage: () => "<title>Sign in to odu</title>",
  });
  return Effect.runPromise(
    Effect.map(
      Effect.provideService(gate(app), HttpServerRequest.HttpServerRequest, request(headers, url)),
      (response) => response.status,
    ),
  );
}

describe("the connection layer", () => {
  /** One connection, with the close kolu PR #2330 adds. */
  const connection = (closed: Array<[number | undefined, string | undefined]>): DoorConnection => ({
    id: 1,
    url: new URL("http://127.0.0.1:18440/rpc/ws"),
    remoteAddress: "127.0.0.1",
    headers: { cookie: "odu_session=s3cret" },
    close: (code?: number, reason?: string) => {
      closed.push([code, reason]);
    },
  });

  /** The broker and the lease behind it, plus a way to end it. */
  function leased() {
    const broker = localBroker({ door: true });
    const made = makeLease(MEMBER);
    broker.register({
      acquire: () => made.lease,
      authorize: () => MEMBER,
    });
    return { broker, end: made.end };
  }

  it("closes the socket ONCE when the session ends, before the lease is released", async () => {
    const closed: Array<[number | undefined, string | undefined]> = [];
    const { broker, end } = leased();
    const scope = Scope.makeUnsafe();
    await Effect.runPromise(
      Scope.provide(Layer.build(connectionLayer(broker, connection(closed))), scope),
    );
    expect(closed).toEqual([]);

    end();
    end();
    // One close, normal, with the reason a client can read.
    expect(closed).toEqual([[1000, "the session ended"]]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(closed).toHaveLength(1);
  });

  it("does not close the socket on an ordinary release", async () => {
    const closed: Array<[number | undefined, string | undefined]> = [];
    const { broker } = leased();
    const scope = Scope.makeUnsafe();
    await Effect.runPromise(
      Scope.provide(Layer.build(connectionLayer(broker, connection(closed))), scope),
    );
    // The CONNECTION went away, not the session: nothing to close.
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(closed).toEqual([]);
  });
});

/** A broker with a door whose resolver answers ONE session cookie. */
function doorWithSession(cookie: string): PrincipalBroker {
  const broker = localBroker({ door: true });
  broker.register({
    acquire: (headers) =>
      headers["cookie"] === `odu_session=${cookie}` ? makeLease(MEMBER).lease : null,
    authorize: (authorization) =>
      authorization === "Bearer good" ? MEMBER : null,
  });
  return broker;
}

describe("the HTTP legs", () => {
  it("asks nothing at all in loopback mode", async () => {
    expect(await through(localBroker(), {}, "/")).toBe(299);
    expect(await through(localBroker(), {}, "/mcp")).toBe(299);
  });

  it("refuses an anonymous /mcp POST once a door is configured", async () => {
    expect(await through(doorWithSession("s3cret"), {}, "/mcp")).toBe(401);
    expect(await through(doorWithSession("s3cret"), { authorization: "Bearer nope" }, "/mcp")).toBe(
      401,
    );
  });

  it("admits a Bearer the resolver recognises", async () => {
    expect(
      await through(doorWithSession("s3cret"), { authorization: "Bearer good" }, "/mcp"),
    ).toBe(299);
  });

  it("answers an anonymous browser with the server-rendered sign-in page", async () => {
    // 200 is the PAGE's status; the app's 299 is what a served shell answers.
    expect(await through(doorWithSession("s3cret"), {}, "/")).toBe(200);
    expect(await through(doorWithSession("s3cret"), {}, "/index.html")).toBe(200);
  });

  it("serves the shell to a live session", async () => {
    expect(await through(doorWithSession("s3cret"), { cookie: "odu_session=s3cret" }, "/")).toBe(
      299,
    );
  });

  it("refuses a shell path on a door daemon whose row is not registered", async () => {
    // The case the review called failing-open: configured, no resolver.
    expect(await through(localBroker({ door: true }), {}, "/")).toBe(200);
    expect(await through(localBroker({ door: true }), {}, "/mcp")).toBe(401);
  });

  it("does not touch the cache's paths or the sign-in routes", async () => {
    const broker = doorWithSession("s3cret");
    expect(await through(broker, {}, "/cache/main/nix-cache-info")).toBe(299);
    expect(await through(broker, {}, "/auth/github")).toBe(299);
    expect(await through(broker, {}, "/assets/app.js")).toBe(299);
  });
});

describe("the MCP dispatch", () => {
  const dispatch = (store: ReturnType<typeof admissionStore>) =>
    admissionDispatch(
      {
        unary: () =>
          Effect.map(Effect.serviceOption(CurrentPrincipal), (held) =>
            Option.match(held, {
              onNone: () => "none",
              onSome: (admission) => admission.principal?.kind ?? "refused",
            }),
          ),
        stream: () => Stream.never,
      },
      store,
    );

  it("provides the request's admission to the call it wraps", async () => {
    const store = admissionStore();
    const user = admissionFor(makeLease(MEMBER).lease);
    expect(
      await store.run(user, () => Effect.runPromise(dispatch(store).unary("t", null))),
    ).toBe("user");
  });

  it("falls back to what the composition root chose — local, or nobody", async () => {
    const loopback = admissionStore();
    expect(await Effect.runPromise(dispatch(loopback).unary("t", null))).toBe("local");
    const door = admissionStore(NOBODY_ADMISSION);
    expect(await Effect.runPromise(dispatch(door).unary("t", null))).toBe("refused");
  });
});

describe("the live dispatch", () => {
  it("reads the handler record at each call", async () => {
    let current: SurfaceHandlers = { "surface/runs/get": () => Effect.succeed("first") };
    const dispatch = liveDispatch(() => current);
    expect(await Effect.runPromise(dispatch.unary("surface/runs/get", null))).toBe("first");
    current = { "surface/runs/get": () => Effect.succeed("second") };
    expect(await Effect.runPromise(dispatch.unary("surface/runs/get", null))).toBe("second");
  });
});
