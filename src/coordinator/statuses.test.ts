import { afterEach, describe, expect, it, jest } from "bun:test";
import { EMPTY_POSTING } from "@odu/run-client/surface";
import {
  fetchUrlFor,
  interruptStatus,
  logPathFor,
  parseGithubRemote,
  postingEqual,
  postingWarning,
  StatusPoster,
  statusFor,
  unpostedNote,
  type GhSendResult,
  type StatusPayload,
} from "./statuses";

/** bun:test's fake timers advance synchronously — there is no
 *  `advanceTimersByTimeAsync`. Drain the microtask queue on both sides of the
 *  advance: before, so the promise chains that arm the timers (the poster's
 *  send queue arms its hang-timeout inside a `.then`) have actually armed them
 *  when the clock moves; after, so the chains those timers kicked off have
 *  settled before the assertion runs. The async advance this replaces
 *  interleaved both itself. */
async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// The context/description/log-path formats are byte-compatible with what
// justci posted (verified against live statuses on merged kolu PRs) — these
// strings are what branch protection matches on.
describe("logPathFor", () => {
  it("keeps the ci:: prefix in the filename, platform as the directory", () => {
    expect(logPathFor("338eb01", "ci::e2e@x86_64-linux")).toBe(
      ".ci/338eb01/x86_64-linux/ci::e2e.log",
    );
  });

  it("handles the unprefixed _ci-setup bookkeeping node", () => {
    expect(logPathFor("338eb01", "_ci-setup@aarch64-darwin")).toBe(
      ".ci/338eb01/aarch64-darwin/_ci-setup.log",
    );
  });
});

describe("statusFor", () => {
  const id = "ci::unit@x86_64-linux";
  const log = ".ci/abc1234/x86_64-linux/ci::unit.log";

  it("posts pending/success/failure in justci's wording", () => {
    expect(statusFor(id, "running", null, "abc1234")).toEqual({
      state: "pending",
      context: id,
      description: `Running: ${log}`,
    });
    expect(statusFor(id, "ok", 25_000, "abc1234")).toEqual({
      state: "success",
      context: id,
      description: `Succeeded (25s): ${log}`,
    });
    expect(statusFor(id, "failed", 8_000, "abc1234")).toEqual({
      state: "failure",
      context: id,
      description: `Failed (8s): ${log}`,
    });
  });

  it("maps infrastructure death to GitHub's error state", () => {
    expect(statusFor(id, "errored", 60_000, "abc1234")).toEqual({
      state: "error",
      context: id,
      description: `Errored (1m0s): ${log}`,
    });
  });

  // An absent required context is what correctly blocks the merge.
  it("posts nothing for skipped and pending", () => {
    expect(statusFor(id, "skipped", null, "abc1234")).toBeNull();
    expect(statusFor(id, "pending", null, "abc1234")).toBeNull();
  });

  it("maps operator cancel to success with Cancelled wording (not a red check)", () => {
    expect(statusFor(id, "cancelled", 12_000, "abc1234")).toEqual({
      state: "success",
      context: id,
      description: `Cancelled (12s): ${log}`,
    });
  });
});

describe("interruptStatus", () => {
  it("routes interrupt wording through the statuses projector", () => {
    expect(
      interruptStatus("ci::unit@x86_64-linux", "cancelled", "abc1234"),
    ).toEqual({
      state: "error",
      context: "ci::unit@x86_64-linux",
      description:
        "Errored (cancelled): .ci/abc1234/x86_64-linux/ci::unit.log",
    });
  });
});

describe("github remote parsing", () => {
  it("understands https and ssh forms", () => {
    expect(parseGithubRemote("https://github.com/juspay/kolu.git")).toEqual({
      owner: "juspay",
      repo: "kolu",
    });
    expect(parseGithubRemote("git@github.com:juspay/kolu.git")).toEqual({
      owner: "juspay",
      repo: "kolu",
    });
    expect(parseGithubRemote("https://example.com/x/y")).toBeNull();
  });

  it("normalizes to the anonymous-https fetch URL lane hosts use", () => {
    expect(fetchUrlFor("git@github.com:juspay/kolu.git")).toBe(
      "https://github.com/juspay/kolu",
    );
    expect(fetchUrlFor("https://git.sr.ht/~x/y")).toBe(
      "https://git.sr.ht/~x/y",
    );
  });
});

