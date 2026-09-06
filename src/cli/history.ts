/**
 * The native face of the durable run catalog — `odu logs --run`,
 * `odu wait --run`, and the `odu history` sub-commands.
 *
 * Everything here answers about a run NOBODY IS SERVING. The live commands
 * next door (`status` / `attach` / `logs <node>` / `wait`) dial `.ci/odu.sock`
 * and are unchanged; these read `@odu/run-history` off disk, so they work after
 * the coordinator has exited, after the checkout has been deleted, and from a
 * different terminal than the one that started the run.
 *
 * Two things this module is careful about, because they are what the loop is
 * for:
 *
 * **Machine-readable output must not need a TTY.** Every `-o json` path here
 * writes one complete JSON value and nothing else to stdout, in one write, with
 * every human sentence on stderr. An agent piping `odu wait --run … -o json`
 * through a shell gets a parseable line without `stdbuf`, and that is a
 * property of where the bytes go rather than of how the terminal is set up.
 *
 * **Exits are a contract, not a side effect.** `odu wait --run` distinguishes
 * "it failed" from "not yet" from "its coordinator died", because those need
 * three different next moves and a script that cannot tell them apart will
 * take the wrong one. {@link WAIT_EXITS} names them, and they are the reason
 * this file exists rather than a flag on the live wait.
 */

import {
  type Attention,
  type AttentionState,
} from "@odu/run-history/attention";
import {
  DEFAULT_ATTENTION_DEADLINE_MS,
  describeCatalog,
  readAttention,
  resolveCursor,
  resolveRun,
  waitForAttention,
} from "@odu/run-history/query";
import { importCheckout } from "@odu/run-history/import";
import { DEFAULT_RETENTION_MS, pruneCatalog } from "@odu/run-history/retention";
import {
  attemptsFor,
  type CatalogRow,
  listRuns,
  readAttemptLog,
  readAttemptRecord,
  readExpiry,
  readManifest,
  readVerdict,
  type RunHandle,
} from "@odu/run-history/store";
import { shortSha } from "@odu/run-history/ids";
import { formatRef } from "@odu/run-history/legacy/record";
import { packagedLauncher, type RunLauncher } from "../coordinator/launcher";
import { type RetryReceipt, retryRun } from "../coordinator/recovery";
import { gitTopLevel } from "../common/git";
import { formatAgo } from "./runs";

/**
 * What `odu wait --run` exits with.
 *
 * The live `odu wait` has always been 0-or-1, and it stays that way — this
 * table is for the addressed wait only, where the extra states are real and
 * a caller has to act on them differently:
 *
 * | exit | meaning | what to do next |
 * | --- | --- | --- |
 * | 0 | settled, and it passed | nothing |
 * | 1 | there is a failure to act on | read `unresolved_failures`, fix, retry |
 * | 2 | still going, nothing red yet | ask again with the returned cursor |
 * | 3 | its coordinator is gone and it never finalized | start a new run |
 * | 4 | no such run, or its evidence expired | check `odu runs` |
 * | 5 | the request itself was refused (a cursor for another run, say) | resync |
 *
 * 1 DOES NOT MEAN SETTLED, and that is the row that carries the whole point of
 * the command. A unit lane that goes red at eight seconds alongside a lane
 * that has ninety to go is a run with a failure you can act on NOW; making the
 * caller wait for settlement to be told so is the behaviour this release
 * exists to remove, and giving it the same exit as "nothing has happened yet"
 * would remove the behaviour and keep the confusion.
 *
 * 2 is the mirror of that: still going, and nothing red. Collapsing it into
 * the failure exit is how a bounded wait turns into a loop that treats a slow
 * lane as a broken one.
 */
export const WAIT_EXITS = {
  passed: 0,
  failed: 1,
  stillRunning: 2,
  ownerLost: 3,
  unknownRun: 4,
  refused: 5,
} as const;

/** The exit for a run that has not settled AND has nothing red to act on —
 *  total over `AttentionState` so a new state is a compile error rather than a
 *  wait that silently exits 1. Two entries are unreachable by construction and
 *  present for that totality: `settled` is answered from the verdict, and a
 *  red run is answered before this table is consulted. See
 *  {@link waitExitFor}, which owns both. */
