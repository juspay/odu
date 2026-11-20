import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { unenrolledStreamCall } from "@kolu/surface/client";
import {
  errorMessage,
  firstFrame as headFrame,
  isNoAnswer,
  NoAnswerWithin,
  subscribe,
  withDeadline,
} from "@odu/execution/common/effectEdge";
import type { ServiceConnection } from "@odu/service-client/dial";
import {
  namedOrigin,
  SERVICE_ORIGIN_ENV,
  serviceOrigin,
} from "@odu/service-client/endpoint";
import type {
  AttentionAnswer,
  ListInput,
  ListOutput,
  NodesFrame,
  OduServiceClient,
} from "@odu/service-client/surface";
import { CI_NEEDS, isCommitPrefix, ServiceRefused } from "@odu/service-client/surface";
import { Effect, type Stream } from "effect";
import { connectOrStartSingleton, SERVICE_WIRE_GROUP } from "./wire";

export const WAIT_EXITS = {
  passed: 0,
  failed: 1,
  stillRunning: 2,
  ownerLost: 3,
  unknownRun: 4,
  refused: 5,
} as const;

export function refusalExit(code: string): number {
  return code === "unknown_run" || code === "expired"
    ? WAIT_EXITS.unknownRun
    : WAIT_EXITS.refused;
}

export function waitExitFor(answer: AttentionAnswer): number {
  if (answer.settled) {
    return answer.outcome === "passed" ? WAIT_EXITS.passed : WAIT_EXITS.failed;
  }
  if (answer.failures.length > 0 || answer.actionable) return WAIT_EXITS.failed;
  if (answer.reason === "owner_lost") return WAIT_EXITS.ownerLost;
  return WAIT_EXITS.stillRunning;
}

