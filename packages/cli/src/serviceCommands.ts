import { subscribe } from "@odu/execution/common/effectEdge";
import { progressEvent } from "@odu/execution/common/presentation";
import { exitCode } from "@odu/execution/common/verdict";
import { duration, runElapsedMs } from "@odu/service-client/board";
import type {
  AttentionAnswer,
  NodesFrame,
  CatalogImportReport,
  CatalogPruneReport,
  LogPage,
  LogStream,
  OduServiceClient,
  RetryReceipt,
  RunRow,
  ServiceCell,
  StartReceipt,
} from "@odu/service-client/surface";
import { ServiceRefused } from "@odu/service-client/surface";
import { logHasMore } from "@odu/service-client/surface";
import {
  CI_LOG_STREAM_GATE,
  rowBehindGate,
} from "@odu/service-client/surface";
import { readServiceCell } from "@odu/service-client/dial";
import { serviceOrigin } from "@odu/service-client/endpoint";
import { runHash } from "@odu/service-client/routes";
import { attemptRewound, nodeStateOf, verdictStateOf } from "./liveFromService";
import { printVerdict } from "./render";
import {
  call,
  checkoutHere,
  emitJson,
  emitJsonLine,
  findRuns,
  firstFrame,
  formatAgo,
  git,
  type RunTarget,
  hostsFileHere,
  nodesStream,
  patience,
  reportFailure,
  reportLost,
  reportRefusal,
  requestId,
  runTarget,
  WAIT_EXITS,
  waitExitFor,
  watchNodes,
  withRunAt,
  withService,
} from "./serviceFace";

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
  linger: boolean;
  noWait: boolean;
  progressJson?: boolean;
  requestId?: string;
  json: boolean;
  origin?: string;
  cwd?: string;
  checkout?: string;
  sha?: string;
  branch?: string;
}

function hostsForwarding(
  at: RunTarget,
  shellHosts: string,
): { hostsFile?: string } {
  return at.world === "here" || shellHosts !== "" ? { hostsFile: shellHosts } : {};
}

export function startInputOf(at: RunTarget, opts: RunOpts) {
  return {
    checkout: at.checkout,
    expectedSha: at.sha,
    ...(at.branch === undefined ? {} : { branch: at.branch }),
    requestId: requestId(opts.requestId),
    selectors: opts.selectors,
    platforms: opts.platforms,
    hostPins: opts.hostPins,
    ...hostsForwarding(at, hostsFileHere(opts.cwd)),
    ...(opts.root === undefined ? {} : { root: opts.root }),
    noDeps: opts.noDeps,
    noStrict: opts.noStrict,
    noSnapshot: opts.noSnapshot,
    noPost: opts.noPost,
    supersede: opts.supersede,
    linger: opts.linger,
  };
}

export async function runViaService(opts: RunOpts): Promise<number> {
  const at = runTarget(opts);
  return withService(opts.origin, async (client) => {
    const started = await call(client.surface.run.start(startInputOf(at, opts)));
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
      return progressStream(client, receipt.runId, receipt.sha.slice(0, 7));
    }
    return observe(client, receipt.runId, receipt.cursor, opts.json);
  });
}

export function renderStart(receipt: StartReceipt, origin: string | undefined): string {
  const where = origin ?? serviceOrigin();
  const lines: string[] = [];
  if (!receipt.accepted && receipt.existing !== undefined) {
    lines.push(
      `odu · a run is already going in this checkout — ${receipt.existing.runId}`,
      "odu ·   watching it instead; `odu ci run --supersede` replaces it",
    );
  } else {
    lines.push(`odu · started ${receipt.runId}`);
  }
  lines.push(`odu · ${new URL(runHash(receipt.runId), where).href}`);
  if (receipt.lifetime !== undefined) lines.push(`odu · ${receipt.lifetime}`);
  lines.push("odu · Ctrl-C stops WATCHING; the run keeps going (odu ci cancel stops it)");
  return `${lines.join("\n")}\n`;
}

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
    await verdictOf(client, runId, answer.sha);
    process.stdout.write(renderAttention(answer));
    return waitExitFor(answer);
  }
}

