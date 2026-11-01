/**
 * The store's edges: what `nix path-info` is allowed to have said, what a NAR
 * stream does when `nix` fails, and what an upload's hash has to be.
 *
 * The first is a shape question — three Nixes answer three ways — and the
 * second is the one that turns a broken read into a silent 200: a `dump-path`
 * that dies halfway leaves a VALID zstd frame of a truncated NAR, so the stream
 * must fail rather than close.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { nixDump, parsePathInfoTable, verifyNarFile } from "./store";

const HELLO = "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3";
const GLIBC = "/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57";
const NAR = "sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76";

const record = {
  ca: null,
  deriver: "/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv",
  narHash: "sha256-5vDnEIkXav/FrAjGoRMKsX6wiJm/JCBTn6SF+52Gpiw=",
  narSize: 279592,
  references: [GLIBC, HELLO],
  signatures: ["cache.nixos.org-1:AAAA"],
};

let scratch: string | null = null;
afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A PATH with a stand-in `nix` in front of the real one — the seam
 *  `default.nix` documents as "the host that provides the daemon provides the
 *  client", turned into something a suite can make fail. */
function withFakeNix(script: string): () => void {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-store-"));
  const path = join(scratch, "nix");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  const before = process.env.PATH ?? "";
  process.env.PATH = `${scratch}:${before}`;
  return () => {
    process.env.PATH = before;
  };
}

describe("nix path-info's three shapes", () => {
  it("reads format 1 — an object keyed by store path", () => {
    const table = parsePathInfoTable(JSON.stringify({ [HELLO]: record }));
    expect(table.get(HELLO)).toEqual({
      storePath: HELLO,
      narHash: NAR,
      narSize: 279592,
      references: [GLIBC, HELLO],
      deriver: "/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv",
      ca: null,
      sigs: ["cache.nixos.org-1:AAAA"],
    });
  });

  it("reads format 2 — the same records under `info`", () => {
    const table = parsePathInfoTable(JSON.stringify({ info: { [HELLO]: record }, version: 2 }));
    expect(table.get(HELLO)?.narHash).toBe(NAR);
  });

  it("reads the ARRAY every Nix before --json-format printed", () => {
    // The fallback path runs only on Nix ≤ 2.18, and that Nix answers an array
    // keyed by each record's own `path` — keyed by index, every entry would be
    // dropped and the narinfo PUT would be a 500.
    const table = parsePathInfoTable(JSON.stringify([{ path: HELLO, ...record }]));
    expect(table.get(HELLO)?.narHash).toBe(NAR);
    expect(table.get(HELLO)?.storePath).toBe(HELLO);
  });

  it("does not invent a record for a store that answered null", () => {
    expect(parsePathInfoTable(JSON.stringify({ [HELLO]: null })).size).toBe(0);
    expect(parsePathInfoTable("not json").size).toBe(0);
  });
});

describe("a NAR stream", () => {
  it("fails the read when nix exits non-zero, rather than closing on a truncated NAR", async () => {
    const restore = withFakeNix("#!/bin/sh\nprintf 'a truncated nar'\nexit 1\n");
    try {
      const chunks: Uint8Array[] = [];
      let failed = false;
      const reader = nixDump(HELLO, null).getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      restore();
    }
  });

  it("fails the read when the pipeline cannot even be spawned", async () => {
    const empty = mkdtempSync(join(tmpdir(), "odu-cache-path-"));
    const restore = withFakeNix("#!/bin/sh\nexit 0\n");
    // A PATH with neither program on it: `spawn` fails, no `close` ever
    // arrives, and the stream must still settle.
    process.env.PATH = empty;
    try {
      const reader = nixDump(HELLO, null).getReader();
      await expect(reader.read()).rejects.toThrow();
    } finally {
      restore();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("an upload's bytes", () => {
  it("hashes a raw NAR and refuses a compression it cannot read", async () => {
    scratch = mkdtempSync(join(tmpdir(), "odu-cache-nar-"));
    const path = join(scratch, "nar");
    writeFileSync(path, "hello");
    const checked = await verifyNarFile(path, "none");
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.narSize).toBe(5);

    expect(await verifyNarFile(path, "lz4")).toMatchObject({ ok: false, absent: false });
    // ABSENT is not WRONG: the caller may have another way to prove the same
    // bytes (a twin object), and a file that is not there has not been judged.
    expect(await verifyNarFile(join(scratch, "absent"), "none")).toMatchObject({
      ok: false,
      absent: true,
    });
  });

  it("decompresses before it hashes, for every Compression a client sends", async () => {
    // THE BUG THIS PINS: a decompressor spawned with stdin closed reads
    // nothing, exits non-zero, and refuses every upload — while `none` passes.
    scratch = mkdtempSync(join(tmpdir(), "odu-cache-nar-"));
    const plain = join(scratch, "plain.nar");
    writeFileSync(plain, "hello");
    const raw = await verifyNarFile(plain, "none");
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;

    for (const [compression, argv] of [
      ["zstd", ["zstd", "-c"]],
      ["xz", ["xz", "-c"]],
      ["bzip2", ["bzip2", "-c"]],
    ] as const) {
      const compressed = join(scratch, `plain.nar.${compression}`);
      const child = spawnSync(argv[0], [...argv.slice(1), plain], { maxBuffer: 1 << 20 });
      expect({ compression, status: child.status }).toEqual({ compression, status: 0 });
      writeFileSync(compressed, child.stdout);
      expect({ compression, checked: await verifyNarFile(compressed, compression) }).toMatchObject({
        compression,
        checked: {
          ok: true,
          narHash: raw.narHash,
          narSize: raw.narSize,
          fileSize: child.stdout.length,
        },
      });
    }
  });
});
