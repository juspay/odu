/**
 * The four rules the attention payload is arranged around, each falsifiable on
 * its own — plus the three small folds a caller's answer is assembled from.
 *
 * Every rule here is one where the WRONG behaviour is quiet. A cursor that
 * resolved failures reports a red run green to whoever asked second. A cursor
 * that ran past what was delivered drops exactly the events a reconnecting
 * caller came back for. A `passed` that can be true before a run settles turns
 * "nothing has failed yet" into "it passed". A budget that sheds excerpts
 * before events throws away the reason the caller was woken up and keeps the
 * replayable half. None of them throws, and none of them shows up in a type —
 * so they are pinned here, against a hand-built journal and a stub log reader.
 */

import { describe, expect, it } from "bun:test";
import {
  ATTENTION_BUDGET_BYTES,
  type AttentionSources,
  attentionFor,
  clampTailBytes,
  foldJournal,
  signalFromExit,
} from "./attention";
import { formatCursor, parseCursor } from "./ids";
import type { JournalEntry, Placement, RunVerdict } from "./schema";

const RUN = "lz4k9x0m-7t2ab019";
const LINUX: Placement = { platform: "x86_64-linux", host: "builder-1" };

/** A journal with dense 1-based sequences, the way the store appends one. */
function journal(...events: JournalEntry["event"][]): JournalEntry[] {
  return events.map((event, i) => ({ seq: i + 1, at: 1_000 + i, event }));
}

function sources(over: Partial<AttentionSources> = {}): AttentionSources {
  return {
    runId: RUN,
    manifest: null,
    journal: [],
    unreadableEvents: 0,
    verdict: null,
    expiry: null,
    ownerAlive: true,
    endpoint: null,
    readExcerpt: () => null,
    ...over,
  };
}

/** A node that started, went red, and had its log sealed. */
function redNode(node: string, opts: { exitCode?: number; sealed?: boolean } = {}): JournalEntry["event"][] {
  const events: JournalEntry["event"][] = [
    { kind: "attempt_started", node, attempt: 1, placement: LINUX },
    {
      kind: "node_status",
      node,
      attempt: 1,
      status: "failed",
      exitCode: opts.exitCode ?? 1,
      durationMs: 42,
      placement: LINUX,
    },
  ];
  if (opts.sealed !== false) {
    events.push({
      kind: "log_finalized",
      node,
      attempt: 1,
      bytes: 12,
      complete: true,
      reason: null,
    });
  }
  return events;
}

function verdict(outcome: RunVerdict["outcome"]): RunVerdict {
  return {
    version: 1,
    runId: RUN,
    outcome,
    startedAt: 1_000,
    finishedAt: 2_000,
    failed: outcome === "failed" ? ["ci::unit@x86_64-linux"] : [],
    errored: [],
    cancelled: [],
    unposted: [],
  };
}

