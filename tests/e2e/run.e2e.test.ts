import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  cleanup,
  hermeticEnv,
  makeFixture,
  oduRun,
  type ProgressEvent,
  terminalStatuses,
} from "./harness";

let oduBin: string;

const RUN_TIMEOUT = 300_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

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

describe("odu ci run (local, black-box)", () => {
  it("runs a passing DAG to success and exits 0", () => {
    const { status, events, stderr } = oduRun(oduBin, fixture("pass"));

    expect(events.length).toBeGreaterThan(0);
    const last = terminalStatuses(events);
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
    const out = execFileSync(oduBin, ["ci", "dump"], {
      cwd: dir,
      env: hermeticEnv,
      encoding: "utf-8",
      maxBuffer: BIG,
    });
    const spec = JSON.parse(out) as { name?: unknown };
    expect(typeof spec.name).toBe("string");
  }, 60_000);
});
