/**
 * End-to-end: the cache a real `nix` writes to and reads from.
 *
 * Everything the cache decides is unit-tested against a fake store; what only a
 * black-box run can catch is whether NIX AGREES — whether the narinfo is a
 * narinfo, whether the base32 hash spelling is Nix's, whether the fingerprint a
 * signature covers is the one Nix verifies, and whether an upload staged as a
 * `file://` cache imports. So this suite drives the nix-built binary and the
 * real client, and asserts on `nix build` succeeding rather than on bytes.
 *
 * **Nothing here touches the host store.** The daemon's cache is given
 * `$ODU_CACHE_STORE=local?root=<tmp>`, and every client store is a chroot of
 * its own: a CI host needs no `trusted-users` entry, and a failure cannot leave
 * paths in somebody's real store. The builder store is a chroot too, reached by
 * `NIX_REMOTE`, which is how `odu cache push` — a program that runs `nix` — is
 * pointed at the same store the derivation was built into.
 *
 * The order of the tests is the order of the story: create, push, substitute,
 * verify, sign, read a private bucket, follow a redirect to the store that
 * holds its NAR, then collect.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Gateway, startGateway } from "@odu/objects/testing";
import {
  BIG,
  buildOduBinary,
  cleanup,
  currentNixSystem,
  scratchDir,
  suitePortFor,
} from "../../../../tests/e2e/harness";
import { type WebWorld, startWebService, until } from "../../../../tests/e2e/webHarness";

/** The root token this world's daemon was started with. Administration needs
 *  it; reads of a public bucket do not. */
const ROOT_TOKEN = "e2e-root-token";

let odu: string;
let world: WebWorld;
/** Every chroot store this suite makes: the builder's, the cache's, and the
 *  substitutes'. */
let storeRoot: string;
let builderStore: string;
let substituteStore: string;
/** A real S3 service of this suite's own, declared to the daemon as an object
 *  store, so one bucket's NARs live somewhere odu can hand a client off to. */
let gateway: Gateway;

/** The name that store is declared under — what `bucket_create { store }` says. */
const GATEWAY_STORE = "gw";

const dirs: string[] = [];

/** macOS cannot build into a diverted store; Linux can, and does. */
const HOST_BUILD = currentNixSystem().endsWith("-darwin");

