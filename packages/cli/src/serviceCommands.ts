/**
 * THE RUN COMMANDS, AS CLIENTS — `odu run`, `wait`, `rerun`, `cancel`, `logs`,
 * `history list|show|import|prune`.
 *
 * Every one of these used to hold authority of its own. `odu run` called
 * `runCommand` and WAS the coordinator. `odu rerun --run` bound
 * `packagedLauncher()` and made its own retry decision. `odu wait --run`,
 * `odu logs --run` and `odu history list` read and wrote the catalog directly.
 * `odu cancel` dialled `.ci/odu.sock`. Six commands, and between them a second
 * complete implementation of everything the shared service does — reachable
 * from a terminal, invisible to the board, and free to disagree with the
 * browser and the agent about what had just happened to a run.
 *
 * There is one authority now, and this module is how a terminal reaches it.
 * Nothing below decides anything: it resolves what the caller meant, makes one
 * call, renders the answer, and exits. The whole file is argument grammar,
 * rendering and exits, which is all a face ever was entitled to add.
 *
 * ## What a client is still allowed to know
 *
 * Two things, and both are about the CALLER rather than about a run:
 *
 *   - **which checkout the person is standing in** — `git rev-parse` in the
 *     cwd. The service addresses runs globally and takes `checkout` as an
 *     explicit absolute path precisely so that no face has to guess; resolving
 *     "here" into that path is this side's job and cannot be anywhere else.
 *   - **which commit they mean** — `HEAD`, sent as `expectedSha` so the service
 *     can REFUSE a checkout that has moved on rather than quietly running a
 *     different commit.
 *
 * Both are reads of the caller's own working directory through `git` itself.
 * Neither is run authority, and the import-boundary test (`authority.test.ts`)
 * is what keeps that distinction honest: nothing here may import the engine,
 * the catalog store, or the coordinator dial.
 *
 * ## Ctrl-C ends an OBSERVATION
 *
 * `odu run` starts a run and then watches it. Interrupting the watch stops the
 * watching: the coordinator is a detached process group of its own, its
 * evidence is in the catalog rather than in this process, and the run appears
 * on the board and in every other face exactly as it did a moment before.
 * Stopping CI is `odu cancel`, which is a different verb because it is a
 * different act.
 */

import { subscribe } from "@odu/execution/common/effectEdge";
import { progressEvent } from "@odu/execution/common/presentation";
import { exitCode } from "@odu/execution/common/verdict";
import type {
  AttentionAnswer,
  NodesFrame,
  CatalogImportReport,
  CatalogPruneReport,
  LogPage,
  OduServiceClient,
  RetryReceipt,
  RunRow,
  StartReceipt,
} from "@odu/service-client/surface";
import { ServiceRefused } from "@odu/service-client/surface";
import { logHasMore } from "@odu/service-client/surface";
import { serviceOrigin } from "@odu/service-client/endpoint";
import { verdictStateOf } from "./liveFromService";
import { printVerdict } from "./render";
import {
  call,
  checkoutHere,
  emitJson,
  emitJsonLine,
  firstFrame,
  formatAgo,
  git,
  here,
  hostsFileHere,
  nodesStream,
  readRows,
  resolveRunAddress,
  reportFailure,
  reportLost,
  reportRefusal,
  requestId,
  WAIT_EXITS,
  waitExitFor,
  watchNodes,
  withConnection,
  withService,
} from "./serviceFace";

// Re-exported because they were this module's before the plumbing was shared,
// and a caller that already names them here should not have to learn which of
// four sibling faces they moved to.
export { formatAgo, here, type Here, WAIT_EXITS, waitExitFor } from "./serviceFace";

// ── odu run ─────────────────────────────────────────────────────────────────

export interface RunOpts {
  selectors: readonly string[];
  platforms: readonly string[];
  hostPins: readonly string[];
  root?: string;
  noDeps: boolean;
  noStrict: boolean;
  noSnapshot: boolean;
  noPost: boolean;
  supersede: boolean;
  /** Park the coordinator at settle instead of tearing down, so its socket
   *  stays answerable after the verdict. */
  linger: boolean;
  /** Start it and return, rather than watching it settle. */
  noWait: boolean;
  /** Emit one NDJSON `ProgressEvent` per node transition on stdout. A FROZEN
   *  contract that `/do` and kolu's CI parse — see
   *  `@odu/execution/common/presentation`. */
  progressJson?: boolean;
  requestId?: string;
  json: boolean;
  origin?: string;
  cwd?: string;
}

