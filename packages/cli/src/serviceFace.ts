/**
 * WHAT A TERMINAL FACE IS ALLOWED TO BE — the plumbing every public command
 * shares, and nothing else.
 *
 * There are four client modules now (`./serviceCommands` for runs,
 * `./serviceStatus` for one checkout's live run, `./serviceVenue` for the
 * machines, `./servicePipeline` for a checkout's recipes and its branch
 * protection), and they exist because those are four different subjects, not
 * because they are four different authorities. This module is what makes that
 * true: the connection, the three-way outcome, the refusal rendering and the
 * exit table live HERE, once, so a face cannot quietly decide that a refusal
 * means something different to it than to its neighbour.
 *
 * That is not a tidiness argument. Before the consolidation, `odu wait` and the
 * MCP face disagreed about whether a red run was an error, and they disagreed
 * because each had written its own answer. One copy of this file is the
 * structural reason that cannot happen again.
 *
 * ## What a client is still allowed to know
 *
 * Two things, and both are about the CALLER rather than about a run:
 *
 *   - **which checkout the person is standing in** — `git rev-parse` in the
 *     cwd. The service addresses runs globally and takes `checkout` as an
 *     explicit absolute path precisely so no face has to guess; resolving
 *     "here" into that path is this side's job and cannot be anywhere else.
 *   - **which commit they mean** — `HEAD`, sent as `expectedSha` so the service
 *     can REFUSE a checkout that has moved on rather than quietly running a
 *     different commit.
 *
 * Both are reads of the caller's own working directory through `git` itself.
 * Neither is run authority, and `./authority.test.ts` is what keeps the
 * distinction honest: nothing reachable from a public command may import the
 * engine, the catalog store, or the coordinator dial.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { unenrolledStreamCall } from "@kolu/surface/client";
import {
  firstFrame as headFrame,
  isNoAnswer,
  NoAnswerWithin,
  subscribe,
  withDeadline,
} from "@odu/execution/common/effectEdge";
import type { ServiceConnection } from "@odu/service-client/dial";
import { serviceOrigin } from "@odu/service-client/endpoint";
import type {
  AttentionAnswer,
  ListInput,
  ListOutput,
  NodesFrame,
  OduServiceClient,
} from "@odu/service-client/surface";
import { isCommitPrefix, ServiceRefused } from "@odu/service-client/surface";
import { Effect, type Stream } from "effect";
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
export function refusalExit(code: string): number {
  return code === "unknown_run" || code === "expired"
    ? WAIT_EXITS.unknownRun
    : WAIT_EXITS.refused;
}

/** The one place an answer about attention becomes an exit, so every face that
 *  reports one reports the same number for the same state. */
export function waitExitFor(answer: AttentionAnswer): number {
  // INCOMPLETE IS NOT A PASS. `outcome` is the three-way — passed, failed,
  // incomplete — and `passed` is the two-way that cannot express the third. A
  // run whose only non-ok node was CANCELLED has no red node, so `passed` reads
  // true and the exit was 0: `odu cancel @platform` on the only lane reported
  // success for a pipeline that never finished.
  if (answer.settled) {
    return answer.outcome === "passed" ? WAIT_EXITS.passed : WAIT_EXITS.failed;
  }
  // A red node is a failure whether or not the slow lanes have finished — the
  // run cannot pass from here. Reporting it as "still running" would be true
  // and useless: the caller has something to act on, and the exit is how it
  // finds that out without parsing the payload.
  if (answer.failures.length > 0 || answer.actionable) return WAIT_EXITS.failed;
  if (answer.reason === "owner_lost") return WAIT_EXITS.ownerLost;
  return WAIT_EXITS.stillRunning;
}

// ── the connection ──────────────────────────────────────────────────────────

