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
import { randomUUID } from "node:crypto";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { firstFrame as headFrame } from "@odu/execution/common/effectEdge";
import type { ServiceConnection } from "@odu/service-client/dial";
import { serviceOrigin } from "@odu/service-client/endpoint";
import type {
  AttentionAnswer,
  OduServiceClient,
  RunRow,
} from "@odu/service-client/surface";
import { oduServiceSurface, ServiceRefused } from "@odu/service-client/surface";
import { Effect, Stream } from "effect";
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
): Promise<number> {
  const dialled = await dial(origin);
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

/** The same, for the readers that need the raw dispatch as well as the typed
 *  face — see {@link readRows} on why a collection is reached that way. */
export async function withConnection(
  origin: string | undefined,
  use: (connection: ServiceConnection) => Promise<number>,
): Promise<number> {
  const dialled = await dial(origin);
  if (typeof dialled === "number") return dialled;
  try {
    return await use(dialled);
  } finally {
    await dialled.dispose();
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
): number {
  return outcome.refusal === null
    ? reportLost(outcome.error, json)
    : reportRefusal(outcome.refusal, json);
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

// ── reading collections ─────────────────────────────────────────────────────

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
 *
 * **A CAST IS A CLAIM, AND THIS ONE WAS WRONG TWICE.** It said the verbs
 * returned async iterables — they return Effect `Stream`s, and the `for await`
 * died with `undefined is not a function`. It said `get` took a bare key — the
 * framework mints it taking `{ key }`, so the input failed to decode and every
 * read of the board came back "Schema validation failed". Neither could be
 * contradicted by a compiler, and no unit test caught either, because every
 * test hands in a stand-in face shaped like the cast itself. Both were found by
 * running the packaged binary. When editing this, read `mintStream` in
 * `node_modules/@kolu/surface/src/client.ts` rather than the type above it.
 */
export async function readRows(dispatch: SurfaceDispatch): Promise<RunRow[]> {
  const face = buildSurfaceFace(oduServiceSurface, dispatch) as unknown as {
    surface: {
      runs: {
        keys: (input: undefined) => Stream.Stream<readonly string[], unknown>;
        get: (
          input: { key: string },
        ) => Stream.Stream<RunRow | undefined, unknown>;
      };
    };
  };
  const keys = (await firstFrame(face.surface.runs.keys(undefined))) ?? [];
  const rows: RunRow[] = [];
  for (const key of keys) {
    const row = await firstFrame(face.surface.runs.get({ key }));
    if (row !== undefined && row !== null) rows.push(row);
  }
  return rows;
}

/** A collection member always opens with a SNAPSHOT, so the first frame is the
 *  read. An empty stream is a link that answered and said nothing, which is a
 *  different thing from an empty board — reported as `undefined` so the caller
 *  is never handed a plausible-looking zero.
 *
 *  Through the shared Effect edge rather than a local loop: `firstFrame` and
 *  `subscribe` are where the laziness, teardown and interruption rules for a
 *  surface stream live, and a face that re-derived them would get one of the
 *  three wrong. */
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