describe("postingWarning", () => {
  it("is null when healthy", () => {
    expect(postingWarning(EMPTY_POSTING)).toBeNull();
  });

  it("says sending before any attempt, retrying after", () => {
    expect(
      postingWarning({
        owed: [
          { context: "ci::unit@x86_64-linux", lastError: null, attempts: 0 },
        ],
      }),
    ).toMatch(/unconfirmed \(sending\)/);
    const w = postingWarning({
      owed: [
        {
          context: "ci::unit@x86_64-linux",
          lastError: "403 rate limited",
          attempts: 2,
        },
      ],
    });
    expect(w).toMatch(/1 status unconfirmed/);
    expect(w).toMatch(/retrying/);
    expect(w).toMatch(/403 rate limited/);
  });
});

describe("unpostedNote", () => {
  it("is empty for zero and pluralizes", () => {
    expect(unpostedNote(0)).toBe("");
    expect(unpostedNote(1)).toBe(", 1 status never reached GitHub");
    expect(unpostedNote(3)).toBe(", 3 statuses never reached GitHub");
  });
});

describe("postingEqual", () => {
  it("compares owed entries structurally", () => {
    const h = {
      owed: [{ context: "x", lastError: "e", attempts: 1 }],
    };
    expect(postingEqual(h, { ...h, owed: [...h.owed] })).toBe(true);
    expect(postingEqual(undefined, EMPTY_POSTING)).toBe(true);
    expect(postingEqual(h, EMPTY_POSTING)).toBe(false);
  });
});

// ── StatusPoster reliability (juspay/odu#61) ────────────────────────────────

function payload(
  over: Partial<StatusPayload> & Pick<StatusPayload, "context">,
): StatusPayload {
  return {
    state: "success",
    description: "Succeeded (1s): .ci/x/y.log",
    ...over,
  };
}

