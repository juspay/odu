import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  cleanup,
  scratchDir,
  suitePortFor,
} from "../../../../tests/e2e/harness";
import { type WebWorld, startWebService } from "../../../../tests/e2e/webHarness";

const ROOT_TOKEN = "e2e-metrics-root";

let odu: string;
let world: WebWorld;
let storeRoot: string;
let builderStore: string;
const dirs: string[] = [];

let pushed: string;
const hashOf = (storePath: string): string =>
  storePath.slice(storePath.lastIndexOf("/") + 1).slice(0, 32);

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(argv: string[], env: NodeJS.ProcessEnv = {}): Ran {
  const res = spawnSync(odu, argv, {
    env: { ...world.env, ODU_ROOT_TOKEN: ROOT_TOKEN, ...env },
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const surface = (row: string, verb: string, input: unknown): Ran =>
  cli(["surface", row, verb, "--input", JSON.stringify(input), "--json"]);

function storeFile(name: string): string {
  const dir = scratchDir("odu-e2e-metrics-file-");
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, `${name}\n`.repeat(64));
  const added = spawnSync("nix", ["store", "add-file", file], {
    env: { ...process.env, NIX_REMOTE: builderStore },
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  if (added.status !== 0) throw new Error(`nix store add-file failed:\n${added.stderr}`);
  return added.stdout.trim();
}

const scrape = (authorization?: string): Promise<Response> =>
  fetch(`${world.origin}/metrics`, {
    headers: authorization === undefined ? {} : { authorization },
  });

function sampleOf(
  exposition: string,
  name: string,
  labels: Record<string, string> = {},
): number | null {
  for (const line of exposition.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) {
      continue;
    }
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const found = new Map<string, string>();
    if (open !== -1 && close > open) {
      for (const pair of line.slice(open + 1, close).split(",")) {
        const at = pair.indexOf("=");
        if (at === -1) continue;
        found.set(pair.slice(0, at), pair.slice(at + 2, -1));
      }
    }
    if (Object.entries(labels).some(([key, value]) => found.get(key) !== value)) continue;
    if (open !== -1 && found.size !== Object.keys(labels).length) continue;
    const value = line.slice(close === -1 ? line.indexOf(" ") : close + 2);
    return Number(value);
  }
  return null;
}

beforeAll(async () => {
  odu = buildOduBinary();
  storeRoot = scratchDir("odu-e2e-metrics-");
  dirs.push(storeRoot);
  builderStore = `local?root=${join(storeRoot, "builder")}`;
  world = await startWebService(
    odu,
    {
      ODU_ROOT_TOKEN: ROOT_TOKEN,
      ODU_CACHE_STORE: `local?root=${join(storeRoot, "server")}`,
    },
    suitePortFor("metrics"),
  );
}, 900_000);

afterAll(() => {
  world?.dispose();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("the scrape", () => {
  it("counts a push and the narinfo read that followed it", async () => {
    const created = surface("cache", "bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "main",
      public: true,
      retentionDays: 0,
    });
    expect({ status: created.status, stderr: created.stderr }).toMatchObject({ status: 0 });

    const minted = surface("cache", "token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "main",
      scope: "write",
    });
    expect(minted.status).toBe(0);
    const cacheToken = JSON.parse(minted.stdout) as { token: string };
    const writeToken = cacheToken.token;

    pushed = storeFile("odu-metrics-e2e");
    const push = cli(["cache", "push", "main", pushed], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect({ status: push.status, stderr: push.stderr }).toMatchObject({ status: 0 });

    const narinfo = await fetch(`${world.origin}/cache/main/${hashOf(pushed)}.narinfo`);
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${pushed}`);

    const answer = await scrape(`Bearer ${ROOT_TOKEN}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toContain("version=0.0.4");
    const body = await answer.text();

    expect(
      sampleOf(body, "odu_cache_requests_total", {
        bucket: "main",
        kind: "narinfo",
        outcome: "hit",
      }),
    ).toBe(1);
    expect(sampleOf(body, "odu_cache_uploads_total", {
      bucket: "main",
      mode: "staged",
      outcome: "recorded",
    })).toBe(1);
    expect(sampleOf(body, "odu_cache_paths", { bucket: "main" })).toBe(1);
    expect(sampleOf(body, "odu_cache_bytes", { bucket: "main" })).toBeGreaterThan(0);
    expect(sampleOf(body, "odu_cache_hits", { bucket: "main" })).toBe(1);

    expect(sampleOf(body, "odu_metrics_contributor_up", { contributor: "cache" })).toBe(1);
    expect(sampleOf(body, "odu_metrics_contributor_up", { contributor: "ci" })).toBe(1);
    expect(sampleOf(body, "odu_runs_total", { outcome: "passed" })).toBe(0);
    expect(sampleOf(body, "odu_unhandled_total", { kind: "rejection" })).toBe(0);
  }, 900_000);

  it("answers an anonymous scrape with 401 and a sentence, not a page", async () => {
    const anonymous = await scrape();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    const text = await anonymous.text();
    expect(text).not.toContain("<html");
    expect(text).toContain("$ODU_ROOT_TOKEN");

    expect((await scrape("Bearer not-the-token")).status).toBe(401);
  });

  it("opens for a minted metrics token and shuts for a revoked one", async () => {
    const minted = surface("metrics", "token_mint", {
      rootToken: ROOT_TOKEN,
      label: "prometheus-pod",
    });
    expect({ status: minted.status, stderr: minted.stderr }).toMatchObject({ status: 0 });
    const answer = JSON.parse(minted.stdout) as {
      token: string;
      facts: { id: string; label: string };
    };
    expect(answer.facts.label).toBe("prometheus-pod");

    const opened = await scrape(`Bearer ${answer.token}`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("odu_cache_paths");

    const listed = surface("metrics", "token_list", { rootToken: ROOT_TOKEN });
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain(answer.token);
    expect(listed.stdout).toContain(answer.facts.id);

    const revoked = surface("metrics", "token_revoke", {
      rootToken: ROOT_TOKEN,
      id: answer.facts.id,
    });
    expect(revoked.status).toBe(0);
    expect((await scrape(`Bearer ${answer.token}`)).status).toBe(401);

    const refused = surface("metrics", "token_mint", { rootToken: "wrong", label: "x" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("root token");
  });
});
