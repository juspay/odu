/**
 * End-to-end: the nix-built `odu` binary runs a real just DAG to completion on
 * a localhost lane, and we assert on its `--progress json` stream + exit code.
 * This exercises the seams the in-process loopback suite (src/odu.test.ts)
 * stubs: just-DAG ingest → scheduling → local lane spawn → NDJSON projection →
 * process exit code.
 */

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOduBinary,
  cleanup,
  makeFixture,
  oduRun,
  type ProgressEvent,
  terminalStatuses,
} from "./harness";

let oduBin: string;
const fixtures: string[] = [];

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000); // nix build, cold cache

afterAll(() => {
  for (const dir of fixtures) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  fixtures.push(dir);
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
  }, 300_000);

  it("propagates a node failure to a non-zero exit", () => {
    const { status, events } = oduRun(oduBin, fixture("fail"));

    const last = terminalStatuses(events);
    expect(shape(last.get("ok")).status).toBe("success");
    const boom = shape(last.get("boom"));
    expect(boom.status).toBe("failed");
    expect(boom.exit_code).toBe(1);
    expect(status).toBe(1);
  }, 300_000);

  it("emits well-formed progress events", () => {
    const { events } = oduRun(oduBin, fixture("pass"));
    const e = shape(events.find((ev) => ev.recipe === "alpha"));
    expect(typeof e.node).toBe("string");
    expect(e.node).toContain("alpha@");
    expect(typeof e.platform).toBe("string");
    expect(typeof e.log).toBe("string");
  }, 300_000);

  it("dump emits the resolved pipeline without a live run", () => {
    const dir = fixture("pass");
    const out = execFileSync(oduBin, ["dump"], {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const spec = JSON.parse(out) as { name?: unknown };
    expect(typeof spec.name).toBe("string");
  }, 60_000);
});
