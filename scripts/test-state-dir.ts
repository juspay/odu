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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (
  process.env.ODU_STATE_DIR === undefined ||
  process.env.ODU_STATE_DIR === ""
) {
  process.env.ODU_STATE_DIR = mkdtempSync(join(tmpdir(), "odu-test-state-"));
}