/**
 * `odu run` — start a run through the service, then watch it.
 *
 * The command a person types most, and the one whose re-pointing carries the
 * whole consolidation: it no longer runs CI, it asks the service to. What it
 * still does is everything a person actually wanted from it — pick the
 * checkout, name the commit, start the work, and stay attached until there is
 * something to say.
 *
 * **Starting and observing are two acts, and the seam between them is where
 * Ctrl-C lands.** `run_start` returns a receipt with a cursor before a single
 * node has moved; everything after that is `run_wait` in a loop, feeding back
 * the cursor. Interrupting the loop leaves the run exactly where it was — which
 * is the same asymmetry `odu web` keeps, and the reason a person can close a
 * laptop without killing their CI.
 */
export async function runViaService(opts: RunOpts): Promise<number> {
  const at = here(opts.cwd);
  return withService(opts.origin, async (client) => {
    const started = await call(
      client.surface.run.start({
        checkout: at.checkout,
        expectedSha: at.sha,
        requestId: requestId(opts.requestId),
        selectors: opts.selectors,
        platforms: opts.platforms,
        hostPins: opts.hostPins,
        // THIS shell's `$ODU_HOSTS`, because this is the shell the person
        // typed in. The service is a singleton somebody else may have
        // started, and `loadHosts` runs in the coordinator it spawns — so a
        // variable that is not carried here is a variable that stopped
        // working the moment `odu run` became a client.
        // Made absolute HERE, against the caller's cwd, because that is the
        // only place the relative form has a meaning. `$ODU_HOSTS=hosts.json`
        // has always meant "in the directory I am standing in".
        //
        // ALWAYS sent, including as `""`. A terminal knows the answer either
        // way, and saying nothing would mean "use the service's own" — right
        // for an agent, wrong for the person who just unset the variable.
        hostsFile: hostsFileHere(opts.cwd),
        ...(opts.root === undefined ? {} : { root: opts.root }),
        noDeps: opts.noDeps,
        noStrict: opts.noStrict,
        noSnapshot: opts.noSnapshot,
        noPost: opts.noPost,
        supersede: opts.supersede,
        linger: opts.linger,
      }),
    );
    if (!started.ok) {
      return started.refusal === null
        ? reportLost(started.error, opts.json)
        : reportRefusal(started.refusal, opts.json);
    }
    const receipt = started.value;
    if (opts.json && opts.noWait) {
      emitJson(receipt);
      return receipt.accepted ? 0 : WAIT_EXITS.stillRunning;
    }
    const initial = await call(client.surface.run.read({ runId: receipt.runId }));
    const contentSha = initial.ok ? initial.value.contentSha : undefined;
    if (!opts.json) {
      process.stderr.write(renderStart(receipt, opts.origin));
      if (contentSha !== undefined) process.stderr.write(`odu · snapshot ${contentSha.slice(0, 7)} (${receipt.sha.slice(0, 7)} + working tree)\n`);
    }
    if (opts.noWait) return receipt.accepted ? 0 : WAIT_EXITS.stillRunning;
    if (opts.progressJson === true) {
      return progressStream(client, receipt.runId, receipt.sha.slice(0, 7), contentSha);
    }
    return observe(client, receipt.runId, receipt.cursor, opts.json);
  });
}

/** What a start says to a person: which run this is, and where to see it. */
function renderStart(receipt: StartReceipt, origin: string | undefined): string {
  const where = origin ?? serviceOrigin();
  const lines: string[] = [];
  if (!receipt.accepted && receipt.existing !== undefined) {
    // An ANSWER, not a refusal: a run is already going in this checkout, and
    // the one the caller is being pointed at is almost certainly the one they
    // wanted. Superseding it is a thing to ask for, never a thing to assume.
    lines.push(
      `odu · a run is already going in this checkout — ${receipt.existing.runId}`,
      "odu ·   watching it instead; `odu run --supersede` replaces it",
    );
  } else {
    lines.push(`odu · started ${receipt.runId}`);
  }
  lines.push(`odu · ${where}/runs/${receipt.runId}`);
  if (receipt.lifetime !== undefined) lines.push(`odu · ${receipt.lifetime}`);
  lines.push("odu · Ctrl-C stops WATCHING; the run keeps going (odu cancel stops it)");
  return `${lines.join("\n")}\n`;
}

/** Watch one run to a verdict, carrying the cursor. Bounded per call and
 *  resumed, rather than one unbounded wait: a deadline that is reached is a
 *  FACT (`still_running`), and a loop that treats it as one can report progress
 *  and be interrupted cleanly. */