async function verdictOf(
  client: OduServiceClient,
  runId: string,
  sha: string | null,
): Promise<void> {
  const sha7 = sha === null ? "" : sha.slice(0, 7);
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

export interface WaitOpts {
  run: string;
  after?: string;
  deadlineMs?: number;
  expectedSha?: string;
  settle: boolean;
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function waitViaService(opts: WaitOpts): Promise<number> {
  return withRunAt(opts, async (client, runId) => {
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
    if (opts.json || process.stdout.isTTY !== true) emitJson(answer);
    else process.stdout.write(renderAttention(answer));
    return waitExitFor(answer);
  });
}

export function renderAttention(a: AttentionAnswer): string {
  const lines: string[] = [];
  const sha7 = a.sha === null ? "" : `  ${a.sha.slice(0, 7)}${a.contentSha === undefined ? "" : `+dirty→${a.contentSha.slice(0, 7)}`}`;
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
    lines.push(`      odu ci logs ${f.logKey}`);
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

export interface RetryOpts {
  run: string;
  selector: string;
  requestId?: string;
  expectAttempt?: { node: string; attempt: number };
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function retryViaService(opts: RetryOpts): Promise<number> {
  return withRunAt(opts, async (client, runId) => {
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

export interface CancelOpts {
  run: string;
  scope: { kind: "run" } | { kind: "node"; node: string } | { kind: "lane"; platform: string };
  requestId?: string;
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function cancelViaService(opts: CancelOpts): Promise<number> {
  return withRunAt(opts, async (client, runId) => {
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
      process.stdout.write(
        result.effective === "nothing"
          ? `odu: nothing cancelled on ${result.runId} — ${result.detail ?? "no reason given"}\n`
          : `odu: run cancelled — ${result.runId} (${result.effective})\n`,
      );
    }
    return 0;
  });
}

export interface LogsOpts {
  key: string;
  offset?: number;
  limit?: number;
  follow?: boolean;
  waitMs?: number;
  stream?: LogStream;
  json: boolean;
  origin?: string;
}

/** A followed read holds an HTTP request open on the `/mcp` door for its whole
 *  duration, exactly as `run_wait` already does, and a proxy with a shorter
 *  idle timeout cuts anything that outlasts it. */
export const FOLLOW_WAIT_MS = 30_000;

/**
 * `stream` is an optional INPUT key, added to `log_read` in
 * {@link CI_LOG_STREAM_SINCE}. A daemon from before the key DROPS it as an
 * excess property and serves the request it understood, so `odu ci logs
 * --stream push` came back with the recipe's bytes and nothing in the page
 * said so. Silently answering a different question is the one skew a caller
 * must not be left to discover from the answer, so this is read BEFORE the
 * call and refused instead.
 */
export function pushStreamRefusal(
  cell: ServiceCell,
  where: string,
): string | null {
  const speaks = rowBehindGate(cell.identity, CI_LOG_STREAM_GATE);
  if (speaks === null) return null;
  return (
    `odu: the service at ${where} serves the ci row at ${speaks} and ` +
    `\`--stream push\` arrived in ci ${CI_LOG_STREAM_GATE.since} — that daemon drops the flag ` +
    "and answers with the attempt's RECIPE log instead, so read that one without " +
    "`--stream`, or `odu web --upgrade` replaces the daemon."
  );
}

export async function logsViaService(opts: LogsOpts): Promise<number> {
  const where = opts.origin ?? serviceOrigin();
  return withService(opts.origin, async (client) => {
    if (opts.stream === "push") {
      const cell = await call(readServiceCell(client));
      if (!cell.ok) {
        return cell.refusal === null
          ? reportLost(cell.error, opts.json)
          : reportRefusal(cell.refusal, opts.json);
      }
      const refusal = pushStreamRefusal(cell.value, where);
      if (refusal !== null) {
        if (opts.json) emitJson({ error: "stream_unsupported", message: refusal });
        else process.stderr.write(`${refusal}\n`);
        return WAIT_EXITS.refused;
      }
    }
    if (opts.follow === true) return followLog(client, opts);
    return readOnePage(client, opts);
  });
}

async function readOnePage(
  client: Pick<OduServiceClient, "surface">,
  opts: LogsOpts,
): Promise<number> {
  const read = await call(
    client.surface.log.read({
      key: opts.key,
      ...(opts.offset === undefined ? {} : { offset: opts.offset }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts.stream === undefined ? {} : { stream: opts.stream }),
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
}

export interface ListOpts {
  all: boolean;
  limit?: number;
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function listViaService(opts: ListOpts): Promise<number> {
  const mine = opts.all
    ? null
    : git(["rev-parse", "--show-toplevel"], opts.cwd ?? process.cwd());
  const p = patience(opts.origin, opts.json);
  return withService(
    opts.origin,
    async (client) => {
      const found = await findRuns(
        client,
        {
          ...(mine === null ? {} : { checkout: mine }),
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        },
        p,
      );
      if (!found.ok) return found.exit;
      const shown = found.value.rows;
      if (opts.json) {
        emitJson(shown);
        return 0;
      }
      process.stdout.write(renderRows(shown, Date.now()));
      return 0;
    },
    p.notice,
  );
}

export function renderRows(rows: readonly RunRow[], now: number): string {
  if (rows.length === 0) return "no runs\n";
  const lines = rows.map((r) => {
    const ref = r.seq === null ? r.sha.slice(0, 7) : `${r.sha.slice(0, 7)}#${r.seq}`;
    const verdict =
      r.state === "settled" ? (r.outcome ?? (r.passed ? "passed" : "failed")) : r.state;
    const debt = r.reportingDebt > 0 ? `  ⇐${r.reportingDebt}` : "";
    const by = r.actor === undefined ? "" : `  started by ${r.actor}`;
    return `${r.runId}  ${ref}${r.dirty ? "+dirty" : ""}${r.contentSha === undefined ? "" : `→${r.contentSha.slice(0, 7)}`}  ${r.branch ?? "-"}  ${verdict}  ${duration(runElapsedMs(r, now))}  ${formatAgo(now - r.createdAt)} ago${debt}${by}`;
  });
  return `${lines.join("\n")}\n`;
}

export interface ShowOpts {
  run: string;
  after?: string;
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function showViaService(opts: ShowOpts): Promise<number> {
  return withRunAt(opts, async (client, runId) => {
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

export interface ImportOpts {
  dryRun: boolean;
  json: boolean;
  origin?: string;
  cwd?: string;
}

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
  for (const kept of report.kept) lines.push(`kept     ${kept.runId}  ${kept.reason}`);
  if (lines.length === 0) lines.push("nothing to prune");
  lines.push(
    `${report.dryRun ? "(dry run) " : ""}retention: ${report.retentionDays}d`,
  );
  return `${lines.join("\n")}\n`;
}

export async function followLog(
  client: Pick<OduServiceClient, "surface">,
  opts: Pick<
    LogsOpts,
    "key" | "offset" | "limit" | "waitMs" | "stream" | "json"
  >,
): Promise<number> {
  let cursor = opts.offset;
  let resynced = false;
  for (;;) {
    const read = await call(
      client.surface.log.read({
        key: opts.key,
        ...(cursor === undefined ? {} : { offset: cursor }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.stream === undefined ? {} : { stream: opts.stream }),
        waitMs: opts.waitMs ?? FOLLOW_WAIT_MS,
      }),
    );
    if (!read.ok) return reportFailure(read, opts.json);
    const page = read.value;

    if (attemptRewound(page, cursor)) {
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
      if (page.text !== "" || !page.open) emitJsonLine(page);
    } else if (page.text !== "") {
      process.stdout.write(page.text);
    }
    cursor = page.nextOffset;

    if (logHasMore(page)) continue;
    if (!page.complete) {
      process.stderr.write(
        "\nodu: this log never got its producer's last word — it is truncated\n",
      );
      return 1;
    }
    return 0;
  }
}

async function progressStream(
  client: Pick<OduServiceClient, "surface">,
  runId: string,
  sha7: string,
): Promise<number> {
  const seen = new Map<string, string>();
  const final = await watchNodes(client, runId, (frame) => {
    for (const node of frame.nodes) {
      if (seen.get(node.id) === node.status) continue;
      seen.set(node.id, node.status);
      const event = progressEvent(sha7, node.id, nodeStateOf(node));
      if (event !== null) process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  });
  if (final === undefined) return 3;
  printVerdict({
    state: verdictStateOf(final, sha7),
    sha7,
    dirty: false,
    commitUrl: final.env.commitUrl,
    unpostedCount: final.env.owed.length,
  });
  if (final.state === "owner_lost") return WAIT_EXITS.ownerLost;
  if (!final.done) return WAIT_EXITS.stillRunning;
  return exitCode(verdictStateOf(final, sha7));
}
