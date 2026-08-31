/**
 * End-to-end: the nix-built `odu` binary runs a real just DAG to completion on
 * a localhost lane, and we assert on its `--progress json` stream + exit code.
 * This exercises the seams the in-process loopback suite (src/odu.test.ts)
 * stubs: just-DAG ingest → scheduling → local lane spawn → NDJSON projection →
 * process exit code.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
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

// Materialize a fixture and register its teardown on a file-local registry the
// `afterEach` below sweeps — bun:test has no per-test `onTestFinished`, so the
// registry is what keeps creation and cleanup co-located in one helper.
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

const shape = (e: ProgressEvent | undefined): ProgressEvent => {
  expect(e).toBeDefined();
  return e as ProgressEvent;
};

describe("odu run (local, black-box)", () => {
  it("runs a passing DAG to success and exits 0", () => {
    const { status, events, stderr } = oduRun(oduBin, fixture("pass"));

    expect(events.length).toBeGreaterThan(0);
    const last = terminalStatuses(events);
    // `default` is the [metadata("ci")] root — the pipeline *name*, not a
    // node; only its reachable recipes (plus the builtin _ci-setup) run.
    for (const recipe of ["_ci-setup", "alpha", "beta"]) {
      expect(shape(last.get(recipe)).status).toBe("success");
    }
    expect(status).toBe(0);
    // juspay/odu#18: every green run tears down the lane pipe AFTER the
    // nodes have already passed. That close used to crash with unhandled
    // `write EPIPE` and pick exit 1; the summary is how we tell a clean
    // verdict from a crash that happened on the way out.
    expect(stderr).toContain("ci run summary");
    expect(stderr).not.toContain("write EPIPE");
    expect(stderr).not.toContain("after its log ended");
  }, RUN_TIMEOUT);

  it("runs a consumer that exports no odu-runner — the runner is odu's own (#30)", () => {
    const dir = fixture("pass");
    // The fixture is a plain repo with no flake.nix: it re-exports nothing.
    // Before #30's fix the coordinator evaluated `<consumer>#…odu-runner` and
    // every lane died at _ci-setup; now the runner is resolved from the baked
    // ODU_RUNNER_FLAKE (odu's own flake), so setup succeeds and the run is green.
    expect(existsSync(join(dir, "flake.nix"))).toBe(false);
    const { status, events } = oduRun(oduBin, dir);
    expect(shape(terminalStatuses(events).get("_ci-setup")).status).toBe(
      "success",
    );
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