/** Do one thing with the service and let go, answering with a process exit.
 *
 *  `dispose` is not bookkeeping: the link holds the dial, ping and response
 *  fibers, and a command that dropped it would be a process that never exits.
 *
 *  The return is a `number` rather than a generic because every caller is a
 *  COMMAND, and a command's answer is its exit code — which is also what lets
 *  a failure to reach the service be reported as an exit rather than escaping
 *  as a rejection. See {@link dial}. */
export async function withService(
  origin: string | undefined,
  use: (client: OduServiceClient) => Promise<number>,
  /** Wraps the dial so a slow one says so — see {@link Patience}. */
  notice: Patience["notice"] = (work) => work,
): Promise<number> {
  const dialled = await notice(dial(origin));
  if (typeof dialled === "number") return dialled;
  try {
    return await use(dialled.client);
  } finally {
    await dialled.dispose();
  }
}

/**
 * Reach the service, or turn the failure into an EXIT rather than a rejection.
 *
 * `connectOrStart` rejects when it cannot dial and cannot start — an occupied
 * port, a misbuilt package, a daemon that will not come up. Left to reject, it
 * unwound to `src/main.ts`'s catch-all, which prints the message and exits 1 —
 * the code this file's own table reserves for "there is a failure to act on",
 * i.e. red CI. A script branching on that exit would have read "your tests
 * failed" from a machine where odu never started, which is the single most
 * misleading answer available.
 *
 * Exit 3 is the honest one and it is already the documented "nothing serving".
 */
