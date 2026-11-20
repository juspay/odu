import { createDisplay } from "./display";
import type { MakeRunFace } from "@odu/execution/common/presentation";
import { printVerdict } from "./render";

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

export { printVerdict } from "./render";
