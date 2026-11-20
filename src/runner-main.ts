import { parseArgs } from "node:util";
import { serveOverStdio } from "@kolu/surface/peer-server";
import { createLaneRunner } from "@odu/execution/runner/runner";

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

const USAGE = "usage: odu-runner --stdio   (spawned by the odu coordinator)";

let disposeRunner: (() => void) | null = null;

const withReapedExit =
  (dispose: () => void) =>
  (reason: string, exitCode?: number): void => {
    dispose();
    log(`odu-runner: ${reason} — recipe process groups reaped, exiting`);
    if (exitCode !== undefined) process.exit(exitCode);
  };

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      stdio: { type: "boolean" },
      // `--help` is the ONE invocation that reports what this binary is and
      // exits 0. It exists for the publisher's smoke step (nix-cache.yml →
      // kolu's `publish-closure` action), which runs a program out of each
      // rewritten closure to prove the rewrite still execs, and does so with
      // stdin OPEN: `--stdio` would serve until the pipe closed, and it is the
      // runner's job to prove it STARTS, not to hang. Loading the whole module
      // graph and exiting is exactly that proof.
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    log(USAGE);
    process.exit(0);
  }
  if (values.stdio !== true) {
    log(USAGE);
    process.exit(1);
  }

  const runner = createLaneRunner();
  disposeRunner = runner.dispose;
  const reapAndExit = withReapedExit(runner.dispose);
  const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      reapAndExit(signal, signalExitCodes[signal]);
    });
  }
  log("odu-runner: idle — waiting for run.configure over stdio");
  const end = await serveOverStdio({
    group: runner.group,
    handlers: runner.handlers,
    onFirstRequest: () =>
      log("odu-runner: first RPC received — coordinator attached"),
  });
  // Synchronous post-settle cleanup — the supported window before the
  // FRAMEWORK-OWNED exit: since kolu#1858, `serveOverStdio` on the default
  // transport exits this process itself once the serve promise settles
  // (0 on a clean end, 1 on a transport error), so a live handle can no
  // longer leave an orphaned lane agent on a CI box (the T/odu/kolu/*
  // leaves). These synchronous lines run before that exit.
  reapAndExit(`stdin closed (${end.reason})`);
}

main().catch((err: unknown) => {
  const e = err as Error;
  log(`odu-runner: fatal: ${e.message}\n${e.stack ?? ""}`);
  disposeRunner?.();
  process.exit(1);
});
