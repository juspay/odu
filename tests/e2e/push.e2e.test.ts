/**
 * THE RUN PUSHES (PLAN 4.1), end to end: a real daemon, a real bucket, a real
 * lane, a real `nix build`, and the bytes asked for where Nix would ask.
 *
 * Nothing here is stubbed, and that is the point — every unit in this change
 * can pass while the WIRING is wrong, and the wiring is what these two
 * scenarios are about:
 *
 *   - **It lands.** A fixture whose `flake.nix` `nixConfig` names this
 *     daemon's own bucket, and a recipe that `nix build`s a derivation with
 *     `--out-link result`. After the run, the bucket SERVES that path (its
 *     narinfo answers 200 at the substituter the repo substitutes from) and
 *     `run_read` reports what was pushed. One declaration in the repo, no step
 *     in the recipe, no token in the tree.
 *   - **A cache somebody else serves is skipped, and said.** The same fixture
 *     pointed at a SECOND daemon's bucket: `Odu-Origin` is not this daemon, so
 *     the interim write grant does not hold. The run goes green, `_ci-setup`
 *     says why nothing was pushed, and the other bucket is still empty.
 */

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
/** The daemon whose runs push: it serves `warm`, and a fixture reads from it. */
let home: WebWorld;
/** A second daemon serving `theirs`, so "a cache this odu does not serve" is a
 *  real odu bucket at a real foreign origin rather than a string this suite
 *  made up — the exact shape the resolution must refuse. */
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

/** One verb, through `odu surface` — the face that administers. A ROW's verb
 *  takes its row first (`cache bucket_create`); the runs are the wire's root,
 *  so theirs are one word (`run_read`). */
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

/** A bucket on a daemon, and the two facts a consumer needs to read from it. */
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

/** How many paths a bucket holds — the admin list, because a bucket's public
 *  identity deliberately does not count its objects. */
function objectsIn(world: WebWorld, rootToken: string, name: string): number {
  const listed = surface(world, ["cache", "bucket_list"], { rootToken }) as {
    buckets: { name: string; objects: number }[];
  };
  return listed.buckets.find((row) => row.name === name)?.objects ?? -1;
}

/**
 * A fixture repository that READS from a cache, and builds something.
 *
 * The `nixConfig` block is the whole declaration — it is what a consumer
 * already pastes out of `odu cache use` in order to substitute from the bucket
 * — and the recipe is an ordinary `nix build … --out-link result` with nothing
 * about odu in it.
 *
 * The derivation's builder is the LANE'S OWN `bash` — already a store path, so
 * `builtins.storePath` brings its closure into the sandbox without a `nixpkgs`
 * anywhere. Its output references nothing, so what gets pushed is one small
 * path: a derivation out of `nixpkgs` would make this suite a test of a
 * download.
 */
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

/**
 * The same fixture with the build recipe in a MODULE, and deliberately in the
 * two shapes a name-equals-directory fixture cannot falsify:
 *
 *   - the module is NAMED `ci` and LIVES in `tooling/`, because `just`'s dump
 *     reports `module_path` as the module's NAMEPATH — so a derivation built
 *     on that field answers `ci` for a module in `tooling/`;
 *   - and the recipe is in a module NESTED inside it, where `module_path` is
 *     `ci::deep` — a string that is never a path in any layout, the
 *     conventional one included.
 *
 * Both globbed a directory that does not exist, found nothing, and left a
 * green run that pushed nothing with no line anywhere: the one silent failure
 * mode in the design. The directory comes from the dump's `source` instead.
 */
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

/** The hash part a narinfo is named for. */
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

/** A bucket's tokens, which is where a run's grant is visible and where its
 *  revocation is PROVED rather than assumed from a fixture's recording. */
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

    // WHAT THE BUCKET HOLDS NOW. The `result` link lives in the LANE's
    // workspace, not in the checkout, so the run's own output is where the
    // store path has to come from — and the bucket is the one that proves the
    // push, so it is the bucket that is asked.
    const paths = surface(home, ["cache", "bucket_paths"], {
      bucket: "warm",
      limit: 10,
    }) as { paths: { storePath: string }[] };
    expect(paths.paths.map((one) => one.storePath)).toHaveLength(1);
    const storePath = paths.paths[0]?.storePath as string;
    expect(storePath).toContain("-odu-run-push-e2e");

    // THE RUN'S OWN ACCOUNT. `run_read` carries where it pushed and how much
    // landed, so an agent that reads a run and nothing else can tell "green,
    // and the cache has it" from "green, and the next machine rebuilds it".
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

    // AND THE BUCKET SERVES IT, where NIX asks: the substituter the repo
    // substitutes from, over plain HTTP, with no odu in the path.
    const narinfo = await fetch(`${warm.url}/${hashOf(storePath)}.narinfo`);
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${storePath}`);

    // THE GRANT'S WHOLE LIFE, read off the CACHE rather than off a fixture's
    // recording — the only place that says what a real daemon did.
    const tokens = tokensIn(home, ROOT, "warm").filter(
      (token) => token.label === `run ${runId}`,
    );
    expect(tokens).toHaveLength(1);
    const granted = tokens[0] as { expires: number | null; revoked: boolean };
    // REVOKED, because the run settled and nothing is serving it any more.
    expect(granted.revoked).toBe(true);
    // AND IT WOULD HAVE EXPIRED ANYWAY. The backstop is 24 hours from the
    // mint, which is a WALL-CLOCK instant and not a day boundary — the
    // `expiresDays: 1` the cache's own CLI takes rounds to one, and the run
    // that finishes at 23:59 would get a token good for a minute.
    const ahead = (granted.expires ?? 0) - Date.now();
    expect(ahead).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(ahead).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);

    // AND NO PLAINTEXT CREDENTIAL IS ANYWHERE A READER LOOKS. The token file
    // itself is gone — the coordinator unlinks it as it reads it — so what is
    // searched for is the SHAPE every minted token has (`odu_` and 43
    // base64url characters), across every surface this run produced. A
    // credential in a log the catalog keeps is a credential in the context of
    // every agent that ever reads the run.
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
    // THE WRITE GRANT IS "this daemon advertises that URL", and this one does
    // not — the URL belongs to the OTHER daemon — so the run is told, once,
    // rather than failing. It is told in one sentence naming what it read,
    // because a substituter this daemon does not serve is indistinguishable
    // here from `cache.nixos.org`.
    expect(read.push?.target).toBeNull();
    expect(read.push?.skipped).toContain("is a cache this odu serves");
    expect(read.push?.skipped).toContain(theirs.url);

    // SAID IN THE SETUP LOG, which is the node every face opens first. The
    // key is minted by the surface's own encoder rather than spelled here:
    // a node id carries an `@`, and the one spelling that addresses it is
    // whatever `formatLogKey` writes.
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

    // AND NOTHING WENT THERE. The other daemon's bucket has no paths at all,
    // which is the assertion that a skip is a skip rather than a silent push
    // somewhere else.
    expect(objectsIn(foreign, FOREIGN_ROOT, "theirs")).toBe(0);
  }, 1_800_000);
});

describe("a run whose build recipe lives in a just MODULE", () => {
  it("pushes the link the recipe left in the module's own directory", async () => {
    // The whole point: `just` ran the recipe in `tooling/nested/`, so
    // `./result` is `tooling/nested/result` and a glob of the workspace root
    // alone finds nothing — silently, since a run with no `result*` anywhere
    // is a legitimate run. Neither the module's NAME (`ci`) nor its namepath
    // (`ci::deep`) is that directory, which is all `module_path` ever said.
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
