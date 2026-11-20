import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SurfaceHandler, SurfaceHandlers } from "@kolu/surface/server";
import { claimsOf } from "./reserved";
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

const handlers: SurfaceHandlers = {
  "surface/service/get": () => Effect.succeed("identity"),
  "surface/runs/get": () => Effect.succeed("runs"),
  "surface/runs/deltas": () => Stream.never,
};

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

    const door = localBroker({ door: true });
    expect(door.hasDoor()).toBe(true);
    expect(door.mounted()).toBe(false);
    expect(door.acquire({})).toBeNull();
    expect(door.authorize(undefined)).toBeNull();
  });
});

const request = (headers: Record<string, string>, url: string) =>
  ({ headers, url }) as unknown as HttpServerRequest.HttpServerRequest;

const SHELL = HttpServerResponse.text("<!doctype html><title>odu</title>", {
  status: 200,
  contentType: "text/html; charset=utf-8",
});

const PROTOCOL = HttpServerResponse.text("served", { status: 299 });

async function through(
  broker: PrincipalBroker,
  headers: Record<string, string>,
  url = "/",
  app: HttpServerResponse.HttpServerResponse = PROTOCOL,
): Promise<HttpServerResponse.HttpServerResponse> {
  const gate = doorGate({
    broker,
    mcpPath: "/mcp",
    signInPage: () => "<title>Sign in to odu</title>",
    reserved: claimsOf(["/mcp", "/cache/*", "/auth/*", "/assets/*"]),
  });
  return Effect.runPromise(
    Effect.provideService(
      gate(Effect.succeed(app)),
      HttpServerRequest.HttpServerRequest,
      request(headers, url),
    ),
  );
}

async function statusThrough(
  broker: PrincipalBroker,
  headers: Record<string, string>,
  url = "/",
  app: HttpServerResponse.HttpServerResponse = PROTOCOL,
): Promise<number> {
  return (await through(broker, headers, url, app)).status;
}

describe("the connection layer", () => {
  const connection = (closed: Array<[number | undefined, string | undefined]>): DoorConnection => ({
    id: 1,
    url: new URL("http://127.0.0.1:18440/rpc/ws"),
    remoteAddress: "127.0.0.1",
    headers: { cookie: "odu_session=s3cret" },
    close: (code?: number, reason?: string) => {
      closed.push([code, reason]);
    },
  });

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
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(closed).toEqual([]);
  });
});

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
    expect(await statusThrough(localBroker(), {}, "/", SHELL)).toBe(200);
    expect(await statusThrough(localBroker(), {}, "/mcp")).toBe(299);
  });

  it("refuses an anonymous /mcp POST once a door is configured", async () => {
    expect(await statusThrough(doorWithSession("s3cret"), {}, "/mcp")).toBe(401);
    expect(
      await statusThrough(doorWithSession("s3cret"), { authorization: "Bearer nope" }, "/mcp"),
    ).toBe(401);
  });

  it("admits a Bearer the resolver recognises", async () => {
    expect(
      await statusThrough(doorWithSession("s3cret"), { authorization: "Bearer good" }, "/mcp"),
    ).toBe(299);
  });

  it("answers an anonymous browser with the sign-in page wherever the shell would be served", async () => {
    const broker = doorWithSession("s3cret");
    for (const url of ["/", "/index.html", "/runs", "/nope", "/cache"]) {
      const answer = await through(broker, {}, url, SHELL);
      expect(answer, url).not.toBe(SHELL);
      expect(answer.status, url).toBe(200);
      expect(answer.headers["cache-control"], url).toBe("no-store");
    }
  });

  it("serves the shell itself to a live session", async () => {
    const answer = await through(
      doorWithSession("s3cret"),
      { cookie: "odu_session=s3cret" },
      "/runs",
      SHELL,
    );
    expect(answer).toBe(SHELL);
  });

  it("leaves every path odu's own routes claim untouched", async () => {
    const broker = doorWithSession("s3cret");
    for (const url of ["/cache/main/nix-cache-info", "/assets/app.js", "/auth/github"]) {
      expect(await statusThrough(broker, {}, url), url).toBe(299);
    }
  });

  it("refuses a shell path on a door daemon whose row is not registered", async () => {
    expect(await statusThrough(localBroker({ door: true }), {}, "/", SHELL)).toBe(200);
    expect(await statusThrough(localBroker({ door: true }), {}, "/mcp")).toBe(401);
  });

  it("does not touch the cache's paths or the sign-in routes", async () => {
    const broker = doorWithSession("s3cret");
    expect(await statusThrough(broker, {}, "/cache/main/nix-cache-info")).toBe(299);
    expect(await statusThrough(broker, {}, "/auth/github")).toBe(299);
    expect(await statusThrough(broker, {}, "/assets/app.js")).toBe(299);
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