beforeAll(async () => {
  odu = buildOduBinary();
  storeRoot = scratchDir("odu-e2e-cache-");
  builderStore = `local?root=${join(storeRoot, "builder")}`;
  substituteStore = `local?root=${join(storeRoot, "substitute")}`;

  // THE DECLARED STORE, written before the daemon starts: `$ODU_OBJECT_STORES`
  // is read once at boot, so a store this suite wants has to exist before the
  // service does.
  gateway = await startGateway();
  const target = await gateway.bucket();
  const credentials = join(storeRoot, "gw-credentials");
  writeFileSync(
    credentials,
    `AWS_ACCESS_KEY_ID=${target.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${target.secretAccessKey}\n`,
    { mode: 0o600 },
  );
  const stores = join(storeRoot, "object-stores.json");
  writeFileSync(
    stores,
    JSON.stringify({
      [GATEWAY_STORE]: {
        kind: "s3",
        // `localhost`, SPELLED THAT WAY ON PURPOSE. The gateway listens on
        // 127.0.0.1 and so does odu, but the two hosts differ as STRINGS —
        // which is the whole of the redirect proof below: curl drops an
        // `Authorization` header when a redirect changes host, so a NAR that
        // still arrives proves the presigned URL carries its own authority and
        // that the bucket's token never reached the store.
        endpoint: `http://localhost:${gateway.endpoint.port}`,
        bucket: target.bucket,
        region: target.region,
        credentialsFile: credentials,
      },
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
}, 900_000); // nix build, cold cache

afterAll(async () => {
  world?.dispose();
  await gateway?.stop();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

/** A deterministic, incompressible file in the builder's store. Xorshift keeps
 *  it reproducible across hosts without a toolchain: no fetch, no /dev/urandom,
 *  no dd. */
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

/** `odu …` against this world's service, as the operator. */
function cli(argv: string[], env: NodeJS.ProcessEnv = {}): Ran {
  const res = spawnSync(odu, argv, {
    env: { ...world.env, ODU_ROOT_TOKEN: ROOT_TOKEN, ...env },
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * One administrative verb, through `odu surface` — the only face that
 * administers the cache now. The root token is a FIELD of the input, not an
 * environment side channel, so each call names the token it is making.
 *
 * Exit 0 is an answer, 1 a refusal (as JSON on stderr), 2 a usage error, 3
 * nothing serving.
 */
function surface(verb: string, input: unknown, env: NodeJS.ProcessEnv = {}): Ran {
  return cli(["surface", "cache", verb, "--input", JSON.stringify(input), "--json"], env);
}

/** `nix …` against the builder's store — the machine that built the paths. */
function nix(argv: string[], env: NodeJS.ProcessEnv = {}): Ran {
  const res = spawnSync("nix", argv, {
    env: { ...process.env, NIX_REMOTE: builderStore, ...env },
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * A derivation with NO inputs: `/bin/sh` is not a store path, so nothing lands
 * in the closure but the output itself. That is what makes this suite fast —
 * and it is still a real derivation, built by a real `nix build` into a store
 * the cache has never seen.
 */
function build(name: string): string {
  return realised(`derivation { name = "${name}"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo ${name} > $out" ]; }`, name);
}

/**
 * Realise a derivation into the BUILDER's store, whichever way this platform
 * allows.
 *
 * On Linux that is one `nix build --store local?root=…`. On macOS it cannot be:
 * Nix refuses — `building using a diverted store is not supported on this
 * platform` — and the refusal is about the diverted store, not the sandbox
 * (`--option sandbox false` says the same thing). So there the path is built in
 * the HOST store and copied into the builder's, which keeps the reference edges
 * a plain `nix store add-path` throws away, and is still two store paths the
 * cache has never seen. The host store is the only thing a macOS run touches
 * outside its own temp dir, and the paths are bytes long.
 */
function realised(expr: string, what: string): string {
  const args = ["build", "--no-link", "--print-out-paths", "--impure", "--expr", expr];
  const res = HOST_BUILD
    ? spawnSync("nix", args, { encoding: "utf-8", maxBuffer: BIG, env: process.env })
    : nix([...args.slice(0, 1), "--store", builderStore, ...args.slice(1)]);
  if (res.status !== 0) throw new Error(`nix build ${what} failed:\n${res.stderr}`);
  const out = res.stdout.trim();
  if (!HOST_BUILD) return out;
  // `--no-check-sigs`: a chroot store is not a trusted destination, and these
  // paths were built on this machine a moment ago. The alternative is signing
  // fixtures, which buys a test nothing.
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

/**
 * Two paths where one REFERENCES the other — the shape every real closure has.
 * The parent records immediately now (a reference is a name in the narinfo),
 * and a cold substitute still walks the closure.
 */
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

  // Building the PARENT builds the child with it, and `--print-out-paths` on a
  // derivation answers its output.
  const parent = realised(
    `let child = ${child}; in derivation { name = "${name}-parent"; ` +
      `system = builtins.currentSystem; builder = "/bin/sh"; ` +
      // The child's path is written INTO the output: Nix computes a path's
      // references by scanning its contents for store-path hashes, so a
      // reference that appears only in `args` would not survive. `echo` is a
      // shell builtin, which is what a builder with an empty PATH has.
      `args = [ "-c" "echo ${'$'}{child} > $out" ]; }`,
    `${name}-parent`,
  );
  return { parent, child: childPath };
}

/** Every file the daemon has staged, so a refusal can be checked to have
 *  written nothing. */
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

/** The 32-character hash a narinfo is named for. */
const hashOf = (storePath: string): string =>
  storePath.slice(storePath.lastIndexOf("/") + 1).slice(0, 32);

interface Bucket {
  name: string;
  url: string;
  publicKey: string;
  keyName: string;
  upstreamKeys: string[];
  /** The declared store its objects live in. */
  store: string;
  /** Who answers a read of it — the store itself, or odu (PLAN 2.8). */
  readsFrom: "store" | "odu";
}

/** One `cache.nar.served` line the daemon wrote. The daemon's log is JSON per
 *  line on stderr, which the world's harness collects into a file: this is the
 *  only place a test can see HOW a NAR left — whether odu streamed it or handed
 *  the client an address. */
interface Served {
  bucket: string;
  /** The store path the NAR holds — what a caller names a read by, since the
   *  line's `hash` is the NAR's and not the store path's. */
  path: string;
  bytes: number;
  source: "object" | "transition" | "redirect";
}

/** Every `cache.nar.served` line written for `storePath`, in order. */
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
      // A partial last line: the daemon is still writing it. The poll retries.
    }
  }
  return lines;
}

/** One `cache.nar.uploaded` line: how a NAR's bytes reached the bucket. */
interface Uploaded {
  bucket: string;
  file: string;
  mode: "direct" | "staged";
  parts: number;
  bytes: number;
}

/** Every `cache.nar.uploaded` line for one bucket, in order. */
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
      // A partial last line: the daemon is still writing it.
    }
  }
  return lines;
}

let main: Bucket;
let writeToken: string;
let pinned: string;
let evictable: string;
/** The private bucket, and a write token for it — made by the private-read
 *  scenario and read by the discovery one below it. */
let priv: Bucket;
let privToken: string;
/** The S3-backed bucket, and a write token for it — made by the redirect
 *  scenario and pushed to again by the direct-upload one (PLAN 2.9). */
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
    // THE PROTOCOL PATH, not the surface: anonymous `cache use` did not work on
    // a daemon with a door because the connection was refused first. The
    // consumer facts are as public as the NARs.
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
    // The plaintext is nowhere in the listing — the database holds a hash.
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

    // The substituter, trusted by the bucket's own key, into a store that has
    // never seen the path.
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
    // `nix store verify` narrates each path on stderr and exits 0 when every
    // one is signed by a trusted key.
    expect(verified.stderr).not.toContain("not signed");
    expect(verified.status).toBe(0);
  });

  it("pushes a NAR in parts, and substitutes the joined path", () => {
    // TWO MEGABYTES OF DETERMINISTIC, INCOMPRESSIBLE BYTES: the NAR's compressed
    // stream cannot fit one part at `--part-size 1`, which is the shape
    // Cloudflare forces on a real closure. A part is an overwrite by index, so
    // this is also the protocol's retry story in miniature.
    //
    // NOT A DERIVATION: the lane host's build sandbox has `/bin/sh` and no
    // `dd`, and a fixture that fetches or runs host tools is not a fixture the
    // lane can build. The bytes are made here, deterministically, and added to
    // the store with `nix store add-file`.
    const big = storeFile("odu-cache-e2e-chunked", 2 * 1024 * 1024);
    const pushed = cli(["cache", "push", "main", big, "--part-size", "1"], {
      ODU_CACHE_TOKEN: writeToken,
      NIX_REMOTE: builderStore,
    });
    expect({ status: pushed.status, stderr: pushed.stderr }).toMatchObject({ status: 0 });
    // The voice names the parts, so a large push is not silent.
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
    // WHAT A CONSUMER REPOSITORY HAS is the URL in its `nix.conf`. The push
    // origin and the bucket are read off `<substituter>/nix-cache-info`, which
    // the cache states for itself — nothing here names a bucket or an origin.
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

    // SERVED WHERE NIX ASKS, which is what the push action then proves.
    const narinfo = await fetch(`${main.url}/${hashOf(discovered)}.narinfo`);
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${discovered}`);
  });

  it("takes a path `nix copy --to` uploads, and keeps the client's signature", async () => {
    evictable = build("odu-cache-e2e-evictable");

    // A key of the CLIENT's own, so the path carries a signature the bucket did
    // not make — which is the signature a lane host's `nix store sign` leaves.
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

    // The token rides in the URL, which is the CI spelling that needs no file.
    const copied = nix([
      "copy",
      "--to",
      `${main.url.replace("http://", `http://x:${writeToken}@`)}`,
      "--no-recursive",
      evictable,
    ]);
    // `nix copy` narrates each path on stderr; the exit code is the answer.
    expect({ status: copied.status, error: copied.stderr.includes("error:") }).toEqual({
      status: 0,
      error: false,
    });

    const narinfo = await narinfoOf(main.url, evictable);
    expect(narinfo).toContain(`StorePath: ${evictable}`);
    expect(narinfo).toContain(`Sig: ${main.keyName}:`);
    expect(narinfo).toContain("Sig: client-1:");

    // And it substitutes, so the narinfo the server re-signed is a narinfo Nix
    // accepts.
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
    // A path carrying a `cache.nixos.org-1` signature is what a lane host that
    // built against nixpkgs produces. `main` skips it as upstream — the whole
    // point of the default. The escape is a bucket with no upstream keys at
    // all; such a bucket stores it like any other object.
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
    // Progress goes to stderr by design; the exit code is the answer.
    expect({ status: pushed.status, stderr: pushed.stderr.split("\n")[0] }).toEqual({
      status: 0,
      stderr: expect.stringContaining("1 paths in the closure"),
    });

    // 404, not 401: "you need a token" would confirm the bucket exists.
    const anonymous = await fetch(`${priv.url}/${hashOf(secret)}.narinfo`);
    expect(anonymous.status).toBe(404);
    const authorised = await fetch(`${priv.url}/${hashOf(secret)}.narinfo`, {
      headers: { authorization: `Basic ${Buffer.from(`anyone:${token}`).toString("base64")}` },
    });
    expect(authorised.status).toBe(200);

    // The netrc file Nix actually reads — `netrc-file`, never `~/.netrc`.
    const netrc = join(storeRoot, "netrc");
    writeFileSync(netrc, `machine ${new URL(priv.url).hostname} password ${token}\n`, {
      mode: 0o600,
    });
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
    // The bucket's OWN key, so a private read verifies signatures rather than
    // skipping them.
    expect(read.stderr).not.toContain("not signed");
    expect(read.stderr).not.toContain("401");
    expect(read.status).toBe(0);
  });

  it("discovers a PRIVATE bucket, which answers its nix-cache-info to nobody", async () => {
    // THE BLOCKER THIS PINS: an anonymous read of a private bucket is a 404,
    // so a discovery that carried no credential would leave exactly the
    // buckets that need a token unpushable — and `--cache` is the push
    // action's only address input now.
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
    // PLAN 2.8, END TO END, with nothing faked: the bucket's objects live on a
    // real S3 service, odu renders and signs the narinfo as it always has, and
    // answers the NAR with an ADDRESS instead of bytes.
    //
    // The bucket is PRIVATE and the store is spelled `localhost` while the
    // daemon is bound at `127.0.0.1`. curl calls that a change of host and
    // drops the `Authorization` the netrc supplied, so a NAR that arrives
    // anyway arrived on the presigned URL's own signature — which is the claim
    // worth proving: the read left odu, and the bucket's token did not.
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
    // The store fronts no public URL of its own, so odu is still the address a
    // client is handed: it is the NAR, and only the NAR, that leaves.
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

    // THE REDIRECT ITSELF, before anything is asked to follow one. A 307, so
    // the method survives the hop; a URL on the STORE's host; no body; and
    // nothing an edge may keep, because the signature in it expires.
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

    // AND A REAL CLIENT FOLLOWS IT. The netrc names odu's host only — the
    // gateway is nowhere in it — so the hop is unauthenticated by construction.
    const netrc = join(storeRoot, "fronted-netrc");
    writeFileSync(netrc, `machine ${new URL(fronted.url).hostname} password ${token}\n`, {
      mode: 0o600,
    });
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

    // The path is VALID in the client's store: the bytes that came off the
    // gateway are the NAR the narinfo odu signed describes.
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

    // ODU STREAMED ZERO NAR BYTES. The daemon's own log is the only witness to
    // that: every line for this path says `redirect`, and none says `object`.
    // Polled, because the world collects the daemon's stderr on this process's
    // event loop and the `nix build` above held it.
    // TWO of them: the probe above, and the client's own fetch — so this waits
    // for the second rather than passing on the first and calling the line the
    // suite made its own proof.
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
    // PLAN 2.9, END TO END: the bucket from the scenario above lives on a real
    // S3 service, so its push NEGOTIATES `direct` — the client sends the bytes
    // to presigned URLs at the gateway, and odu reads the object back to prove
    // it before the path is recorded.
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

    // THE DAEMON'S OWN ACCOUNT OF IT: a direct upload of this path, and odu's
    // NAR upload routes were handed nothing — a staged line for this bucket
    // would be bytes that crossed the machine. Polled, because the daemon
    // writes the line after it has answered the client.
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

    // AND IT IS A PATH THE CACHE SERVES: the narinfo odu signed is there, over
    // the object its own copy made inside the store — which is the proof that
    // the readback verified and the copy landed.
    const narinfo = await fetch(`${fronted.url}/${hashOf(offloaded)}.narinfo`, {
      headers: { authorization: `Bearer ${frontedToken}` },
    });
    expect(narinfo.status).toBe(200);
    expect(await narinfo.text()).toContain(`StorePath: ${offloaded}`);
  });

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

    // The TOP path only, into a store that has neither: substitution has to
    // walk the reference it was given, which is the fingerprint with a
    // non-empty reference list and the ordering, end to end.
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
    // THE CROSS-BUCKET HOLE: `private` holds a write token, and `main` holds a
    // path. A narinfo alone must not be enough to publish it.
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

    // A NAR whose bytes do not hash to the narinfo's NarHash.
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
        // `none`, so the refusal under test is the HASH and not a decompressor
        // that could not read the frame.
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
    // Both paths are older than retention 0 the moment they were pushed; the
    // pin is the only thing between `pinned` and the collector.
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
      "thief",
    ]);
    expect(answer.objects).toBeGreaterThanOrEqual(2);
    // Every read above went through the protocol, so the counter moved.
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
