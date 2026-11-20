import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
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

export const PUSH_RECIPE = "warm";

export interface PushingRun {
  bucket: string;
  url: string;
  checkout: string;
  runId: string;
}

function addedStorePath(service: Service, body: string, bytes = 0): string {
  const file = join(mkdtempSync(join(tmpdir(), "odu-push-fixture-")), "warm.txt");
  writeFileSync(file, body);
  if (bytes > 0) appendFileSync(file, randomBytes(bytes));
  const added = spawnSync("nix", ["store", "add-file", file], {
    env: service.env,
    encoding: "utf-8",
  });
  assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
  return added.stdout.trim();
}

function pushingFixture(storePath: string, url: string, key: string): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-push-repo-"));
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  writeFileSync(
    join(dir, "flake.nix"),
    `{\n  nixConfig = {\n    extra-substituters = [ "${url}" ];\n    extra-trusted-public-keys = [ "${key}" ];\n  };\n  outputs = { ... }: { };\n}\n`,
  );
  writeFileSync(
    join(dir, "justfile"),
    `[metadata("ci")]\ndefault: ${PUSH_RECIPE}\n\n${PUSH_RECIPE}:\n` +
      `    ln -sfn ${storePath} result\n` +
      `    seq 1 400 | sed 's/^/${PUSH_RECIPE} built line /'\n` +
      `    echo "${PUSH_RECIPE} built its result"\n`,
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

export async function arrangePushingRun(
  service: Service,
  opts: {
    bucket?: string;
    requestId?: string;
    timeoutMs?: number;
    payloadBytes?: number;
    settle?: boolean;
  } = {},
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

  const storePath = addedStorePath(
    service,
    `warm ${bucket}\nso the NAR is not empty\n`,
    opts.payloadBytes ?? 0,
  );
  const checkout = pushingFixture(storePath, facts.url, facts.publicKey);
  const runId = startRun(service, {
    checkout,
    expectedSha: headOf(checkout),
    requestId: opts.requestId ?? `push-${crypto.randomUUID()}`,
  });
  if (opts.settle !== false) {
    const settled = await waitSettled(service, runId, opts.timeoutMs ?? 600_000);
    assert.ok(
      settled.passed,
      `the pushing fixture did not pass, so nothing was warmed: ${JSON.stringify(settled.failures)}`,
    );
  }
  return { bucket, url: facts.url, checkout, runId };
}