const bytesOf = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe("a cursor suppresses repeats but resolves nothing", () => {
  it("still reports a failure the caller has already been served the events for", () => {
    const entries = journal(
      { kind: "roster", order: ["ci::unit@x86_64-linux"] },
      ...redNode("ci::unit@x86_64-linux"),
    );
    const src = sources({
      journal: entries,
      readExcerpt: () => ({ text: "boom", totalBytes: 4 }),
    });

    const first = attentionFor(src);
    expect(first.events).toHaveLength(entries.length);
    expect(first.unresolved_failures).toHaveLength(1);

    // Same run, asked again from the cursor the first answer handed back.
    const again = attentionFor(src, { after: { runId: RUN, seq: entries.length } });
    expect(again.events).toEqual([]);
    expect(again.has_more).toBe(false);
    expect(again.remaining).toBe(0);
    // The failure is state, not news: it is still failing.
    expect(again.unresolved_failures).toHaveLength(1);
    expect(again.unresolved_failures[0]?.node).toBe("ci::unit@x86_64-linux");
    expect(again.unresolved_failures[0]?.excerpt).toBe("boom");
  });

  it("takes the query's `after` over a stale one carried on the sources", () => {
    const entries = journal(
      { kind: "phase", phase: "lanes" },
      { kind: "phase", phase: "no_lanes" },
    );
    const src = sources({ journal: entries, after: { runId: RUN, seq: 2 } });
    const answer = attentionFor(src, { after: { runId: RUN, seq: 0 } });
    expect(answer.events.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("the cursor advances only through included events", () => {
  it("stops where the page stopped, and says how much is left", () => {
    const entries = journal(
      ...Array.from({ length: 9 }, () => ({ kind: "phase", phase: "lanes" }) as const),
    );
    const page = attentionFor(sources({ journal: entries }), { limit: 4 });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(page.cursor).toBe(formatCursor({ runId: RUN, seq: 4 }));
    expect(page.has_more).toBe(true);
    expect(page.remaining).toBe(5);
  });

  it("delivers exactly the rest when asked again with it — no gap, no repeat", () => {
    const entries = journal(
      ...Array.from({ length: 9 }, () => ({ kind: "phase", phase: "lanes" }) as const),
    );
    const src = sources({ journal: entries });
    const page = attentionFor(src, { limit: 4 });
    const rest = attentionFor(src, { after: { runId: RUN, seq: 4 }, limit: 100 });

    expect(rest.events.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(rest.has_more).toBe(false);
    expect(rest.remaining).toBe(0);
    expect(rest.cursor).toBe(formatCursor({ runId: RUN, seq: 9 }));
    // Every sequence exactly once, across the two pages.
    expect([...page.events, ...rest.events].map((e) => e.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("leaves the cursor where the caller left it when the page is empty", () => {
    const entries = journal({ kind: "phase", phase: "lanes" });
    const answer = attentionFor(sources({ journal: entries }), {
      after: { runId: RUN, seq: 1 },
    });
    expect(answer.events).toEqual([]);
    expect(answer.cursor).toBe(formatCursor({ runId: RUN, seq: 1 }));
  });
});

describe("a settled run always returns its verdict", () => {
  it("reports the outcome from the journal's finalized line alone", () => {
    const answer = attentionFor(
      sources({
        journal: journal(
          { kind: "roster", order: ["ci::unit@x86_64-linux"] },
          { kind: "finalized", outcome: "passed" },
        ),
      }),
    );
    expect(answer.state).toBe("settled");
    expect(answer.settled).toBe(true);
    expect(answer.passed).toBe(true);
  });

  it("reports a red outcome as settled but not passed", () => {
    const answer = attentionFor(
      sources({
        journal: journal(
          ...redNode("ci::unit@x86_64-linux"),
          { kind: "finalized", outcome: "failed" },
        ),
        readExcerpt: () => ({ text: "assert failed", totalBytes: 13 }),
      }),
    );
    expect(answer.state).toBe("settled");
    expect(answer.settled).toBe(true);
    expect(answer.passed).toBe(false);
    expect(answer.unresolved_failures).toHaveLength(1);
  });

  it("treats `incomplete` as settled and not passed", () => {
    const answer = attentionFor(
      sources({ journal: journal({ kind: "finalized", outcome: "incomplete" }) }),
    );
    expect(answer.settled).toBe(true);
    expect(answer.passed).toBe(false);
  });

  it("answers from a durable verdict even when the journal has no finalized line", () => {
    const answer = attentionFor(
      sources({
        journal: journal({ kind: "phase", phase: "lanes" }),
        verdict: verdict("passed"),
      }),
    );
    expect(answer.state).toBe("settled");
    expect(answer.passed).toBe(true);
  });

  it("is the same answer an hour later — the cursor does not consume the verdict", () => {
    const entries = journal(
      { kind: "roster", order: [] },
      { kind: "finalized", outcome: "passed" },
    );
    const src = sources({ journal: entries });
    const later = attentionFor(src, { after: { runId: RUN, seq: 2 } });
    expect(later.events).toEqual([]);
    expect(later.settled).toBe(true);
    expect(later.passed).toBe(true);
  });
});

describe("running, gone, and finished are three states", () => {
  it("is still_running for a live owner with no terminal line", () => {
    const answer = attentionFor(
      sources({ journal: journal({ kind: "phase", phase: "lanes" }), ownerAlive: true }),
    );
    expect(answer.state).toBe("still_running");
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("is owner_lost for a provably dead owner with no terminal line", () => {
    const answer = attentionFor(
      sources({ journal: journal({ kind: "phase", phase: "lanes" }), ownerAlive: false }),
    );
    expect(answer.state).toBe("owner_lost");
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("is expired once a tombstone is there, whatever the verdict said", () => {
    const answer = attentionFor(
      sources({
        journal: journal({ kind: "finalized", outcome: "passed" }),
        verdict: verdict("passed"),
        expiry: { version: 1, runId: RUN, expiredAt: 9_000, outcome: "passed" },
      }),
    );
    expect(answer.state).toBe("expired");
    // Expired is not settled, so it is not a pass — a caller that wants the
    // outcome of an aged-out run reads the tombstone, not this bit.
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("is unknown_run with no manifest and no journal", () => {
    const answer = attentionFor(sources({ manifest: null, journal: [] }));
    expect(answer.state).toBe("unknown_run");
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("never reports passed for a run that has not settled", () => {
    for (const src of [
      sources({ journal: journal({ kind: "phase", phase: "lanes" }), ownerAlive: true }),
      sources({ journal: journal({ kind: "phase", phase: "lanes" }), ownerAlive: false }),
      sources({ journal: journal({ kind: "roster", order: ["a"] }), ownerAlive: null }),
      sources({}),
    ]) {
      const answer = attentionFor(src);
      expect(answer.settled).toBe(false);
      expect(answer.passed).toBe(false);
    }
  });
});

describe("foldJournal — the latest attempt is the one that counts", () => {
  it("a node that failed attempt 1 and passed attempt 2 is not an unresolved failure", () => {
    const node = "ci::unit@x86_64-linux";
    const entries = journal(
      { kind: "roster", order: [node] },
      { kind: "attempt_started", node, attempt: 1, placement: LINUX },
      { kind: "node_status", node, attempt: 1, status: "failed", exitCode: 1, durationMs: 5, placement: LINUX },
      { kind: "attempt_started", node, attempt: 2, placement: LINUX },
      { kind: "node_status", node, attempt: 2, status: "ok", exitCode: 0, durationMs: 6, placement: LINUX },
    );
    expect(foldJournal(entries).latest.get(node)?.attempt).toBe(2);
    expect(attentionFor(sources({ journal: entries })).unresolved_failures).toEqual([]);
  });

  it("a node that passed attempt 1 and failed attempt 2 IS an unresolved failure", () => {
    const node = "ci::unit@x86_64-linux";
    const entries = journal(
      { kind: "roster", order: [node] },
      { kind: "attempt_started", node, attempt: 1, placement: LINUX },
      { kind: "node_status", node, attempt: 1, status: "ok", exitCode: 0, durationMs: 5, placement: LINUX },
      { kind: "attempt_started", node, attempt: 2, placement: LINUX },
      { kind: "node_status", node, attempt: 2, status: "failed", exitCode: 2, durationMs: 6, placement: LINUX },
    );
    const failures = attentionFor(sources({ journal: entries })).unresolved_failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]?.attempt).toBe(2);
    expect(failures[0]?.exit_code).toBe(2);
  });

  it("carries the roster, the scope, the debt and the outcome out of one pass", () => {
    const fold = foldJournal(
      journal(
        { kind: "registered", scope: { selectors: ["e2e"], platforms: [], noDeps: true } },
        { kind: "roster", order: ["a", "b"] },
        { kind: "posting_debt", context: "ci/e2e", lastError: "502", attempts: 3 },
        { kind: "finalized", outcome: "failed" },
      ),
    );
    expect(fold.roster).toEqual(["a", "b"]);
    expect(fold.scope?.selectors).toEqual(["e2e"]);
    expect(fold.scope?.noDeps).toBe(true);
    expect(fold.debt.get("ci/e2e")?.attempts).toBe(3);
    expect(fold.finalized).toBe("failed");
  });

  it("surfaces reporting debt beside the verdict, not inside it", () => {
    const answer = attentionFor(
      sources({
        journal: journal(
          { kind: "posting_debt", context: "ci/unit", lastError: "403", attempts: 2 },
          { kind: "finalized", outcome: "passed" },
        ),
      }),
    );
    expect(answer.passed).toBe(true);
    expect(answer.reporting_debt).toEqual([
      { context: "ci/unit", last_error: "403", attempts: 2 },
    ]);
  });
});

describe("actionable — red is returned once the log barrier completes", () => {
  it("is false for a red node whose log_finalized has not arrived", () => {
    const answer = attentionFor(
      sources({
        journal: journal(
          { kind: "roster", order: ["ci::unit@x86_64-linux"] },
          ...redNode("ci::unit@x86_64-linux", { sealed: false }),
        ),
        readExcerpt: () => ({ text: "half a li", totalBytes: 9 }),
      }),
    );
    expect(answer.unresolved_failures).toHaveLength(1);
    expect(answer.unresolved_failures[0]?.log_complete).toBe(false);
    expect(answer.actionable).toBe(false);
  });

  it("is true once it has", () => {
    const answer = attentionFor(
      sources({
        journal: journal(
          { kind: "roster", order: ["ci::unit@x86_64-linux"] },
          ...redNode("ci::unit@x86_64-linux"),
        ),
        readExcerpt: () => ({ text: "the whole line\n", totalBytes: 15 }),
      }),
    );
    expect(answer.unresolved_failures[0]?.log_complete).toBe(true);
    expect(answer.actionable).toBe(true);
    // …and it is still not settled: actionable is an invitation to look, not a
    // verdict.
    expect(answer.settled).toBe(false);
    expect(answer.passed).toBe(false);
  });

  it("reports an unreadable log as itself, never as an empty passing node", () => {
    const answer = attentionFor(
      sources({
        journal: journal(...redNode("ci::unit@x86_64-linux")),
        readExcerpt: () => null,
      }),
    );
    expect(answer.unresolved_failures[0]?.excerpt_source).toBe("none");
    expect(answer.unresolved_failures[0]?.excerpt).toBe("");
  });
});

describe("the byte budget", () => {
  const NODE = "ci::e2e@x86_64-linux";

  /** A run with `count` journal lines and one red node holding `excerpt`. */
  function bigRun(count: number, excerpt: string): AttentionSources {
    return sources({
      journal: journal(
        { kind: "roster", order: [NODE] },
        ...redNode(NODE),
        ...Array.from(
          { length: count },
          () => ({ kind: "phase", phase: "lanes" }) as const,
        ),
      ),
      readExcerpt: () => ({ text: excerpt, totalBytes: excerpt.length }),
    });
  }

  it("keeps the encoded payload inside the budget it was given", () => {
    const src = bigRun(400, "e".repeat(8_000));
    const natural = bytesOf(attentionFor(src, { budgetBytes: 1_000_000, excerptBytes: 64_000 }));
    const budget = Math.floor(natural / 4);
    const trimmed = attentionFor(src, { budgetBytes: budget, excerptBytes: 64_000 });
    expect(bytesOf(trimmed)).toBeLessThanOrEqual(budget);
  });

  it("sheds events before excerpts — the reason survives, the replayable half goes", () => {
    const excerpt = "the failing line\n".repeat(30);
    const src = bigRun(300, excerpt);
    // A budget that fits the failure with no events at all, plus a little slack.
    const withoutEvents = bytesOf(
      attentionFor(src, { after: { runId: RUN, seq: 1_000 }, budgetBytes: 1_000_000 }),
    );
    const answer = attentionFor(src, { budgetBytes: withoutEvents + 200 });

    expect(bytesOf(answer)).toBeLessThanOrEqual(withoutEvents + 200);
    expect(answer.events.length).toBeLessThan(304);
    expect(answer.unresolved_failures).toHaveLength(1);
    expect(answer.unresolved_failures[0]?.excerpt).toBe(excerpt);
    expect(answer.unresolved_failures[0]?.excerpt_truncated).toBe(false);
  });

  it("moves the cursor back with the shed events, so nothing is silently dropped", () => {
    const excerpt = "the failing line\n".repeat(30);
    const src = bigRun(300, excerpt);
    const withoutEvents = bytesOf(
      attentionFor(src, { after: { runId: RUN, seq: 1_000 }, budgetBytes: 1_000_000 }),
    );
    const answer = attentionFor(src, { budgetBytes: withoutEvents + 400 });

    const lastDelivered = answer.events.at(-1)?.seq ?? 0;
    expect(answer.cursor).toBe(formatCursor({ runId: RUN, seq: lastDelivered }));
    expect(answer.has_more).toBe(true);
    expect(answer.remaining).toBe(src.journal.length - answer.events.length);

    // Asking again from that cursor delivers the shed tail, starting exactly
    // one past what arrived.
    const rest = attentionFor(src, {
      after: { runId: RUN, seq: lastDelivered },
      budgetBytes: 1_000_000,
      limit: 10_000,
    });
    expect(rest.events[0]?.seq).toBe(lastDelivered + 1);
    expect(rest.events).toHaveLength(src.journal.length - answer.events.length);
  });

  it("sheds events down to ONE, never to none, and then shrinks the excerpt", () => {
    // One event is RESERVED from every reduction, and that reservation is the
    // difference between a payload that can be drained and one that cannot: a
    // page whose cursor did not move returns the same oversized answer next
    // time, forever.
    const src = bigRun(0, "x".repeat(20_000));
    const withEmpty = bytesOf(
      attentionFor(
        sources({ journal: journal(...redNode(NODE)), readExcerpt: () => null }),
        { budgetBytes: 1_000_000 },
      ),
    );
    const answer = attentionFor(src, {
      budgetBytes: withEmpty + 2_000,
      excerptBytes: 64_000,
    });
    expect(answer.events).toHaveLength(1);
    expect(bytesOf(answer)).toBeLessThanOrEqual(withEmpty + 2_000);
    // The failure is still reported, and says its evidence was cut.
    expect(answer.unresolved_failures).toHaveLength(1);
    expect(answer.unresolved_failures[0]?.excerpt_truncated).toBe(true);
    expect(answer.unresolved_failures[0]?.excerpt.length).toBeLessThan(20_000);
  });

  it("keeps a run with many failures inside the budget, and says how many it dropped", () => {
    // The reported shape: sixty red nodes produced a 21,776-byte answer against
    // a 16 KiB budget, with zero events, `has_more: true` and an unchanged
    // cursor — an answer that was both too big and impossible to page past.
    const nodes = Array.from({ length: 60 }, (_, i) => `ci::n${i}@x86_64-linux`);
    const src = sources({
      journal: journal(
        { kind: "roster", order: nodes },
        ...nodes.flatMap((n) => redNode(n)),
      ),
      readExcerpt: () => ({ text: "z".repeat(4_000), totalBytes: 4_000 }),
    });
    const answer = attentionFor(src, { budgetBytes: ATTENTION_BUDGET_BYTES });

    expect(bytesOf(answer)).toBeLessThanOrEqual(ATTENTION_BUDGET_BYTES);
    // A prefix, and it SAYS it is a prefix — a caller shown three of sixty
    // must not read that as three.
    expect(answer.unresolved_failures_total).toBe(60);
    expect(answer.failures_omitted).toBe(
      60 - answer.unresolved_failures.length,
    );
    expect(answer.failures_omitted).toBeGreaterThan(0);
  });

  it("advances the cursor even when nothing else fits, so a backlog can drain", () => {
    // The drain property, stated as a loop: page until `has_more` goes false.
    // Under the old rule this never terminated.
    const nodes = Array.from({ length: 40 }, (_, i) => `ci::n${i}@x86_64-linux`);
    const src = sources({
      journal: journal(
        { kind: "roster", order: nodes },
        ...nodes.flatMap((n) => redNode(n)),
      ),
      readExcerpt: () => ({ text: "q".repeat(4_000), totalBytes: 4_000 }),
    });

    let cursor = parseCursor(
      attentionFor(src, { budgetBytes: ATTENTION_BUDGET_BYTES }).cursor,
    );
    let rounds = 0;
    for (;;) {
      const page = attentionFor(src, {
        budgetBytes: ATTENTION_BUDGET_BYTES,
        ...(cursor === null ? {} : { after: cursor }),
      });
      if (!page.has_more) break;
      const next = parseCursor(page.cursor);
      expect(next).not.toBeNull();
      // Strictly forward, every round — the guarantee that makes this finite.
      expect(next!.seq).toBeGreaterThan(cursor?.seq ?? 0);
      cursor = next;
      rounds += 1;
      expect(rounds, "the backlog must drain in a bounded number of pages").toBeLessThan(
        500,
      );
    }
  });

  it("clamps each excerpt to the per-failure ceiling before the payload budget", () => {
    const src = bigRun(0, "y".repeat(10_000));
    const answer = attentionFor(src, { excerptBytes: 512, budgetBytes: 1_000_000 });
    const failure = answer.unresolved_failures[0];
    expect(new TextEncoder().encode(failure?.excerpt ?? "").length).toBeLessThanOrEqual(512);
    expect(failure?.excerpt_truncated).toBe(true);
  });
});

describe("clampTailBytes", () => {
  it("is a no-op when the text already fits", () => {
    expect(clampTailBytes("hello", 100)).toEqual({ text: "hello", truncated: false });
    expect(clampTailBytes("", 0)).toEqual({ text: "", truncated: false });
  });

  it("returns the TAIL — the end of a failing log is where the reason is", () => {
    expect(clampTailBytes("abcdefgh", 3)).toEqual({ text: "fgh", truncated: true });
  });

  it("never splits a multibyte character", () => {
    // Three 4-byte emoji, with room for one and a half.
    const emoji = clampTailBytes("🙂🙂🙂", 6);
    expect(emoji.text).toBe("🙂");
    expect(emoji.truncated).toBe(true);
    expect(new TextEncoder().encode(emoji.text).length).toBeLessThanOrEqual(6);

    // Three 3-byte CJK characters, with room for one and a third.
    const cjk = clampTailBytes("日本語", 4);
    expect(cjk.text).toBe("語");
    expect(cjk.truncated).toBe(true);
  });

  it("returns nothing rather than half a character when not even one fits", () => {
    const clamped = clampTailBytes("🙂", 3);
    expect(clamped.text).toBe("");
    expect(clamped.truncated).toBe(true);
  });

  it("stays inside the byte budget for a log of box-drawing characters", () => {
    const text = "│ ".repeat(500);
    for (const max of [1, 7, 64, 1_000]) {
      const clamped = clampTailBytes(text, max);
      expect(new TextEncoder().encode(clamped.text).length).toBeLessThanOrEqual(max);
      expect(text.endsWith(clamped.text)).toBe(true);
    }
  });
});

describe("signalFromExit", () => {
  it("reads the shell's 128 + N convention", () => {
    expect(signalFromExit(137)).toBe("SIGKILL");
    expect(signalFromExit(130)).toBe("SIGINT");
    expect(signalFromExit(143)).toBe("SIGTERM");
  });

  it("is null for an exit status that is not a signal reading", () => {
    expect(signalFromExit(0)).toBeNull();
    expect(signalFromExit(1)).toBeNull();
    expect(signalFromExit(null)).toBeNull();
    expect(signalFromExit(128)).toBeNull();
  });

  it("is null for a number outside the signal range", () => {
    expect(signalFromExit(300)).toBeNull();
    expect(signalFromExit(-1)).toBeNull();
  });

  it("names an unlisted signal by number rather than guessing", () => {
    expect(signalFromExit(128 + 31)).toBe("SIG31");
  });
});

describe("the failure row", () => {
  it("carries the exact `--run … --attempt … NODE` triple, so an agent echoes it", () => {
    const node = "ci::e2e@aarch64-darwin";
    const answer = attentionFor(
      sources({
        journal: journal(
          { kind: "attempt_started", node, attempt: 3, placement: LINUX },
          {
            kind: "node_status",
            node,
            attempt: 3,
            status: "errored",
            exitCode: 137,
            durationMs: 1,
            placement: LINUX,
          },
        ),
        readExcerpt: () => ({ text: "killed", totalBytes: 6 }),
      }),
    );
    const failure = answer.unresolved_failures[0];
    expect(failure?.log_key).toBe(`--run ${RUN} --attempt 3 ${node}`);
    expect(failure?.status).toBe("errored");
    expect(failure?.signal).toBe("SIGKILL");
    expect(failure?.placement).toEqual(LINUX);
    expect(failure?.excerpt_source).toBe("attempt_log");
  });

  it("reports unreadable journal lines rather than swallowing them", () => {
    const answer = attentionFor(sources({ journal: journal({ kind: "phase", phase: "lanes" }), unreadableEvents: 3 }));
    expect(answer.unreadable_events).toBe(3);
  });
});
