/**
 * THE DOOR, FROM THE HOST'S SIDE — the gate in front of the handlers, and the
 * two ways a request arrives with a credential.
 *
 * `serveSurfaceApp` cannot refuse an upgrade, so a connection with no session is
 * served a daemon that answers NOTHING but the identity reads: this suite pins
 * that, and the rule that makes it safe — a session that ENDS takes effect on
 * the next call and INTERRUPTS every subscription already open, because that is
 * what the lease's `ended` does.
 *
 * And the HTTP leg: an anonymous `/mcp` POST is answered `401` when an identity
 * provider is mounted, and untouched when none is (loopback mode's existing MCP
 * clients are the guard).
 */

import { describe, expect, it } from "bun:test";
import { Effect, Exit, Option, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SurfaceHandler, SurfaceHandlers } from "@kolu/surface/server";
import {
  admissionFor,
  CurrentPrincipal,
  localBroker,
  makeLease,
  type Admission,
  type PrincipalBroker,
} from "@odu/cordis/principal";
import { admissionDispatch, admissionStore, bearerGate, gatedHandlers } from "./principal";

const MEMBER = { kind: "user", login: "srid", role: "member" } as const;

/** The three shapes a connection sends: an identity read, an ordinary member,
 *  and a subscription that never finishes on its own. */
const handlers: SurfaceHandlers = {
  "surface/service/get": () => Effect.succeed("identity"),
  "surface/runs/get": () => Effect.succeed("runs"),
  "surface/runs/deltas": () => Stream.never,
};

/** The gated record, with the shape each member produced narrowed. A handler's
 *  value is one of two forms, and the gate must preserve which — so the tests
 *  read it the same way the runtime does. */
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
  return Effect.runPromise(
    Effect.exit(Effect.provideService(effect, CurrentPrincipal, admission)),
  );
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

/** A request the middleware can read: headers and path are the only fields this
 *  seam touches. */
const request = (headers: Record<string, string>, url: string) =>
  ({ headers, url }) as unknown as HttpServerRequest.HttpServerRequest;

/** Run an app through the middleware and read its status. */
async function through(
  broker: PrincipalBroker,
  headers: Record<string, string>,
  url = "/mcp",
): Promise<number> {
  const app = Effect.succeed(HttpServerResponse.text("served"));
  return Effect.runPromise(
    Effect.map(
      Effect.provideService(
        bearerGate(broker, "/mcp")(app),
        HttpServerRequest.HttpServerRequest,
        request(headers, url),
      ),
      (response) => response.status,
    ),
  );
}

describe("the HTTP leg", () => {
  it("asks nothing in loopback mode", async () => {
    expect(await through(localBroker(), {})).toBe(200);
  });

  it("refuses an anonymous POST once a resolver is mounted", async () => {
    const broker = localBroker();
    broker.register({ acquire: () => null, authorize: () => null });
    expect(await through(broker, {})).toBe(401);
    expect(await through(broker, { authorization: "Bearer nope" })).toBe(401);
  });

  it("admits a Bearer the resolver recognises", async () => {
    const broker = localBroker();
    broker.register({
      acquire: () => null,
      authorize: (authorization) => (authorization === "Bearer good" ? MEMBER : null),
    });
    expect(await through(broker, { authorization: "Bearer good" })).toBe(200);
  });

  it("does not touch a non-MCP path", async () => {
    const broker = localBroker();
    broker.register({ acquire: () => null, authorize: () => null });
    expect(await through(broker, {}, "/")).toBe(200);
  });
});

describe("the MCP dispatch", () => {
  it("provides the request's admission to the call it wraps", async () => {
    const store = admissionStore();
    const dispatch = admissionDispatch(
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

    const user = admissionFor(makeLease(MEMBER).lease);
    expect(await store.run(user, () => Effect.runPromise(dispatch.unary("t", null)))).toBe("user");
    // Outside the request, the absence rule stands — loopback's local owner.
    expect(await Effect.runPromise(dispatch.unary("t", null))).toBe("local");
  });
});
