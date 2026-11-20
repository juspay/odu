import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isTemp, s3Fetch, type S3Target } from "@odu/objects";
import { type Gateway, startGateway } from "@odu/objects/testing";
import {
  BIG,
  buildOduBinary,
  currentNixSystem,
  removeNow,
  scratchDir,
  suitePortFor,
} from "../../../../tests/e2e/harness";
import { type WebWorld, startWebService, until } from "../../../../tests/e2e/webHarness";

const ROOT_TOKEN = "e2e-root-token";

let odu: string;
let world: WebWorld;
let storeRoot: string;
let builderStore: string;
let substituteStore: string;
let gateway: Gateway;

const GATEWAY_STORE = "gw";

const RACE_STORE = "gw-racy";
let storeProxy: { port: number; stop: () => void };
let rewriteNextTempRead = false;
const rewritten: string[] = [];
let gatewayTarget: S3Target;

const REWRITTEN_BYTES = new Uint8Array(512).fill(0x5a);

function startStoreProxy(upstream: string): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      url.port = upstream;
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const answer = await fetch(url, {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });
      const key = decodeURIComponent(url.pathname).split("/").slice(2).join("/");
      const opening = request.headers.get("range")?.startsWith("bytes=0-") === true;
      if (!rewriteNextTempRead || request.method !== "GET" || !opening || !isTemp(key)) {
        return answer;
      }
      rewriteNextTempRead = false;
      const window = await answer.arrayBuffer();
      const put = await s3Fetch(gatewayTarget, "PUT", key, { body: REWRITTEN_BYTES });
      if (!put.ok) throw new Error(`rewriting ${key} answered ${put.status}`);
      rewritten.push(key);
      return new Response(window, { status: answer.status, headers: answer.headers });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("the store proxy bound no port");
  return { port, stop: () => void server.stop(true) };
}

const dirs: string[] = [];

const HOST_BUILD = currentNixSystem().endsWith("-darwin");

beforeAll(async () => {
  odu = buildOduBinary();
  storeRoot = scratchDir("odu-e2e-cache-");
  builderStore = `local?root=${join(storeRoot, "builder")}`;
  substituteStore = `local?root=${join(storeRoot, "substitute")}`;

  gateway = await startGateway();
  const target = await gateway.bucket();
  const credentials = join(storeRoot, "gw-credentials");
  writeFileSync(
    credentials,
    `AWS_ACCESS_KEY_ID=${target.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${target.secretAccessKey}\n`,
    { mode: 0o600 },
  );
  gatewayTarget = target;
  storeProxy = startStoreProxy(gateway.endpoint.port);
  const stores = join(storeRoot, "object-stores.json");
  const declared = {
    kind: "s3",
    bucket: target.bucket,
    region: target.region,
    credentialsFile: credentials,
  };
  writeFileSync(
    stores,
    JSON.stringify({
      [GATEWAY_STORE]: {
        ...declared,
        endpoint: `http://localhost:${gateway.endpoint.port}`,
      },
      [RACE_STORE]: { ...declared, endpoint: `http://127.0.0.1:${storeProxy.port}` },
    }),
  );

  world = await startWebService(
    odu,
    {
      ODU_ROOT_TOKEN: ROOT_TOKEN,
      ODU_CACHE_STORE: `local?root=${join(storeRoot, "server")}`,
      ODU_OBJECT_STORES: stores,
    },
    suitePortFor("cache"),
  );
}, 900_000);

afterAll(async () => {
  world?.dispose();
  storeProxy?.stop();
  await gateway?.stop();
  for (const dir of dirs.splice(0)) removeNow(dir);
});

function storeFile(name: string, bytes: number): string {
  const dir = scratchDir("odu-e2e-file-");
  dirs.push(dir);
  const file = join(dir, name);
  const data = Buffer.alloc(bytes);
  let x = 0x9e3779b9;
  for (let at = 0; at < data.length; at++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[at] = x & 0xff;
  }
  writeFileSync(file, data);
  const added = nix(["store", "add-file", file]);
  if (added.status !== 0) throw new Error(`nix store add-file ${name} failed:\n${added.stderr}`);
  return added.stdout.trim();
}

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

