/**
 * The terminal's implementation of {@link MakeRunFace} — the only thing that
 * knows `odu run` is being watched by a person or by a pipe.
 *
 * WHICH FACE, decided here and nowhere else. Where stdout points picks the
 * medium: NDJSON for `--progress json` (the byte contract `/do` and kolu's CI
 * consume), an in-place live matrix on a TTY, transition lines plus heartbeats
 * for a pipe. That choice used to sit inside the coordinator, three branches
 * deep in a function whose subject is scheduling — which is how the engine came
 * to import a terminal emulator, and why an engine served from anything other
 * than a CLI was a refactor rather than a wiring change.
 *
 * The verdict summary comes with it, for the same reason: it is a rendering.
 * The coordinator still owns the EXIT CODE — it derives that from the same
 * state, through `exitCode`, so no face can make a red run exit zero by
 * printing it wrongly.
 */

import { bold, dim, link } from "./ansi";
import { createDisplay } from "./display";
import {
  countsLine,
  outcomeOf,
  summarize,
} from "@odu/execution/common/verdict";
import type { MakeRunFace, VerdictInput } from "@odu/execution/common/presentation";
import { formatGoDuration } from "@odu/execution/common/duration";
import { logPathFor } from "@odu/run-client/nodeId";
import {
  commitLabel,
  OUTCOME_COLOR,
  OUTCOME_LABEL,
  statusGlyph,
} from "./render";
import { unpostedNote } from "@odu/execution/coordinator/statuses";

/** The bucket list and order `odu run`'s final summary has always printed.
 *  Kept explicit and zero-inclusive: the live faces drop empty buckets (a
 *  status bar has no room for `0 errored`), but this line is the run's durable
 *  verdict and is the kind of output people grep. */
const VERDICT_BUCKETS = [
  "ok",
  "failed",
  "errored",
  "skipped",
  "cancelled",
] as const;

/** How `odu run` decides which of the three renderings to be. Passed in rather
 *  than probed, so a test states the world instead of the process's tty bits
 *  deciding what a test asserts. */
export interface FaceEnv {
  progressJson: boolean;
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
}

export function faceEnv(): FaceEnv {
  return {
    progressJson: false,
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
  };
}

/**
 * Build the terminal face for a run.
 *
 * Keys are only live when stdin is a TTY as well — an output-only `run` keeps
 * the matrix but binds nothing, because a program with no keyboard behind it
 * that puts the terminal in raw mode is a program that has stolen a shell.
 */
export function cliRunFace(env: FaceEnv): MakeRunFace {
  return (seam) => {
    const display = env.progressJson
      ? createDisplay("json")
      : env.stdoutIsTty
        ? createDisplay("live", {
            interactive: env.stdinIsTty,
            hookStderr: true,
            openLog: seam.openLog,
            rerun: seam.rerun,
            onQuit: seam.onQuit,
          })
        : createDisplay("plain");
    return { display, verdict: (input) => printVerdict(input) };
  };
}

/** The human verdict summary — foreground completion only, never mid-linger
 *  where the live display still owns the screen. */
export function printVerdict(input: VerdictInput): void {
  const { state } = input;
  const counts = summarize(state);
  const shaLabel = commitLabel({ sha7: input.sha7, dirty: input.dirty });
  const lines: string[] = [
    dim(
      `── ci run summary @ ${
        input.commitUrl !== null ? link(shaLabel, input.commitUrl) : shaLabel
      } ──`,
    ),
  ];
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    const glyph = statusGlyph(node.status);
    const dur =
      node.durationMs !== null
        ? ` ${dim(formatGoDuration(node.durationMs))}`
        : "";
    const logRef =
      node.status === "failed" || node.status === "errored"
        ? dim(`  ${logPathFor(input.sha7, id)}`)
        : "";
    lines.push(`  ${glyph} ${id.padEnd(44)} ${node.status}${dur}${logRef}`);
  }
  const debt = unpostedNote(input.unpostedCount);
  // The outcome taxonomy and the counts line both come from `common/verdict` —
  // this summary, the live header and the live status bar were three
  // hand-rolled versions, and only this one knew about INCOMPLETE.
  const outcome = outcomeOf(counts);
  const label = bold(OUTCOME_COLOR[outcome](OUTCOME_LABEL[outcome]));
  lines.push(
    `${countsLine(counts, VERDICT_BUCKETS, true)} — ${label}${debt !== "" ? dim(debt) : ""}`,
  );
  process.stderr.write(`${lines.join("\n")}\n`);
}
