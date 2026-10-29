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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  cleanup,
  scratchDir,
  suitePortFor,
} from "./harness";
import { type WebWorld, startWebService } from "./webHarness";

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
  const res = nix([
    "build",
    "--store",
    builderStore,
    "--no-link",
    "--print-out-paths",
    "--impure",
    "--expr",
    `derivation { name = "${name}"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo ${name} > $out" ]; }`,
  ]);
  if (res.status !== 0) throw new Error(`nix build ${name} failed:\n${res.stderr}`);
  return res.stdout.trim();
}

/** The 32-character hash a narinfo is named for. */
const hashOf = (storePath: string): string =>
  storePath.slice(storePath.lastIndexOf("/") + 1).slice(0, 32);

interface Bucket {
  name: string;
  url: string;
  publicKey: string;
  keyName: string;
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
    expect(main.url).toBe(`${world.origin}/main`);
    expect(main.keyName).toBe("main-1");
    expect(main.publicKey.startsWith("main-1:")).toBe(true);

    const listed = cli(["cache", "list", "-o", "json"]);
    expect(listed.status).toBe(0);
    expect((JSON.parse(listed.stdout) as { buckets: Bucket[] }).buckets.map((b) => b.name)).toEqual([
      "main",
    ]);
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
    expect(copied.status).toBe(0);

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
    expect(pushed.status).toBe(0);

    const anonymous = await fetch(`${priv.url}/${hashOf(secret)}.narinfo`);
    expect(anonymous.status).toBe(401);
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
        "copy",
        "--from",
        priv.url,
        "--to",
        privateStore,
        "--netrc-file",
        netrc,
        "--no-check-sigs",
        secret,
      ],
      { encoding: "utf-8", maxBuffer: BIG },
    );
    expect(read.stderr).not.toContain("401");
    expect(read.status).toBe(0);
  });

  it("keeps a pinned closure and evicts what nothing holds", async () => {
    // Both paths are older than retention 0 the moment they were pushed; the
    // pin is the only thing between `pinned` and the collector.
    const pin = cli(["cache", "pin", "main", "release-1", pinned, "-o", "json"]);
    expect(pin.status).toBe(0);
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
    expect(answer.buckets.map((bucket) => bucket.name).sort()).toEqual(["main", "private"]);
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