async function dial(
  origin: string | undefined,
): Promise<ServiceConnection | number> {
  try {
    return await connectOrStart(origin ?? serviceOrigin());
  } catch (err) {
    process.stderr.write(
      `${String((err as { message?: unknown }).message ?? err)}\n`,
    );
    return WAIT_EXITS.ownerLost;
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
export async function call<A>(
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
export function isRefusal(value: unknown): value is ServiceRefused {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "ServiceRefused"
  );
}

/** What a transport failure exits with, and what it says. Exit 3 is the
 *  documented "nothing serving" code and it is the honest one here: whatever
 *  was serving is not serving this call. */
export function reportLost(error: unknown, json: boolean): number {
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
export function reportRefusal(refusal: ServiceRefused, json: boolean): number {
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

/** The one shape both failure arms collapse to at a command's edge. Every
 *  command ends `if (!x.ok) return reportFailure(x, json)`, so no face can
 *  invent a fourth way of reporting the same two things. */
export function reportFailure(
  outcome:
    | { ok: false; refusal: ServiceRefused }
    | { ok: false; refusal: null; error: unknown },
  json: boolean,
  /**
   * What a REFUSAL exits with, for a command the run-shaped table is not about.
   *
   * {@link WAIT_EXITS} numbers the states of a RUN — passed, red, still going,
   * owner lost. `odu protect` and `odu graph` have none of those: they either
   * did the thing or did not, which is `0` and `1`, and that is the contract
   * they shipped with. Routing their refusals through `refusalExit` renumbered
   * "protect found no platforms" from 1 to 5 — a script's error branch, moved
   * for no reason its author could see.
   */
  refusalIs?: number,
): number {
  if (outcome.refusal === null) return reportLost(outcome.error, json);
  const reported = reportRefusal(outcome.refusal, json);
  return refusalIs ?? reported;
}

/** One complete JSON value, one write, nothing else on stdout. An agent piping
 *  `-o json` through a shell gets a parseable line without `stdbuf`, and that
 *  is a property of where the bytes go rather than of the terminal. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** ONE LINE, no indentation — for a stream of values rather than a single
 *  answer.
 *
 *  `emitJson` pretty-prints, which is right for a command that emits one object
 *  and wrong for a follow: `odu logs -f -o json` promised NDJSON in its own
 *  comment, in the usage text and in the docs, and emitted an indented object
 *  spanning many lines per page. An agent reading it line by line got fragments
 *  that do not parse. */
export function emitJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// ── what the caller meant ───────────────────────────────────────────────────

/** The checkout the caller is standing in, and the commit it is on. A read of
 *  the caller's own cwd through git — see the module header on why this, and
 *  only this, stays on the client's side. */
export interface Here {
  checkout: string;
  sha: string;
}

export function git(args: string[], cwd: string): string | null {
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

/** Just the checkout, for the verbs whose subject is a directory rather than a
 *  commit — `pipeline.read`, `catalog.import`, `venue.hold`. Asking for a
 *  commit there would refuse a perfectly good checkout with no history. */
export function checkoutHere(cwd: string = process.cwd()): string {
  const checkout = git(["rev-parse", "--show-toplevel"], cwd);
  if (checkout === null) {
    throw new Error(`odu: ${cwd} is not inside a git repository`);
  }
  return checkout;
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
export function requestId(given: string | undefined): string {
  return given ?? `cli-${randomUUID()}`;
}

// ── waiting on the service ──────────────────────────────────────────────────

/**
 * How long a command waits for the service's FIRST answer — a run listing, or
 * a run's opening nodes frame — before it says the service is not answering.
 *
 * Nothing bounded that wait before, and juspay/odu#113 is what that cost: a
 * daemon whose loop was pinned by its own poller accepted the connection and
 * then answered nothing for minutes, and `odu attach` sat on a blank terminal
 * with no way to tell "slow" from "hung". Ten seconds is far beyond any healthy
 * answer, which is a single in-memory scan, and short enough that a person
 * learns something is wrong while they are still looking.
 *
 * Only the FIRST answer: a follow that has started is bounded by
 * {@link watchNodes}' own deadline, and a run that is simply long is not slow.
 */
export const FIRST_ANSWER_MS = 10_000;

/** How long a command stays silent before saying it is waiting. Below this a
 *  line would flash for an answer that was about to arrive anyway. */
export const FEEDBACK_AFTER_MS = 250;

/**
 * How a command waits: bounded, and not in silence.
 *
 * One per command, so the waiting line is printed AT MOST ONCE however many
 * steps (the dial, the listing, the first frame) turn out to be slow.
 */
export interface Patience {
  origin: string;
  json: boolean;
  deadlineMs: number;
  /** Resolve with `work`, writing the waiting line to stderr if it is still
   *  pending after the threshold — and nothing otherwise. */
  notice: <T>(work: Promise<T>) => Promise<T>;
}

export function patience(
  origin: string | undefined,
  json: boolean,
  opts: {
    afterMs?: number;
    deadlineMs?: number;
    /** Whether a person is watching stderr. Injected by tests. */
    tty?: boolean;
    write?: (text: string) => void;
  } = {},
): Patience {
  const at = origin ?? serviceOrigin();
  // Never under `-o json` and never into a pipe: the line is for a person, and
  // a consumer parsing output should not have to know it might appear.
  const speaks = !json && (opts.tty ?? process.stderr.isTTY === true);
  const write = opts.write ?? ((text: string) => void process.stderr.write(text));
  const afterMs = opts.afterMs ?? FEEDBACK_AFTER_MS;
  let said = false;
  return {
    origin: at,
    json,
    deadlineMs: opts.deadlineMs ?? FIRST_ANSWER_MS,
    notice: async (work) => {
      if (!speaks || said) return work;
      const timer = setTimeout(() => {
        if (said) return;
        said = true;
        write(`odu: waiting for the service at ${at}…\n`);
      }, afterMs);
      try {
        return await work;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The service accepted us and then said nothing in time. Exit 3, the
 *  documented "nothing serving" — whatever is there is not serving THIS. */
export function reportNoAnswer(p: Patience, what: string): number {
  const message =
    `odu: the service at ${p.origin} did not answer ${what} within ` +
    `${Math.round(p.deadlineMs / 1000)}s — it accepted the connection and then ` +
    "said nothing. Its log (`odu web` in a terminal, or the daemon's journal) " +
    "says why.";
  if (p.json) emitJson({ error: "no_answer", message });
  else process.stderr.write(`${message}\n`);
  return WAIT_EXITS.ownerLost;
}

/** A question the service answered, or one already reported to the user with
 *  the exit it earned. One shape for every step a command threads through, so
 *  a caller passes the failure on (`if (!x.ok) return x.exit`) without
 *  remembering which step spelled its success arm how. */
export type Answered<T> = { ok: true; value: T } | { ok: false; exit: number };

// ── finding runs ────────────────────────────────────────────────────────────

/**
 * The board, filtered by the service — ONE round trip, bounded.
 *
 * This replaced reading the `runs` collection a row at a time (`keys`, then a
 * `get` per key) and filtering here. That was one round trip per run in the
 * catalog to name a single one of them, on every `odu status`, `attach`,
 * `--run latest` and `history list` — 711 of them on the host that reported
 * juspay/odu#113. The filters did not move to the service because it should
 * know where the caller stands (it still does not: `checkout` is a path this
 * side resolved and sends as data), but because a filter that runs where the
 * rows are is one message, and one that runs here is all of them.
 */
export async function findRuns(
  client: Pick<OduServiceClient, "surface">,
  query: ListInput,
  p: Patience,
): Promise<Answered<ListOutput>> {
  const answered = await p.notice(
    call(withDeadline(client.surface.run.list(query), p.deadlineMs)),
  );
  if (answered.ok) return answered;
  if (answered.refusal === null && isNoAnswer(answered.error)) {
    return { ok: false, exit: reportNoAnswer(p, "a run listing") };
  }
  return { ok: false, exit: reportFailure(answered, p.json) };
}

/** A run's opening nodes frame, bounded the same way. `undefined` is still a
 *  stream that opened and said nothing — a different fault from no answer. */
export async function firstNodesFrame(
  client: Pick<OduServiceClient, "surface">,
  runId: string,
  p: Patience,
): Promise<Answered<NodesFrame | undefined>> {
  try {
    const value = await p.notice(
      headFrame(nodesStream(client, runId), { deadlineMs: p.deadlineMs }),
    );
    return { ok: true, value };
  } catch (err) {
    if (isNoAnswer(err)) {
      return { ok: false, exit: reportNoAnswer(p, `${runId}'s nodes`) };
    }
    throw err;
  }
}

/**
 * THE THREE WAYS TO NAME A RUN, resolved in one place.
 *
 * `odu wait`, `odu rerun`, `odu cancel` and `odu history show` all refuse a
 * missing `--run` with the same sentence: "a run id, `<sha7>#<seq>`, or
 * `latest`". Two of those three spellings did not resolve anywhere — the
 * grammar was promised by the error message and implemented by nobody, so
 * `odu wait --run latest` exited 4 with "no run latest in the catalog" against
 * a run that had just finished in the directory the caller was standing in.
 *
 * A promise made by a refusal is still a promise, and this is where it is kept.
 *
 *   - a RUN ID passes through untouched — it is already the global address, and
 *     resolving it here would mean a listing on every command that has one;
 *   - `latest` is the newest run OF THIS CHECKOUT. Deliberately not the newest
 *     run in the catalog: the catalog is per user, and a person standing in one
 *     repository who types `latest` means the thing they just started, not
 *     whatever another worktree began a second later;
 *   - `<sha7>#<seq>` is the seq-th run recorded at that commit — the spelling
 *     `odu history list` prints, so what is on the screen can be typed back.
 *     Global, newest first, like the catalog's own `resolveRunRef`.
 */
export async function resolveRunAddress(
  client: Pick<OduServiceClient, "surface">,
  address: string,
  cwd: string,
  p: Patience,
): Promise<Answered<string>> {
  // EXIT 4, not a throw, on every arm that names nothing. An unresolvable
  // address is a fact about the QUESTION, which is what exit 4 means in this
  // file's table — and a throw would unwind to `main.ts` and exit 1, the code
  // reserved for "your CI is red". A script branching on that would report a
  // test failure for a run it could not name.
  const parsed = parseRunAddress(address);
  switch (parsed.kind) {
    // A run id passes through WITHOUT a listing. The service is the authority
    // on whether it exists and refuses it properly; resolving it here would
    // buy nothing and cost a round trip on every `odu wait`.
    case "id":
      return { ok: true, value: parsed.runId };
    case "latest": {
      const checkout = git(["rev-parse", "--show-toplevel"], cwd);
      if (checkout !== null) {
        const found = await findRuns(client, { checkout, limit: 1 }, p);
        if (!found.ok) return found;
        const row = found.value.rows[0];
        if (row !== undefined) return { ok: true, value: row.runId };
      }
      return {
        ok: false,
        exit: unknownRun(
          address,
          `odu: no run recorded for ${checkout ?? cwd}` +
            " — `latest` means the newest run OF THIS CHECKOUT, and this one" +
            " has none. `odu history list --all` shows every run in your catalog.",
          p.json,
        ),
      };
    }
    case "ref": {
      const found = await findRuns(client, { sha: parsed.sha, seq: parsed.seq, limit: 1 }, p);
      if (!found.ok) return found;
      const row = found.value.rows[0];
      if (row !== undefined) return { ok: true, value: row.runId };
      return { ok: false, exit: noRunAtRef(address, p.json) };
    }
    case "malformed":
      return { ok: false, exit: noRunAtRef(address, p.json) };
  }
}

/**
 * One command that takes `--run <address>`: its patience, its connection and
 * the address resolved, as ONE preamble.
 *
 * `odu wait`, `rerun`, `cancel` and `history show` each spelled these three
 * steps out, with the origin passed twice and the waiting line's `notice`
 * threaded to the dial by hand — so a fifth such command could build its
 * patience and forget to hand it to the dial, and nothing would say so.
 * Commands whose subject is not a run address (`status`, `attach`, `list`,
 * `logs`) keep calling {@link withService} directly.
 */
export function withRunAt(
  opts: { origin?: string; json: boolean; run: string; cwd?: string },
  use: (client: OduServiceClient, runId: string) => Promise<number>,
): Promise<number> {
  const p = patience(opts.origin, opts.json);
  return withService(
    p.origin,
    async (client) => {
      const resolved = await resolveRunAddress(client, opts.run, opts.cwd ?? process.cwd(), p);
      return resolved.ok ? use(client, resolved.value) : resolved.exit;
    },
    p.notice,
  );
}

/** A `<sha7>#<seq>` that named nothing — well-formed and unmatched, or not a
 *  ref at all; the same fact either way (see {@link RunAddress}). */
function noRunAtRef(address: string, json: boolean): number {
  return unknownRun(
    address,
    `odu: no run ${address} in the catalog — \`<sha7>#<seq>\` addresses` +
      " the seq-th run recorded at a commit, as `odu history list` prints it.",
    json,
  );
}

/** The run-address grammar as a value — parsed once, so the resolver switches on
 *  what was typed rather than re-asking the string at every step. */
export type RunAddress =
  | { kind: "id"; runId: string }
  | { kind: "latest" }
  | { kind: "ref"; sha: string; seq: number }
  // A ref that cannot name a run is UNKNOWN, not refused: the grammar is this
  // face's, so a malformed one is the same fact as a well-formed one nothing
  // matches — and worth no round trip.
  | { kind: "malformed" };

export function parseRunAddress(address: string): RunAddress {
  if (address === "latest") return { kind: "latest" };
  const hash = address.indexOf("#");
  if (hash <= 0) return { kind: "id", runId: address };
  const sha = address.slice(0, hash);
  const seq = Number(address.slice(hash + 1));
  return isCommitPrefix(sha) && Number.isSafeInteger(seq) && seq > 0
    ? { kind: "ref", sha, seq }
    : { kind: "malformed" };
}

/** Report an address that named no run, in whichever voice the caller asked
 *  for — the same `{error, message, run}` shape the service's own `unknown_run`
 *  refusal emits, so a JSON consumer branches on one thing. */
function unknownRun(address: string, message: string, json: boolean): number {
  if (json) emitJson({ error: "unknown_run", message, run: address });
  else process.stderr.write(`${message}\n`);
  return WAIT_EXITS.unknownRun;
}

/** The head of a stream, through the shared Effect edge rather than a local
 *  loop: `firstFrame` and `subscribe` are where the laziness, teardown and
 *  interruption rules for a surface stream live, and a face that re-derived
 *  them would get one of the three wrong. `undefined` is a stream that ended
 *  without a frame — never a plausible-looking empty answer. */
export async function firstFrame<A>(
  stream: Stream.Stream<A, unknown>,
): Promise<A | undefined> {
  return headFrame(stream);
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

/**
 * THIS shell's `$ODU_HOSTS`, as `run.start` takes it.
 *
 * The service is a per-user singleton somebody else may have started, and
 * `loadHosts` runs in the coordinator it spawns — so a variable that is not
 * carried here is a variable that stopped working the moment `odu run` became
 * a client. `""` is an answer, not a gap: it says this shell has none, which
 * is different from an agent's silence.
 */
export function hostsFileHere(cwd: string | undefined): string {
  const raw = process.env.ODU_HOSTS;
  if (raw === undefined || raw === "") return "";
  return resolve(cwd ?? process.cwd(), raw);
}

/**
 * ONE RUN'S NODE STREAM, FENCED — the only way this package opens one.
 *
 * A bare `client.surface.nodes.get(…)` is an unfenced stream, and the framework
 * is explicit about what that costs: `fenceStream` is where transparent
 * re-subscribe lives, and a call that skips it "silently loses the reconnect
 * context". Silently is the word that matters. A retryable transport hiccup —
 * a busy machine, a momentary stall on the socket — does not raise; it ENDS the
 * iteration, and every consumer here reads that as "the stream is over".
 *
 * The three consumers then each reported something false. `odu run --progress
 * json` stopped emitting events for a run that was still going and exited `2`;
 * `odu status` said "the service opened this run's node stream and sent no
 * frame"; `odu attach` closed the matrix on a live run. All three intermittent,
 * all three under load, which is exactly when a fence earns its keep — the e2e
 * suite lost a different one of them on each platform, on the same commit.
 *
 * `label` is the liveness registry's name for the subscription, spelled in
 * `client.health()`'s vocabulary so a diagnostic snapshot says which run's
 * stream is parked rather than "(unlabeled)".
 */
export function nodesStream(
  client: Pick<OduServiceClient, "surface">,
  runId: string,
  onRetry?: () => void,
): Stream.Stream<NodesFrame, unknown> {
  return unenrolledStreamCall(
    client.surface.nodes.get,
    { runId },
    { label: `nodes[${runId}]`, ...(onRetry === undefined ? {} : { onRetry }) },
  );
}

/**
 * EVERY FRAME OF A RUN, until it says it is done.
 *
 * A stream ENDING is not evidence about the run, and treating it as evidence is
 * the bug this exists to remove. The link pings; a daemon busy with several
 * live coordinators can miss one; the link's run then ends and the subscription
 * is INTERRUPTED. `endOnInterrupt` turns that into a clean end of iteration —
 * correctly, because an interrupt is not an error — and every consumer here
 * then concluded the run was over. `odu run --progress json` stopped emitting
 * events mid-run and exited 2; `odu attach` closed the matrix on a live run.
 *
 * The fence (`nodesStream`) handles a retryable FAILURE. It cannot handle this
 * one: `Stream.retry` retries failures, and an interrupt is not one. So the
 * loop is here, where the only fact that ends a watch is the one the service
 * states — a frame with `done`.
 *
 * `sawDone` rather than a count: re-subscribing is cheap and idempotent (a
 * stream opens with a snapshot, and every consumer of this dedupes), while
 * stopping early is a wrong answer about somebody's CI. The deadline exists so
 * a service that has gone away entirely cannot hold a terminal forever.
 *
 * `patience` bounds the FIRST frame — across re-subscribes, on the subscription
 * that is then kept — and rejects with {@link NoAnswerWithin} when it does not
 * come (juspay/odu#113). On THIS stream rather than on a probe beside it: a
 * probe that answered proved nothing about the second subscription the follow
 * then opened, and cost `odu attach` two stream opens on the path it exists to
 * make cheap. After the first frame the follow is unbounded but for
 * `deadlineMs` — a long run is not a slow one.
 */
export async function watchNodes(
  client: Pick<OduServiceClient, "surface">,
  runId: string,
  onFrame: (frame: NodesFrame) => void,
  opts: { deadlineMs?: number; patience?: Patience } = {},
): Promise<NodesFrame | undefined> {
  const until = Date.now() + (opts.deadlineMs ?? 24 * 60 * 60 * 1000);
  const p = opts.patience;
  const firstBy = p === undefined ? undefined : Date.now() + p.deadlineMs;
  let last: NodesFrame | undefined;
  for (;;) {
    trace(`watch ${runId}: subscribing`);
    const sub = subscribe(
      nodesStream(client, runId, () => trace(`watch ${runId}: link retrying`)),
    );
    try {
      for (;;) {
        const next =
          p !== undefined && firstBy !== undefined && last === undefined
            ? await p.notice(nextBy(sub, firstBy, p.deadlineMs))
            : await sub.next();
        if (next.done) break;
        const frame = next.value;
        last = frame;
        trace(`watch ${runId}: frame done=${frame.done} nodes=${frame.nodes.length}`);
        onFrame(frame);
        if (frame.done) return frame;
      }
    } finally {
      // Hand-advanced, so released by hand — what `for await … return` did.
      void sub.return?.();
    }
    trace(`watch ${runId}: stream ended without a verdict`);
    // Still no first frame, and its bound is spent: re-subscribing would only
    // hide a service that is not answering behind one that is slow.
    if (p !== undefined && firstBy !== undefined && last === undefined && Date.now() >= firstBy) {
      throw new NoAnswerWithin(p.deadlineMs);
    }
    // The stream ended without saying the run had. Re-subscribe — unless the
    // clock says nobody is coming back.
    if (Date.now() >= until) return last;
    await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_MS));
  }
}

/** The iterator's next result, or {@link NoAnswerWithin} once `by` passes. The
 *  caller releases the subscription; a `next()` that loses the race settles
 *  into the interrupt that release issues, never into an unhandled rejection. */
async function nextBy<T>(
  sub: AsyncIterator<T>,
  by: number,
  deadlineMs: number,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new NoAnswerWithin(deadlineMs)),
      Math.max(0, by - Date.now()),
    );
  });
  try {
    return await Promise.race([sub.next(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long to wait before re-opening a watch that ended without a verdict.
 *  Short: the common cause is a momentary stall on a busy service, and the
 *  subscription that replaces it opens with a fresh snapshot. */
const RESUBSCRIBE_MS = 250;

/** A line on stderr under `$ODU_DEBUG`, and nothing otherwise. The subscription
 *  faults this exists to diagnose are invisible by construction — an interrupt
 *  is not an error and a parked retry says nothing at all — so the only way to
 *  see one is to have asked for it. */
function trace(message: string): void {
  if (process.env.ODU_DEBUG !== undefined && process.env.ODU_DEBUG !== "") {
    process.stderr.write(`odu[debug] ${message}\n`);
  }
}
