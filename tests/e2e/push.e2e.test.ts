import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { formatLogKey } from "@odu/service-client/logKey";
import {
  BIG,
  buildOduBinary,
  cleanup,
  currentNixSystem,
  scratchDir,
  suitePortFor,
} from "./harness";
import { type WebWorld, startWebService } from "./webHarness";

const ROOT = "e2e-run-push-root";
const FOREIGN_ROOT = "e2e-run-push-foreign-root";

let odu: string;
let home: WebWorld;
let foreign: WebWorld;
const dirs: string[] = [];

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}
function run(
  world: WebWorld,
  argv: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Ran {
  const res = spawnSync(odu, argv, {
    env: { ...world.env, ...(opts.env ?? {}) },
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function surface(world: WebWorld, argv: string[], input: unknown): unknown {
  const res = run(world, [
    "surface",
    ...argv,
    "--input",
    JSON.stringify(input),
    "--json",
  ]);
  if (res.status !== 0) {
    throw new Error(`odu surface ${argv.join(" ")} exited ${res.status}:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function bucket(
  world: WebWorld,
  rootToken: string,
  name: string,
): { url: string; publicKey: string } {
  surface(world, ["cache", "bucket_create"], {
    rootToken,
    name,
    public: true,
    retentionDays: 0,
  });
  const facts = surface(world, ["cache", "bucket_describe"], { bucket: name }) as {
    url: string;
    publicKey: string;
  };
  return { url: facts.url, publicKey: facts.publicKey };
}

function objectsIn(world: WebWorld, rootToken: string, name: string): number {
  const listed = surface(world, ["cache", "bucket_list"], { rootToken }) as {
    buckets: { name: string; objects: number }[];
  };
  return listed.buckets.find((row) => row.name === name)?.objects ?? -1;
}

function fixture(substituter: string, publicKey: string): string {
  const dir = scratchDir("odu-e2e-run-push-");
  dirs.push(dir);
  writeFileSync(
    join(dir, "flake.nix"),
    `{
  nixConfig = {
    extra-substituters = [ "${substituter}" ];
    extra-trusted-public-keys = [ "${publicKey}" ];
  };
  outputs = { ... }: { };
}
`,
  );
  writeFileSync(
    join(dir, "build.nix"),
    `let
  bash = builtins.storePath (builtins.getEnv "ODU_E2E_BASH");
in
derivation {
  name = "odu-run-push-e2e";
  system = builtins.currentSystem;
  builder = "\${bash}/bin/bash";
  args = [ "-c" "echo warmed-by-odu > $out" ];
}
`,
  );
  writeFileSync(
    join(dir, "justfile"),
    `[metadata("ci")]
default: build

build:
    #!/usr/bin/env bash
    set -euo pipefail
    bash=$(readlink -f "$(command -v bash)")
    export ODU_E2E_BASH=\${bash%/bin/bash}
    nix build --impure --file build.nix --out-link result
    readlink -f result
`,
  );
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=e2e@odu.test",
    "-c",
    "user.name=odu e2e",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return dir;
}

function moduleFixture(substituter: string, publicKey: string): string {
  const dir = fixture(substituter, publicKey);
  mkdirSync(join(dir, "tooling", "nested"), { recursive: true });
  writeFileSync(join(dir, "tooling", "mod.just"), "mod deep 'nested/mod.just'\n");
  writeFileSync(
    join(dir, "tooling", "nested", "mod.just"),
    `[metadata("ci")]
build:
    #!/usr/bin/env bash
    set -euo pipefail
    bash=$(readlink -f "$(command -v bash)")
    export ODU_E2E_BASH=\${bash%/bin/bash}
    nix build --impure --file ../../build.nix --out-link result
    readlink -f result
`,
  );
  writeFileSync(join(dir, "justfile"), "mod ci 'tooling/mod.just'\n");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("add", "-A");
  git(
    "-c",
    "user.email=e2e@odu.test",
    "-c",
    "user.name=odu e2e",
    "commit",
    "-q",
    "-m",
    "module",
  );
  return dir;
}

const PIN_REF = "trunk";
const PIN_REPO = "odu-e2e/pinned";

function pinnedFixture(substituter: string, publicKey: string): string {
  const dir = fixture(substituter, publicKey);
  writeFileSync(
    join(dir, "justfile"),
    `[metadata("ci")]
default: build

[metadata("odu:pin=${PIN_REF}")]
build:
    #!/usr/bin/env bash
    set -euo pipefail
    bash=$(readlink -f "$(command -v bash)")
    export ODU_E2E_BASH=\${bash%/bin/bash}
    nix build --impure --file build.nix --out-link result
    readlink -f result
`,
  );
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("remote", "add", "origin", `https://github.com/${PIN_REPO}.git`);
  // THE BRANCH IS NAMED HERE rather than taken from `git init`'s default,
  // which is a machine's `init.defaultBranch` and would put a different name
  // in the pin on a different developer's laptop.
  git("checkout", "-q", "-B", PIN_REF);
  git("add", "-A");
  git(
    "-c",
    "user.email=e2e@odu.test",
    "-c",
    "user.name=odu e2e",
    "commit",
    "-q",
    "-m",
    "pinned",
  );
  return dir;
}

const hashOf = (storePath: string): string =>
  storePath.slice(storePath.lastIndexOf("/") + 1).slice(0, 32);

interface ReadRun {
  push?: {
    target: { substituter: string; bucket: string } | null;
    skipped: string | null;
    keyWarning: string | null;
    paths: number;
    bytes: number;
  };
  passed: boolean;
  settled: boolean;
}

function tokensIn(
  world: WebWorld,
  rootToken: string,
  name: string,
): { id: string; label?: string | null; expires: number | null; revoked: boolean }[] {
  const listed = surface(world, ["cache", "token_list"], {
    rootToken,
    bucket: name,
  }) as {
    tokens: { id: string; label?: string | null; expires: number | null; revoked: boolean }[];
  };
  return listed.tokens;
}

beforeAll(async () => {
  odu = buildOduBinary();
  const stores = scratchDir("odu-e2e-run-push-stores-");
  dirs.push(stores);
  home = await startWebService(
    odu,
    {
      ODU_ROOT_TOKEN: ROOT,
      ODU_CACHE_STORE: `local?root=${join(stores, "home")}`,
    },
    suitePortFor("runPush"),
  );
  foreign = await startWebService(
    odu,
    {
      ODU_ROOT_TOKEN: FOREIGN_ROOT,
      ODU_CACHE_STORE: `local?root=${join(stores, "foreign")}`,
    },
    suitePortFor("runPushForeign"),
  );
}, 1_800_000);

afterAll(() => {
  home?.dispose();
  foreign?.dispose();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("a run whose repository reads from this daemon's cache", () => {
  it("pushes what it built, and the bucket serves it", async () => {
    const warm = bucket(home, ROOT, "warm");
    const dir = fixture(warm.url, warm.publicKey);

    const ran = run(home, ["ci", "run", "--no-strict"], { cwd: dir });
    expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });

    const paths = surface(home, ["cache", "bucket_paths"], {
      bucket: "warm",
      limit: 10,
    }) as { paths: { storePath: string }[] };
    expect(paths.paths.map((one) => one.storePath)).toHaveLength(1);
    const storePath = paths.paths[0]?.storePath as string;
    expect(storePath).toContain("-odu-run-push-e2e");

    const listed = surface(home, ["run_list"], { checkout: dir, limit: 1 }) as {
      rows: { runId: string }[];
    };
    const runId = listed.rows[0]?.runId as string;
    const read = surface(home, ["run_read"], { runId }) as ReadRun;
    expect(read.passed).toBe(true);
    expect(read.push?.target).toEqual({ substituter: warm.url, bucket: "warm" });
    expect(read.push?.skipped).toBeNull();
    expect(read.push?.keyWarning).toBeNull();
    expect(read.push?.paths).toBeGreaterThan(0);
    expect(read.push?.bytes).toBeGreaterThan(0);

    const narinfo = await fetch(`${warm.url}/${hashOf(storePath)}.narinfo`);
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${storePath}`);

    const tokens = tokensIn(home, ROOT, "warm").filter(
      (token) => token.label === `run ${runId}`,
    );
    expect(tokens).toHaveLength(1);
    const granted = tokens[0] as { expires: number | null; revoked: boolean };
    expect(granted.revoked).toBe(true);
    const ahead = (granted.expires ?? 0) - Date.now();
    expect(ahead).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(ahead).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);

    const stateDir = home.env.ODU_STATE_DIR as string;
    const leftOver = readdirSync(stateDir, { recursive: true, encoding: "utf-8" }).filter(
      (entry) => entry.endsWith("push.token"),
    );
    expect(leftOver).toEqual([]);
    const plaintext = /odu_[A-Za-z0-9_-]{43}/;
    const node = `ci::build@${currentNixSystem()}`;
    const surfaces = [
      ran.stdout,
      ran.stderr,
      run(home, ["ci", "logs", formatLogKey({ runId, node, attempt: 1 })]).stdout,
      run(home, [
        "ci",
        "logs",
        formatLogKey({ runId, node: `_ci-setup@${currentNixSystem()}`, attempt: 1 }),
      ]).stdout,
      JSON.stringify(read),
    ];
    for (const text of surfaces) expect(text).not.toMatch(plaintext);
  }, 1_800_000);
});

describe("a recipe that pins what its branch builds", () => {
  it("pins under the name the Action derives, and the path says what built it", async () => {
    const held = bucket(home, ROOT, "held");
    const dir = pinnedFixture(held.url, held.publicKey);

    const ran = run(home, ["ci", "run", "--no-strict"], { cwd: dir });
    expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });

    const listed = surface(home, ["run_list"], { checkout: dir, limit: 1 }) as {
      rows: { runId: string }[];
    };
    const runId = listed.rows[0]?.runId as string;
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();

    const paths = surface(home, ["cache", "bucket_paths"], {
      bucket: "held",
      limit: 10,
    }) as { paths: { storePath: string; run: string | null; commit: string | null }[] };
    expect(paths.paths).toHaveLength(1);
    expect(paths.paths[0]).toMatchObject({ run: runId, commit: head });

    const pins = surface(home, ["cache", "pin_list"], {
      rootToken: ROOT,
      bucket: "held",
    }) as { pins: { name: string; createdBy: string; rootPaths: string[] }[] };
    expect(pins.pins.map((pin) => pin.name)).toEqual([
      `${PIN_REPO}@${PIN_REF}/${currentNixSystem()}`,
    ]);
    expect(pins.pins[0]?.createdBy).toBe("write");
    expect(pins.pins[0]?.rootPaths).toEqual([paths.paths[0]?.storePath as string]);
  }, 1_800_000);
});

describe("a run whose repository reads from somebody else's odu cache", () => {
  it("goes green, says why it pushed nothing, and leaves that bucket empty", async () => {
    const theirs = bucket(foreign, FOREIGN_ROOT, "theirs");
    const dir = fixture(theirs.url, theirs.publicKey);

    const ran = run(home, ["ci", "run", "--no-strict"], { cwd: dir });
    expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });

    const listed = surface(home, ["run_list"], { checkout: dir, limit: 1 }) as {
      rows: { runId: string }[];
    };
    const runId = listed.rows[0]?.runId as string;
    const read = surface(home, ["run_read"], { runId }) as ReadRun;
    expect(read.passed).toBe(true);
    expect(read.push?.target).toBeNull();
    expect(read.push?.skipped).toContain("is a cache this odu serves");
    expect(read.push?.skipped).toContain(theirs.url);

    const setup = run(home, [
      "ci",
      "logs",
      formatLogKey({
        runId,
        node: `_ci-setup@${currentNixSystem()}`,
        attempt: 1,
      }),
    ]);
    expect(setup.stdout).toContain("not pushing");
    expect(setup.stdout).toContain("is a cache this odu serves");

    expect(objectsIn(foreign, FOREIGN_ROOT, "theirs")).toBe(0);
  }, 1_800_000);
});

describe("a run whose build recipe lives in a just MODULE", () => {
  it("pushes the link the recipe left in the module's own directory", async () => {
    const warm = bucket(home, ROOT, "warm-module");
    const dir = moduleFixture(warm.url, warm.publicKey);

    const ran = run(home, ["ci", "run", "--no-strict"], { cwd: dir });
    expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });

    const paths = surface(home, ["cache", "bucket_paths"], {
      bucket: "warm-module",
      limit: 10,
    }) as { paths: { storePath: string }[] };
    expect(paths.paths.map((one) => one.storePath)).toHaveLength(1);
    expect(paths.paths[0]?.storePath).toContain("-odu-run-push-e2e");
  }, 1_800_000);
});