async function observe(
  client: OduServiceClient,
  runId: string,
  from: string,
  json: boolean,
): Promise<number> {
  let cursor = from;
  for (;;) {
    const answered = await call(
      client.surface.run.wait({ runId, after: cursor, settle: true }),
    );
    if (!answered.ok) {
      return answered.refusal === null
        ? reportLost(answered.error, json)
        : reportRefusal(answered.refusal, json);
    }
    const answer = answered.value;
    cursor = answer.cursor;
    if (answer.reason === "still_running") continue;
    if (json) {
      emitJson(answer);
      return waitExitFor(answer);
    }
    // TWO ANSWERS, ON TWO STREAMS, because they are for two readers.
    //
    // The verdict grid on stderr is what `odu run` has always ended with: every
    // node, its status and its duration — which is the only thing that says
    // what a green actually COVERED. It came from the coordinator's own face
    // and was lost when the coordinator became a detached process writing to a
    // log nobody reads.
    //
    // The attention block on stdout is what this command gained: the run id
    // (the address every other verb now takes) and, per failure, the host, the
    // attempt and the log key to read next.
    await verdictOf(client, runId, answer.sha, answer.contentSha);
    process.stdout.write(renderAttention(answer));
    return waitExitFor(answer);
  }
}

/**
 * Print the run's verdict grid, from one read of its final frame.
 *
 * A read rather than a fold of what `observe` already saw: `run.wait` answers
 * about ATTENTION — what a caller must act on — and deliberately carries only
 * the failures. The grid is about every node, including the ones that went
 * green, which is the half a person needs to know what the green covered.
 *
 * Best-effort. A verdict that cannot be drawn must not change the exit code of
 * the run it is describing.
 */
async function verdictOf(
  client: OduServiceClient,
  runId: string,
  sha: string | null,
  contentSha?: string,
): Promise<void> {
  const sha7 = sha === null ? "" : sha.slice(0, 7);
  if (contentSha !== undefined) process.stderr.write(`odu · snapshot ${contentSha.slice(0, 7)} (${sha7} + working tree)\n`);
  const frame = await firstFrame(nodesStream(client, runId));
  if (frame === undefined) return;
  printVerdict({
    state: verdictStateOf(frame, sha7),
    sha7,
    dirty: false,
    commitUrl: frame.env.commitUrl,
    unpostedCount: frame.env.owed.length,
  });
}

// ── odu wait ────────────────────────────────────────────────────────────────

export interface WaitOpts {
  run: string;
  after?: string;
  deadlineMs?: number;
  /** Refuse unless the run is about this commit. The guard `odu wait` has
   *  always had: a script that waited on "the run here" after a rebase was
   *  waiting on the wrong commit and could not tell. */
  expectedSha?: string;
  settle: boolean;
  json: boolean;
  origin?: string;  /** Where the caller is standing — the checkout `--run latest` is about. */
  cwd?: string;
}

export async function waitViaService(opts: WaitOpts): Promise<number> {
  return withConnection(opts.origin, async ({ client, dispatch }) => {
    const resolved = await resolveRunAddress(
      dispatch,
      opts.run,
      opts.cwd ?? process.cwd(),
      opts.json,
    );
    if (!resolved.ok) return resolved.exit;
    const runId = resolved.runId;
    const answered = await call(
      client.surface.run.wait({
        runId,
        ...(opts.after === undefined ? {} : { after: opts.after }),
        ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
        settle: opts.settle,
      }),
    );
    if (!answered.ok) {
      return answered.refusal === null
        ? reportLost(answered.error, opts.json)
        : reportRefusal(answered.refusal, opts.json);
    }
    // THE COMMIT GUARD, checked here because only here are both halves known:
    // the caller's claim about which commit it is waiting on, and the run's
    // own. A script that waited on "the run in this checkout" across a rebase
    // was waiting on the previous commit's run and had no way to tell.
    const answer = answered.value;
    if (
      opts.expectedSha !== undefined &&
      answer.sha !== null &&
      !answer.sha.startsWith(opts.expectedSha)
    ) {
      return reportRefusal(
        new ServiceRefused({
          code: "checkout_refused",
          message:
            `odu: run ${answer.runId} is about ${answer.sha.slice(0, 7)}, not ` +
            `${opts.expectedSha} — --expected-sha refuses rather than report a ` +
            "verdict about a different commit",
          runId: answer.runId,
        }),
        opts.json,
      );
    }
    // WHERE STDOUT POINTS PICKS THE MEDIUM — odu's own rule, and the reason
    // `odu wait` is not free to be prose by default. It wrote one JSON object
    // on stdout unconditionally before this rewrite, and it is the command
    // scripts and agents parse; making that opt-in silently fed them a
    // paragraph. A person at a terminal still gets the readable block, because
    // for them it is the better answer and no script is watching.
    if (opts.json || process.stdout.isTTY !== true) emitJson(answer);
    else process.stdout.write(renderAttention(answer));
    return waitExitFor(answer);
  });
}