describe("StatusPoster — honest dedup + retry", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("records confirmed only after a successful send (fails N times then succeeds)", async () => {
    let calls = 0;
    const sendGh = jest.fn(async (): Promise<GhSendResult> => {
      calls += 1;
      if (calls < 3) return { ok: false, error: "403 rate limited" };
      return { ok: true };
    });
    const healthSnaps: number[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      onHealth: (h) => healthSnaps.push(h.owed.length),
      sendGh,
      debounceMs: 0,
      backoffBaseMs: 1,
      backoffCapMs: 1,
    });
    const p = payload({ context: "ci::unit@x86_64-linux" });
    poster.post(p);
    // Drain: initial + retries until success.
    for (let i = 0; i < 10 && poster.health().owed.length > 0; i++) {
      await poster.settle();
      await new Promise((r) => setTimeout(r, 5));
    }
    await poster.settle();
    expect(sendGh.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(poster.health()).toEqual(EMPTY_POSTING);
    expect(poster.unposted()).toEqual([]);
    // Re-post identical payload is a no-op (confirmed).
    const before = sendGh.mock.calls.length;
    poster.post(p);
    await poster.settle();
    expect(sendGh.mock.calls.length).toBe(before);
    expect(healthSnaps.some((n) => n > 0)).toBe(true);
    expect(healthSnaps[healthSnaps.length - 1]).toBe(0);
  });

  it("leaves owed contexts unconfirmed when send never succeeds", async () => {
    const sendGh = jest.fn(async (): Promise<GhSendResult> => ({
      ok: false,
      error: "API down",
    }));
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      sendGh,
      debounceMs: 0,
      backoffBaseMs: 60_000, // don't reschedule during the test window
      backoffCapMs: 60_000,
    });
    poster.post(payload({ context: "ci::unit@x86_64-linux" }));
    await poster.settle();
    expect(poster.health().owed.length).toBe(1);
    expect(poster.health().owed[0]?.context).toBe("ci::unit@x86_64-linux");
    expect(poster.health().owed[0]?.lastError).toMatch(/API down/);
    expect(poster.pendingContexts()).toEqual([]); // desired is success, not pending
    const unposted = await poster.finalize();
    // `attempts` is persisted now (it used to be dropped and fabricated as 0 by
    // whichever reader needed it), so the durable row carries the real count.
    expect(unposted).toEqual([
      { context: "ci::unit@x86_64-linux", lastError: "API down", attempts: 3 },
    ]);
    // Closed — further posts are ignored.
    const callsBefore = sendGh.mock.calls.length;
    poster.post(payload({ context: "other" }));
    await poster.settle();
    expect(sendGh.mock.calls.length).toBe(callsBefore);
  });

  it("pendingContexts lists contexts still desired/confirmed as pending", async () => {
    const sendGh = jest.fn(async (): Promise<GhSendResult> => ({ ok: true }));
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      sendGh,
      debounceMs: 0,
    });
    poster.post(
      payload({
        context: "ci::unit@x86_64-linux",
        state: "pending",
        description: "Running: x",
      }),
    );
    await poster.settle();
    // Confirmed pending with no newer desired → still in pendingContexts.
    expect(poster.pendingContexts()).toContain("ci::unit@x86_64-linux");
    // Terminal success clears the pending worklist once confirmed.
    poster.post(payload({ context: "ci::unit@x86_64-linux" }));
    await poster.settle();
    expect(poster.pendingContexts()).not.toContain("ci::unit@x86_64-linux");
  });

  it("pendingContexts ignores seeded foreign pending contexts", async () => {
    const sendGh = jest.fn(async (): Promise<GhSendResult> => ({ ok: true }));
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      sendGh,
      debounceMs: 0,
      listStatuses: async () => [
        {
          context: "github-actions/ci",
          state: "pending",
          description: "Waiting for a runner",
        },
        {
          context: "ci::unit@x86_64-linux",
          state: "pending",
          description: "Running: x",
        },
      ],
    });
    await poster.seed();
    // Seed alone must not put third-party or prior-run contexts on the interrupt list.
    expect(poster.pendingContexts()).toEqual([]);
    // Once this run posts, only that context is interruptible.
    poster.post(
      payload({
        context: "ci::unit@x86_64-linux",
        state: "pending",
        description: "Running: x",
      }),
    );
    await poster.settle();
    expect(poster.pendingContexts()).toEqual(["ci::unit@x86_64-linux"]);
    expect(poster.pendingContexts()).not.toContain("github-actions/ci");
  });

  it("seed skips remote states that are not valid GitHub states", async () => {
    const sendGh = jest.fn(async (): Promise<GhSendResult> => ({ ok: true }));
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      sendGh,
      debounceMs: 0,
      listStatuses: async () => [
        {
          context: "ci::unit@x86_64-linux",
          state: "unexpected",
          description: "bogus",
        },
      ],
    });
    await poster.seed();
    // Invalid seed must not act as confirmed — a real post still sends.
    poster.post(
      payload({
        context: "ci::unit@x86_64-linux",
        description: "Succeeded (1s): .ci/x/y.log",
      }),
    );
    await poster.settle();
    expect(sendGh).toHaveBeenCalledTimes(1);
  });

  it("records confirmed even when desired moves mid-flight", async () => {
    jest.useFakeTimers();
    let release: ((r: GhSendResult) => void) | undefined;
    const sent: string[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 0,
      sendGh: (p) => {
        sent.push(p.state);
        if (p.state === "pending") {
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve({ ok: true });
      },
    });
    const ctx = "ci::unit@x86_64-linux";
    poster.post(
      payload({ context: ctx, state: "pending", description: "Running: a" }),
    );
    // Wait until the pending send is in flight.
    await Promise.resolve();
    await Promise.resolve();
    // Desired moves to success while pending is still on the wire.
    poster.post(
      payload({ context: ctx, state: "success", description: "Succeeded: a" }),
    );
    release?.({ ok: true });
    await poster.settle();
    await advanceTimersByTimeAsync(0);
    await poster.settle();
    // Pending success was recorded; success must still be sent (not discarded).
    expect(sent).toContain("pending");
    expect(sent).toContain("success");
    expect(poster.health().owed).toEqual([]);
  });

  it("times out a hung send and does not block later posts", async () => {
    jest.useFakeTimers();
    const order: string[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 0,
      timeoutMs: 50,
      backoffBaseMs: 60_000,
      sendGh: (p) => {
        if (p.context === "hang") {
          // Never resolves — the poster's timeout must free the queue.
          return new Promise(() => {});
        }
        order.push(p.context);
        return Promise.resolve({ ok: true });
      },
    });
    poster.post(payload({ context: "hang", description: "Running: h" }));
    poster.post(payload({ context: "next" }));
    await advanceTimersByTimeAsync(60);
    await poster.settle();
    expect(order).toContain("next");
    expect(poster.health().owed.some((o) => o.context === "hang")).toBe(true);
    expect(poster.health().owed.some((o) => o.context === "next")).toBe(false);
    expect(
      poster.health().owed.find((o) => o.context === "hang")?.lastError,
    ).toMatch(/timed out/);
  });

  it("seed makes an identical post a no-op", async () => {
    const sendGh = jest.fn(async (): Promise<GhSendResult> => ({ ok: true }));
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      sendGh,
      debounceMs: 0,
      listStatuses: async () => [
        {
          context: "ci::unit@x86_64-linux",
          state: "success",
          description: "Succeeded (1s): .ci/x/y.log",
        },
      ],
    });
    await poster.seed();
    poster.post(
      payload({
        context: "ci::unit@x86_64-linux",
        description: "Succeeded (1s): .ci/x/y.log",
      }),
    );
    await poster.settle();
    expect(sendGh).not.toHaveBeenCalled();
  });

  // The stuck-pending bug: a re-run of an already-green sha left five contexts
  // showing "Running" on GitHub while the run itself passed and `unposted`
  // reported nothing owed — so the merge stayed blocked with no sign anything
  // was wrong. Seed loads the previous run's terminal statuses as `confirmed`;
  // a node fast enough to finish inside its own debounce then re-posts a
  // byte-identical success (same duration on a warm cache), which matched
  // `confirmed` and returned early — leaving the un-sent `pending` armed as
  // desired. The debounce then fired and put GitHub *back* to "Running".
  it("drops a stale pending when the terminal status GitHub has is re-posted", async () => {
    jest.useFakeTimers();
    const sent: StatusPayload[] = [];
    const ctx = "ci::fmt@x86_64-linux";
    const done = payload({
      context: ctx,
      state: "success",
      description: "Succeeded (0s): .ci/x/y.log",
    });
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 20,
      sendGh: async (p) => {
        sent.push(p);
        return { ok: true };
      },
      // The previous run on this same sha left the context green.
      listStatuses: async () => [
        { context: ctx, state: "success", description: done.description },
      ],
    });
    await poster.seed();

    poster.post(
      payload({ context: ctx, state: "pending", description: "Running: x" }),
    );
    // Warm cache: the recipe finishes before its own pending has been sent.
    poster.post(done);

    await advanceTimersByTimeAsync(50);
    await poster.settle();

    // Nothing needed sending — GitHub already showed exactly this success — and
    // above all the obsolete pending must not have been sent on top of it.
    expect(sent.map((p) => p.state)).toEqual([]);
    expect(poster.pendingContexts()).toEqual([]);
    expect(poster.health().owed).toEqual([]);
  });

  // The same stuck check, one beat later: here the pending is already on the
  // wire when the success arrives. `confirmed` still names what GitHub had
  // *before* that send — the seeded success — so the incoming success looked
  // redundant and was dropped, and the pending it was racing then landed and
  // stayed. Observed live: `_ci-setup@aarch64-darwin` and
  // `ci::typecheck@aarch64-darwin` finished in 1-4s and sat on "Running" while
  // the 18s node beside them reported fine.
  it("does not dedup against confirmed while a send is on the wire", async () => {
    const sent: StatusPayload[] = [];
    const ctx = "ci::typecheck@aarch64-darwin";
    const done = payload({
      context: ctx,
      state: "success",
      description: "Succeeded (1s): .ci/x/y.log",
    });
    let release = (): void => {};
    const onWire = new Promise<void>((r) => {
      release = r;
    });
    let gateFirst = true;
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 0,
      sendGh: async (p) => {
        sent.push(p);
        if (gateFirst) {
          gateFirst = false;
          await onWire;
        }
        return { ok: true };
      },
      // The previous run on this sha left the context green with this exact
      // description — a cached recipe reproduces its duration.
      listStatuses: async () => [
        { context: ctx, state: "success", description: done.description },
      ],
    });
    await poster.seed();

    poster.post(
      payload({ context: ctx, state: "pending", description: "Running: x" }),
    );
    // Let the pending reach the wire, then finish the node under it.
    await Promise.resolve();
    poster.post(done);
    release();
    await poster.finalize();

    // The success must follow the pending, so GitHub ends terminal rather than
    // stranded on "Running".
    expect(sent.map((p) => p.state)).toEqual(["pending", "success"]);
    expect(poster.pendingContexts()).toEqual([]);
    expect(poster.health().owed).toEqual([]);
  });

  it("still refuses to let a redundant success re-post swallow a failure", async () => {
    // The guard this narrows: a *terminal* desired outranks a re-post of the
    // status GitHub already has, so a red node can never be reported green.
    jest.useFakeTimers();
    const sent: string[] = [];
    const ctx = "ci::unit@x86_64-linux";
    const seeded = "Succeeded (1s): .ci/x/y.log";
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 20,
      sendGh: async (p) => {
        sent.push(p.state);
        return { ok: true };
      },
      listStatuses: async () => [
        { context: ctx, state: "success", description: seeded },
      ],
    });
    await poster.seed();
    poster.post(
      payload({ context: ctx, state: "failure", description: "Failed: a" }),
    );
    poster.post(payload({ context: ctx, description: seeded }));
    await advanceTimersByTimeAsync(25);
    await poster.settle();
    expect(sent).toEqual(["failure"]);
  });

  it("keeps a successful send that landed as the poster closed", async () => {
    // The mirror-image false alarm: `finalize` flipped to closed while the send
    // was in flight, so an ok result was discarded and the run reported a
    // status as owed (attempts: 0) that GitHub had in fact received.
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 0,
      sendGh: async () => {
        await gate;
        return { ok: true };
      },
    });
    poster.post(payload({ context: "ci::nix@x86_64-linux" }));
    const finalized = poster.finalize();
    release();
    expect(await finalized).toEqual([]);
    expect(poster.unposted()).toEqual([]);
  });

  it("coalesces rapid flips to the latest desired state", async () => {
    jest.useFakeTimers();
    const sent: string[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 20,
      sendGh: async (p) => {
        sent.push(`${p.state}:${p.description}`);
        return { ok: true };
      },
    });
    const ctx = "ci::unit@x86_64-linux";
    poster.post(
      payload({ context: ctx, state: "pending", description: "Running: a" }),
    );
    poster.post(
      payload({ context: ctx, state: "failure", description: "Failed: a" }),
    );
    poster.post(
      payload({ context: ctx, state: "pending", description: "Running: b" }),
    );
    await advanceTimersByTimeAsync(25);
    await poster.settle();
    expect(sent).toEqual(["pending:Running: b"]);
  });

  it("post(confirmed) does not drop a different desired still in flight", async () => {
    jest.useFakeTimers();
    const sent: string[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 20,
      sendGh: async (p) => {
        sent.push(p.state);
        return { ok: true };
      },
      listStatuses: async () => [
        {
          context: "ci::unit@x86_64-linux",
          state: "success",
          description: "Succeeded (1s): .ci/x/y.log",
        },
      ],
    });
    await poster.seed();
    const ctx = "ci::unit@x86_64-linux";
    // Failure is desired but still debouncing.
    poster.post(
      payload({ context: ctx, state: "failure", description: "Failed: a" }),
    );
    // Re-post of the seeded success must NOT wipe the failure desired.
    poster.post(
      payload({
        context: ctx,
        state: "success",
        description: "Succeeded (1s): .ci/x/y.log",
      }),
    );
    await advanceTimersByTimeAsync(25);
    await poster.settle();
    expect(sent).toEqual(["failure"]);
    expect(poster.health().owed).toEqual([]);
  });

  it("finalize flushes a pending debounce and attempts the payload", async () => {
    jest.useFakeTimers();
    const sent: string[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 5_000,
      sendGh: async (p) => {
        sent.push(p.context);
        return { ok: true };
      },
    });
    poster.post(payload({ context: "ci::unit@x86_64-linux" }));
    // Debounce has not fired yet — finalize must flush it.
    expect(sent).toEqual([]);
    const unposted = await poster.finalize();
    expect(sent).toEqual(["ci::unit@x86_64-linux"]);
    expect(unposted).toEqual([]);
  });

  it("finalize attempts a post that arrives mid-drain", async () => {
    const sent: string[] = [];
    let resolveHang: ((r: GhSendResult) => void) | undefined;
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      debounceMs: 0,
      sendGh: (p) => {
        if (p.context === "first") {
          return new Promise((resolve) => {
            resolveHang = resolve;
          });
        }
        sent.push(p.context);
        return Promise.resolve({ ok: true });
      },
    });
    poster.post(payload({ context: "first", description: "Running: f" }));
    // Start finalize; while first is in flight, post a second context.
    const fin = poster.finalize();
    await new Promise((r) => setTimeout(r, 5));
    poster.post(payload({ context: "second" }));
    resolveHang?.({ ok: true });
    const unposted = await fin;
    expect(sent).toContain("second");
    expect(unposted).toEqual([]);
  });
});
