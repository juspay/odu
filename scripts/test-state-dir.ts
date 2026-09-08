/**
 * Point the run catalog somewhere disposable, for the whole test process.
 *
 * `bun test` preloads this (see `bunfig.toml`). Without it, every suite that
 * drives the real coordinator — and several do, deliberately, because a
 * coordinator faked at that level tests nothing — would register its fixture
 * runs in the DEVELOPER'S catalog at `~/.local/state/odu/runs`. That is a test
 * suite with a side effect on the machine it runs on: history nobody asked
 * for, growing every time somebody runs `just test`.
 *
 * A preload rather than a per-suite `beforeAll` because the leak is not opt-in.
 * A suite that forgets the hook still writes to the real catalog, and it does
 * so silently — there is no assertion that fails, which is exactly the shape of
 * side effect that survives review. Setting it once, before any module is
 * imported, means no suite has to remember.
 *
 * Env vars are inherited, so this also covers the e2e suite's real `odu`
 * subprocesses: the binary under test reads the same disposable root.
 *
 * An explicit `ODU_STATE_DIR` wins — a run of the suite that wants to inspect
 * what was written points it at a directory it keeps.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (
  process.env.ODU_STATE_DIR === undefined ||
  process.env.ODU_STATE_DIR === ""
) {
  const root = mkdtempSync(join(tmpdir(), "odu-test-state-"));
  process.env.ODU_STATE_DIR = root;

  // AND REMOVED AGAIN. "Disposable" was only half true: the directory was
  // made every run and removed by nothing, so a machine that runs the suite
  // often accumulates one catalog per run — each holding whole fixture runs,
  // their logs and their manifests. Seventeen of them had piled up before
  // anybody looked.
  //
  // Idempotent and total, because `exit` does not fire for a signal and a test
  // process is interrupted more often than it finishes while somebody is
  // working on it. The signals leave by the route they arrived, so a runner
  // reading how its child died still gets the truth.
  let removed = false;
  const dispose = (): void => {
    if (removed) return;
    removed = true;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // On the way out. A cleanup that throws would replace the suite's real
      // verdict with its own.
    }
  };
  process.on("exit", dispose);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      dispose();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