/** The human rendering of an attention answer. Deliberately short: the failures
 *  and how to read more, not a transcript. Someone who wants the transcript has
 *  `--after` and `-o json`. */
export function renderAttention(a: AttentionAnswer): string {
  const lines: string[] = [];
  const sha7 = a.sha === null ? "" : `  ${a.sha.slice(0, 7)}${a.contentSha === undefined ? "" : `+dirty→${a.contentSha.slice(0, 7)}`}`;
  // The run's own word, not a re-derivation of it: `passed: false` covers a red
  // run AND one that never finished, and telling an operator "failed" for the
  // second sends them looking for a broken test that does not exist.
  lines.push(
    `${a.runId}${sha7}  ${a.reason}${a.outcome === null ? "" : ` · ${a.outcome}`}`,
  );
  for (const f of a.failures) {
    const where = f.host === null ? f.platform : `${f.platform} on ${f.host}`;
    const how =
      f.signal !== null ? `${f.signal} (exit ${f.exitCode})` : `exit ${f.exitCode ?? "?"}`;
    lines.push(`  ✗ ${f.node}  attempt ${f.attempt}  ${how}  ${where}`);
    if (!f.logComplete) {
      lines.push("      log INCOMPLETE — its producer never said it was finished");
    }
    for (const line of f.excerpt.split("\n").slice(-8)) {
      if (line.trim() !== "") lines.push(`      ${line}`);
    }
    lines.push(`      odu logs ${f.logKey}`);
  }
  if (a.failuresOmitted > 0) {
    lines.push(`  (${a.failuresOmitted} more failures not shown — raise --limit)`);
  }
  for (const debt of a.reportingDebt) {
    lines.push(`  ⇐ github? ${debt.context} — ${debt.lastError}`);
  }
  if (a.unreadableEvents > 0) {
    lines.push(`  (${a.unreadableEvents} journal events this build could not read)`);
  }
  lines.push(`  cursor ${a.cursor}${a.hasMore ? ` (+${a.remaining} more)` : ""}`);
  return `${lines.join("\n")}\n`;
}

// ── odu rerun ───────────────────────────────────────────────────────────────

export interface RetryOpts {
  run: string;
  selector: string;
  requestId?: string;
  expectAttempt?: { node: string; attempt: number };
  json: boolean;
  origin?: string;  /** Where the caller is standing — the checkout `--run latest` is about. */
  cwd?: string;
}

/**
 * `odu rerun` — retry, and let odu decide what retrying means.
 *
 * The policy is the service's, and the caller does not choose it: a coordinator
 * still up gets a new attempt on the same run, one that is gone gets a fresh
 * linked replay. Which applies is a fact about the run, and a caller that chose
 * would choose wrongly — so `mode` is on the receipt and `effectiveRun` is what
 * to watch next.
 */
export async function retryViaService(opts: RetryOpts): Promise<number> {
  return withConnection(opts.origin, async ({ client, dispatch }) => {
    const resolved = await resolveRunAddress(
      dispatch,
      opts.run,
      opts.cwd ?? process.cwd(),
      opts.json,
    );
    if (!resolved.ok) return resolved.exit;
    const runId = resolved.runId;
    const done = await call(
      client.surface.run.retry({
        runId,
        selector: opts.selector,
        requestId: requestId(opts.requestId),
        ...(opts.expectAttempt === undefined
          ? {}
          : { expectAttempt: opts.expectAttempt }),
      }),
    );
    if (!done.ok) {
      return done.refusal === null
        ? reportLost(done.error, opts.json)
        : reportRefusal(done.refusal, opts.json);
    }
    if (opts.json) emitJson(done.value);
    else process.stdout.write(renderRetry(done.value));
    return 0;
  });
}

export function renderRetry(r: RetryReceipt): string {
  const lines: string[] = [];
  lines.push(
    r.mode === "live"
      ? `${r.effectiveRun}  new attempt on the live run`
      : `${r.effectiveRun}  replaying ${r.parentRun ?? "?"} as a new run`,
  );
  if (r.replayed) {
    lines.push("  (replayed — this request id had already been answered)");
  }
  for (const a of r.attempts) lines.push(`  ↻ ${a.node}  attempt ${a.attempt}`);
  if (r.resetDependants.length > 0) {
    lines.push(`  resets ${r.resetDependants.join(", ")}`);
  }
  lines.push(`  cursor ${r.cursor}`);
  return `${lines.join("\n")}\n`;
}

// ── odu cancel ──────────────────────────────────────────────────────────────

export interface CancelOpts {
  run: string;
  scope: { kind: "run" } | { kind: "node"; node: string } | { kind: "lane"; platform: string };
  requestId?: string;
  json: boolean;
  origin?: string;  /** Where the caller is standing — the checkout `--run latest` is about. */
  cwd?: string;
}

