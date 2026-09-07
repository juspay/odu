/**
 * THE PUBLIC COMMANDS, AS CLIENTS — `odu run`, `wait`, `rerun`, `cancel`,
 * `logs`, `history list`.
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

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AttentionAnswer,
  LogPage,
  OduServiceClient,
  RetryReceipt,
  RunRow,
  StartReceipt,
} from "@odu/service-client/surface";
import { ServiceRefused } from "@odu/service-client/surface";
import { serviceOrigin } from "@odu/service-client/endpoint";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { oduServiceSurface } from "@odu/service-client/surface";
import { Effect } from "effect";
import { connectOrStart } from "./webLauncher";

// ── exits ───────────────────────────────────────────────────────────────────

/**
 * What a command that answers a question about CI exits with.
 *
 * Unchanged from the durable faces these replace, and deliberately so: the
 * table is a published contract that scripts branch on, and re-pointing a
 * command at a different authority is not a reason to renumber what its answer
 * means. `odu surface`'s exits are DIFFERENT and also unchanged — that face
 * answers a question about a CALL, so it spends its codes on the call.
 *
 * | exit | meaning | what to do next |
 * | --- | --- | --- |
 * | 0 | settled, and it passed | nothing |
 * | 1 | there is a failure to act on | read the failures, fix, retry |
 * | 2 | still going, nothing red yet | ask again with the returned cursor |
 * | 3 | its coordinator is gone and it never finalized | start a new run |
 * | 4 | no such run, or its evidence expired | check `odu history list` |
 * | 5 | the request itself was refused | read the refusal; resync if offered |
 */
export const WAIT_EXITS = {
  passed: 0,
  failed: 1,
  stillRunning: 2,
  ownerLost: 3,
  unknownRun: 4,
  refused: 5,
} as const;

/** Which exit a refusal earns. `unknown_run` and `expired` are facts about the
 *  RUN and keep the run-shaped exit a caller already branches on; everything
 *  else is a fact about the REQUEST. */
function refusalExit(code: string): number {
  return code === "unknown_run" || code === "expired"
    ? WAIT_EXITS.unknownRun
    : WAIT_EXITS.refused;
}

/** The one place an answer about attention becomes an exit, so every face that
 *  reports one reports the same number for the same state. */
export function waitExitFor(answer: AttentionAnswer): number {
  if (answer.settled) return answer.passed ? WAIT_EXITS.passed : WAIT_EXITS.failed;
  // A red node is a failure whether or not the slow lanes have finished — the
  // run cannot pass from here. Reporting it as "still running" would be true
  // and useless: the caller has something to act on, and the exit is how it
  // finds that out without parsing the payload.
  if (answer.failures.length > 0 || answer.actionable) return WAIT_EXITS.failed;
  if (answer.reason === "owner_lost") return WAIT_EXITS.ownerLost;
  return WAIT_EXITS.stillRunning;
}

// ── the connection ──────────────────────────────────────────────────────────

/** Do one thing with the service and let go.
 *
 *  `dispose` is not bookkeeping: the link holds the dial, ping and response
 *  fibers, and a command that dropped it would be a process that never exits. */
async function withService<T>(
  origin: string | undefined,
  use: (client: OduServiceClient) => Promise<T>,
): Promise<T> {
  const connection = await connectOrStart(origin ?? serviceOrigin());
  try {
    return await use(connection.client);
  } finally {
    await connection.dispose();
  }
}

/**
 * Run one procedure, keeping THREE outcomes apart.
 *
 * A procedure's declared error channel is `ServiceRefused`, but the wire adds
 * its own arm: a call can also fail because the link died under it. Those are
 * different facts and a caller must not act on them the same way — a refusal is
 * odu declining, with a code to branch on and often a recovery; a transport
 * failure is the service going away mid-call, which says nothing about the run
 * and leaves the mutation's outcome unknown.
 *
 * Collapsing the second into the first is how "the daemon was upgraded while I
 * was waiting" gets reported as "odu refused your request".
 */
async function call<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<
  | { ok: true; value: A }
  | { ok: false; refusal: ServiceRefused }
  | { ok: false; refusal: null; error: unknown }
> {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Success") return { ok: true, value: outcome.success };
  const failure = outcome.failure;
  return isRefusal(failure)
    ? { ok: false, refusal: failure }
    : { ok: false, refusal: null, error: failure };
}