async function cliAsync(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  const child = Bun.spawn([odu, ...argv], {
    env: { ...world.env, ODU_ROOT_TOKEN: ROOT_TOKEN, ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

function surface(verb: string, input: unknown, env: NodeJS.ProcessEnv = {}): Ran {
  return cli(["surface", "cache", verb, "--input", JSON.stringify(input), "--json"], env);
}

const surfaceAsync = (verb: string, input: unknown): Promise<Ran> =>
  cliAsync(["surface", "cache", verb, "--input", JSON.stringify(input), "--json"]);

function printedNetrc(bucket: string, token: string): string {
  const used = cli(["cache", "use", bucket, "--origin", world.origin], { ODU_TOKEN: token });
  expect({ status: used.status, stderr: used.stderr }).toMatchObject({ status: 0 });
  const machine = used.stdout.split("\n").filter((line) => line.startsWith("machine "));
  expect(machine).toHaveLength(1);
  return `${(machine[0] as string).replace("<your-read-token>", token)}\n`;
}

function nix(argv: string[], env: NodeJS.ProcessEnv = {}): Ran {
  const res = spawnSync("nix", argv, {
    env: { ...process.env, NIX_REMOTE: builderStore, ...env },
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function build(name: string): string {
  return realised(`derivation { name = "${name}"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo ${name} > $out" ]; }`, name);
}

function realised(expr: string, what: string): string {
  const args = ["build", "--no-link", "--print-out-paths", "--impure", "--expr", expr];
  const res = HOST_BUILD
    ? spawnSync("nix", args, { encoding: "utf-8", maxBuffer: BIG, env: process.env })
    : nix([...args.slice(0, 1), "--store", builderStore, ...args.slice(1)]);
  if (res.status !== 0) throw new Error(`nix build ${what} failed:\n${res.stderr}`);
  const out = res.stdout.trim();
  if (!HOST_BUILD) return out;
  const copied = spawnSync("nix", ["copy", "--no-check-sigs", "--to", builderStore, out], {
    encoding: "utf-8",
    maxBuffer: BIG,
    env: process.env,
  });
  if (copied.status !== 0) {
    throw new Error(`nix copy ${what} to the builder store failed:\n${copied.stderr}`);
  }
  return out;
}

function buildPair(name: string): { parent: string; child: string } {
  const child = `derivation { name = "${name}-child"; system = builtins.currentSystem; ` +
    `builder = "/bin/sh"; args = [ "-c" "echo child > $out" ]; }`;
  const evaluated = spawnSync(
    "nix",
    ["eval", "--impure", "--raw", "--expr", `let child = ${child}; in "${'$'}{child}"`],
    { encoding: "utf-8", maxBuffer: BIG },
  );
  if (evaluated.status !== 0) throw new Error(`nix eval ${name} failed:\n${evaluated.stderr}`);
  const childPath = evaluated.stdout.trim();

  const parent = realised(
    `let child = ${child}; in derivation { name = "${name}-parent"; ` +
      `system = builtins.currentSystem; builder = "/bin/sh"; ` +
      `args = [ "-c" "echo ${'$'}{child} > $out" ]; }`,
    `${name}-parent`,
  );
  return { parent, child: childPath };
}

function stagedFiles(): string[] {
  const root = join(world.env.ODU_STATE_DIR as string, "cache", "staging");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return out.sort();
}

const hashOf = (storePath: string): string =>
  storePath.slice(storePath.lastIndexOf("/") + 1).slice(0, 32);

interface Bucket {
  name: string;
  url: string;
  publicKey: string;
  keyName: string;
  upstreamKeys: string[];
  store: string;
  readsFrom: "store" | "odu";
}

interface Served {
  bucket: string;
  path: string;
  bytes: number;
  source: "object" | "transition" | "redirect";
}

function narServed(storePath: string): Served[] {
  let text: string;
  try {
    text = readFileSync(world.logPath, "utf-8");
  } catch {
    return [];
  }
  const lines: Served[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("cache.nar.served")) continue;
    try {
      const entry = JSON.parse(line) as Served & { msg?: string };
      if (entry.msg === "odu cache: cache.nar.served" && entry.path === storePath) lines.push(entry);
    } catch {
    }
  }
  return lines;
}

interface Uploaded {
  bucket: string;
  file: string;
  mode: "direct" | "staged";
  parts: number;
  bytes: number;
}

function narUploaded(bucket: string): Uploaded[] {
  let text: string;
  try {
    text = readFileSync(world.logPath, "utf-8");
  } catch {
    return [];
  }
  const lines: Uploaded[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("cache.nar.uploaded")) continue;
    try {
      const entry = JSON.parse(line) as Uploaded & { msg?: string };
      if (entry.msg === "odu cache: cache.nar.uploaded" && entry.bucket === bucket) lines.push(entry);
    } catch {
    }
  }
  return lines;
}

interface VerifyFailed {
  bucket: string;
  mode: "direct" | "staged";
  path: string;
  reason: string;
}

function verifyFailed(bucket: string): VerifyFailed[] {
  let text: string;
  try {
    text = readFileSync(world.logPath, "utf-8");
  } catch {
    return [];
  }
  const lines: VerifyFailed[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("cache.nar.verify_failed")) continue;
    try {
      const entry = JSON.parse(line) as VerifyFailed & { msg?: string };
      if (entry.msg === "odu cache: cache.nar.verify_failed" && entry.bucket === bucket) lines.push(entry);
    } catch {
    }
  }
  return lines;
}

let main: Bucket;
let writeToken: string;
let pinned: string;
let evictable: string;
let priv: Bucket;
let privToken: string;
let fronted: Bucket;
let frontedToken: string;

describe("odu serves a Nix binary cache", () => {
  it("creates a bucket and prints what a client has to trust", () => {
    const created = surface("bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "main",
      public: true,
      retentionDays: 0,
    });
    expect(created.stderr).toBe("");
    expect(created.status).toBe(0);
    main = JSON.parse(created.stdout) as Bucket;
    expect(main.name).toBe("main");
    expect(main.url).toBe(`${world.origin}/cache/main`);
    expect(main.keyName).toBe("main-1");
    expect(main.publicKey.startsWith("main-1:")).toBe(true);

    const listed = surface("bucket_list", { rootToken: ROOT_TOKEN });
    expect(listed.status).toBe(0);
    expect((JSON.parse(listed.stdout) as { buckets: Bucket[] }).buckets.map((b) => b.name)).toEqual([
      "main",
    ]);
  });

  it("serves a public bucket's facts with no account", async () => {
    const response = await fetch(`${world.origin}/cache/main`, {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    const facts = (await response.json()) as { publicKey: string; url: string };
    expect(facts.publicKey).toBe(main.publicKey);
    expect(facts.url).toBe(`${world.origin}/cache/main`);

    const used = cli(["cache", "use", "main", "--origin", world.origin], {
      ODU_ROOT_TOKEN: "",
      ODU_TOKEN: "",
    });
    expect({ status: used.status, stderr: used.stderr }).toMatchObject({ status: 0 });
    expect(used.stdout).toContain(main.publicKey);
    expect(used.stdout).not.toContain("netrc-file");
    expect(used.stdout.split("\n").some((line) => line.startsWith("machine "))).toBe(false);
  });

  it("refuses administration without the root token", () => {
    const refused = surface("bucket_create", {
      rootToken: "wrong",
      name: "other",
      public: true,
      retentionDays: 90,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("root token");
  });

  it("refuses a bucket delete without the root token, and keeps the bucket", () => {
    const refused = surface("bucket_delete", { rootToken: "wrong", bucket: "main" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("root token");

    const listed = surface("bucket_list", { rootToken: ROOT_TOKEN });
    expect(listed.status).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as { buckets: Bucket[] }).buckets.map((b) => b.name),
    ).toContain("main");
  });

  it("mints a write token, and shows it once", () => {
    const minted = surface("token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "main",
      scope: "write",
    });
    expect(minted.status).toBe(0);
    const answer = JSON.parse(minted.stdout) as {
      token: string;
      facts: { id: string; scope: string };
    };
    expect(answer.token.startsWith("odu_")).toBe(true);
    expect(answer.facts.scope).toBe("write");
    writeToken = answer.token;

    const listed = surface("token_list", { rootToken: ROOT_TOKEN });
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain(writeToken);
    expect(listed.stdout).toContain(answer.facts.id);
  });

  it("pushes a closure, and `nix build` substitutes it from the bucket", () => {
    pinned = build("odu-cache-e2e-pinned");

    const pushed = cli(["cache", "push", "main", pinned], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect(pushed.stderr).not.toContain("odu:");
    expect(pushed.status).toBe(0);
    expect(pushed.stdout).toContain("pushed 1");

    const substituted = nix(
      [
        "build",
        "--store",
        substituteStore,
        "--substituters",
        main.url,
        "--trusted-public-keys",
        main.publicKey,
        "--no-link",
        pinned,
      ],
      { NIX_REMOTE: "" },
    );
    expect(substituted.stderr).not.toContain("not signed");
    expect(substituted.status).toBe(0);

    const verified = spawnSync(
      "nix",
      ["store", "verify", "--store", substituteStore, "--trusted-public-keys", main.publicKey, pinned],
      { encoding: "utf-8", maxBuffer: BIG },
    );
    expect(verified.stderr).not.toContain("not signed");
    expect(verified.status).toBe(0);
  });

  it("pushes a NAR in parts, and substitutes the joined path", () => {
    const big = storeFile("odu-cache-e2e-chunked", 2 * 1024 * 1024);
    const pushed = cli(["cache", "push", "main", big, "--part-size", "1"], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect({ status: pushed.status, stderr: pushed.stderr }).toMatchObject({ status: 0 });
    expect(pushed.stderr).toContain("part 2");
    expect(pushed.stdout).toContain("pushed 1");

    const substituted = nix(
      [
        "build",
        "--store",
        substituteStore,
        "--substituters",
        main.url,
        "--trusted-public-keys",
        main.publicKey,
        "--no-link",
        big,
      ],
      { NIX_REMOTE: "" },
    );
    expect(substituted.stderr).not.toContain("not signed");
    expect(substituted.status).toBe(0);
  });

  it("discovers a bucket from its substituter, and pushes with `--cache` alone", async () => {
    const info = await fetch(`${main.url}/nix-cache-info`);
    expect(info.status).toBe(200);
    const stated = await info.text();
    expect(stated).toContain(`Odu-Origin: ${world.origin}\n`);
    expect(stated).toContain("Odu-Bucket: main\n");

    const discovered = build("odu-cache-e2e-discovered");
    const pushed = cli(["cache", "push", "--cache", main.url, "--output", "json", discovered], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect({ status: pushed.status, stderr: pushed.stderr }).toMatchObject({ status: 0 });
    const summary = JSON.parse(pushed.stdout) as {
      pushed: number;
      failed: number;
      served: string[];
      substituter: string;
    };
    expect(summary).toMatchObject({ pushed: 1, failed: 0, substituter: main.url });
    expect(summary.served).toContain(discovered);

    const narinfo = await fetch(`${main.url}/${hashOf(discovered)}.narinfo`);
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${discovered}`);
  });

  it("takes a path `nix copy --to` uploads, and keeps the client's signature", async () => {
    evictable = build("odu-cache-e2e-evictable");

    const keyFile = join(storeRoot, "client-key");
    const generated = spawnSync(
      "nix",
      ["key", "generate-secret", "--key-name", "client-1"],
      { encoding: "utf-8" },
    );
    expect(generated.status).toBe(0);
    writeFileSync(keyFile, generated.stdout, { mode: 0o600 });
    const signed = nix(["store", "sign", "--store", builderStore, "--key-file", keyFile, evictable]);
    expect(signed.status).toBe(0);

    const copied = nix([
      "copy",
      "--to",
      `${main.url.replace("http://", `http://x:${writeToken}@`)}`,
      "--no-recursive",
      evictable,
    ]);
    expect({ status: copied.status, error: copied.stderr.includes("error:") }).toEqual({
      status: 0,
      error: false,
    });

    const narinfo = await narinfoOf(main.url, evictable);
    expect(narinfo).toContain(`StorePath: ${evictable}`);
    expect(narinfo).toContain(`Sig: ${main.keyName}:`);
    expect(narinfo).toContain("Sig: client-1:");

    const substituted = nix(
      [
        "build",
        "--store",
        substituteStore,
        "--substituters",
        main.url,
        "--trusted-public-keys",
        main.publicKey,
        "--no-link",
        evictable,
      ],
      { NIX_REMOTE: "" },
    );
    expect(substituted.status).toBe(0);
  });

  it("takes what an upstream key signed when the bucket names no upstream", async () => {
    const within = build("odu-cache-e2e-upstream");
    const keyFile = join(storeRoot, "nixos-key");
    const generated = spawnSync(
      "nix",
      ["key", "generate-secret", "--key-name", "cache.nixos.org-1"],
      { encoding: "utf-8" },
    );
    expect(generated.status).toBe(0);
    writeFileSync(keyFile, generated.stdout, { mode: 0o600 });
    expect(nix(["store", "sign", "--store", builderStore, "--key-file", keyFile, within]).status).toBe(0);

    const skipped = cli(["cache", "push", "main", within], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("skipped-upstream 1");

    const created = surface("bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "everything",
      public: true,
      retentionDays: 90,
      upstreamKeys: [],
    });
    expect(created.status).toBe(0);
    const everything = JSON.parse(created.stdout) as Bucket;
    expect(everything.upstreamKeys).toEqual([]);
    const minted = surface("token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "everything",
      scope: "write",
    });
    expect(minted.status).toBe(0);
    const token = (JSON.parse(minted.stdout) as { token: string }).token;

    const pushed = cli(["cache", "push", "everything", within], {
      NIX_REMOTE: builderStore,
      ODU_CACHE_TOKEN: token,
    });
    expect(pushed.status).toBe(0);
    expect(pushed.stdout).toContain("pushed 1");
    expect(pushed.stdout).toContain("skipped-upstream 0");
  });

  it("pushes a closure whole with `--whole`, so `nix copy --from` the bucket alone takes it", () => {
    const { parent, child } = buildPair("odu-cache-e2e-whole");
    const keyFile = join(storeRoot, "whole-upstream-key");
    const generated = spawnSync(
      "nix",
      ["key", "generate-secret", "--key-name", "cache.nixos.org-1"],
      { encoding: "utf-8" },
    );
    expect(generated.status).toBe(0);
    writeFileSync(keyFile, generated.stdout, { mode: 0o600 });
    expect(nix(["store", "sign", "--store", builderStore, "--key-file", keyFile, child]).status).toBe(0);

    const fetchAlone = (name: string): Ran => {
      const xdg = scratchDir(`odu-e2e-xdg-${name}-`);
      dirs.push(xdg);
      return nix(
        [
          "copy",
          "--extra-trusted-public-keys",
          main.publicKey,
          "--from",
          main.url,
          "--to",
          `local?root=${join(storeRoot, name)}`,
          parent,
        ],
        { NIX_REMOTE: "", XDG_CACHE_HOME: xdg },
      );
    };

    const filtered = cli(["cache", "push", "main", parent], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect(filtered.status).toBe(0);
    expect(filtered.stdout).toContain("pushed 1, skipped-upstream 1");
    const partial = fetchAlone("whole-before");
    console.log(`nix copy --from main, after a push without --whole:\n${partial.stderr}`);
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain(`path '${child}' is not valid`);

    const whole = cli(["cache", "push", "main", parent, "--whole"], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect(whole.stderr).not.toContain("odu:");
    expect(whole.status).toBe(0);
    expect(whole.stdout).toContain("pushed 1, skipped-upstream 0");
    const fetched = fetchAlone("whole-after");
    console.log(`nix copy --from main, after a push with --whole:\n${fetched.stderr}`);
    expect({ status: fetched.status, stderr: fetched.stderr }).toMatchObject({ status: 0 });
    const landed = spawnSync(
      "nix",
      ["path-info", "--store", `local?root=${join(storeRoot, "whole-after")}`, child],
      { encoding: "utf-8" },
    );
    expect(landed.status).toBe(0);
  });

  it("refuses an unauthenticated read of a private bucket, and serves with netrc", async () => {
    const created = surface("bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "private",
      public: false,
      retentionDays: 90,
    });
    expect(created.status).toBe(0);
    priv = JSON.parse(created.stdout) as Bucket;
    const minted = surface("token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "private",
      scope: "write",
    });
    const token = (JSON.parse(minted.stdout) as { token: string }).token;
    privToken = token;
    const secret = build("odu-cache-e2e-private");
    const pushed = cli(["cache", "push", "private", secret], {
      ODU_CACHE_TOKEN: token,
      NIX_REMOTE: builderStore,
    });
    expect({ status: pushed.status, stderr: pushed.stderr.split("\n")[0] }).toEqual({
      status: 0,
      stderr: expect.stringContaining("1 paths in the closure"),
    });

    const anonymous = await fetch(`${priv.url}/${hashOf(secret)}.narinfo`);
    expect(anonymous.status).toBe(404);
    const authorised = await fetch(`${priv.url}/${hashOf(secret)}.narinfo`, {
      headers: { authorization: `Basic ${Buffer.from(`anyone:${token}`).toString("base64")}` },
    });
    expect(authorised.status).toBe(200);

    const netrc = join(storeRoot, "netrc");
    writeFileSync(netrc, printedNetrc("private", token), { mode: 0o600 });
    const privateStore = `local?root=${join(storeRoot, "private")}`;
    const read = spawnSync(
      "nix",
      [
        "build",
        "--store",
        privateStore,
        "--substituters",
        priv.url,
        "--trusted-public-keys",
        priv.publicKey,
        "--netrc-file",
        netrc,
        "--no-link",
        secret,
      ],
      { encoding: "utf-8", maxBuffer: BIG },
    );
    expect(read.stderr).not.toContain("not signed");
    expect(read.stderr).not.toContain("401");
    expect(read.status).toBe(0);
  });

  it("discovers a PRIVATE bucket, which answers its nix-cache-info to nobody", async () => {
    expect((await fetch(`${priv.url}/nix-cache-info`)).status).toBe(404);
    const stated = await fetch(`${priv.url}/nix-cache-info`, {
      headers: { authorization: `Bearer ${privToken}` },
    });
    expect(stated.status).toBe(200);
    expect(await stated.text()).toContain("Odu-Bucket: private\n");

    const blind = cli(["cache", "push", "--cache", priv.url, build("odu-cache-e2e-blind")], {
      ODU_CACHE_TOKEN: "",
      NIX_REMOTE: builderStore,
    });
    expect(blind.status).toBe(1);
    expect(blind.stderr).toContain("no token was sent");

    const discovered = build("odu-cache-e2e-private-discovered");
    const pushed = cli(
      ["cache", "push", "--cache", priv.url, "--output", "json", discovered],
      { ODU_CACHE_TOKEN: privToken, NIX_REMOTE: builderStore },
    );
    expect({ status: pushed.status, stderr: pushed.stderr }).toMatchObject({ status: 0 });
    const summary = JSON.parse(pushed.stdout) as { failed: number; served: string[] };
    expect(summary.failed).toBe(0);
    expect(summary.served).toContain(discovered);
  });

  it("redirects a private bucket's NAR to its store, and a real Nix client follows it", async () => {
    const created = surface("bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "fronted",
      public: false,
      retentionDays: 90,
      store: GATEWAY_STORE,
    });
    expect({ status: created.status, stderr: created.stderr }).toMatchObject({ status: 0 });
    fronted = JSON.parse(created.stdout) as Bucket;
    expect(fronted.store).toBe(GATEWAY_STORE);
    expect(fronted.readsFrom).toBe("odu");
    expect(new URL(fronted.url).hostname).toBe("127.0.0.1");

    const minted = surface("token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "fronted",
      scope: "write",
    });
    expect(minted.status).toBe(0);
    frontedToken = (JSON.parse(minted.stdout) as { token: string }).token;
    const token = frontedToken;

    const offloaded = build("odu-cache-e2e-fronted");
    const pushed = cli(["cache", "push", "fronted", offloaded], {
      ODU_CACHE_TOKEN: frontedToken,
      NIX_REMOTE: builderStore,
    });
    expect({ status: pushed.status, stderr: pushed.stderr.split("\n")[0] }).toMatchObject({
      status: 0,
    });
    expect(pushed.stdout).toContain("pushed 1");

    const basic = {
      authorization: `Basic ${Buffer.from(`anyone:${token}`).toString("base64")}`,
    };
    const narinfo = await fetch(`${fronted.url}/${hashOf(offloaded)}.narinfo`, { headers: basic });
    expect(narinfo.status).toBe(200);
    const narPath = /^URL: (.+)$/m.exec(await narinfo.text())?.[1];
    expect(narPath).toMatch(/^nar\//);
    const redirect = await fetch(`${fronted.url}/${narPath}`, {
      headers: basic,
      redirect: "manual",
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("cache-control")).toBe("private, no-store");
    expect((await redirect.arrayBuffer()).byteLength).toBe(0);
    const location = new URL(redirect.headers.get("location") ?? "");
    expect(location.hostname).toBe("localhost");
    expect(location.port).toBe(gateway.endpoint.port);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("600");

    const netrc = join(storeRoot, "fronted-netrc");
    writeFileSync(netrc, printedNetrc("fronted", token), { mode: 0o600 });
    const clientStore = `local?root=${join(storeRoot, "fronted-client")}`;
    const read = spawnSync(
      "nix",
      [
        "build",
        "--store",
        clientStore,
        "--substituters",
        fronted.url,
        "--trusted-public-keys",
        fronted.publicKey,
        "--netrc-file",
        netrc,
        "--no-link",
        offloaded,
      ],
      { encoding: "utf-8", maxBuffer: BIG },
    );
    expect(read.stderr).not.toContain("not signed");
    expect(read.stderr).not.toContain("403");
    expect(read.status).toBe(0);

    const verified = spawnSync(
      "nix",
      [
        "store",
        "verify",
        "--store",
        clientStore,
        "--trusted-public-keys",
        fronted.publicKey,
        offloaded,
      ],
      { encoding: "utf-8", maxBuffer: BIG },
    );
    expect(verified.stderr).not.toContain("not signed");
    expect(verified.status).toBe(0);

    const served = await until(
      "odu to log the two NARs it redirected",
      () => {
        const lines = narServed(offloaded);
        return lines.filter((line) => line.source === "redirect").length >= 2 ? lines : null;
      },
      30_000,
    );
    expect(served.find((line) => line.source === "redirect")).toMatchObject({
      bucket: "fronted",
      source: "redirect",
      bytes: 0,
    });
    expect(served.map((line) => line.source)).not.toContain("object");
    expect(served.every((line) => line.bytes === 0)).toBe(true);
  });

  it("pushes into an S3-backed bucket without sending odu a single NAR byte", async () => {
    const offloaded = build("odu-cache-e2e-direct");
    const pushed = cli(["cache", "push", "fronted", offloaded, "-o", "json"], {
      ODU_CACHE_TOKEN: frontedToken,
      NIX_REMOTE: builderStore,
    });
    expect({ status: pushed.status, stderr: pushed.stderr.split("\n")[0] }).toMatchObject({
      status: 0,
    });
    const summary = JSON.parse(pushed.stdout) as { pushed: number; failed: number; mode: string };
    expect(summary).toMatchObject({ pushed: 1, failed: 0, mode: "direct" });

    const uploads = await until(
      "odu to log the upload it took",
      () => {
        const lines = narUploaded("fronted");
        return lines.length > 0 ? lines : null;
      },
      30_000,
    );
    expect(uploads.map((line) => line.mode)).not.toContain("staged");
    expect(uploads.at(-1)).toMatchObject({ bucket: "fronted", mode: "direct" });

    const narinfo = await fetch(`${fronted.url}/${hashOf(offloaded)}.narinfo`, {
      headers: { authorization: `Bearer ${frontedToken}` },
    });
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${offloaded}`);
  });

  it("refuses a direct upload whose object changed under the readback, and keeps serving", async () => {
    const created = await surfaceAsync("bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "racy",
      public: false,
      retentionDays: 90,
      store: RACE_STORE,
    });
    expect({ status: created.status, stderr: created.stderr }).toMatchObject({ status: 0 });
    const racy = JSON.parse(created.stdout) as Bucket;
    const minted = await surfaceAsync("token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "racy",
      scope: "write",
    });
    expect(minted.status).toBe(0);
    const token = (JSON.parse(minted.stdout) as { token: string }).token;

    const racing = storeFile("odu-cache-e2e-racy", 4 << 20);
    rewriteNextTempRead = true;
    const pushed = await cliAsync(["cache", "push", "racy", racing, "-o", "json"], {
      ODU_CACHE_TOKEN: token,
      NIX_REMOTE: builderStore,
    });
    expect(rewritten).toHaveLength(1);
    const summary = JSON.parse(pushed.stdout) as {
      pushed: number;
      failed: number;
      failures: { message: string }[];
    };
    expect({ pushed: summary.pushed, failed: summary.failed }).toEqual({ pushed: 0, failed: 1 });
    expect(summary.failures[0]?.message).toContain("answered 400");
    expect(summary.failures[0]?.message).toContain("changed while it was being read");

    const refusals = await until(
      "odu to log the upload it refused",
      () => {
        const lines = verifyFailed("racy");
        return lines.length > 0 ? lines : null;
      },
      30_000,
    );
    expect(refusals.at(-1)).toMatchObject({ bucket: "racy", mode: "direct", reason: "short_read" });

    const alive = await fetch(`${racy.url}/nix-cache-info`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(alive.status).toBe(200);
    expect(await alive.text()).toContain("StoreDir:");
    const narinfo = await fetch(`${racy.url}/${hashOf(racing)}.narinfo`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(narinfo.status).toBe(404);
  }, 300_000);

  it("pushes a two-path closure in dependency order, and substitutes the top path cold", () => {
    const { parent, child } = buildPair("odu-cache-e2e-pair");
    expect(parent).not.toBe("");
    expect(child).not.toBe("");

    const pushed = cli(["cache", "push", "main", parent], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect(pushed.status).toBe(0);
    expect(pushed.stdout).toContain("pushed 2");

    const cold = `local?root=${join(storeRoot, "cold")}`;
    const substituted = nix(
      [
        "build",
        "--store",
        cold,
        "--substituters",
        main.url,
        "--trusted-public-keys",
        main.publicKey,
        "--no-link",
        parent,
      ],
      { NIX_REMOTE: "" },
    );
    expect(substituted.status).toBe(0);
    const present = spawnSync("nix", ["path-info", "--store", cold, child], {
      encoding: "utf-8",
    });
    expect(present.status).toBe(0);
  });

  it("refuses an upload with no bytes behind it, and one whose hash disagrees", async () => {
    const created = surface("bucket_create", {
      rootToken: ROOT_TOKEN,
      name: "thief",
      public: false,
      retentionDays: 90,
    });
    expect(created.status).toBe(0);
    const thief = JSON.parse(created.stdout) as Bucket;
    const minted = surface("token_mint", {
      rootToken: ROOT_TOKEN,
      bucket: "thief",
      scope: "write",
    });
    const token = (JSON.parse(minted.stdout) as { token: string }).token;
    const hash = hashOf(pinned);

    const bare = await fetch(`${thief.url}/${hash}.narinfo`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: [
        `StorePath: ${pinned}`,
        "URL: nar/0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76.nar.zst",
        "Compression: zstd",
        "NarHash: sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76",
        "NarSize: 279592",
        "References: ",
        "",
      ].join("\n"),
    });
    expect(bare.status).toBe(400);
    expect(await bare.text()).toContain("never uploaded");
    expect(await statusOf(thief.url, pinned)).toBe(404);

    const truncated = "0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76";
    const put = await fetch(`${thief.url}/nar/${truncated}.nar.zst`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(200);
    const lying = await fetch(`${thief.url}/${hash}.narinfo`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: [
        `StorePath: ${pinned}`,
        `URL: nar/${truncated}.nar.zst`,
        "Compression: none",
        "NarHash: sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76",
        "NarSize: 279592",
        "References: ",
        "",
      ].join("\n"),
    });
    expect(lying.status).toBe(400);
    expect(await lying.text()).toContain("hashes to");
    expect(await statusOf(thief.url, pinned)).toBe(404);
  });

  it("refuses a narinfo name that is not a store path hash, and writes nothing", async () => {
    const before = stagedFiles();
    for (const name of ["..%2F..%2Fescape.narinfo", "short.narinfo"]) {
      const response = await fetch(`${main.url}/${name}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${writeToken}` },
        body: "StorePath: /nix/store/x\n",
      });
      expect({ name, status: response.status }).toEqual({ name, status: 400 });
    }
    expect(stagedFiles()).toEqual(before);
  });

  it("keeps a pinned closure and evicts what nothing holds", async () => {
    const pin = surface("pin_create", {
      rootToken: ROOT_TOKEN,
      bucket: "main",
      name: "release-1",
      paths: [pinned],
    });
    expect({ status: pin.status, stderr: pin.stderr }).toEqual({ status: 0, stderr: "" });
    expect((JSON.parse(pin.stdout) as { rootPaths: string[] }).rootPaths).toContain(pinned);

    const collected = surface("gc_run", { rootToken: ROOT_TOKEN, bucket: "main" });
    expect(collected.status).toBe(0);
    const report = JSON.parse(collected.stdout) as {
      buckets: { bucket: string; evicted: number }[];
    };
    expect(report.buckets[0]?.evicted).toBeGreaterThanOrEqual(1);

    expect(await statusOf(main.url, pinned)).toBe(200);
    expect(await statusOf(main.url, evictable)).toBe(404);
  });

  it("reports what it holds", () => {
    const stats = surface("stats_read", { rootToken: ROOT_TOKEN });
    expect(stats.status).toBe(0);
    const answer = JSON.parse(stats.stdout) as {
      buckets: { name: string; objects: number }[];
      objects: number;
      hits: number;
    };
    expect(answer.buckets.map((bucket) => bucket.name).sort()).toEqual([
      "everything",
      "fronted",
      "main",
      "private",
      "racy",
      "thief",
    ]);
    expect(answer.objects).toBeGreaterThanOrEqual(2);
    expect(answer.hits).toBeGreaterThan(0);
  });
});

async function narinfoOf(url: string, storePath: string): Promise<string> {
  const response = await fetch(`${url}/${hashOf(storePath)}.narinfo`);
  expect(response.status).toBe(200);
  return await response.text();
}

async function statusOf(url: string, storePath: string): Promise<number> {
  const response = await fetch(`${url}/${hashOf(storePath)}.narinfo`, { method: "HEAD" });
  return response.status;
}
