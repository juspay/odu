/**
 * End-to-end: the nix-built `odu` binary runs a real just DAG to completion on
 * a localhost lane, and we assert on its `--progress json` stream + exit code.
 * This exercises the seams the in-process loopback suite (src/odu.test.ts)
 * stubs: just-DAG ingest → scheduling → local lane spawn → NDJSON projection →
 * process exit code.
 */

import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
  BIG,
  buildOduBinary,
  cleanup,
  makeFixture,
  oduRun,
  type ProgressEvent,
  terminalStatuses,
} from "./harness";

let oduBin: string;

// One full `odu run` per test, with the binary already built — generous to
// absorb the localhost lane realise/spawn without flaking on a busy machine.
const RUN_TIMEOUT = 300_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000); // nix build, cold cache

// Materialize a fixture and register its teardown with the running test, so
// creation and cleanup are co-located (no module-level accumulator to sweep).
function fixture(name: string): string {
  const dir = makeFixture(name);
  onTestFinished(() => cleanup(dir));
  return dir;
}

const shape = (e: ProgressEvent | undefined): ProgressEvent => {
  expect(e).toBeDefined();
  return e as ProgressEvent;
};

describe("odu run (local, black-box)", () => {
  it("runs a passing DAG to success and exits 0", () => {
    const { status, events } = oduRun(oduBin, fixture("pass"));

    expect(events.length).toBeGreaterThan(0);
    const last = terminalStatuses(events);
    // `default` is the [metadata("ci")] root — the pipeline *name*, not a
    // node; only its reachable recipes (plus the builtin _ci-setup) run.
    for (const recipe of ["_ci-setup", "alpha", "beta"]) {
      expect(shape(last.get(recipe)).status).toBe("success");
    }
    expect(status).toBe(0);
  }, RUN_TIMEOUT);

  it("propagates a node failure to a non-zero exit", () => {
    const { status, events } = oduRun(oduBin, fixture("fail"));

    const last = terminalStatuses(events);
    expect(shape(last.get("ok")).status).toBe("success");
    const boom = shape(last.get("boom"));
    expect(boom.status).toBe("failed");
    expect(boom.exit_code).toBe(1);
    expect(status).toBe(1);
  }, RUN_TIMEOUT);

  it("emits well-formed progress events", () => {
    const { events } = oduRun(oduBin, fixture("pass"));
    const e = shape(events.find((ev) => ev.recipe === "alpha"));
    expect(typeof e.node).toBe("string");
    expect(e.node).toContain("alpha@");
    expect(typeof e.platform).toBe("string");
    expect(typeof e.log).toBe("string");
  }, RUN_TIMEOUT);

  it("dump emits the resolved pipeline without a live run", () => {
    const dir = fixture("pass");
    const out = execFileSync(oduBin, ["dump"], {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: BIG,
    });
    const spec = JSON.parse(out) as { name?: unknown };
    expect(typeof spec.name).toBe("string");
  }, 60_000);
});