/** Is this the service declining, or the wire dying? `_tag` is the schema's own
 *  discriminator, checked rather than assumed: anything else on this channel is
 *  a transport failure wearing whatever shape the link gave it. */
function isRefusal(value: unknown): value is ServiceRefused {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "ServiceRefused"
  );
}

/** What a transport failure exits with, and what it says. Exit 3 is the
 *  documented "nothing serving" code and it is the honest one here: whatever
 *  was serving is not serving this call. */
function reportLost(error: unknown, json: boolean): number {
  const message =
    `odu: the service went away mid-call — ${String(
      (error as { message?: unknown }).message ?? error,
    )}. Whether it acted is not known; re-issue with the SAME request id to ` +
    "find out rather than a fresh one.";
  if (json) emitJson({ error: "transport_lost", message });
  else process.stderr.write(`${message}\n`);
  return 3;
}

/** Report a refusal the way its own shape asks to be reported, and exit. */
function reportRefusal(refusal: ServiceRefused, json: boolean): number {
  if (json) {
    emitJson({
      error: refusal.code,
      message: refusal.message,
      ...(refusal.resync === undefined ? {} : { resync: refusal.resync }),
      ...(refusal.suggestion === undefined
        ? {}
        : { suggestion: refusal.suggestion }),
      ...(refusal.runId === undefined ? {} : { run: refusal.runId }),
    });
  } else {
    process.stderr.write(`${refusal.message}\n`);
    // A refusal with a ROUTE. A cursor that cannot be honoured is the one
    // moment a caller is guaranteed to be confused, and "resync with this exact
    // command" beats an error it has to interpret.
    if (refusal.resync !== undefined) {
      process.stderr.write(`  resync: ${refusal.resync}\n`);
    }
    if (refusal.suggestion !== undefined) {
      process.stderr.write(`  try: ${refusal.suggestion.join(" ")}\n`);
    }
  }
  return refusalExit(refusal.code);
}

/** One complete JSON value, one write, nothing else on stdout. An agent piping
 *  `-o json` through a shell gets a parseable line without `stdbuf`, and that
 *  is a property of where the bytes go rather than of the terminal. */
function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ── what the caller meant ───────────────────────────────────────────────────

/** The checkout the caller is standing in, and the commit it is on. A read of
 *  the caller's own cwd through git — see the module header on why this, and
 *  only this, stays on the client's side. */
export interface Here {
  checkout: string;
  sha: string;
}

function git(args: string[], cwd: string): string | null {
  const out = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return out.status === 0 ? out.stdout.trim() : null;
}

export function here(cwd: string = process.cwd()): Here {
  const checkout = git(["rev-parse", "--show-toplevel"], cwd);
  if (checkout === null) {
    throw new Error(`odu: ${cwd} is not inside a git repository`);
  }
  const sha = git(["rev-parse", "HEAD"], checkout);
  if (sha === null) {
    throw new Error(
      `odu: ${checkout} has no commit yet — odu runs a commit, so there has ` +
        "to be one",
    );
  }
  return { checkout, sha };
}

/**
 * A request id, when the caller did not bring one.
 *
 * Mandatory on every mutation, because a lost reply must be answerable: repeat
 * the SAME id and the service replays the receipt it already wrote. A caller
 * that lets us mint one gets exactly-once for the call it is making now and
 * nothing more — which is right for a person at a terminal, who will look at
 * the board if a command dies mid-flight. An agent brings its own.
 */
function requestId(given: string | undefined): string {
  return given ?? `cli-${randomUUID()}`;
}

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
  /** Start it and return, rather than watching it settle. */
  noWait: boolean;
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
        ...(opts.root === undefined ? {} : { root: opts.root }),
        noDeps: opts.noDeps,
        noStrict: opts.noStrict,
        noSnapshot: opts.noSnapshot,
        noPost: opts.noPost,
        supersede: opts.supersede,
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
    if (!opts.json) process.stderr.write(renderStart(receipt, opts.origin));
    if (opts.noWait) return receipt.accepted ? 0 : WAIT_EXITS.stillRunning;
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
    if (json) emitJson(answer);
    else process.stdout.write(renderAttention(answer));
    return waitExitFor(answer);
  }
}

// ── odu wait ────────────────────────────────────────────────────────────────

export interface WaitOpts {
  run: string;
  after?: string;
  deadlineMs?: number;
  settle: boolean;
  json: boolean;
  origin?: string;
}