export async function cancelViaService(opts: CancelOpts): Promise<number> {
  return withConnection(opts.origin, async ({ client, dispatch }) => {
    const resolved = await resolveRunAddress(
      dispatch,
      opts.run,
      opts.cwd ?? process.cwd(),
      opts.json,
    );
    if (!resolved.ok) return resolved.exit;
    const runId = resolved.runId;
    const done = await call(
      client.surface.run.cancel({
        runId,
        scope: opts.scope,
        requestId: requestId(opts.requestId),
      }),
    );
    if (!done.ok) {
      return done.refusal === null
        ? reportLost(done.error, opts.json)
        : reportRefusal(done.refusal, opts.json);
    }
    const result = done.value;
    if (opts.json) {
      emitJson(result);
    } else {
      // `effective: "nothing"` is an ANSWER with a reason, never a cheerful ok:
      // a caller asking to cancel a lane on a run whose coordinator has already
      // gone is entitled to know nothing happened.
      // The sentence `odu cancel` has always printed, with the run named. It
      // read "odu: run cancelled" before this command was addressed by run id;
      // the id is genuinely new information and the words around it are not
      // this rewrite's to change, since a script grepping them is a script that
      // was working.
      process.stdout.write(
        result.effective === "nothing"
          ? `odu: nothing cancelled on ${result.runId} — ${result.detail ?? "no reason given"}\n`
          : `odu: run cancelled — ${result.runId} (${result.effective})\n`,
      );
    }
    // Exit 0 either way: the CALL was answered. "Nothing was cancelled because
    // the run had already finished" is not a failure of the request.
    return 0;
  });
}

// ── odu logs ────────────────────────────────────────────────────────────────

export interface LogsOpts {
  key: string;
  offset?: number;
  limit?: number;
  /** Keep reading until the log can grow no further. */
  follow?: boolean;
  /** How long one followed read may wait for growth before answering empty. */
  waitMs?: number;
  json: boolean;
  origin?: string;
}

/** The follow's per-call deadline, matching `run.wait`'s. Deliberately not
 *  longer: a followed read holds an HTTP request open on the `/mcp` door for
 *  its whole duration, exactly as `run_wait` already does, and a proxy with a
 *  shorter idle timeout cuts anything that outlasts it. Bounded and re-issued
 *  beats one long call, which is the same shape the attention loop settled on. */
export const FOLLOW_WAIT_MS = 30_000;

/**
 * `odu logs <key>` — one attempt's bytes, addressed by the key a failure
 * handed you.
 *
 * The key is ECHOED, never reassembled: `run/node/attempt` is a shape this face
 * has no business knowing, and a caller that rebuilt it would be a second
 * spelling of an address the service already published.
 */
