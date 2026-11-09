/**
 * WHAT A REPOSITORY ALREADY SAID ABOUT ITS CACHE — `flake.nix`'s `nixConfig`,
 * read (PLAN 4.1) — and the restraint the reading runs under.
 *
 * Two halves. The PARSE is about somebody else's file: Nix accepts a
 * multi-valued setting as a space-separated STRING or as a LIST and a
 * repository may have written either, and `substituters` and
 * `extra-substituters` are two spellings of one set. Get either wrong and a
 * repo that reads from a cache is told it names none.
 *
 * The EVALUATION is about a hostile one. `flake.nix` is the least trusted
 * input odu has — on `odu ci run` over a contributor's branch it is
 * attacker-controlled — and it is the only repository-supplied expression that
 * executes on the SERVICE. The cases below are the three escapes that were
 * open: reading the daemon's environment, reading its disk, and fetching.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeCache,
  FLAKE_EVAL_MAX_STDERR,
  lastLine,
  nixEvalFlakeConfig,
  oduCachesOf,
  readFlakeNixConfig,
} from "./push";
import { cacheCommand } from "./cli";

/** A directory with a `flake.nix` in it. For the PARSE cases the file's
 *  content never matters — the evaluation is injected — and its existence is
 *  the gate; for the EVALUATION cases it is the subject. */
function withFlake(source = "{ nixConfig = {}; }\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-flake-"));
  writeFileSync(join(dir, "flake.nix"), source);
  return dir;
}

const evaluating = (value: unknown) => async () =>
  ({ ok: true as const, json: JSON.stringify(value) });