const EXIT_FOR: Record<AttentionState, number> = {
  settled: WAIT_EXITS.failed,
  still_running: WAIT_EXITS.stillRunning,
  owner_lost: WAIT_EXITS.ownerLost,
  expired: WAIT_EXITS.unknownRun,
  unknown_run: WAIT_EXITS.unknownRun,
};

/** The one place a wait's exit is decided, so the CLI and any test that pins
 *  the contract read the same rule. */
export function waitExitFor(attention: Attention): number {
  if (attention.settled) {
    return attention.passed ? WAIT_EXITS.passed : WAIT_EXITS.failed;
  }
  // A red node is a failure whether or not the slow lanes have finished — the
  // run cannot pass from here. Reporting it as "still running" would be true
  // and useless: the caller has something to act on, and the exit is how it
  // finds that out without parsing the payload.
  if (attention.unresolved_failures.length > 0) return WAIT_EXITS.failed;
  return EXIT_FOR[attention.state];
}

/** The checkout these commands are scoped to. Outside a git checkout the cwd
 *  stands in — an explicit `--run <id>` still resolves, since a run id names a
 *  run without needing a repo. */
function checkoutRoot(): string {
  return gitTopLevel() ?? process.cwd();
}

/** One write, one JSON value, stdout. Every human word goes to stderr. */
function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// ── odu logs --run ──────────────────────────────────────────────────────────

export interface DurableLogsOpts {
  run: string;
  node: string;
  /** Which attempt. Absent means the latest recorded one. */
  attempt?: number;
  /** Byte offset; negative counts back from the end (a tail). */
  offset?: number;
  /** Byte limit. Absent means to the end. */
  limit?: number;
  json: boolean;
  catalogRoot?: string;
}

/**
 * `odu logs --run R [--attempt N] NODE` — one attempt's evidence, by address.
 *
 * BYTES, not lines. A caller resuming a long log wants "from where I stopped",
 * which is exact and cheap in bytes and approximate and expensive in lines; and
 * the completeness question — did this log get its producer's last word — is
 * answered by a FIELD rather than by whether the output happens to end in a
 * summary. A log that is short says so, in both output modes.
 */
export function durableLogsCommand(opts: DurableLogsOpts): number {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const found = resolveRun(opts.run, { ...catalog, repoRoot: checkoutRoot() });
  if (!found.ok) {
    process.stderr.write(`${found.message}\n`);
    // The SAME code the wait uses for the same condition. A caller scripting
    // "read the log, and if the run is gone say so" should not have to learn
    // that `logs` and `wait` disagree about what "no such run" is worth.
    return WAIT_EXITS.unknownRun;
  }
  const handle = found.handle;
  const expiry = readExpiry(handle);
  if (expiry !== null) {
    process.stderr.write(
      `odu: run ${handle.runId}'s evidence expired on ` +
        `${new Date(expiry.expiredAt).toISOString()} (it ended ${expiry.outcome}); ` +
        "logs are pruned after the retention window — see `odu history prune --help`\n",
    );
    return WAIT_EXITS.unknownRun;
  }
  const attempts = attemptsFor(handle, opts.node);
  if (attempts.length === 0) {
    process.stderr.write(
      `odu: run ${handle.runId} has no evidence for "${opts.node}"` +
        `${nodeHint(handle)}\n`,
    );
    return 1;
  }
  const attempt = opts.attempt ?? attempts[attempts.length - 1];
  if (attempt === undefined || !attempts.includes(attempt)) {
    process.stderr.write(
      `odu: run ${handle.runId} has no attempt ${opts.attempt} of "${opts.node}" ` +
        `(recorded: ${attempts.join(", ")})\n`,
    );
    return 1;
  }
  const slice = readAttemptLog(handle, opts.node, attempt, {
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  });
  if (slice === null) {
    process.stderr.write(
      `odu: run ${handle.runId} recorded attempt ${attempt} of "${opts.node}" ` +
        "but its log is unreadable\n",
    );
    return 1;
  }
  const record = readAttemptRecord(handle, opts.node, attempt);
  if (opts.json) {
    emitJson({
      run: handle.runId,
      node: opts.node,
      attempt,
      attempts,
      status: record?.status ?? null,
      exit_code: record?.exitCode ?? null,
      signal: record?.signal ?? null,
      placement: record?.placement ?? null,
      offset: slice.offset,
      bytes_read: slice.bytesRead,
      // Where to continue. A consumer must NOT recompute this from `text`: the
      // decode is non-fatal, so a range that split a multibyte character has
      // more bytes in the string than were read off the file, and resuming
      // from that number skips real log content.
      next_offset: slice.offset + slice.bytesRead,
      size: slice.size,
      // Two different facts, and a reader needs both: `eof` says this SLICE
      // reached the end of the file, `complete` says the file is everything
      // there ever was.
      eof: slice.eof,
      complete: record?.logComplete ?? false,
      truncation_reason: record?.logTruncationReason ?? null,
      text: slice.text,
    });
    return 0;
  }
  process.stdout.write(slice.text);
  // On stderr so a `> file` redirect captures the log and not the caveat.
  if (record !== null && !record.logComplete) {
    process.stderr.write(
      `odu: this log is INCOMPLETE — ${record.logTruncationReason ?? "its producer never said it was finished"}\n`,
    );
  }
  if (!slice.eof) {
    const next = slice.offset + slice.bytesRead;
    process.stderr.write(
      `odu: showing bytes ${slice.offset}–${next} of ${slice.size}; ` +
        `continue with --offset ${next}\n`,
    );
  }
  return 0;
}

