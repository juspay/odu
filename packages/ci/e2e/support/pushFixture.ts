/**
 * A RUN THAT REALLY PUSHES, arranged in one call.
 *
 * Shared by the acceptance scenario that asserts on the push step and by the
 * screenshot script that photographs it, because both need exactly the same
 * thing and the arrangement is the fiddly part: a bucket on this daemon, a
 * fixture whose `flake.nix` names that bucket the way a consumer's repository
 * does, and a recipe whose `result` link points at a real store path.
 *
 * Under `e2e/support/` rather than `e2e/steps/`, which cucumber imports: a
 * module that registered steps would register them into any script that merely
 * wanted the fixture.
 *
 * **Why it is cheap.** No `nix build`, no nixpkgs, no derivation. `nix store
 * add-file` puts a two-line file in the store — a real store path with no
 * references, so the closure is one path and the NAR is about a hundred bytes.
 * The recipe does nothing but point `result` at it.
 *
 * **Why the fixture needs a `flake.nix`.** There is no seam that hands a run a
 * push target: `run_start` resolves it from the checkout's own
 * `nixConfig.extra-substituters`, matching the URL against the buckets this
 * daemon advertises. That is the entire public interface — a repository
 * declares where it READS from and odu writes there — so the fixture declares
 * it the way a consumer's repository does, and the bucket must exist before
 * the run starts. The file is read as plain Nix (`(import <src/flake.nix>)
 * .nixConfig`): no inputs, no lock, no `outputs` evaluation, nothing dialled.
 */

import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  headOf,
  oduCli,
  ROOT_TOKEN,
  startRun,
  waitSettled,
  type Service,
} from "../../../web-acceptance/support/service.ts";

/** The recipe this fixture runs, and the node id it becomes the namepath of. */
export const PUSH_RECIPE = "warm";

export interface PushingRun {
  /** The bucket the run pushed into. */
  bucket: string;
  /** The substituter URL the daemon advertises for it — taken from
   *  `bucket_describe` rather than composed here, because a caller that
   *  composed it would be asserting this file agrees with the server about a
   *  format rather than exercising the matcher. */
  url: string;
  checkout: string;
  runId: string;
}

/** A store path of a few bytes, with no references. */
function tinyStorePath(service: Service, body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "odu-push-fixture-")), "warm.txt");
  writeFileSync(file, body);
  const added = spawnSync("nix", ["store", "add-file", file], {
    env: service.env,
    encoding: "utf-8",
  });
  assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
  return added.stdout.trim();
}

/** A fixture checkout that declares a cache and leaves a `result` link. Its own
 *  builder rather than `makeFixture`, which writes a justfile and nothing else:
 *  this one needs a second file, and a `flake.nix` is not a thing every fixture
 *  should start carrying. */
function pushingFixture(storePath: string, url: string, key: string): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-push-repo-"));
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  writeFileSync(
    join(dir, "flake.nix"),
    `{\n  nixConfig = {\n    extra-substituters = [ "${url}" ];\n    extra-trusted-public-keys = [ "${key}" ];\n  };\n  outputs = { ... }: { };\n}\n`,
  );
  // `ln -sfn`, so a rerun of this recipe in the same checkout replaces the
  // link rather than making `result/result`.
  writeFileSync(
    join(dir, "justfile"),
    `[metadata("ci")]\ndefault: ${PUSH_RECIPE}\n\n${PUSH_RECIPE}:\n    ln -sfn ${storePath} result\n    echo "${PUSH_RECIPE} built its result"\n`,
  );
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=acceptance@odu.test",
    "-c",
    "user.name=odu web acceptance",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return dir;
}

/**
 * Create a bucket, build the fixture, run it, and wait for it to settle green.
 *
 * Green is asserted here rather than left to the caller: GREEN MEANS WARMED is
 * the rule a failed push breaks, so a red run means the closure did not land —
 * and every caller of this would then be photographing or asserting on a step
 * that says `push failed`. Failing at the arrangement, with the failures the
 * service named, is the difference between a diagnosable suite and a confusing
 * one.
 */
export async function arrangePushingRun(
  service: Service,
  opts: { bucket?: string; requestId?: string; timeoutMs?: number } = {},
): Promise<PushingRun> {
  const bucket = opts.bucket ?? `push-${crypto.randomUUID().slice(0, 8)}`;
  const created = oduCli(service, [
    "surface",
    "cache",
    "bucket_create",
    "--input",
    JSON.stringify({ rootToken: ROOT_TOKEN, name: bucket, public: true, retentionDays: 90 }),
    "--json",
  ]);
  assert.strictEqual(created.status, 0, `cache bucket_create failed: ${created.stderr}`);
  // `bucket_describe` takes no root token: a bucket's substituter URL and its
  // public key are what it publishes to every client that can read it anyway.
  const described = oduCli(service, [
    "surface",
    "cache",
    "bucket_describe",
    "--input",
    JSON.stringify({ bucket }),
    "--json",
  ]);
  assert.strictEqual(described.status, 0, `cache bucket_describe failed: ${described.stderr}`);
  const facts = JSON.parse(described.stdout) as { url?: unknown; publicKey?: unknown };
  assert.ok(
    typeof facts.url === "string" && typeof facts.publicKey === "string",
    `cache bucket_describe answered no url/publicKey: ${described.stdout}`,
  );

  const storePath = tinyStorePath(service, `warm ${bucket}\nso the NAR is not empty\n`);
  const checkout = pushingFixture(storePath, facts.url, facts.publicKey);
  const runId = startRun(service, {
    checkout,
    expectedSha: headOf(checkout),
    requestId: opts.requestId ?? `push-${crypto.randomUUID()}`,
  });
  const settled = await waitSettled(service, runId, opts.timeoutMs ?? 600_000);
  assert.ok(
    settled.passed,
    `the pushing fixture did not pass, so nothing was warmed: ${JSON.stringify(settled.failures)}`,
  );
  return { bucket, url: facts.url, checkout, runId };
}
