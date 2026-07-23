import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchUrlFor,
  logPathFor,
  parseGhPaginatedStdout,
  parseGithubRemote,
  postingEqual,
  postingWarning,
  StatusPoster,
  statusFor,
  type GhSendResult,
  type StatusPayload,
} from "./statuses";
import { EMPTY_POSTING } from "../common/surface";

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
        state: "degraded",
        owed: [
          { context: "ci::unit@x86_64-linux", lastError: null, attempts: 0 },
        ],
      }),
    ).toMatch(/unconfirmed \(sending\)/);
    const w = postingWarning({
      state: "degraded",
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

describe("parseGhPaginatedStdout", () => {
  it("parses a single JSON array page", () => {
    const items = parseGhPaginatedStdout(
      `[{"context":"a","state":"success","description":"ok"}]`,
    );
    expect(items).toHaveLength(1);
  });

  it("flattens concatenated multi-page arrays", () => {
    const page1 = `[{"context":"a","state":"success","description":"ok"}]`;
    const page2 = `[{"context":"b","state":"pending","description":"run"}]`;
    const items = parseGhPaginatedStdout(page1 + page2);
    expect(items).toEqual([
      { context: "a", state: "success", description: "ok" },
      { context: "b", state: "pending", description: "run" },
    ]);
  });
});

describe("postingEqual", () => {
  it("compares state and owed entries structurally", () => {
    const h = {
      state: "degraded" as const,
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
    vi.useRealTimers();
  });

  it("records lastPosted only after a successful send (fails N times then succeeds)", async () => {
    let calls = 0;
    const sendGh = vi.fn(async (): Promise<GhSendResult> => {
      calls += 1;
      if (calls < 3) return { ok: false, error: "403 rate limited" };
      return { ok: true };
    });
    const healthSnaps: string[] = [];
    const poster = new StatusPoster({
      owner: "o",
      repo: "r",
      sha: "abc",
      enabled: true,
      onLine: () => {},
      onHealth: (h) => healthSnaps.push(h.state),
      sendGh,
      debounceMs: 0,
      backoffBaseMs: 1,
      backoffCapMs: 1,
    });
    const p = payload({ context: "ci::unit@x86_64-linux" });
    poster.post(p);
    // Drain: initial + retries until success.
    for (let i = 0; i < 10 && poster.health().state === "degraded"; i++) {
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
    expect(healthSnaps).toContain("degraded");
    expect(healthSnaps[healthSnaps.length - 1]).toBe("ok");
  });

  it("leaves owed contexts unconfirmed when send never succeeds", async () => {
    const sendGh = vi.fn(async (): Promise<GhSendResult> => ({
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
    expect(poster.health().state).toBe("degraded");
    expect(poster.health().owed[0]?.context).toBe("ci::unit@x86_64-linux");
    expect(poster.health().owed[0]?.lastError).toMatch(/API down/);
    expect(poster.pendingContexts()).toEqual([]); // desired is success, not pending
    const unposted = await poster.finalize();
    expect(unposted).toEqual([
      { context: "ci::unit@x86_64-linux", lastError: "API down" },
    ]);
    // Closed — further posts are ignored.
    const callsBefore = sendGh.mock.calls.length;
    poster.post(payload({ context: "other" }));
    await poster.settle();
    expect(sendGh.mock.calls.length).toBe(callsBefore);
  });

  it("pendingContexts lists contexts still desired/confirmed as pending", async () => {
    const sendGh = vi.fn(async (): Promise<GhSendResult> => ({ ok: true }));
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

  it("times out a hung send and does not block later posts", async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(60);
    await poster.settle();
    expect(order).toContain("next");
    expect(poster.health().owed.some((o) => o.context === "hang")).toBe(true);
    expect(poster.health().owed.some((o) => o.context === "next")).toBe(false);
    expect(
      poster.health().owed.find((o) => o.context === "hang")?.lastError,
    ).toMatch(/timed out/);
  });

  it("seed makes an identical post a no-op", async () => {
    const sendGh = vi.fn(async (): Promise<GhSendResult> => ({ ok: true }));
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

  it("coalesces rapid flips to the latest desired state", async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(25);
    await poster.settle();
    expect(sent).toEqual(["pending:Running: b"]);
  });

  it("post(confirmed) does not drop a different desired still in flight", async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(25);
    await poster.settle();
    expect(sent).toEqual(["failure"]);
    expect(poster.health().state).toBe("ok");
  });

  it("finalize flushes a pending debounce and attempts the payload", async () => {
    vi.useFakeTimers();
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