/** What else this run has evidence for — the refusal's second sentence, so a
 *  caller who mistyped a node id does not have to go looking. Bounded: a
 *  wide fanout would otherwise print a screen of ids under an error. */
function nodeHint(handle: RunHandle): string {
  const manifest = readManifest(handle);
  if (manifest === null) return "";
  const verdict = readVerdict(handle);
  const known = verdict === null ? [] : [...verdict.failed, ...verdict.errored];
  return known.length === 0
    ? ""
    : ` (this run's red nodes: ${known.slice(0, 6).join(", ")})`;
}

// ── odu wait --run ──────────────────────────────────────────────────────────

export interface DurableWaitOpts {
  run: string;
  after?: string;
  deadlineMs?: number;
  settle: boolean;
  json: boolean;
  catalogRoot?: string;
}

/**
 * `odu wait --run R [--after CURSOR]` — block until something is worth
 * reporting, then print one attention payload.
 *
 * "Worth reporting" is the point: a settled run, an actionable red (a failure
 * whose log has had its last word), an owner that is provably gone, or — when
 * a cursor was supplied — any event the caller has not seen. It does NOT wait
 * for the slow lanes. That is the difference between learning about a unit
 * failure at eight seconds and learning about it at ninety.
 */
export async function durableWaitCommand(
  opts: DurableWaitOpts,
): Promise<number> {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const found = resolveRun(opts.run, { ...catalog, repoRoot: checkoutRoot() });
  if (!found.ok) {
    process.stderr.write(`${found.message}\n`);
    return WAIT_EXITS.unknownRun;
  }
  const handle = found.handle;
  const cursor = resolveCursor(handle, opts.after);
  if (!cursor.ok) {
    // A refusal with a ROUTE. A cursor that cannot be honoured is the one
    // moment an agent is guaranteed to be confused, and "resync with this
    // exact command" is a better answer than an error it has to interpret.
    if (opts.json) {
      emitJson({
        error: "cursor_refused",
        message: cursor.message,
        resync: cursor.resync,
        run: handle.runId,
      });
    } else {
      process.stderr.write(`${cursor.message}\n  resync: ${cursor.resync}\n`);
    }
    return WAIT_EXITS.refused;
  }
  const attention = await waitForAttention(handle, {
    ...(cursor.cursor === null ? {} : { after: cursor.cursor }),
    deadlineMs: opts.deadlineMs ?? DEFAULT_ATTENTION_DEADLINE_MS,
    settle: opts.settle,
  });
  if (opts.json) {
    emitJson(attention);
  } else {
    process.stdout.write(renderAttention(attention));
  }
  return waitExitFor(attention);
}