describe("reading a flake's nixConfig", () => {
  it("answers `no flake.nix` for a directory without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-noflake-"));
    try {
      expect(await readFlakeNixConfig(dir, evaluating({}))).toEqual({
        ok: false,
        reason: "no flake.nix",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says COULD NOT READ and quotes nix, rather than blaming the flake", async () => {
    const dir = withFlake();
    try {
      const read = await readFlakeNixConfig(dir, async () => ({
        ok: false,
        stderr: "error: attribute 'nixConfig' missing",
      }));
      expect(read).toMatchObject({ ok: false });
      if (read.ok) return;
      expect(read.reason).toContain("could not read nixConfig");
      expect(read.reason).toContain("attribute 'nixConfig' missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a space-separated STRING as several substituters", async () => {
    const dir = withFlake();
    try {
      const read = await readFlakeNixConfig(
        dir,
        evaluating({ "extra-substituters": "https://a.example https://b.example" }),
      );
      expect(read).toMatchObject({ ok: true });
      if (!read.ok) return;
      expect(read.config.substituters).toEqual([
        "https://a.example",
        "https://b.example",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unions `substituters` with `extra-substituters`, without repeats", async () => {
    const dir = withFlake();
    try {
      const read = await readFlakeNixConfig(
        dir,
        evaluating({
          substituters: ["https://a.example"],
          "extra-substituters": ["https://a.example", "https://b.example"],
        }),
      );
      expect(read).toMatchObject({ ok: true });
      if (!read.ok) return;
      expect(read.config.substituters).toEqual([
        "https://a.example",
        "https://b.example",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads both spellings of the trusted keys", async () => {
    const dir = withFlake();
    try {
      const read = await readFlakeNixConfig(
        dir,
        evaluating({
          "trusted-public-keys": "one:AAA=",
          "extra-trusted-public-keys": ["two:BBB="],
        }),
      );
      expect(read).toMatchObject({ ok: true });
      if (!read.ok) return;
      expect(read.config.trustedPublicKeys).toEqual(["one:AAA=", "two:BBB="]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a nixConfig that is not an attrset", async () => {
    const dir = withFlake();
    try {
      expect(await readFlakeNixConfig(dir, evaluating(["a"]))).toEqual({
        ok: false,
        reason: "flake.nix has no nixConfig attrset",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what `nix` is published saying", () => {
  it("keeps the LAST line, which is where the fault is, and bounds it", () => {
    expect(lastLine("trace: a\ntrace: b\nerror: the real one")).toBe("error: the real one");
    const long = `error: ${"x".repeat(5_000)}`;
    const said = lastLine(long);
    // THE REASON BECOMES AN ARGV and a durable manifest field, and a
    // repository controls every byte of it. A multi-hundred-KB error line
    // would otherwise fail the launch with an unrelated-looking error.
    expect(said.length).toBeLessThanOrEqual(FLAKE_EVAL_MAX_STDERR + 32);
    expect(said).toContain("truncated");
  });
});

/** The restrained evaluation against a REAL `nix`. These are the escapes the
 *  first shape left open, so they are asserted against the thing that would
 *  have been exploited rather than against a stub. */
describe("evaluating a hostile flake.nix", () => {
  const evaluate = async (source: string) => {
    const dir = withFlake(source);
    try {
      // THE ENVIRONMENT IS AN ARGUMENT, and this is the case that proves
      // what the evaluator does with it: a secret in the parent is not a
      // secret the expression can reach.
      return await nixEvalFlakeConfig(process.env)(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("evaluates an honest nixConfig", async () => {
    const answered = await evaluate(
      '{ nixConfig = { extra-substituters = [ "https://cache.example/main" ]; }; }\n',
    );
    expect(answered).toMatchObject({ ok: true });
    if (!answered.ok) return;
    expect(JSON.parse(answered.json)).toEqual({
      "extra-substituters": ["https://cache.example/main"],
    });
  }, 120_000);

  it("cannot read the daemon's environment", async () => {
    // `$ODU_ROOT_TOKEN` lives in the daemon's environment, and this value is
    // PUBLISHED: it reaches the run's setup log, the manifest and `run_read`.
    process.env.ODU_FLAKE_EVAL_PROBE = "the-root-token";
    try {
      const answered = await evaluate(
        '{ nixConfig = { extra-substituters = [ (builtins.getEnv "ODU_FLAKE_EVAL_PROBE") ]; }; }\n',
      );
      expect(answered).toMatchObject({ ok: true });
      if (!answered.ok) return;
      expect(answered.json).not.toContain("the-root-token");
    } finally {
      delete process.env.ODU_FLAKE_EVAL_PROBE;
    }
  }, 120_000);

  it("cannot read a file outside the checkout", async () => {
    const answered = await evaluate(
      "{ nixConfig = { extra-substituters = [ (builtins.readFile /etc/hostname) ]; }; }\n",
    );
    expect(answered).toMatchObject({ ok: false });
    if (answered.ok) return;
    expect(answered.stderr).toContain("restricted mode");
  }, 120_000);

  it("cannot fetch", async () => {
    const answered = await evaluate(
      '{ nixConfig = { extra-substituters = [ (builtins.fetchurl "https://example.com/") ]; }; }\n',
    );
    expect(answered).toMatchObject({ ok: false });
    if (answered.ok) return;
    expect(answered.stderr).toContain("restricted mode");
  }, 120_000);
});

describe("which substituters are odu caches", () => {
  const INFO =
    "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n" +
    "Odu-Origin: https://odu.example.org\nOdu-Bucket: main\n";

  it("keeps the ones answering both Odu- lines and drops the rest", async () => {
    const asked: string[] = [];
    const send = (async (url: string) => {
      asked.push(url);
      return url === "https://cache.ours.example/main/nix-cache-info"
        ? new Response(INFO, { status: 200 })
        : new Response("StoreDir: /nix/store\n", { status: 200 });
    }) as unknown as typeof fetch;
    const found = await oduCachesOf(
      ["https://cache.nixos.org", "https://cache.ours.example/main"],
      { send },
    );
    expect(found).toEqual([
      {
        substituter: "https://cache.ours.example/main",
        origin: "https://odu.example.org",
        bucket: "main",
      },
    ]);
    expect(asked).toEqual([
      "https://cache.nixos.org/nix-cache-info",
      "https://cache.ours.example/main/nix-cache-info",
    ]);
  });

  it("dials neither a `file:` URL nor more than the cap", async () => {
    // Bun's `fetch` serves `file:` URLs, and the list comes from a repository.
    const asked: string[] = [];
    const send = (async (url: string) => {
      asked.push(url);
      return new Response(INFO, { status: 200 });
    }) as unknown as typeof fetch;
    await oduCachesOf(
      [
        "file:///etc/passwd",
        ...Array.from({ length: 20 }, (_, i) => `https://many${i}.example`),
      ],
      { send },
    );
    expect(asked.some((url) => url.startsWith("file:"))).toBe(false);
    expect(asked.length).toBe(8);
  });

  it("does not follow a redirect to a URL nobody vetted", async () => {
    const seen: RequestInit[] = [];
    const send = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(INFO, { status: 200 });
    }) as unknown as typeof fetch;
    await oduCachesOf(["https://cache.ours.example/main"], { send });
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("gives up on a substituter that accepts and never answers", async () => {
    // Without the deadline a `run.start` parks forever on one hostile URL.
    const send = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(
      await oduCachesOf(["https://silent.example"], { send, timeoutMs: 10 }),
    ).toEqual([]);
  });

  it("drops a substituter that will not answer at all", async () => {
    const send = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await oduCachesOf(["https://gone.example"], { send })).toEqual([]);
  });

  it("stops READING a body that will not stop, rather than truncating it after", async () => {
    // `(await response.text()).slice(limit)` is not a bound: it buffers
    // whatever the server sends and discards afterwards, so a URL out of
    // somebody's `flake.nix` answering a gigabyte costs a gigabyte of this
    // process's memory first. What proves the difference is a stream that
    // never ends — `.text()` on this never resolves at all.
    let produced = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const send = (async () =>
      new Response(endless, { status: 200 })) as unknown as typeof fetch;

    // The two `Odu-` lines never arrive, so this refuses — having READ the
    // cap and hung up, which is the whole assertion.
    await expect(
      describeCache("https://flood.example", send),
    ).rejects.toThrow(/does not say where it is pushed to/);
    expect(cancelled).toBe(true);
    // 8 KiB of 4 KiB chunks: a handful, not a gigabyte.
    expect(produced).toBeLessThan(8);
  });
});

/**
 * `odu cache target` — THE SAME INFERENCE, PRINTED.
 *
 * The contract `.github/actions/push` depends on: the URL alone on stdout for
 * `$(…)`, and `{cache, origin, bucket}` under `--output json`. A field renamed
 * here is a push action that resolves nothing, so the shape is asserted rather
 * than described.
 *
 * Against a real `nix` and a real HTTP server on loopback, because that is
 * what the command does: evaluate this directory's `flake.nix`, then ask each
 * substituter it names for its `nix-cache-info`.
 */
describe("the target a flake names, said out loud", () => {
  /** `target` dials no daemon at all, so the one port the face is given must
   *  never be reached. */
  const ports = {
    connect: () => {
      throw new Error("odu cache target must not dial the service");
    },
  };

  /** Run the verb in `dir`, with stdout captured. */
  async function target(
    dir: string,
    args: string[],
  ): Promise<{ code: number; out: string }> {
    const was = process.cwd();
    const written: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.chdir(dir);
    try {
      const code = await cacheCommand("target", args, ports);
      return { code, out: written.join("") };
    } finally {
      process.stdout.write = stdout;
      process.chdir(was);
    }
  }

  /** A bucket that answers its `nix-cache-info` like odu's does. */
  function bucketServer(buckets: readonly string[]): {
    origin: string;
    stop: () => void;
  } {
    // `origin` is read inside `fetch`, which only ever runs after `serve`
    // returned — spelling it through a `let` is what keeps the handler from
    // referring to the server it is part of.
    let origin = "";
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const { pathname } = new URL(request.url);
        const bucket = buckets.find(
          (name) => pathname === `/cache/${name}/nix-cache-info`,
        );
        return bucket === undefined
          ? new Response("no", { status: 404 })
          : new Response(
              `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n` +
                `Odu-Origin: ${origin}\nOdu-Bucket: ${bucket}\n`,
            );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    return { origin, stop: () => server.stop(true) };
  }

  it("answers {cache, origin, bucket} as json, and the URL alone otherwise", async () => {
    const served = bucketServer(["main"]);
    const cache = `${served.origin}/cache/main`;
    const dir = withFlake(
      `{ nixConfig = { extra-substituters = [ "${cache}" ]; }; }\n`,
    );
    try {
      const asJson = await target(dir, ["--output", "json"]);
      expect(asJson.code).toBe(0);
      expect(JSON.parse(asJson.out)).toEqual({
        cache,
        origin: served.origin,
        bucket: "main",
      });

      // The plain form is what `push.sh` reads with `$(…)`: one line, the URL,
      // and nothing else on stdout — the narration goes to stderr.
      const plain = await target(dir, []);
      expect(plain.code).toBe(0);
      expect(plain.out).toBe(`${cache}\n`);
    } finally {
      served.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses two odu caches, naming both, and prints no target", async () => {
    // The refusal the action turns into its own failure: a repository builds
    // for one cache, so choosing would be this command inventing a policy.
    const served = bucketServer(["main", "other"]);
    const dir = withFlake(
      `{ nixConfig = { extra-substituters = [ "${served.origin}/cache/main" ` +
        `"${served.origin}/cache/other" ]; }; }\n`,
    );
    try {
      const refused = await target(dir, ["--output", "json"]);
      expect(refused.code).toBe(1);
      expect(refused.out).toBe("");
    } finally {
      served.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
