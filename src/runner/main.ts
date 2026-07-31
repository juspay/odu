/**
 * odu-runner entrypoint — the lane agent HostSession spawns on each host:
 *
 *   ssh <host> /nix/store/…-odu-runner/bin/odu-runner --stdio
 *
 * Stdout is the protocol channel: all diagnostics go to fd 2 (and
 * `serveOverStdio` defensively redirects `console.log` there). The runner
 * spawns idle and serves `laneSurface`: venue `lease.*` (pool claim/probe)
 * and `run.configure` (CI). It exits when the coordinator closes the pipe —
 * one agent process per dial (lease hold and/or lane).
 */

import { parseArgs } from "node:util";
import { serveOverStdio } from "@kolu/surface/peer-server";
import { createLaneRunner } from "./runner";

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

/** Set once the runner exists so the fatal-error exit below can reap recipe
 *  process groups too — they are `detached`, so an unswept exit orphans them. */
let disposeRunner: (() => void) | null = null;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      stdio: { type: "boolean" },
    },
  });
  if (values.stdio !== true) {
    log("usage: odu-runner --stdio   (spawned by the odu coordinator)");
    process.exit(1);
  }

  const runner = createLaneRunner();
  disposeRunner = runner.dispose;
  // Death by signal must reap the recipe process groups exactly like stdin
  // EOF does. This is not hypothetical: a localhost lane's teardown
  // (surface-remote `session.destroy()`) SIGTERMs this very process, and the
  // default disposition would kill us without running `dispose()` — every
  // `detached` recipe tree (test drivers, package managers, test fork workers)
  // would reparent to init and leak forever. `dispose()` sweeps the groups
  // synchronously (SIGTERM → bounded grace → SIGKILL), so exiting right
  // after it returns is safe.
  const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      runner.dispose();
      log(`odu-runner: ${signal} — recipe process groups reaped, exiting`);
      process.exit(signalExitCodes[signal]);
    });
  }
  log("odu-runner: idle — waiting for run.configure over stdio");
  const end = await serveOverStdio({
    router: runner.router,
    onFirstRequest: () =>
      log("odu-runner: first RPC received — coordinator attached"),
  });
  // Synchronous post-settle cleanup — the supported window before the
  // FRAMEWORK-OWNED exit: since kolu#1858, `serveOverStdio` on the default
  // transport exits this process itself once the serve promise settles
  // (0 on a clean end, 1 on a transport error), so a live handle can no
  // longer leave an orphaned lane agent on a CI box (the T/odu/kolu/*
  // leaves). These synchronous lines run before that exit.
  runner.dispose();
  log(`odu-runner: stdin closed (${end.reason}) — exiting`);
}

main().catch((err: unknown) => {
  const e = err as Error;
  log(`odu-runner: fatal: ${e.message}\n${e.stack ?? ""}`);
  // A fatal exit is still a teardown path: sweep the detached recipe groups
  // (idempotent — a no-op when dispose already ran) before dying.
  disposeRunner?.();
  process.exit(1);
});
