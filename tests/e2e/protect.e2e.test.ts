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
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BIG, buildOduBinary, cleanup, makeFixture } from "./harness";

let oduBin: string;

// Dry-run never builds or dials anything — git rev-parse + just ingest only.
const PROTECT_TIMEOUT = 60_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000); // nix build, cold cache

// Every temp dir a test makes — fixture repos and per-test hosts dirs alike —
// lands here and is swept after the test. bun:test has no per-test
// `onTestFinished`, so one file-local registry stands in for it.
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

/** Run `odu protect --dry-run` in `dir` with a throwaway hosts file holding
 *  exactly `hosts` (an object, or a raw string for a deliberately malformed
 *  file) — hermetic against the dev machine's ambient config, like the
 *  harness's `hermeticEnv`, but per-test so a test can name an EMPTY config
 *  (the #52 case `hermeticEnv` can never express). Returns the generated
 *  `hostsFile` path too, so tests can assert the provenance messages name the
 *  file that actually won. */
function oduProtect(
  dir: string,
  hosts: Record<string, string> | string,
  args: string[] = [],
): { res: SpawnSyncReturns<string>; hostsFile: string } {
  const hostsDir = mkdtempSync(join(tmpdir(), "odu-e2e-protect-"));
  created.push(hostsDir);
  const hostsFile = join(hostsDir, "hosts.json");
  writeFileSync(
    hostsFile,
    typeof hosts === "string" ? hosts : JSON.stringify(hosts),
  );
  const res = spawnSync(oduBin, ["protect", "--dry-run", ...args], {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: { ...process.env, ODU_HOSTS: hostsFile },
  });
  return { res, hostsFile };
}

const lines = (out: string): string[] =>
  out.split("\n").filter((l) => l !== "");

const BOTH_PLATFORMS = [
  "--platform",
  "x86_64-linux",
  "--platform",
  "aarch64-darwin",
];

describe("odu protect --dry-run (black-box)", () => {
  it("enumerates explicit --platform flags with an empty hosts config (#52)", () => {
    const { res } = oduProtect(fixture("pass"), {}, BOTH_PLATFORMS);
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

  it("never parses the hosts file when --platform is explicit", () => {
    // Not just independence from the file's *membership* — the explicit path
    // must bypass hosts resolution entirely, so even an unparseable file
    // cannot break it.
    const { res } = oduProtect(fixture("pass"), "not json {{{", BOTH_PLATFORMS);
    expect(res.stderr).toBe("");
    expect(lines(res.stdout).length).toBe(4);
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("refuses a blank --platform value instead of emitting `recipe@` contexts", () => {
    // `--platform=` used to be rejected only incidentally (no host named "");
    // with enumeration decoupled the refusal must be deliberate.
    const { res } = oduProtect(fixture("pass"), {}, ["--platform", ""]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--platform");
  }, PROTECT_TIMEOUT);

  it("derives platforms from the hosts config when unsliced — and names that provenance", () => {
    const { res, hostsFile } = oduProtect(fixture("pass"), {
      "x86_64-linux": "some-host",
    });
    expect(lines(res.stdout)).toEqual([
      "alpha@x86_64-linux",
      "beta@x86_64-linux",
    ]);
    // The silent-halving trap: protection is repo-global, the hosts file is
    // machine-local. The derived set must say exactly which file it came from.
    expect(res.stderr).toContain("derives from");
    expect(res.stderr).toContain(hostsFile);
    expect(res.stderr).toContain("--platform");
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("refuses an empty platform set, naming the empty file and --platform", () => {
    const { res, hostsFile } = oduProtect(fixture("pass"), {});
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--platform");
    // The winning-but-empty file is diagnosed as such (lens fix ee4939f).
    expect(res.stderr).toContain(hostsFile);
  }, PROTECT_TIMEOUT);
});