/** The human rendering of an attention payload. Deliberately short: the
 *  failures and how to read more, not a transcript. An operator who wants the
 *  transcript has `--after` and `-o json`. */
export function renderAttention(a: Attention): string {
  const lines: string[] = [];
  const ref =
    a.run.sha7 === null ? a.run.id : `${a.run.id}  ${formatRef(a.run.sha7, a.run.seq)}`;
  // The run's own word, not a re-derivation of it: `passed: false` covers a
  // red run AND one that never finished, and telling an operator "failed" for
  // the second sends them looking for a broken test that does not exist.
  lines.push(`${ref}  ${a.state}${a.outcome === null ? "" : ` · ${a.outcome}`}`);
  for (const f of a.unresolved_failures) {
    const where =
      f.placement.host === null
        ? f.placement.platform
        : `${f.placement.platform} on ${f.placement.host}`;
    const how =
      f.signal !== null
        ? `${f.signal} (exit ${f.exit_code})`
        : `exit ${f.exit_code ?? "?"}`;
    lines.push(`  ✗ ${f.node}  attempt ${f.attempt}  ${how}  ${where}`);
    if (!f.log_complete) {
      lines.push(
        `      log INCOMPLETE — ${f.log_truncation_reason ?? "its producer never said it was finished"}`,
      );
    }
    for (const line of f.excerpt.split("\n").slice(-8)) {
      if (line.trim() !== "") lines.push(`      ${line}`);
    }
    lines.push(`      odu logs ${f.log_key}`);
  }
  for (const debt of a.reporting_debt) {
    lines.push(`  ⇐ github? ${debt.context} — ${debt.last_error}`);
  }
  if (a.unreadable_events > 0) {
    lines.push(`  (${a.unreadable_events} journal events this build could not read)`);
  }
  lines.push(`  cursor ${a.cursor}${a.has_more ? ` (+${a.remaining} more)` : ""}`);
  return `${lines.join("\n")}\n`;
}

// ── odu rerun --run ─────────────────────────────────────────────────────────

export interface RetryCommandOpts {
  run: string;
  selector: string;
  requestId?: string;
  /** Refuse unless the selector's node is on exactly this attempt. */
  expectAttempt?: number;
  json: boolean;
  catalogRoot?: string;
  /** Injected by tests; production binds the packaged coordinator launcher. */
  launcher?: RunLauncher;
}

/**
 * `odu rerun --run R SELECTOR` — retry against a recorded run.
 *
 * The face is thin on purpose: the policy is `src/coordinator/recovery.ts`,
 * because PR 2's service must reach the same decision and a policy that lived
 * in a CLI would have to be reimplemented there. What belongs here is the
 * argument grammar, the two output modes, and the exit.
 */
export async function retryCommand(opts: RetryCommandOpts): Promise<number> {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const found = resolveRun(opts.run, { ...catalog, repoRoot: checkoutRoot() });
  if (!found.ok) {
    process.stderr.write(`${found.message}\n`);
    return WAIT_EXITS.unknownRun;
  }
  const outcome = await retryRun({
    runId: found.handle.runId,
    selector: opts.selector,
    ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
    ...(opts.expectAttempt === undefined
      ? {}
      : {
          expectAttempt: {
            node: opts.selector,
            attempt: opts.expectAttempt,
          },
        }),
    catalog,
    launcher: opts.launcher ?? packagedLauncher(),
  });
  if (!outcome.ok) {
    if (opts.json) {
      emitJson({
        error: "retry_refused",
        message: outcome.message,
        ...(outcome.suggestion === undefined ? {} : { suggestion: outcome.suggestion }),
      });
    } else {
      process.stderr.write(`${outcome.message}\n`);
      if (outcome.suggestion !== undefined) {
        // ARGV, one token per element — a person can read it and re-issue it,
        // and nothing anywhere is invited to hand it to a shell.
        process.stderr.write(`  try: ${outcome.suggestion.join(" ")}\n`);
      }
    }
    return 1;
  }
  if (opts.json) {
    emitJson({ ...outcome.receipt, replayed: outcome.replayed });
    return 0;
  }
  process.stdout.write(renderRetry(outcome.receipt, outcome.replayed));
  return 0;
}

