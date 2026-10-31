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
 * verify, sign, read a private bucket, then collect.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  cleanup,
  currentNixSystem,
  scratchDir,
  suitePortFor,
} from "../../../../tests/e2e/harness";
import { type WebWorld, startWebService } from "../../../../tests/e2e/webHarness";

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

const dirs: string[] = [];

/** macOS cannot build into a diverted store; Linux can, and does. */
const HOST_BUILD = currentNixSystem().endsWith("-darwin");

beforeAll(async () => {
  odu = buildOduBinary();
  storeRoot = scratchDir("odu-e2e-cache-");
  builderStore = `local?root=${join(storeRoot, "builder")}`;
  substituteStore = `local?root=${join(storeRoot, "substitute")}`;
  world = await startWebService(
    odu,
    {
      ODU_ROOT_TOKEN: ROOT_TOKEN,
      ODU_CACHE_STORE: `local?root=${join(storeRoot, "server")}`,
    },
    suitePortFor("cache"),
  );
}, 900_000); // nix build, cold cache

afterAll(() => {
  world?.dispose();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

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
 * Two paths where one REFERENCES the other — the shape every real closure has,
 * and the one the ordering exists for: the parent cannot be imported until the
 * child is valid, so a push that sent them in the wrong order would defer, and
 * a server that imported eagerly would fail.
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
}

let main: Bucket;
let writeToken: string;
let pinned: string;
let evictable: string;

describe("odu serves a Nix binary cache", () => {
  it("creates a bucket and prints what a client has to trust", () => {
    const created = cli([
      "cache",
      "create",
      "main",
      "--retention-days",
      "0",
      "-o",
      "json",
    ]);
    expect(created.stderr).toBe("");
    expect(created.status).toBe(0);
    main = JSON.parse(created.stdout) as Bucket;
    expect(main.name).toBe("main");
    expect(main.url).toBe(`${world.origin}/cache/main`);
    expect(main.keyName).toBe("main-1");
    expect(main.publicKey.startsWith("main-1:")).toBe(true);

    const listed = cli(["cache", "list", "-o", "json"]);
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
    const refused = cli(["cache", "create", "other"], { ODU_ROOT_TOKEN: "wrong" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("root token");
  });

  it("mints a write token, and shows it once", () => {
    const minted = cli(["cache", "token", "mint", "main", "--write", "-o", "json"]);
    expect(minted.status).toBe(0);
    const answer = JSON.parse(minted.stdout) as {
      token: string;
      facts: { id: string; scope: string };
    };
    expect(answer.token.startsWith("odu_")).toBe(true);
    expect(answer.facts.scope).toBe("write");
    writeToken = answer.token;

    const listed = cli(["cache", "token", "list", "-o", "json"]);
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
    // TWO MEGABYTES OF RANDOM BYTES: the NAR's compressed stream cannot fit one
    // part at `--part-size 1`, which is the shape Cloudflare forces on a real
    // closure. A part is an overwrite by index, so this is also the protocol's
    // retry story in miniature.
    const big = realised(
      `derivation { name = "odu-cache-e2e-chunked"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "dd if=/dev/urandom of=$out bs=1048576 count=2 2>/dev/null" ]; }`,
      "odu-cache-e2e-chunked",
    );
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
    // point of the default — and a server whose store is NOT the builder's has
    // nothing to fall back on, so its referrers would sit at 202 for ever. The
    // escape is a bucket with no upstream keys at all.
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

    const created = cli(["cache", "create", "everything", "--no-upstream", "-o", "json"]);
    expect(created.status).toBe(0);
    const everything = JSON.parse(created.stdout) as Bucket;
    expect(everything.upstreamKeys).toEqual([]);
    const minted = cli(["cache", "token", "mint", "everything", "--write", "-o", "json"]);
    expect(minted.status).toBe(0);
    const token = (JSON.parse(minted.stdout) as { token: string }).token;

    const pushed = cli(["cache", "push", "everything", within], {
      NIX_REMOTE: builderStore,
      ODU_CACHE_TOKEN: token,
    });
    expect(pushed.status).toBe(0);
    expect(pushed.stdout).toContain("pushed 1");
    expect(pushed.stdout).toContain("skipped-upstream 0");

    // And the flag has an opposite: naming both is refused, not merged.
    const both = cli(["cache", "create", "nope", "--no-upstream", "--upstream-key", "x-1"]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("opposites");
  });

  it("refuses an unauthenticated read of a private bucket, and serves with netrc", async () => {
    const created = cli(["cache", "create", "private", "--private", "-o", "json"]);
    expect(created.status).toBe(0);
    const priv = JSON.parse(created.stdout) as Bucket;
    const minted = cli(["cache", "token", "mint", "private", "--write", "-o", "json"]);
    const token = (JSON.parse(minted.stdout) as { token: string }).token;
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
    const created = cli(["cache", "create", "thief", "--private", "-o", "json"]);
    expect(created.status).toBe(0);
    const thief = JSON.parse(created.stdout) as Bucket;
    const minted = cli(["cache", "token", "mint", "thief", "--write", "-o", "json"]);
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
    const pin = cli(["cache", "pin", "main", "release-1", pinned, "-o", "json"]);
    expect({ status: pin.status, stderr: pin.stderr }).toEqual({ status: 0, stderr: "" });
    expect((JSON.parse(pin.stdout) as { rootPaths: string[] }).rootPaths).toContain(pinned);

    const collected = cli(["cache", "gc", "main", "-o", "json"]);
    expect(collected.status).toBe(0);
    const report = JSON.parse(collected.stdout) as {
      buckets: { bucket: string; evicted: number }[];
    };
    expect(report.buckets[0]?.evicted).toBeGreaterThanOrEqual(1);

    expect(await statusOf(main.url, pinned)).toBe(200);
    expect(await statusOf(main.url, evictable)).toBe(404);
  });

  it("reports what it holds", () => {
    const stats = cli(["cache", "stats", "-o", "json"]);
    expect(stats.status).toBe(0);
    const answer = JSON.parse(stats.stdout) as {
      buckets: { name: string; objects: number }[];
      objects: number;
      hits: number;
    };
    expect(answer.buckets.map((bucket) => bucket.name).sort()).toEqual([
      "everything",
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
