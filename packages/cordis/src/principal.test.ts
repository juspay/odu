/**
 * THE DOOR'S VOCABULARY, held to its two promises.
 *
 * One is the ABSENCE rule, which is what makes loopback mode a construction
 * rather than a flag: with no resolver registered every connection is the local
 * owner, and nothing refuses. The other is the single-owner claim: exactly one
 * row may decide who is on a connection, a second claim installs NOTHING, and a
 * withdrawal removes only the resolver that made it.
 *
 * The lease is the third: it is how a connection learns its session ended
 * without polling anything, and it fires exactly once.
 */

import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import {
  admissionFor,
  admissionOf,
  CurrentPrincipal,
  LOCAL_OWNER,
  localBroker,
  makeLease,
  PrincipalClaimRefused,
  principalOf,
  type PrincipalResolver,
} from "./principal";

const forever: PrincipalResolver = {
  acquire: () => makeLease({ kind: "user", login: "srid", role: "admin" }).lease,
  authorize: () => ({ kind: "user", login: "srid", role: "admin" }),
};

describe("the broker with no resolver — loopback mode", () => {
  it("admits every connection as the local owner", () => {
    const broker = localBroker();
    expect(broker.mounted()).toBe(false);
    expect(broker.acquire({})?.principal).toEqual(LOCAL_OWNER);
    expect(broker.authorize(undefined)).toEqual(LOCAL_OWNER);
  });
});

describe("the single-owner claim", () => {
  it("installs the first resolver and answers for it", () => {
    const broker = localBroker();
    broker.register(forever);
    expect(broker.mounted()).toBe(true);
    expect(broker.authorize(undefined)).toEqual({ kind: "user", login: "srid", role: "admin" });
  });

  it("refuses a second claimant and installs nothing", () => {
    const broker = localBroker();
    broker.register(forever);
    const second: PrincipalResolver = {
      acquire: () => null,
      authorize: () => null,
    };
    expect(() => broker.register(second)).toThrow(PrincipalClaimRefused);
    // NOTHING was installed by the refused claim: the first resolver still
    // answers, so the refusal left no half-registration behind.
    expect(broker.authorize(undefined)).toEqual({ kind: "user", login: "srid", role: "admin" });
    expect(broker.acquire({})).not.toBeNull();
  });

  it("a withdrawal removes only the claimant that made it", () => {
    const broker = localBroker();
    const withdraw = broker.register(forever);
    withdraw();
    expect(broker.mounted()).toBe(false);
    // The slot is free again, and a SECOND withdrawal cannot clear a successor.
    expect(() => broker.register(forever)).not.toThrow();
    withdraw();
    expect(broker.mounted()).toBe(true);
  });
});

describe("a lease", () => {
  it("ends once, and its watchers fire once each", () => {
    const { lease, end } = makeLease({ kind: "user", login: "srid", role: "member" });
    let fired = 0;
    lease.watch(() => {
      fired += 1;
    });
    end();
    end();
    expect(fired).toBe(1);
  });

  it("tells a watcher that arrives after the end immediately", () => {
    const { lease, end } = makeLease(LOCAL_OWNER);
    end();
    let fired = 0;
    lease.watch(() => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  it("release ends the lease without running the watchers", () => {
    const { lease } = makeLease(LOCAL_OWNER);
    let fired = 0;
    lease.watch(() => {
      fired += 1;
    });
    lease.release();
    expect(fired).toBe(0);
  });

  it("turns an admission dead, and completes `ended`", async () => {
    const { lease, end } = makeLease(LOCAL_OWNER);
    const admission = admissionFor(lease);
    expect(admission.live()).toBe(true);
    end();
    expect(admission.live()).toBe(false);
    // `ended` resolves rather than hanging — that is what a subscription
    // watches, and a hang there would be a stream that never stops.
    const exit = await Effect.runPromise(Effect.exit(admission.ended));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("a connection with no lease is nobody, and nothing to end", async () => {
    const admission = admissionFor(null);
    expect(admission.principal).toBeNull();
    expect(admission.live()).toBe(false);
    expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(admission.ended)))).toBe(true);
  });
});

describe("what a verb reads", () => {
  it("defaults to the local owner when no context was provided", async () => {
    expect(await Effect.runPromise(principalOf)).toEqual(LOCAL_OWNER);
    expect((await Effect.runPromise(admissionOf)).principal).toEqual(LOCAL_OWNER);
  });

  it("reads the admission the connection provided", async () => {
    const admission = admissionFor(
      makeLease({ kind: "user", login: "srid", role: "owner" }).lease,
    );
    const read = await Effect.runPromise(
      Effect.provideService(principalOf, CurrentPrincipal, admission),
    );
    expect(read).toEqual({ kind: "user", login: "srid", role: "owner" });
  });

  it("DIES on a connection with no principal — the gate should have refused first", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provideService(principalOf, CurrentPrincipal, admissionFor(null)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