/** The human rendering of a retry receipt. Says which of the two things
 *  happened, because "a new attempt on the run you named" and "a whole new run
 *  linked to it" are different enough that guessing is expensive. */
export function renderRetry(receipt: RetryReceipt, replayed: boolean): string {
  const lines: string[] = [];
  const what =
    receipt.mode === "live"
      ? `reran ${receipt.roots.join(", ")} on ${receipt.effective_run}`
      : `started ${receipt.effective_run} — a new run replaying ${receipt.parent_run ?? "?"}`;
  lines.push(`odu: ${what}${replayed ? " (already done; replayed)" : ""}`);
  if (receipt.reset_dependants.length > 0) {
    lines.push(`  resets ${receipt.reset_dependants.join(", ")}`);
  }
  for (const a of receipt.attempts) {
    lines.push(`  ${a.node} is now on attempt ${a.attempt}`);
  }
  if (receipt.mode === "relaunched") {
    // The honest scope, stated where somebody will read it: this run covers a
    // selection, and its verdict is not the pipeline's.
    lines.push(
      `  scope: ${receipt.scope.selectors.join(", ")} at ${receipt.sha.slice(0, 7)} ` +
        "(a selection — its verdict does not speak for the whole pipeline)",
    );
  }
  if (receipt.lifetime !== undefined) lines.push(`  ${receipt.lifetime}`);
  lines.push(`  watch it: odu wait --run ${receipt.effective_run} --after ${receipt.cursor}`);
  return `${lines.join("\n")}\n`;
}

// ── odu history ─────────────────────────────────────────────────────────────

export interface HistoryListOpts {
  json: boolean;
  /** Every checkout's runs, not just this one's. */
  all: boolean;
  limit?: number;
  catalogRoot?: string;
}

/** `odu history list` — the catalog, newest first. `odu runs` still answers
 *  about THIS checkout (and still reads the `.ci` ledger beside the catalog);
 *  this is the per-user view PR 2's service will read from the same place. */