export async function withService(
  origin: string | undefined,
  use: (client: OduServiceClient) => Promise<number>,
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

async function dial(
  origin: string | undefined,
): Promise<ServiceConnection | number> {
  try {
    return await connectOrStartSingleton(origin ?? serviceOrigin(), { needs: CI_NEEDS });
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n`);
    return WAIT_EXITS.ownerLost;
  }
}

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

export function isRefusal(value: unknown): value is ServiceRefused {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "ServiceRefused"
  );
}

export function reportLost(error: unknown, json: boolean): number {
  const message =
    `odu: the service went away mid-call — ${errorMessage(error)}. Whether it ` +
    "acted is not known; re-issue with the SAME request id to find out rather " +
    "than a fresh one.";
  if (json) emitJson({ error: "transport_lost", message });
  else process.stderr.write(`${message}\n`);
  return 3;
}

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
    if (refusal.resync !== undefined) {
      process.stderr.write(`  resync: ${refusal.resync}\n`);
    }
    if (refusal.suggestion !== undefined) {
      process.stderr.write(`  try: ${refusal.suggestion.join(" ")}\n`);
    }
  }
  return refusalExit(refusal.code);
}

export function reportFailure(
  outcome:
    | { ok: false; refusal: ServiceRefused }
    | { ok: false; refusal: null; error: unknown },
  json: boolean,
  refusalExitOverride?: number,
): number {
  if (outcome.refusal === null) return reportLost(outcome.error, json);
  const reported = reportRefusal(outcome.refusal, json);
  return refusalExitOverride ?? reported;
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function emitJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export interface Here {
  checkout: string;
  sha: string;
}

export interface RunTarget extends Here {
  world: "here" | "elsewhere";
  branch?: string;
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

export function checkoutHere(cwd: string = process.cwd()): string {
  const checkout = git(["rev-parse", "--show-toplevel"], cwd);
  if (checkout === null) {
    throw new Error(`odu: ${cwd} is not inside a git repository`);
  }
  return checkout;
}

export function runTarget(
  opts: {
    checkout?: string;
    sha?: string;
    branch?: string;
    origin?: string;
    cwd?: string;
  },
  env: Record<string, string | undefined> = process.env,
): RunTarget {
  if (opts.checkout === undefined) {
    if (opts.sha !== undefined) {
      throw new Error(
        "odu: --sha names the commit of --checkout, which was not given — in " +
          "this checkout odu reads HEAD itself, so there is nothing for --sha " +
          "to say",
      );
    }
    if (opts.branch !== undefined) {
      throw new Error(
        "odu: --branch names the branch of --checkout, which was not given — " +
          "this checkout is yours and odu never moves it; check out the " +
          "branch you mean and run again",
      );
    }
    return { ...here(opts.cwd), world: "here" };
  }
  if (opts.sha === undefined) {
    throw new Error(
      "odu: --checkout needs --sha — the service refuses a checkout that has " +
        "moved since you read it, and it can only do that against the commit " +
        "YOU believe is there (git -C <checkout> rev-parse HEAD, on that host)",
    );
  }
  if ((opts.origin ?? namedOrigin(env)) === undefined) {
    throw new Error(
      "odu: --checkout names a path on the SERVICE's machine, so say which " +
        "service — this command was given none, and the default one is the " +
        "daemon for the directory you are already standing in. " +
        `Pass --origin <url>, or export $${SERVICE_ORIGIN_ENV}.`,
    );
  }
  return {
    checkout: opts.checkout,
    sha: opts.sha,
    world: "elsewhere",
    ...(opts.branch === undefined ? {} : { branch: opts.branch }),
  };
}

export function requestId(given: string | undefined): string {
  return given ?? `cli-${randomUUID()}`;
}

export const FIRST_ANSWER_MS = 10_000;

export const FEEDBACK_AFTER_MS = 250;

export interface Patience {
  origin: string;
  json: boolean;
  deadlineMs: number;
  notice: <T>(work: Promise<T>) => Promise<T>;
}

export function patience(
  origin: string | undefined,
  json: boolean,
  opts: {
    afterMs?: number;
    deadlineMs?: number;
    tty?: boolean;
    write?: (text: string) => void;
  } = {},
): Patience {
  const at = origin ?? serviceOrigin();
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

export type Answered<T> = { ok: true; value: T } | { ok: false; exit: number };

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

export async function resolveRunAddress(
  client: Pick<OduServiceClient, "surface">,
  address: string,
  cwd: string,
  p: Patience,
): Promise<Answered<string>> {
  const parsed = parseRunAddress(address);
  switch (parsed.kind) {
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
            " has none. `odu ci history list --all` shows every run in your catalog.",
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

function noRunAtRef(address: string, json: boolean): number {
  return unknownRun(
    address,
    `odu: no run ${address} in the catalog — \`<sha7>#<seq>\` addresses` +
      " the seq-th run recorded at a commit, as `odu ci history list` prints it.",
    json,
  );
}

export type RunAddress =
  | { kind: "id"; runId: string }
  | { kind: "latest" }
  | { kind: "ref"; sha: string; seq: number }
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

function unknownRun(address: string, message: string, json: boolean): number {
  if (json) emitJson({ error: "unknown_run", message, run: address });
  else process.stderr.write(`${message}\n`);
  return WAIT_EXITS.unknownRun;
}

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

export function hostsFileHere(cwd: string | undefined): string {
  const raw = process.env.ODU_HOSTS;
  if (raw === undefined || raw === "") return "";
  return resolve(cwd ?? process.cwd(), raw);
}

/**
 * The only way this package opens a run's node stream. A bare
 * `client.surface.nodes.get(…)` is an unfenced stream, and the framework is
 * explicit about what that costs: `fenceStream` is where transparent
 * re-subscribe lives, and a call that skips it "silently loses the reconnect
 * context". A retryable transport hiccup does not raise; it ENDS the
 * iteration, and every consumer here reads that as "the stream is over".
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
 * A link can end under a live run — a daemon busy with several live
 * coordinators can go quiet past the keep-alive backstop (60–65s,
 * `@kolu/surface/keepAlive`; the websocket leg then cycles its socket), or
 * send a frame that does not decode — and the subscription is INTERRUPTED.
 * `endOnInterrupt` turns that into a clean end of iteration, correctly,
 * because an interrupt is not an error.
 *
 * The fence (`nodesStream`) handles a retryable FAILURE. It cannot handle this
 * one: `Stream.retry` retries failures, and an interrupt is not one. So the
 * loop is here, where the only fact that ends a watch is the one the service
 * states — a frame with `done`.
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
      void sub.return?.();
    }
    trace(`watch ${runId}: stream ended without a verdict`);
    if (p !== undefined && firstBy !== undefined && last === undefined && Date.now() >= firstBy) {
      throw new NoAnswerWithin(p.deadlineMs);
    }
    if (Date.now() >= until) return last;
    await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_MS));
  }
}

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

const RESUBSCRIBE_MS = 250;

function trace(message: string): void {
  if (process.env.ODU_DEBUG !== undefined && process.env.ODU_DEBUG !== "") {
    process.stderr.write(`odu[debug] ${message}\n`);
  }
}