export async function logsViaService(opts: LogsOpts): Promise<number> {
  if (opts.follow === true) {
    return withService(opts.origin, (client) => followLog(client, opts));
  }
  return withService(opts.origin, async (client) => {
    const read = await call(
      client.surface.log.read({
        key: opts.key,
        ...(opts.offset === undefined ? {} : { offset: opts.offset }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      }),
    );
    if (!read.ok) {
      return read.refusal === null
        ? reportLost(read.error, opts.json)
        : reportRefusal(read.refusal, opts.json);
    }
    const page: LogPage = read.value;
    if (opts.json) {
      emitJson(page);
      return 0;
    }
    process.stdout.write(page.text);
    // Distinct from `eof`, which is only about this read: a log that is
    // complete-false and has been read to its end is a TRUNCATED log, and
    // saying so is the difference between "the recipe was quiet" and "the
    // evidence is gone".
    if (page.eof && !page.complete) {
      process.stderr.write(
        "\nodu: this log never got its producer's last word — it is truncated\n",
      );
    }
    if (!page.eof) {
      process.stderr.write(
        `\nodu: more at --offset ${page.nextOffset} (of ${page.size} bytes)\n`,
      );
    }
    return 0;
  });
}

// ── odu history list ────────────────────────────────────────────────────────

export interface ListOpts {
  /** Every run this user has, rather than the ones from this checkout. */
  all: boolean;
  limit?: number;
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function listViaService(opts: ListOpts): Promise<number> {
  // The checkout filter is resolved HERE because "this checkout" is a fact
  // about the caller. A run row carries its own `repoRoot`, so the service does
  // not need to be told where anybody is standing.
  const mine = opts.all
    ? null
    : git(["rev-parse", "--show-toplevel"], opts.cwd ?? process.cwd());
  return withConnection(opts.origin, async (connection) => {
    const all = await readRows(connection.dispatch);
    const rows = all.filter((r) => mine === null || r.repoRoot === mine);
    const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
    const shown = opts.limit === undefined ? sorted : sorted.slice(0, opts.limit);
    if (opts.json) {
      emitJson(shown);
      return 0;
    }
    process.stdout.write(renderRows(shown, Date.now()));
    return 0;
  });
}

export function renderRows(rows: readonly RunRow[], now: number): string {
  if (rows.length === 0) return "no runs\n";
  const lines = rows.map((r) => {
    const ref = r.seq === null ? r.sha.slice(0, 7) : `${r.sha.slice(0, 7)}#${r.seq}`;
    const verdict =
      r.state === "settled" ? (r.outcome ?? (r.passed ? "passed" : "failed")) : r.state;
    const debt = r.reportingDebt > 0 ? `  ⇐${r.reportingDebt}` : "";
    return `${r.runId}  ${ref}${r.dirty ? "+dirty" : ""}${r.contentSha === undefined ? "" : `→${r.contentSha.slice(0, 7)}`}  ${r.branch ?? "-"}  ${verdict}  ${formatAgo(now - r.createdAt)} ago${debt}`;
  });
  return `${lines.join("\n")}\n`;
}

// ── odu history show ────────────────────────────────────────────────────────

export interface ShowOpts {
  run: string;
  after?: string;
  json: boolean;
  origin?: string;  /** Where the caller is standing — the checkout `--run latest` is about. */
  cwd?: string;
}

/**
 * `odu history show --run R` — one run's attention payload, without waiting.
 *
 * The same answer `odu wait` gives, asked of a run that may have finished last
 * week. It used to open the catalog in the caller's own process — `resolveRun`,
 * `resolveCursor`, `readAttention` — which put a second reader beside the
 * daemon that was reading and writing the same directories, and made "what does
 * this run's evidence say" a question with two implementations that could
 * disagree about a run mid-write.
 *
 * `run.read` and `run.wait` return the IDENTICAL payload, deliberately: "what
 * is this run's state" has one answer, and a second shape for the non-blocking
 * case would be a second thing to keep true. The only difference is whether the
 * service holds the call open.
 */
export async function showViaService(opts: ShowOpts): Promise<number> {
  return withConnection(opts.origin, async ({ client, dispatch }) => {
    const resolved = await resolveRunAddress(
      dispatch,
      opts.run,
      opts.cwd ?? process.cwd(),
      opts.json,
    );
    if (!resolved.ok) return resolved.exit;
    const runId = resolved.runId;
    const answered = await call(
      client.surface.run.read({
        runId,
        ...(opts.after === undefined ? {} : { after: opts.after }),
      }),
    );
    if (!answered.ok) return reportFailure(answered, opts.json);
    const answer = answered.value;
    if (opts.json) emitJson(answer);
    else process.stdout.write(renderAttention(answer));
    return waitExitFor(answer);
  });
}

// ── odu history import / prune ──────────────────────────────────────────────

export interface ImportOpts {
  dryRun: boolean;
  json: boolean;
  origin?: string;
  cwd?: string;
}

/**
 * `odu history import` — bring this checkout's legacy `.ci` records into the
 * catalog.
 *
 * Through the service because the catalog is the SERVICE's store. Importing
 * from the caller's process meant two writers on one set of directories, and
 * the fact that it mostly worked is not the same as it being safe: a record
 * being written while the daemon walked the same tree is a race with no owner.
 *
 * The checkout is resolved here and sent as an absolute path — the same rule
 * `run.start` keeps, and for the same reason: an agent's cwd is not a fact
 * about what anybody meant.
 */
export async function importViaService(opts: ImportOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.catalog.import({
        checkout,
        dryRun: opts.dryRun,
        requestId: requestId(undefined),
      }),
    );
    if (!done.ok) return reportFailure(done, opts.json);
    const report: CatalogImportReport = done.value;
    if (opts.json) {
      emitJson(report);
      return 0;
    }
    process.stdout.write(renderImport(report));
    return 0;
  });
}

function renderImport(report: CatalogImportReport): string {
  const lines: string[] = [];
  for (const row of report.imported) lines.push(`imported  ${row.ref}  ${row.runId}`);
  // A SKIP IS AN OUTCOME. A record already in the catalog and one that could
  // not be read are both "not imported", and only the second is a problem —
  // reporting them together as a count is how the second goes unnoticed.
  for (const row of report.skipped) {
    lines.push(`skipped   ${row.ref}  ${row.reason ?? "already in the catalog"}`);
  }
  if (lines.length === 0) lines.push("nothing to import");
  lines.push(
    report.dryRun
      ? `(dry run — nothing was written to ${report.catalog})`
      : `into ${report.catalog}`,
  );
  return `${lines.join("\n")}\n`;
}

