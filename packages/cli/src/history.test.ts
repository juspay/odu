/**
 * The native face of the durable run catalog, pinned on the two properties its
 * header claims and nothing else can check for it.
 *
 * **THE EXIT IS THE ANSWER.** `odu wait --run` is read by scripts far more
 * often than by people, and the whole reason it exists beside the live wait is
 * that it distinguishes "it failed" from "not yet" from "its coordinator died".
 * Every one of those needs a different next move, and the failure mode is
 * silent: a wait that collapses "still going" into the failure exit turns a
 * slow lane into a red one, and a wait that collapses "there is a red node I
 * can act on" into "still going" makes a bounded wait useless for the thing it
 * was built for. So {@link waitExitFor} is tested row by row, including the
 * unsettled-but-red row that is the point of the command.
 *
 * **MACHINE-READABLE OUTPUT MUST NOT NEED A TTY.** Every `-o json` path writes
 * ONE complete JSON value in ONE write to stdout, with every human sentence on
 * stderr. That is a property of WHERE THE BYTES GO, so the tests count writes
 * and inspect both streams rather than pattern-matching a rendering: an agent
 * piping this through a shell without `stdbuf` has to get a parseable line, and
 * `odu logs --run … > file` has to capture the log and not the caveat about it.
 *
 * The command tests run against a real catalog in a temp dir — resolution,
 * refusal and slicing are all about files, and a stubbed store would be testing
 * the stub. Every call passes `catalogRoot`: a suite that wrote into the
 * developer's real `~/.local/state/odu` is a suite nobody can run twice.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
  Attention,
  AttentionFailure,
} from "@odu/run-history/attention";
import { formatCursor, isRunId, mintRunId } from "@odu/run-history/ids";
import type {
  Placement,
  RunManifest,
  RunVerdict,
} from "@odu/run-history/schema";
import type { OwnershipToken } from "@odu/run-history/owner";
import {
  appendAttemptLog,
  appendEvent,
  type CatalogRow,
  expireRun,
  readExpiry,
  registerRun,
  type RunHandle,
  sealAttempt,
  startAttempt,
  writeVerdict,
} from "@odu/run-history/store";
import type { RetryReceipt } from "@odu/execution/coordinator/recovery";
import { gitTopLevel } from "@odu/execution/common/git";
import {
  durableLogsCommand,
  durableWaitCommand,
  historyImportCommand,
  historyListCommand,
  historyPruneCommand,
  historyShowCommand,
  renderAttention,
  renderCatalog,
  renderRetry,
  WAIT_EXITS,
  waitExitFor,
} from "./history";

const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const NODE = "ci::unit@x86_64-linux";
const OTHER = "ci::e2e@x86_64-linux";
const LINUX: Placement = { platform: "x86_64-linux", host: "builder-1" };
/** Old enough that retention counts it, and that its ownership heartbeat is
 *  stale — which is what lets a janitor (expiry, prune) touch these runs. */
const T0 = 1_700_000_000_000;

// ── capture ─────────────────────────────────────────────────────────────────

/** Every write, kept SEPARATELY rather than concatenated: "one JSON value" and
 *  "one write" are different claims, and only the second one survives a shell
 *  with no TTY between the command and its reader. */
let out: string[] = [];
let err: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  out = [];
  err = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const sink =
    (into: string[]) =>
    (chunk: string | Uint8Array): boolean => {
      into.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    };
  process.stdout.write = sink(out) as typeof process.stdout.write;
  process.stderr.write = sink(err) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
});

afterEach(() => {
  restore();
});

const stdout = (): string => out.join("");
const stderr = (): string => err.join("");

// ── fixtures ────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A catalog of this test's own. Never the developer's. */
function catalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-history-cli-"));
  dirs.push(dir);
  return dir;
}

interface Run {
  handle: RunHandle;
  token: OwnershipToken;
  runId: string;
}

