/**
 * End-to-end: `odu protect --dry-run` prints the (recipe × platform) contexts
 * branch protection would require. `protect` never dials a host, so its
 * platform enumeration must not depend on the machine's hosts config:
 * explicit `--platform` flags work against an EMPTY hosts file
 * (juspay/odu#52), and a hosts-derived platform set names its machine-local
 * provenance on stderr — branch protection is a repo-global fact, and
 * deriving it silently from one machine's config once halved a repo's
 * required contexts.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { BIG, buildOduBinary, cleanup, makeFixture } from "./harness";

let oduBin: string;

// Dry-run never builds or dials anything — git rev-parse + just ingest only.
const PROTECT_TIMEOUT = 60_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000); // nix build, cold cache

function fixture(name: string): string {
  const dir = makeFixture(name);
  onTestFinished(() => cleanup(dir));
  return dir;
}

/** Run `odu protect --dry-run` in `dir` with a throwaway hosts file holding
 *  exactly `hosts` — hermetic against the dev machine's ambient config, like
 *  the harness's `hermeticEnv`, but per-test so a test can name an EMPTY
 *  config (the #52 case `hermeticEnv` can never express). */
function oduProtect(
  dir: string,
  hosts: Record<string, string>,
  args: string[] = [],
): SpawnSyncReturns<string> {
  const hostsDir = mkdtempSync(join(tmpdir(), "odu-e2e-protect-"));
  onTestFinished(() => cleanup(hostsDir));
  const hostsFile = join(hostsDir, "hosts.json");
  writeFileSync(hostsFile, JSON.stringify(hosts));
  return spawnSync(oduBin, ["protect", "--dry-run", ...args], {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: { ...process.env, ODU_HOSTS: hostsFile },
  });
}

const lines = (out: string): string[] =>
  out.split("\n").filter((l) => l !== "");

describe("odu protect --dry-run (black-box)", () => {
  it("enumerates explicit --platform flags with an empty hosts config (#52)", () => {
    const res = oduProtect(fixture("pass"), {}, [
      "--platform",
      "x86_64-linux",
      "--platform",
      "aarch64-darwin",
    ]);
    // Explicit platforms are the operator's own decision — no provenance
    // warning, no host requirement, just the contexts.
    expect(res.stderr).toBe("");
    expect(lines(res.stdout).sort()).toEqual([
      "alpha@aarch64-darwin",
      "alpha@x86_64-linux",
      "beta@aarch64-darwin",
      "beta@x86_64-linux",
    ]);
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("derives platforms from the hosts config when unsliced — and names that provenance", () => {
    const res = oduProtect(fixture("pass"), { "x86_64-linux": "some-host" });
    expect(lines(res.stdout)).toEqual([
      "alpha@x86_64-linux",
      "beta@x86_64-linux",
    ]);
    // The silent-halving trap: protection is repo-global, the hosts file is
    // machine-local. The derived set must say where it came from.
    expect(res.stderr).toContain("derives from");
    expect(res.stderr).toContain("--platform");
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("refuses an empty platform set, pointing at --platform", () => {
    const res = oduProtect(fixture("pass"), {});
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--platform");
  }, PROTECT_TIMEOUT);
});