export async function waitViaService(opts: WaitOpts): Promise<number> {
  return withService(opts.origin, async (client) => {
    const answered = await call(
      client.surface.run.wait({
        runId: opts.run,
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
    if (opts.json) emitJson(answered.value);
    else process.stdout.write(renderAttention(answered.value));
    return waitExitFor(answered.value);
  });
}

/** The human rendering of an attention answer. Deliberately short: the failures
 *  and how to read more, not a transcript. Someone who wants the transcript has
 *  `--after` and `-o json`. */
export function renderAttention(a: AttentionAnswer): string {
  const lines: string[] = [];
  const sha7 = a.sha === null ? "" : `  ${a.sha.slice(0, 7)}`;
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
  origin?: string;
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
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.run.retry({
        runId: opts.run,
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
  origin?: string;
}

export async function cancelViaService(opts: CancelOpts): Promise<number> {
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.run.cancel({
        runId: opts.run,
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
      process.stdout.write(
        result.effective === "nothing"
          ? `${result.runId}  nothing cancelled — ${result.detail ?? "no reason given"}\n`
          : `${result.runId}  cancelled (${result.effective})\n`,
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
  json: boolean;
  origin?: string;
}

/**
 * `odu logs <key>` — one attempt's bytes, addressed by the key a failure
 * handed you.
 *
 * The key is ECHOED, never reassembled: `run/node/attempt` is a shape this face
 * has no business knowing, and a caller that rebuilt it would be a second
 * spelling of an address the service already published.
 */
export async function logsViaService(opts: LogsOpts): Promise<number> {
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
  const connection = await connectOrStart(opts.origin ?? serviceOrigin());
  try {
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
  } finally {
    await connection.dispose();
  }
}

/**
 * The board, read off the `runs` COLLECTION.
 *
 * Through the structural face rather than the typed one, and that is the
 * framework's own shape rather than a workaround: `SurfaceReadFace` types cells,
 * streams and procedures and deliberately declines to type collection verbs
 * (per-member precision there is a union-budget problem the framework solved by
 * not solving it). `buildSurfaceFace` returns the structural view where the
 * verbs ARE present, and `odu surface keys runs` reaches them the same way —
 * one cast at an adapter seam, which is exactly where the framework says to put
 * it.
 *
 * `keys` then `get`, rather than a bespoke "list the board for me" procedure:
 * the collection IS the board, and asking the service for a pre-filtered list
 * would be asking it to know where the caller is standing.
 */
async function readRows(dispatch: SurfaceDispatch): Promise<RunRow[]> {
  const face = buildSurfaceFace(oduServiceSurface, dispatch) as unknown as {
    surface: {
      runs: {
        keys: (input: undefined) => AsyncIterable<readonly string[]>;
        get: (key: string) => AsyncIterable<RunRow | undefined>;
      };
    };
  };
  const keys = (await firstFrame(face.surface.runs.keys(undefined))) ?? [];
  const rows: RunRow[] = [];
  for (const key of keys) {
    const row = await firstFrame(face.surface.runs.get(key));
    if (row !== undefined && row !== null) rows.push(row);
  }
  return rows;
}

/** A collection member always opens with a SNAPSHOT, so the first frame is the
 *  read. An empty stream is a link that answered and said nothing, which is a
 *  different thing from an empty board — reported as `undefined` so the caller
 *  is never handed a plausible-looking zero. */
async function firstFrame<A>(stream: AsyncIterable<A>): Promise<A | undefined> {
  for await (const frame of stream) return frame;
  return undefined;
}

const AGO = [
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
  [1_000, "s"],
] as const;

export function formatAgo(deltaMs: number): string {
  for (const [unit, label] of AGO) {
    if (deltaMs >= unit) return `${Math.floor(deltaMs / unit)}${label}`;
  }
  return "now";
}

export function renderRows(rows: readonly RunRow[], now: number): string {
  if (rows.length === 0) return "no runs\n";
  const lines = rows.map((r) => {
    const ref = r.seq === null ? r.sha.slice(0, 7) : `${r.sha.slice(0, 7)}#${r.seq}`;
    const verdict =
      r.state === "settled" ? (r.outcome ?? (r.passed ? "passed" : "failed")) : r.state;
    const debt = r.reportingDebt > 0 ? `  ⇐${r.reportingDebt}` : "";
    return `${r.runId}  ${ref}${r.dirty ? "+dirty" : ""}  ${r.branch ?? "-"}  ${verdict}  ${formatAgo(now - r.createdAt)} ago${debt}`;
  });
  return `${lines.join("\n")}\n`;
}
