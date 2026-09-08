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

import { createDisplay } from "./display";
import type { MakeRunFace } from "@odu/execution/common/presentation";
import { printVerdict } from "./render";

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

// The verdict block moved to `./render`, which is where a terminal
// projection of a run belongs and — unlike this file — is reachable from a
// public client. `odu run` is one now, and it has to print the same block.
export { printVerdict } from "./render";