function register(
  root: string,
  over: Partial<Pick<RunManifest, "runId" | "sha" | "seq" | "repoRoot">> & {
    endpoint?: string | null;
  } = {},
): Run {
  const runId = over.runId ?? mintRunId(T0);
  const sha = over.sha ?? SHA;
  const result = registerRun(
    {
      runId,
      repo: "juspay/odu",
      sha,
      seq: over.seq ?? 1,
      pipeline: "ci",
      repoRoot: over.repoRoot ?? "/checkouts/odu",
      createdAt: T0,
      scope: { selectors: [], platforms: [], noDeps: false },
      snapshot: { mode: "strict", expectedSha: sha, dirty: false, retryable: true },
      build: { oduVersion: "test", self: null, runnerFlake: null },
      parentRunId: null,
      requestId: null,
    },
    { root, endpoint: over.endpoint ?? null, now: T0 },
  );
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.kind}`);
  return { handle: result.handle, token: result.token, runId };
}

/** Record one attempt's evidence end to end: the journal lines, the log bytes,
 *  and the seal that stamps whether the log got its producer's last word. */
function recordAttempt(
  run: Run,
  opts: {
    node?: string;
    attempt?: number;
    text: string;
    status?: "failed" | "ok";
    complete?: boolean;
    reason?: string | null;
  },
): void {
  const node = opts.node ?? NODE;
  const attempt = opts.attempt ?? 1;
  const status = opts.status ?? "failed";
  const complete = opts.complete ?? true;
  appendEvent(run.handle, run.token, { kind: "roster", order: [node] });
  appendEvent(run.handle, run.token, {
    kind: "attempt_started",
    node,
    attempt,
    placement: LINUX,
  });
  startAttempt(run.handle, run.token, {
    node,
    attempt,
    placement: LINUX,
    startedAt: T0,
  });
  appendAttemptLog(run.handle, node, attempt, opts.text);
  appendEvent(run.handle, run.token, {
    kind: "node_status",
    node,
    attempt,
    status,
    exitCode: status === "failed" ? 1 : 0,
    durationMs: 12,
    placement: LINUX,
  });
  appendEvent(run.handle, run.token, {
    kind: "log_finalized",
    node,
    attempt,
    bytes: Buffer.byteLength(opts.text),
    complete,
    reason: opts.reason ?? null,
  });
  sealAttempt(run.handle, run.token, node, attempt, {
    endedAt: T0 + 1_000,
    status,
    exitCode: status === "failed" ? 1 : 0,
    signal: null,
    logComplete: complete,
    logTruncationReason: opts.reason ?? null,
  });
}

/** Publish a terminal outcome, both ways a reader can learn it. */
function finalize(run: Run, over: Partial<RunVerdict> = {}): void {
  const outcome = over.outcome ?? "failed";
  appendEvent(run.handle, run.token, { kind: "finalized", outcome });
  writeVerdict(run.handle, run.token, {
    runId: run.runId,
    outcome,
    startedAt: T0,
    finishedAt: T0 + 5_000,
    failed: over.failed ?? (outcome === "failed" ? [NODE] : []),
    errored: over.errored ?? [],
    cancelled: over.cancelled ?? [],
    unposted: over.unposted ?? [],
  });
}

const RUN = mintRunId(T0, () => 0.5);

/** A hand-built attention payload: the pure renderers and the exit table are
 *  total over shapes the filesystem would take a whole pipeline to produce. */
function attention(over: Partial<Attention> = {}): Attention {
  return {
    run: {
      id: RUN,
      sha: SHA,
      sha7: "26d2c2d",
      seq: 2,
      repo: "juspay/odu",
      pipeline: "ci",
      repo_root: "/checkouts/odu",
      parent_run_id: null,
    },
    scope: null,
    state: "still_running",
    settled: false,
    passed: false,
    outcome: null,
    actionable: false,
    cursor: formatCursor({ runId: RUN, seq: 0 }),
    events: [],
    has_more: false,
    remaining: 0,
    unreadable_events: 0,
    unresolved_failures: [],
    unresolved_failures_total: 0,
    failures_omitted: 0,
    debt_omitted: 0,
    over_budget: false,
    reporting_debt: [],
    endpoint: null,
    ...over,
  };
}

function failure(over: Partial<AttentionFailure> = {}): AttentionFailure {
  return {
    node: NODE,
    attempt: 2,
    status: "failed",
    exit_code: 1,
    signal: null,
    placement: LINUX,
    log_key: `--run ${RUN} --attempt 2 ${NODE}`,
    log_complete: true,
    log_bytes: 64,
    log_truncation_reason: null,
    excerpt: "expected 1 to be 2\n",
    excerpt_source: "attempt_log",
    excerpt_truncated: false,
    ...over,
  };
}

// ── the exit contract ───────────────────────────────────────────────────────

describe("waitExitFor", () => {
  it("exits 0 only for a run that settled AND passed", () => {
    expect(
      waitExitFor(
        attention({ state: "settled", settled: true, passed: true, outcome: "passed" }),
      ),
    ).toBe(WAIT_EXITS.passed);
  });

  it("exits 1 for a run that settled without passing", () => {
    expect(
      waitExitFor(
        attention({ state: "settled", settled: true, passed: false, outcome: "failed" }),
      ),
    ).toBe(WAIT_EXITS.failed);
  });

  it("exits 1 for a run that has NOT settled but has a failure to act on", () => {
    // The row the bounded wait exists for. A red unit lane at eight seconds is
    // something a caller must act on now, and reporting it as "still going"
    // would make the early answer worthless — the caller would wait for the
    // slow lanes anyway to find out whether it mattered.
    expect(
      waitExitFor(
        attention({
          state: "still_running",
          settled: false,
          actionable: true,
          unresolved_failures: [failure()],
        }),
      ),
    ).toBe(WAIT_EXITS.failed);
  });

  it("exits 2 for a run that is still going with nothing red", () => {
    // The other side of the same line: "not yet" is not a failure, and a script
    // that cannot tell them apart retries a lane that never broke.
    expect(waitExitFor(attention({ state: "still_running" }))).toBe(
      WAIT_EXITS.stillRunning,
    );
  });

  it("exits 3 when the coordinator is provably gone", () => {
    expect(waitExitFor(attention({ state: "owner_lost" }))).toBe(
      WAIT_EXITS.ownerLost,
    );
  });

  it("exits 4 for an expired run and for one the catalog never had", () => {
    // Both mean "there is no evidence to read here", and the caller's move for
    // both is `odu runs` — so they share an exit rather than inventing a sixth.
    expect(waitExitFor(attention({ state: "expired" }))).toBe(WAIT_EXITS.unknownRun);
    expect(waitExitFor(attention({ state: "unknown_run" }))).toBe(
      WAIT_EXITS.unknownRun,
    );
  });
});

// ── the human renderings ────────────────────────────────────────────────────

describe("renderAttention", () => {
  it("shows the run's OWN outcome, so an incomplete run does not read as failed", () => {
    // `passed: false` covers a red run and one that was torn down before every
    // node finished. Calling the second "failed" sends an operator looking for
    // a broken test that does not exist.
    const rendered = renderAttention(
      attention({ state: "settled", settled: true, passed: false, outcome: "incomplete" }),
    );
    expect(rendered).toContain("incomplete");
    expect(rendered).not.toContain("failed");
  });

  it("names the node, attempt, how it died and where, on one failure row", () => {
    const rendered = renderAttention(
      attention({
        unresolved_failures: [failure({ exit_code: 137, signal: "SIGKILL" })],
      }),
    );
    expect(rendered).toContain(NODE);
    expect(rendered).toContain("attempt 2");
    expect(rendered).toContain("SIGKILL (exit 137)");
    expect(rendered).toContain("x86_64-linux on builder-1");
  });

  it("says WHY a log is short when its producer never finished it", () => {
    const rendered = renderAttention(
      attention({
        unresolved_failures: [
          failure({
            log_complete: false,
            log_truncation_reason: "the lane host went away mid-attempt",
          }),
        ],
      }),
    );
    expect(rendered).toContain("log INCOMPLETE");
    expect(rendered).toContain("the lane host went away mid-attempt");
  });

  it("prints the exact `odu logs` line for the failure, to echo rather than assemble", () => {
    const rendered = renderAttention(attention({ unresolved_failures: [failure()] }));
    expect(rendered).toContain(`odu logs --run ${RUN} --attempt 2 ${NODE}`);
  });

  it("ends on the cursor, and says how much it did not carry", () => {
    const rendered = renderAttention(
      attention({
        cursor: formatCursor({ runId: RUN, seq: 12 }),
        has_more: true,
        remaining: 7,
        unresolved_failures: [failure()],
      }),
    );
    const lines = rendered.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(`  cursor ${RUN}@12 (+7 more)`);
  });

  it("says nothing about `more` when the page carried everything", () => {
    const rendered = renderAttention(attention({ cursor: `${RUN}@3` }));
    expect(rendered.trimEnd().split("\n").at(-1)).toBe(`  cursor ${RUN}@3`);
  });
});

describe("renderCatalog", () => {
  const NOW = T0 + 7_200_000;

  function manifest(over: Partial<RunManifest> = {}): RunManifest {
    return {
      version: 1,
      runId: RUN,
      repo: "juspay/odu",
      sha: SHA,
      seq: 1,
      pipeline: "ci",
      repoRoot: "/checkouts/odu",
      createdAt: T0,
      scope: { selectors: [], platforms: [], noDeps: false },
      snapshot: { mode: "strict", expectedSha: SHA, dirty: false, retryable: true },
      build: { oduVersion: "test", self: null, runnerFlake: null },
      registeredBy: {
        epoch: 1,
        pid: 1,
        host: "builder-1",
        claimedAt: T0,
        heartbeatAt: T0,
        endpoint: null,
      },
      parentRunId: null,
      requestId: null,
      ...over,
    };
  }

  function row(over: Partial<CatalogRow> = {}): CatalogRow {
    return {
      runId: RUN,
      manifest: manifest(),
      verdict: null,
      expiry: null,
      liveness: "no_owner",
      endpoint: null,
      ...over,
    };
  }

  it("keeps the catalog's newest-first order and dates each row", () => {
    const rendered = renderCatalog(
      [row({ runId: "newer-0001" }), row({ runId: "older-0002" })],
      NOW,
    );
    const lines = rendered.trimEnd().split("\n");
    expect(lines[0]).toContain("newer-0001");
    expect(lines[0]).toContain("26d2c2d#1");
    expect(lines[0]).toContain("2h ago");
    expect(lines[1]).toContain("older-0002");
  });

  it("says an expired run expired, and still says how it had ended", () => {
    // A tombstone is not "no such run": an agent holding a months-old id has to
    // learn that the verdict survives and the evidence does not.
    const rendered = renderCatalog(
      [
        row({
          expiry: { version: 1, runId: RUN, expiredAt: T0, outcome: "failed" },
        }),
      ],
      NOW,
    );
    expect(rendered).toContain("expired (failed)");
  });

  it("tells a run that is being written from one whose coordinator died", () => {
    // THREE states, not two. A verdict-less run used to render `running`
    // whenever the manifest carried an endpoint — and the manifest's endpoint
    // is stamped once at registration and never cleared, so a coordinator
    // killed before it finalized claimed to be executing for the life of the
    // catalog. In the listing an operator reads to find out what is still
    // going.
    const live = renderCatalog(
      [row({ liveness: "owned", endpoint: "/checkouts/odu/.ci/odu.sock" })],
      NOW,
    );
    expect(live).toContain("running");

    const dead = renderCatalog([row({ liveness: "owner_lost" })], NOW);
    expect(dead).toContain("owner lost");
    expect(dead).not.toContain("running");

    const orphan = renderCatalog([row({ liveness: "no_owner" })], NOW);
    expect(orphan).toContain("unfinished");
    expect(orphan).not.toContain("running");
  });

  it("prints a settled run's verdict verbatim", () => {
    const rendered = renderCatalog(
      [
        row({
          verdict: {
            version: 1,
            runId: RUN,
            outcome: "incomplete",
            startedAt: T0,
            finishedAt: T0 + 1,
            failed: [],
            errored: [],
            cancelled: [NODE],
            unposted: [],
          },
        }),
      ],
      NOW,
    );
    expect(rendered).toContain("incomplete");
  });
});

describe("renderRetry", () => {
  function receipt(over: Partial<RetryReceipt> = {}): RetryReceipt {
    return {
      request_id: null,
      mode: "live",
      effective_run: RUN,
      parent_run: null,
      roots: [NODE],
      reset_dependants: [OTHER],
      attempts: [{ node: NODE, attempt: 2 }],
      scope: { selectors: ["unit"], platforms: [], noDeps: false },
      sha: SHA,
      cursor: formatCursor({ runId: RUN, seq: 9 }),
      ...over,
    };
  }

  it("a live retry says it reran the roots ON the run that was named", () => {
    const rendered = renderRetry(receipt(), false);
    expect(rendered).toContain(`reran ${NODE} on ${RUN}`);
    expect(rendered).toContain(`resets ${OTHER}`);
    expect(rendered).toContain(`${NODE} is now on attempt 2`);
    expect(rendered).not.toContain("new run");
  });

  it("a relaunch says a NEW run is replaying the parent, and caveats its scope", () => {
    // "a new attempt on the run you named" and "a whole new run linked to it"
    // are different enough that guessing is expensive — and the new run covers
    // a SELECTION, so its verdict must not be read as the pipeline's.
    const child = mintRunId(T0 + 1_000, () => 0.25);
    const rendered = renderRetry(
      receipt({
        mode: "relaunched",
        effective_run: child,
        parent_run: RUN,
        attempts: [],
      }),
      false,
    );
    expect(rendered).toContain(`started ${child} — a new run replaying ${RUN}`);
    expect(rendered).toContain("scope: unit at 26d2c2d");
    expect(rendered).toContain(
      "(a selection — its verdict does not speak for the whole pipeline)",
    );
  });

  it("says when a receipt was replayed rather than acted on a second time", () => {
    expect(renderRetry(receipt(), true)).toContain("(already done; replayed)");
    expect(renderRetry(receipt(), false)).not.toContain("replayed");
  });

  it("hands back the exact wait that resumes where the retry left off", () => {
    expect(renderRetry(receipt(), false)).toContain(
      `watch it: odu wait --run ${RUN} --after ${RUN}@9`,
    );
  });
});

// ── odu logs --run ──────────────────────────────────────────────────────────

describe("durableLogsCommand", () => {
  it("writes the attempt's BYTES to stdout and nothing else", () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "step 1 ok\nstep 2 BOOM\n" });

    const code = durableLogsCommand({
      run: run.runId,
      node: NODE,
      json: false,
      catalogRoot: root,
    });
    expect(code).toBe(0);
    // Exactly the log, with no banner around it: a caller redirecting this into
    // a file gets a file it can diff.
    expect(out).toEqual(["step 1 ok\nstep 2 BOOM\n"]);
    expect(stderr()).toBe("");
  });

  it("defaults to the LATEST attempt, and `--attempt` addresses an older one", () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { attempt: 1, text: "first try\n" });
    recordAttempt(run, { attempt: 2, text: "second try\n" });

    expect(
      durableLogsCommand({ run: run.runId, node: NODE, json: false, catalogRoot: root }),
    ).toBe(0);
    expect(stdout()).toBe("second try\n");

    out.length = 0;
    expect(
      durableLogsCommand({
        run: run.runId,
        node: NODE,
        attempt: 1,
        json: false,
        catalogRoot: root,
      }),
    ).toBe(0);
    expect(stdout()).toBe("first try\n");
  });

  it("in json mode writes ONE parseable line to stdout and nothing else", () => {
    // The no-TTY property. One write of one complete value means a shell with
    // no terminal between the command and its reader still delivers a line an
    // agent can parse, without `stdbuf`.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "boom\n" });

    const code = durableLogsCommand({
      run: run.runId,
      node: NODE,
      json: true,
      catalogRoot: root,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const payload = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    expect(payload["run"]).toBe(run.runId);
    expect(payload["node"]).toBe(NODE);
    expect(payload["attempt"]).toBe(1);
    expect(payload["attempts"]).toEqual([1]);
    expect(payload["offset"]).toBe(0);
    expect(payload["size"]).toBe(5);
    expect(payload["eof"]).toBe(true);
    expect(payload["complete"]).toBe(true);
    expect(payload["text"]).toBe("boom\n");
  });

  it("puts an INCOMPLETE log's caveat on stderr, never in the log itself", () => {
    // `odu logs --run … > file` must capture the log alone; the sentence about
    // it belongs beside the terminal, not inside the evidence.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, {
      text: "half a line",
      complete: false,
      reason: "the lane host went away mid-attempt",
    });

    expect(
      durableLogsCommand({ run: run.runId, node: NODE, json: false, catalogRoot: root }),
    ).toBe(0);
    expect(stdout()).toBe("half a line");
    expect(stderr()).toContain("INCOMPLETE");
    expect(stderr()).toContain("the lane host went away mid-attempt");
  });

  it("reports incompleteness as a FIELD in json, distinct from reaching the end", () => {
    // `eof` says this slice read to the end of the file; `complete` says the
    // file is everything there ever was. A reader needs both, and neither
    // implies the other.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "half a line", complete: false, reason: "host lost" });

    durableLogsCommand({ run: run.runId, node: NODE, json: true, catalogRoot: root });
    const payload = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    expect(payload["eof"]).toBe(true);
    expect(payload["complete"]).toBe(false);
    expect(payload["truncation_reason"]).toBe("host lost");
  });

  it("slices by byte offset and limit, and says how to continue", () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "0123456789" });

    expect(
      durableLogsCommand({
        run: run.runId,
        node: NODE,
        offset: 2,
        limit: 3,
        json: false,
        catalogRoot: root,
      }),
    ).toBe(0);
    expect(stdout()).toBe("234");
    // The resume hint is a sentence, so it goes where sentences go.
    expect(stderr()).toContain("continue with --offset 5");
  });

  it("a partial slice is NOT eof in json, so a resuming reader knows to ask again", () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "0123456789" });

    durableLogsCommand({
      run: run.runId,
      node: NODE,
      offset: 2,
      limit: 3,
      json: true,
      catalogRoot: root,
    });
    const payload = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    expect(payload["offset"]).toBe(2);
    expect(payload["size"]).toBe(10);
    expect(payload["eof"]).toBe(false);
    expect(payload["text"]).toBe("234");
  });

  it("refuses a run the catalog does not have, on stderr, with the wait's own no-such-run exit", () => {
    const root = catalog();
    const code = durableLogsCommand({
      run: mintRunId(T0 + 500),
      node: NODE,
      json: false,
      catalogRoot: root,
    });
    // The SAME code the wait uses for the same condition: a script that reads
    // a log and then asks whether the run is gone should not have to learn
    // that the two commands disagree about what "no such run" is worth.
    expect(code).toBe(WAIT_EXITS.unknownRun);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("no run");
  });

  it("refuses an unknown node and names the run's red ones", () => {
    // The second sentence of the refusal: a caller who mistyped a node id
    // should not have to go looking for the spelling.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "boom\n" });
    finalize(run, { outcome: "failed", failed: [NODE] });

    const code = durableLogsCommand({
      run: run.runId,
      node: "ci::typo@x86_64-linux",
      json: false,
      catalogRoot: root,
    });
    expect(code).toBe(1);
    expect(stderr()).toContain("no evidence");
    expect(stderr()).toContain(NODE);
    expect(stdout()).toBe("");
  });

  it("refuses an attempt that was never recorded, listing the ones that were", () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { attempt: 1, text: "a\n" });
    recordAttempt(run, { attempt: 2, text: "b\n" });

    const code = durableLogsCommand({
      run: run.runId,
      node: NODE,
      attempt: 7,
      json: false,
      catalogRoot: root,
    });
    expect(code).toBe(1);
    expect(stderr()).toContain("no attempt 7");
    expect(stderr()).toContain("(recorded: 1, 2)");
    expect(stdout()).toBe("");
  });

  it("refuses an EXPIRED run by saying so, with the date its evidence went", () => {
    // Not "no such run". The tombstone is the difference between "you are
    // holding a bad id" and "you are holding an old one".
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "boom\n" });
    finalize(run, { outcome: "failed" });
    const expiredAt = T0 + 40 * 86_400_000;
    expect(expireRun(run.handle, expiredAt)).toBe(true);

    const code = durableLogsCommand({
      run: run.runId,
      node: NODE,
      json: false,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.unknownRun);
    expect(stderr()).toContain("expired");
    expect(stderr()).toContain(new Date(expiredAt).toISOString());
    expect(stderr()).toContain("it ended failed");
    expect(stdout()).toBe("");
  });
});

// ── odu wait --run ──────────────────────────────────────────────────────────

describe("durableWaitCommand", () => {
  it("returns 0 promptly for a run that already settled green", async () => {
    const root = catalog();
    const run = register(root);
    finalize(run, { outcome: "passed" });

    const started = Date.now();
    const code = await durableWaitCommand({
      run: run.runId,
      settle: false,
      json: false,
      deadlineMs: 5_000,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.passed);
    // A settled run is a durable fact; it must not cost a deadline to learn.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stdout()).toContain("settled");
  });

  it("returns 1 for a run that settled red", async () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "expected 1 to be 2\n" });
    finalize(run, { outcome: "failed" });

    expect(
      await durableWaitCommand({
        run: run.runId,
        settle: false,
        json: false,
        deadlineMs: 5_000,
        catalogRoot: root,
      }),
    ).toBe(WAIT_EXITS.failed);
  });

  it("returns 1 for a red node whose log is finished, before the run settles", async () => {
    // The eight-seconds-not-ninety case. The run is still going; there is
    // nonetheless something to act on, and the exit says so.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "expected 1 to be 2\n" });

    const code = await durableWaitCommand({
      run: run.runId,
      settle: false,
      json: false,
      deadlineMs: 5_000,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.failed);
    expect(stdout()).toContain(NODE);
  });

  it("returns 2 — NOT 1 — for a run that is going nowhere at the deadline", async () => {
    // The row that earns the table. Collapsing "not yet" into the failure exit
    // is how a bounded wait turns into a loop that treats a slow lane as a red
    // one.
    const root = catalog();
    const run = register(root);

    const code = await durableWaitCommand({
      run: run.runId,
      settle: false,
      json: false,
      deadlineMs: 300,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.stillRunning);
  });

  it("returns 4 for a run the catalog never had, on stderr", async () => {
    const root = catalog();
    const code = await durableWaitCommand({
      run: mintRunId(T0 + 900),
      settle: false,
      json: false,
      deadlineMs: 300,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.unknownRun);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("no run");
  });

  it("writes the whole attention payload as ONE json line, with stderr silent", async () => {
    const root = catalog();
    const run = register(root);
    finalize(run, { outcome: "passed" });

    await durableWaitCommand({
      run: run.runId,
      settle: false,
      json: true,
      deadlineMs: 5_000,
      catalogRoot: root,
    });
    expect(out).toHaveLength(1);
    const payload = JSON.parse(out[0] ?? "") as Attention;
    expect(payload.state).toBe("settled");
    expect(payload.passed).toBe(true);
    expect(payload.cursor).toContain(run.runId);
    expect(stderr()).toBe("");
  });

  it("REFUSES a cursor that belongs to another run, with exit 5", async () => {
    // The finalized-retry trap: a retry mints a NEW run, so an agent that kept
    // its cursor holds a token for the parent. Resuming it here would report
    // "nothing new" about a run that has done everything.
    const root = catalog();
    const parent = register(root, { runId: mintRunId(T0) });
    const child = register(root, { runId: mintRunId(T0 + 100_000) });

    const code = await durableWaitCommand({
      run: child.runId,
      after: formatCursor({ runId: parent.runId, seq: 1 }),
      settle: false,
      json: false,
      deadlineMs: 300,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.refused);
    expect(stdout()).toBe("");
    expect(stderr()).toContain(parent.runId);
    expect(stderr()).toContain(`resync: odu wait --run ${child.runId}`);
  });

  it("routes the same refusal through json as one line naming cursor_refused", async () => {
    const root = catalog();
    const parent = register(root, { runId: mintRunId(T0) });
    const child = register(root, { runId: mintRunId(T0 + 100_000) });

    const code = await durableWaitCommand({
      run: child.runId,
      after: formatCursor({ runId: parent.runId, seq: 1 }),
      settle: false,
      json: true,
      deadlineMs: 300,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.refused);
    expect(out).toHaveLength(1);
    const payload = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    expect(payload["error"]).toBe("cursor_refused");
    // A refusal with a ROUTE: the one moment an agent is guaranteed to be
    // confused is not the moment to hand it an error it must interpret.
    expect(payload["resync"]).toBe(`odu wait --run ${child.runId}`);
    expect(payload["run"]).toBe(child.runId);
    expect(stderr()).toBe("");
  });
});

// ── odu history ─────────────────────────────────────────────────────────────

describe("historyListCommand", () => {
  /** The checkout the command scopes itself to when `--all` is absent. */
  const here = gitTopLevel() ?? process.cwd();

  it("shows only this checkout's runs, newest first", () => {
    const root = catalog();
    const older = register(root, { runId: mintRunId(T0), repoRoot: here });
    const newer = register(root, { runId: mintRunId(T0 + 900_000), repoRoot: here });
    const elsewhere = register(root, {
      runId: mintRunId(T0 + 500_000),
      repoRoot: "/checkouts/somebody-else",
    });

    expect(historyListCommand({ json: false, all: false, catalogRoot: root })).toBe(0);
    const lines = stdout().trimEnd().split("\n");
    expect(lines[0]).toContain(newer.runId);
    expect(lines[1]).toContain(older.runId);
    expect(stdout()).not.toContain(elsewhere.runId);
  });

  it("with --all, shows the runs of every checkout the user has", () => {
    const root = catalog();
    const mine = register(root, { runId: mintRunId(T0), repoRoot: here });
    const theirs = register(root, {
      runId: mintRunId(T0 + 500_000),
      repoRoot: "/checkouts/somebody-else",
    });

    expect(historyListCommand({ json: true, all: true, catalogRoot: root })).toBe(0);
    expect(out).toHaveLength(1);
    const rows = JSON.parse(out[0] ?? "") as CatalogRow[];
    expect(rows.map((r) => r.runId).sort()).toEqual([mine.runId, theirs.runId].sort());
  });

  it("says WHERE it looked when the catalog is empty", () => {
    // "no runs" without a path is an answer a user cannot check. The catalog
    // location is configurable, so the message names the directory it read.
    const root = catalog();
    expect(historyListCommand({ json: false, all: false, catalogRoot: root })).toBe(0);
    expect(stdout()).toContain(root);
    expect(stdout()).toContain("pass --all for every checkout");
  });

  it("drops the --all hint when --all was already given", () => {
    const root = catalog();
    historyListCommand({ json: false, all: true, catalogRoot: root });
    expect(stdout()).toContain(root);
    expect(stdout()).not.toContain("pass --all");
  });
});

describe("historyShowCommand", () => {
  it("answers a settled run with the wait's exit and the wait's rendering", () => {
    // The read half of `odu wait --run`: a caller that already knows the run is
    // finished should not have to phrase its question as a wait, and must not
    // get a different answer for having asked differently.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "expected 1 to be 2\n" });
    finalize(run, { outcome: "failed" });

    const code = historyShowCommand({ run: run.runId, json: false, catalogRoot: root });
    expect(code).toBe(WAIT_EXITS.failed);
    expect(stdout()).toContain(run.runId);
    expect(stdout()).toContain("settled");
    expect(stdout()).toContain(NODE);
  });

  it("exits 0 for a settled green run", () => {
    const root = catalog();
    const run = register(root);
    finalize(run, { outcome: "passed" });
    expect(historyShowCommand({ run: run.runId, json: false, catalogRoot: root })).toBe(
      WAIT_EXITS.passed,
    );
  });

  it("exits 4 with a message for a run the catalog does not have", () => {
    const root = catalog();
    const code = historyShowCommand({
      run: mintRunId(T0 + 700),
      json: false,
      catalogRoot: root,
    });
    expect(code).toBe(WAIT_EXITS.unknownRun);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("no run");
  });

  it("emits the payload as one json line", () => {
    const root = catalog();
    const run = register(root);
    finalize(run, { outcome: "passed" });
    historyShowCommand({ run: run.runId, json: true, catalogRoot: root });
    expect(out).toHaveLength(1);
    expect((JSON.parse(out[0] ?? "") as Attention).run.id).toBe(run.runId);
  });
});

describe("historyImportCommand", () => {
  it("with --dry-run reports and writes nothing into the catalog", () => {
    const root = catalog();
    const code = historyImportCommand({ json: false, dryRun: true, catalogRoot: root });
    expect(code).toBe(0);
    expect(stdout()).toContain("would import");
    expect(stdout()).toContain(root);
    // Nothing is deleted and nothing is created: an automatic migration would
    // be a claim the old bytes cannot support.
    expect(registeredIn(root)).toEqual([]);
  });
});

describe("historyPruneCommand", () => {
  it("with --dry-run names what would go and leaves the evidence alone", () => {
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "expected 1 to be 2\n" });
    finalize(run, { outcome: "failed" });

    const code = historyPruneCommand({ json: false, dryRun: true, catalogRoot: root });
    expect(code).toBe(0);
    expect(stdout()).toContain("would expire");
    expect(stdout()).toContain(run.runId);
    // No tombstone: a dry run that expired something would be a dry run in
    // name only.
    expect(readExpiry(run.handle)).toBeNull();
    expect(
      durableLogsCommand({ run: run.runId, node: NODE, json: false, catalogRoot: root }),
    ).toBe(0);
  });

  it("keeps a run that never published a verdict, and prints the reason", () => {
    // An un-finalized run's evidence is the only account of how it ended, which
    // is exactly when it is worth most — so it is kept whatever its age, and
    // the report says which runs were kept and why. A `--dry-run` whose whole
    // promise is "this is what a real pass would do" has to explain a disk that
    // is not going to shrink.
    const root = catalog();
    const run = register(root);
    recordAttempt(run, { text: "…\n" });

    historyPruneCommand({ json: false, dryRun: true, catalogRoot: root });
    expect(stdout()).toContain("would expire 0 run(s)");
    expect(stdout()).toMatch(new RegExp(`kept ${run.runId} — \\S`));
  });
});

/** The run ids actually materialised under a catalog root. */
function registeredIn(root: string): string[] {
  return readdirSync(root).filter(isRunId);
}
