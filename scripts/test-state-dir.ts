import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuiteTeardown } from "../tests/e2e/suiteTeardown";

if (
  process.env.ODU_STATE_DIR === undefined ||
  process.env.ODU_STATE_DIR === ""
) {
  const root = mkdtempSync(join(tmpdir(), "odu-test-state-"));
  process.env.ODU_STATE_DIR = root;

  let removed = false;
  const dispose = (): void => {
    if (removed) return;
    removed = true;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
    }
  };
  // A PRELOAD's `afterAll` is global — it runs after the last test in the
  // process, which is exactly when this directory stops being needed.
  // `process.on("exit")` is NOT an option: `bun test` ends without calling exit
  // listeners, so a teardown hung on that hook never runs at all. Nor is an
  // `afterAll` from an ordinary imported module: it registers into the scope of
  // the file that imported it FIRST, so it fires at the end of that one file
  // and takes the shared service with it while ten files still need it.
  //
  // Which is why this is also where a suite hands in its own teardown. See
  // `registerSuiteTeardown`.
  //
  // With a budget of its own: the e2e teardown asks the service for its pid (a
  // process start), stops it, and removes every fixture and world the suite
  // made — a thousand-run catalog among them — and bun's 5 s hook default
  // failed the last file of a green run for taking longer than that.
  afterAll(() => {
    runSuiteTeardown();
    dispose();
  }, 120_000);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      dispose();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
