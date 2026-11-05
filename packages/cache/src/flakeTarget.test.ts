/**
 * WHAT A REPOSITORY ALREADY SAID ABOUT ITS CACHE — `flake.nix`'s `nixConfig`,
 * read (PLAN 4.1).
 *
 * Two properties, and both are about somebody else's file rather than about
 * odu: Nix accepts a multi-valued setting as a space-separated STRING or as a
 * LIST and a repository may have written either, and `substituters` and
 * `extra-substituters` are two spellings of one set. Get either wrong and a
 * repo that reads from a cache is told it names none.
 *
 * The `nix eval` is injected. The arms here are about parsing an answer, and a
 * suite that shelled out to Nix to assert "a string of two URLs is two
 * substituters" would be testing Nix.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oduCachesOf, readFlakeNixConfig } from "./push";

/** A directory with a `flake.nix` in it — the file's CONTENT never matters
 *  here, because the evaluation is injected; its existence is the gate. */
function withFlake(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-flake-"));
  writeFileSync(join(dir, "flake.nix"), "{ nixConfig = {}; }\n");
  return dir;
}

const evaluating = (value: unknown) => () =>
  ({ ok: true as const, json: JSON.stringify(value) });

describe("reading a flake's nixConfig", () => {
  it("answers `no flake.nix` for a directory without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-noflake-"));
    try {
      expect(readFlakeNixConfig(dir, evaluating({}))).toEqual({
        ok: false,
        reason: "no flake.nix",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the LAST line of nix's stderr, which is where the fault is", () => {
    const dir = withFlake();
    try {
      const read = readFlakeNixConfig(dir, () => ({
        ok: false,
        stderr: "error: attribute 'nixConfig' missing",
      }));
      expect(read).toMatchObject({ ok: false });
      if (read.ok) return;
      expect(read.reason).toContain("attribute 'nixConfig' missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a space-separated STRING as several substituters", () => {
    const dir = withFlake();
    try {
      const read = readFlakeNixConfig(
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

  it("unions `substituters` with `extra-substituters`, without repeats", () => {
    const dir = withFlake();
    try {
      const read = readFlakeNixConfig(
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

  it("reads both spellings of the trusted keys", () => {
    const dir = withFlake();
    try {
      const read = readFlakeNixConfig(
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

  it("refuses a nixConfig that is not an attrset", () => {
    const dir = withFlake();
    try {
      expect(readFlakeNixConfig(dir, evaluating(["a"]))).toEqual({
        ok: false,
        reason: "flake.nix has no nixConfig attrset",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which substituters are odu caches", () => {
  const INFO =
    "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n" +
    "Odu-Origin: https://odu.example.org\nOdu-Bucket: main\n";

  it("keeps the ones answering both Odu- lines and drops the rest", async () => {
    const asked: string[] = [];
    const send = (async (url: string) => {
      asked.push(url);
      return url.startsWith("https://cache.ours")
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
    // Both were asked — the resolution is a probe per substituter, and a cache
    // that is not odu's is learnt rather than assumed from its hostname.
    expect(asked).toEqual([
      "https://cache.nixos.org/nix-cache-info",
      "https://cache.ours.example/main/nix-cache-info",
    ]);
  });

  it("drops a substituter that will not answer at all", async () => {
    const send = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await oduCachesOf(["https://gone.example"], { send })).toEqual([]);
  });
});
