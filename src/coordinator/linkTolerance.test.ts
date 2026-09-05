/**
 * The one rule that spans the two sides of the ssh link, pinned where a change
 * to either side has to walk past it.
 *
 * The coordinator decides how long a silent link may stay silent before it is
 * called dead; the builder decides how long it will hold a venue for a
 * coordinator that has stopped talking. Those are two independent numbers in
 * two processes that never negotiate — and if the builder's is the smaller one,
 * it hands the box to the next run in the queue during a blip the coordinator
 * was configured to ride out. The run then comes back from a network hiccup to
 * a venue it no longer owns, which is the failure lane resurrection exists to
 * survive, reintroduced by a constant.
 */

import { describe, expect, it } from "bun:test";
import { deadManMs } from "../runner/leaseHold";
import {
  CI_LINK_LIVENESS,
  CI_LINK_WORST_CASE_SILENCE_MS,
} from "./linkTolerance";
import {
  MAX_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_TIMEOUT_MS,
} from "@kolu/surface/heartbeat";

/** `deadManMs` reads the environment, and the DEFAULT is what ships to a box —
 *  nothing passes it from the coordinator. Read it with the override cleared. */
function defaultDeadManMs(): number {
  const previous = process.env.ODU_LEASE_DEAD_MAN_MS;
  delete process.env.ODU_LEASE_DEAD_MAN_MS;
  try {
    return deadManMs();
  } finally {
    if (previous !== undefined) process.env.ODU_LEASE_DEAD_MAN_MS = previous;
  }
}

describe("CI link tolerance", () => {
  it("holds the venue for ten minutes of silence by default", () => {
    expect(defaultDeadManMs()).toBe(10 * 60_000);
  });

  it("never gives the box up before the coordinator has given the link up", () => {
    // The invariant, stated as the inequality it is. Not `>=` on a hand-copied
    // number: the coordinator's side is derived from the policy it actually
    // passes to `makeSession`, so tuning that policy moves this assertion.
    expect(CI_LINK_WORST_CASE_SILENCE_MS).toBe(
      CI_LINK_LIVENESS.intervalMs + CI_LINK_LIVENESS.timeoutMs,
    );
    expect(defaultDeadManMs()).toBeGreaterThanOrEqual(
      CI_LINK_WORST_CASE_SILENCE_MS,
    );
  });

  it("stays inside the framework's heartbeat bounds", () => {
    // `startHeartbeat` throws on a policy past these, and it throws at DIAL
    // time — i.e. every lane in every run, not in a test.
    expect(CI_LINK_LIVENESS.intervalMs).toBeLessThanOrEqual(
      MAX_HEARTBEAT_INTERVAL_MS,
    );
    expect(CI_LINK_LIVENESS.timeoutMs).toBeLessThanOrEqual(
      MAX_HEARTBEAT_TIMEOUT_MS,
    );
  });
});