export function historyListCommand(opts: HistoryListOpts): number {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const rows = listRuns({
    ...catalog,
    ...(opts.all ? {} : { repoRoot: checkoutRoot() }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  });
  if (opts.json) {
    emitJson(rows);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(
      `no runs in the catalog at ${describeCatalog(catalog)}\n` +
        (opts.all ? "" : "(this checkout only — pass --all for every checkout)\n"),
    );
    return 0;
  }
  process.stdout.write(renderCatalog(rows, Date.now()));
  return 0;
}

/**
 * What a listed run ENDED AS, or why it has no ending.
 *
 * A run with no verdict has two very different explanations, and telling them
 * apart is the whole reason `liveness` is a three-state value rather than an
 * endpoint string. `owner lost` is a coordinator that was killed before it
 * could finalize — the case this release exists to make visible — and it used
 * to render as `running`, permanently, because the only signal the listing had
 * was an endpoint the manifest stamped once at registration and nothing ever
 * cleared. A crashed run therefore claimed to be executing for the life of the
 * catalog, in exactly the listing an operator scans to find out what is still
 * going.
 */
export function catalogOutcome(row: CatalogRow): string {
  if (row.expiry !== null) return `expired (${row.expiry.outcome})`;
  if (row.verdict !== null) return row.verdict.outcome;
  if (row.liveness === "owned") return "running";
  if (row.liveness === "owner_lost") return "owner lost";
  return "unfinished";
}

/** The catalog table: run id · ref · outcome · where · age. Pure over `now`. */
export function renderCatalog(rows: readonly CatalogRow[], now: number): string {
  const cells = rows.map((row) => {
    const m = row.manifest;
    const outcome = catalogOutcome(row);
    return {
      id: row.runId,
      ref: m === null ? "?" : formatRef(shortSha(m.sha), m.seq),
      outcome,
      where: m?.repo ?? m?.repoRoot ?? "?",
      age:
        m === null ? "" : formatAgo(Math.max(0, now - m.createdAt)),
    };
  });
  const width = (pick: (c: (typeof cells)[number]) => string): number =>
    Math.max(...cells.map((c) => pick(c).length));
  const w = {
    id: width((c) => c.id),
    ref: width((c) => c.ref),
    outcome: width((c) => c.outcome),
    where: width((c) => c.where),
  };
  return `${cells
    .map(
      (c) =>
        `${c.id.padEnd(w.id)}  ${c.ref.padEnd(w.ref)}  ${c.outcome.padEnd(
          w.outcome,
        )}  ${c.where.padEnd(w.where)}  ${c.age}`,
    )
    .join("\n")}\n`;
}

export interface HistoryShowOpts {
  run: string;
  json: boolean;
  after?: string;
  catalogRoot?: string;
}

/** `odu history show --run R` — the attention payload for a run, without
 *  waiting. The read half of `odu wait --run`, so a caller that already knows
 *  the run is finished does not have to phrase its question as a wait. */
export function historyShowCommand(opts: HistoryShowOpts): number {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const found = resolveRun(opts.run, { ...catalog, repoRoot: checkoutRoot() });
  if (!found.ok) {
    process.stderr.write(`${found.message}\n`);
    return WAIT_EXITS.unknownRun;
  }
  const cursor = resolveCursor(found.handle, opts.after);
  if (!cursor.ok) {
    process.stderr.write(`${cursor.message}\n  resync: ${cursor.resync}\n`);
    return WAIT_EXITS.refused;
  }
  const attention = readAttention(
    found.handle,
    cursor.cursor === null ? {} : { after: cursor.cursor },
  );
  if (opts.json) emitJson(attention);
  else process.stdout.write(renderAttention(attention));
  return waitExitFor(attention);
}

export interface HistoryImportOpts {
  json: boolean;
  dryRun: boolean;
  catalogRoot?: string;
}

/** `odu history import` — bring this checkout's `.ci` records into the
 *  catalog. Explicit, and nothing is deleted: see the import module for why
 *  an automatic migration would be a claim the old bytes cannot support. */
export function historyImportCommand(opts: HistoryImportOpts): number {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const report = importCheckout({
    ...catalog,
    repoRoot: checkoutRoot(),
    dryRun: opts.dryRun,
  });
  if (opts.json) {
    emitJson(report);
    return 0;
  }
  const verb = opts.dryRun ? "would import" : "imported";
  process.stdout.write(
    `${verb} ${report.imported.length} run(s) into ${report.catalog}` +
      `${report.skipped.length > 0 ? `, ${report.skipped.length} already there` : ""}\n`,
  );
  for (const row of report.imported) {
    process.stdout.write(`  ${row.runId}  ${row.ref}\n`);
  }
  if (report.imported.length > 0) {
    process.stdout.write(
      "note: imported runs carry attempt 1 only and their logs are marked\n" +
        "      incomplete — the `.ci` layout kept one log per (commit, node)\n" +
        "      and overwrote it on rerun, so completeness was never recorded.\n",
    );
  }
  return 0;
}

export interface HistoryPruneOpts {
  json: boolean;
  dryRun: boolean;
  retentionDays?: number;
  catalogRoot?: string;
}

/** `odu history prune` — expire finished runs past the retention window.
 *  Active runs and runs that never finalized are kept whatever their age; see
 *  the retention module. */
export function historyPruneCommand(opts: HistoryPruneOpts): number {
  const catalog = opts.catalogRoot === undefined ? {} : { root: opts.catalogRoot };
  const retentionMs =
    opts.retentionDays === undefined
      ? DEFAULT_RETENTION_MS
      : opts.retentionDays * 24 * 60 * 60 * 1000;
  const report = pruneCatalog({ ...catalog, retentionMs, dryRun: opts.dryRun });
  if (opts.json) {
    emitJson(report);
    return 0;
  }
  const verb = opts.dryRun ? "would expire" : "expired";
  process.stdout.write(`${verb} ${report.expired.length} run(s)\n`);
  for (const runId of report.expired) process.stdout.write(`  ${runId}\n`);
  for (const kept of report.kept) {
    process.stdout.write(`  kept ${kept.runId} — ${kept.reason}\n`);
  }
  return 0;
}