export interface PruneOpts {
  retentionDays?: number;
  dryRun: boolean;
  json: boolean;
  origin?: string;
}

/** `odu history prune` — expire finished runs past the retention window. */
export async function pruneViaService(opts: PruneOpts): Promise<number> {
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.catalog.prune({
        ...(opts.retentionDays === undefined
          ? {}
          : { retentionDays: opts.retentionDays }),
        dryRun: opts.dryRun,
        requestId: requestId(undefined),
      }),
    );
    if (!done.ok) return reportFailure(done, opts.json);
    const report: CatalogPruneReport = done.value;
    if (opts.json) {
      emitJson(report);
      return 0;
    }
    process.stdout.write(renderPrune(report));
    return 0;
  });
}

function renderPrune(report: CatalogPruneReport): string {
  const lines = report.expired.map((runId) => `expired  ${runId}`);
  // Why a run SURVIVED is the useful half of a prune's output: "still inside
  // the window" and "its coordinator is still running" call for different
  // reactions, and a bare count of what went says neither.
  for (const kept of report.kept) lines.push(`kept     ${kept.runId}  ${kept.reason}`);
  if (lines.length === 0) lines.push("nothing to prune");
  lines.push(
    `${report.dryRun ? "(dry run) " : ""}retention: ${report.retentionDays}d`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * `odu logs <key> --follow` — every byte, until there can be no more.
 *
 * **The cursor is the caller's, and that is the design.** Each call asks for
 * bytes at an offset and answers with `nextOffset`; nothing on the service side
 * remembers this follower. So a follow that dies — the daemon restarted, the
 * laptop slept, the process was killed — is RESUMED by re-issuing with the
 * offset it reached, rather than by a server-side session that has to be
 * garbage-collected and can be lost anyway. That is why this is a loop over a
 * paged read rather than a subscription.
 *
 * It stops on `open: false`, which is a fact the page carries rather than one
 * inferred from `eof` and `complete`. The case that forces it: a writer that
 * was KILLED leaves a log which is at EOF, not complete, and will never grow —
 * indistinguishable, from those two fields alone, from a slow recipe. A
 * follower that guessed would hang on precisely the run somebody is waiting to
 * hear about.
 *
 * Split from the dial so it can be tested with a scripted client: the loop is
 * what has a contract, and a contract wants a test that can end the feed on
 * purpose.
 */
export async function followLog(
  client: Pick<OduServiceClient, "surface">,
  opts: Pick<LogsOpts, "key" | "offset" | "limit" | "waitMs" | "json">,
): Promise<number> {
  // Negative only on the FIRST call — `--offset=-4096` means "start from the
  // last 4 KiB". After that the cursor is an absolute position, because
  // `nextOffset` always is.
  let cursor = opts.offset;
  let resynced = false;
  for (;;) {
    const read = await call(
      client.surface.log.read({
        key: opts.key,
        ...(cursor === undefined ? {} : { offset: cursor }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        waitMs: opts.waitMs ?? FOLLOW_WAIT_MS,
      }),
    );
    // A DEAD LINK MID-FOLLOW IS NOT A COMPLETE LOG. Exiting 0 here would hand
    // back a log that stops mid-line as though it were whole, which is the one
    // forbidden outcome this repo already spent two issues on.
    if (!read.ok) return reportFailure(read, opts.json);
    const page = read.value;

    // THE ATTEMPT WAS RE-RUN UNDER US. A rerun rewrites an attempt's log in
    // place, so the file can be SHORTER than the cursor we hold; the read
    // clamps, and `offset < what we asked for` is the only signal of it. Said
    // out loud exactly once, then restarted from the beginning — silently
    // resuming would print the tail of a different attempt as a continuation of
    // this one.
    if (cursor !== undefined && cursor > 0 && page.offset < cursor) {
      if (!resynced) {
        process.stderr.write(
          `\nodu: this attempt was re-run and its log rewritten (${page.size} ` +
            `bytes now, you were at ${cursor}) — following from the start\n`,
        );
        resynced = true;
      }
      cursor = 0;
      continue;
    }

    if (opts.json) {
      // One complete page per LINE — `emitJsonLine`, not `emitJson`. The
      // pretty-printer spans many lines per page, so an agent reading this
      // stream line by line got fragments that do not parse, from a branch
      // whose whole promise is NDJSON.
      if (page.text !== "" || !page.open) emitJsonLine(page);
    } else if (page.text !== "") {
      process.stdout.write(page.text);
    }
    cursor = page.nextOffset;

    // KEEP GOING while there is more to come OR more already there. A page is
    // bounded by `limit` (12 KiB by default), so a log that is ALREADY closed
    // comes back `eof: false, open: false` on its first page — and stopping on
    // `open` alone printed those twelve kilobytes and exited 0, silently
    // dropping the rest of a fifty-kilobyte failure while the usage text
    // promised "the whole log". The same loss hit a live follow the moment its
    // run finalized: the page that first reports `open: false` is also the one
    // carrying unread bytes.
    //
    // This cannot spin. With `offset < size` and a positive limit the store
    // always returns at least one byte, so `nextOffset` strictly advances until
    // `eof` — and once `eof` is true with `open` false, the loop ends below.
    if (logHasMore(page)) continue;
    // Closed, and drained. `complete` is what says whether we have the whole
    // thing.
    if (!page.complete) {
      process.stderr.write(
        "\nodu: this log never got its producer's last word — it is truncated\n",
      );
      return 1;
    }
    return 0;
  }
}

/**
 * `odu run --progress json` — one NDJSON line per node transition.
 *
 * A FROZEN contract: `/do` and kolu's CI parse these bytes, and
 * `@odu/execution/common/presentation` owns the projection so this face and the
 * coordinator's own emit byte-identical events rather than each hand-rolling
 * one. That shared projection is the fix for juspay/odu#4 and it is not going to
 * be re-derived here.
 *
 * **It was lost, and losing it was the sharpest regression in this whole
 * change.** `--progress json` used to be the coordinator's flag, because
 * `odu run` WAS the coordinator; when the public verb became a service client
 * the flag went with the coordinator to `run-coordinator` and nothing put it
 * back. `parseArgs` throws on an unknown option, so every caller passing it —
 * which is every e2e test that drives a run, plus every consumer — got an
 * immediate exit 1 and no output at all. The failure did not read as "that flag
 * is gone": on one platform it read as four assertion failures about missing
 * events, and on another as a ten-minute timeout waiting for a socket that was
 * never going to be served.
 *
 * The events come off `streams.nodes` now rather than the coordinator's own
 * face, which is what makes them available to a client at all — and means a
 * second `odu run --progress json` watching the same run sees the same stream.
 */
async function progressStream(
  client: Pick<OduServiceClient, "surface">,
  runId: string,
  sha7: string,
  contentSha?: string,
): Promise<number> {
  // Only TRANSITIONS are events. A frame arrives whenever anything moved,
  // including a lane landing on a box, so emitting per frame would repeat a
  // node's line for a reason the contract has no word for.
  const seen = new Map<string, string>();
  // `watchNodes` re-subscribes if the stream ends without a verdict, and the
  // dedupe above is what makes that free: a fresh subscription opens with a
  // snapshot, and a node whose status this has already reported emits nothing.
  const final = await watchNodes(client, runId, (frame) => {
    for (const node of frame.nodes) {
      if (seen.get(node.id) === node.status) continue;
      seen.set(node.id, node.status);
      const event = progressEvent(sha7, node.id, {
        id: node.id,
        name: node.id,
        command: "",
        needs: [],
        status: node.status,
        exitCode: node.exitCode,
        startedAt: node.startedAt,
        durationMs: node.durationMs,
      });
      // `null` for a status that emits nothing — `pending`, whose progress
      // mapping is deliberately absent. The caller skips it; it is not a gap.
      if (event !== null) process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  });
  if (final === undefined) return 3;
  if (contentSha !== undefined) process.stderr.write(`odu · snapshot ${contentSha.slice(0, 7)} (${sha7} + working tree)\n`);
  // THE VERDICT BLOCK, on stderr, after the NDJSON. Both halves of the
  // `--progress json` contract: the stream is the machine's and the summary is
  // the person's, and a pipeline that emits the first without the second gives
  // whoever is watching the terminal a wall of JSON and no answer. It used to
  // come from the coordinator's own face; the coordinator is detached now and
  // writes to a log nobody is reading, so the client prints it — the same
  // `printVerdict`, from the same state.
  printVerdict({
    state: verdictStateOf(final, sha7),
    sha7,
    dirty: false,
    commitUrl: final.env.commitUrl,
    unpostedCount: final.env.owed.length,
  });
  if (final.state === "owner_lost") return WAIT_EXITS.ownerLost;
  if (!final.done) return WAIT_EXITS.stillRunning;
  // INCOMPLETE IS NOT A PASS, and "no red node" cannot see the difference: a
  // CANCELLED node is not red, so a run whose only lane was cancelled reported
  // success. `exitCode` is the rule this command shipped with — done and not
  // clean is 1 — and it is the same fold the verdict block above just printed,
  // so the number and the summary cannot disagree.
  return exitCode(verdictStateOf(final, sha7));
}
