import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { s3ObjectStore } from "@odu/objects";
import { type Gateway, shortWindowFrom, startGateway } from "@odu/objects/testing";
import { fifoStream } from "./fifo";
import { base32 } from "./narinfo";
import {
  type NarCheck,
  narHashModuloHasher,
  nixDump,
  parsePathInfoTable,
  verifyNarFile,
  verifyNarStream,
} from "./store";
import { contentAddressOf } from "./storePath";
import { NIX_RECORDED } from "../test/nixRecorded";

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
    process.env.PATH = empty;
    try {
      const reader = nixDump(HELLO, null).getReader();
      await expect(reader.read()).rejects.toThrow();
    } finally {
      restore();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("keeps reading when a writer has nothing YET", async () => {
    let fifo = "";
    let fd = -1;
    let asked = 0;
    const reader = fifoStream((path) => {
      fifo = path;
      // O_RDWR never blocks and counts as a writer, so the FIFO has one from
      // the first poll.
      fd = openSync(path, constants.O_RDWR);
      return {
        ended: () => {
          asked += 1;
          return { ok: true };
        },
        stop: () => {},
      };
    }).getReader();
    try {
      writeSync(fd, "first");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      const late = reader.read();
      await new Promise((resolve) => setTimeout(resolve, 25));
      writeSync(fd, "late");
      expect(new TextDecoder().decode((await late).value)).toBe("late");
      expect(asked).toBe(0);
      closeSync(fd);
      fd = -1;
      expect((await reader.read()).done).toBe(true);
      expect(existsSync(fifo)).toBe(false);
    } finally {
      if (fd !== -1) closeSync(fd);
    }
  });

  it("refuses an empty upload with the decompressor's own reason", async () => {
    scratch = mkdtempSync(join(tmpdir(), "odu-cache-nar-"));
    const path = join(scratch, "nar.zst");
    writeFileSync(path, "");
    const checked = await verifyNarFile(path, "zstd");
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.message).toContain("zstd exited 1");
    expect(checked.message).toContain("unexpected end of");
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

    expect(await verifyNarFile(path, "lz4")).toEqual({
      ok: false,
      message: "unsupported Compression: lz4",
      why: "bad-bytes",
    });
    expect(await verifyNarFile(join(scratch, "absent"), "none")).toMatchObject({
      ok: false,
      why: "absent",
    });
  });

  it("carries a split hash part across any chunk boundary, offsets included", () => {
    const hashPart = "0123456789abcdfghijklmnpqrsvwxyz";
    const payload = Buffer.from(
      `nar:${hashPart}:middle:${hashPart}:tail:${hashPart}`,
      "utf8",
    );
    const whole = narHashModuloHasher(hashPart);
    whole.update(payload);
    const expected = whole.finish();
    const zeroed = Buffer.from(payload);
    for (const at of [4, 44, 82]) zeroed.fill(0, at, at + 32);
    expect(expected.withOffsets).toBe(
      `sha256:${base32(createHash("sha256").update(zeroed).update("|4|44|82").digest())}`,
    );

    const oneByte = narHashModuloHasher(hashPart);
    for (const byte of payload) oneByte.update(Uint8Array.of(byte));
    expect(oneByte.finish()).toEqual(expected);

    for (let split = 0; split <= payload.length; split++) {
      const hasher = narHashModuloHasher(hashPart);
      hasher.update(payload.subarray(0, split));
      hasher.update(payload.subarray(split));
      expect({ split, hash: hasher.finish() }).toEqual({ split, hash: expected });
    }
  });

  for (const vector of Object.values(NIX_RECORDED)) {
    it(`proves the CA Nix ${vector.nix} wrote for ${vector.storePath.slice(44)}`, async () => {
      scratch = mkdtempSync(join(tmpdir(), "odu-self-ca-"));
      const narFile = join(scratch, "self.nar");
      writeFileSync(narFile, Buffer.from(vector.nar, "base64"));
      const hashPart = vector.storePath.slice("/nix/store/".length, "/nix/store/".length + 32);
      const checked = await verifyNarFile(narFile, "none", hashPart);
      if (!checked.ok || checked.selfHash.kind !== "computed") throw new Error("no modulo hash");
      const hashes = checked.selfHash.hashes;
      const other = vector.form === "withOffsets" ? "withoutOffsets" : "withOffsets";
      expect(hashes[vector.form]).toBe(`sha256:${vector.ca.slice("fixed:r:sha256:".length)}`);
      expect(hashes[other]).not.toBe(hashes[vector.form]);
      expect(
        contentAddressOf({
          storePath: vector.storePath,
          narHash: checked.narHash,
          references: [vector.storePath],
          selfHash: hashes,
        }),
      ).toBe(vector.ca);
    });
  }

  it("computes Nix's modulo-self hash from a make-content-addressed NAR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-self-ca-"));
    try {
      const drv = join(dir, "selfref.nix");
      writeFileSync(
        drv,
        'derivation { name = "selfref"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo $out > $out" ]; }',
      );
      const built = spawnSync(
        "nix",
        ["build", "--impure", "--no-link", "--print-out-paths", "-f", drv],
        { encoding: "utf-8" },
      );
      expect(built.status).toBe(0);
      const input = built.stdout.trim();
      const rewritten = spawnSync(
        "nix",
        ["store", "make-content-addressed", "--json", input],
        { encoding: "utf-8" },
      );
      expect(rewritten.status).toBe(0);
      const paths = JSON.parse(rewritten.stdout) as { rewrites: Record<string, string> };
      const storePath = Object.values(paths.rewrites)[0] as string;
      const info = JSON.parse(
        spawnSync("nix", ["path-info", "--json", storePath], { encoding: "utf-8" }).stdout,
      ) as Record<string, { ca: string | null; narHash: string; references: string[] }>;
      const facts = Object.values(info)[0];
      if (facts === undefined || facts.ca === null) throw new Error("no CA from nix path-info");
      const nar = spawnSync("nix", ["store", "dump-path", storePath], { maxBuffer: 8 << 20 });
      expect(nar.status).toBe(0);
      const narFile = join(dir, "self.nar");
      writeFileSync(narFile, nar.stdout);
      const hashPart = storePath.split("/").at(-1)!.slice(0, 32);
      const checked = await verifyNarFile(narFile, "none", hashPart);
      expect(checked.ok).toBe(true);
      if (!checked.ok || checked.selfHash.kind !== "computed") throw new Error("no modulo hash");
      expect(Object.values(checked.selfHash.hashes)).toContain(
        `sha256:${facts.ca.replace("fixed:r:sha256:", "")}`,
      );
      expect(
        contentAddressOf({
          storePath,
          narHash: facts.narHash,
          references: facts.references,
          selfHash: checked.selfHash.hashes,
        }),
      ).toBe(facts.ca);

      const altered = Buffer.from(nar.stdout);
      altered[Math.floor(altered.length / 2)]! ^= 0x01;
      writeFileSync(narFile, altered);
      const changed = await verifyNarFile(narFile, "none", hashPart);
      expect(changed.ok).toBe(true);
      expect(
        contentAddressOf({
          storePath,
          narHash: facts.narHash,
          references: facts.references,
          selfHash: changed.ok && changed.selfHash.kind === "computed" ? changed.selfHash.hashes : null,
        }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decompresses before it hashes, for every Compression a client sends", async () => {
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

describe("a readback whose window comes up short", () => {
  let gateway: Gateway;
  beforeAll(async () => {
    gateway = await startGateway();
  });
  afterAll(async () => {
    await gateway.stop();
  });

  async function readbackOf(bytes: Uint8Array): Promise<{
    stream: ReadableStream<Uint8Array>;
    size: number;
  }> {
    const target = await gateway.bucket();
    const put = await s3ObjectStore({ target }).put("main/nar/readback", new Blob([bytes as BlobPart]));
    if (!put.ok) throw new Error(`this case could not put its object: ${JSON.stringify(put.refusal)}`);
    const object = await s3ObjectStore({
      target,
      send: shortWindowFrom(1024 * 1024),
    }).get("main/nar/readback");
    if (object === null) throw new Error("the object this case just put is not there");
    return object;
  }

  async function verified(
    object: { stream: ReadableStream<Uint8Array>; size: number },
    compression: string,
  ): Promise<{ checked: NarCheck; loose: string[] }> {
    const loose: string[] = [];
    const watch = (err: unknown): void => {
      loose.push(String(err));
    };
    process.on("unhandledRejection", watch);
    const watchdog = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => watchdog.reject(new Error("verifyNarStream never settled")),
      10_000,
    );
    try {
      const checked = await Promise.race([verifyNarStream(object, compression), watchdog.promise]);
      const turned = Promise.withResolvers<void>();
      setImmediate(() => turned.resolve());
      await turned.promise;
      return { checked, loose };
    } finally {
      clearTimeout(timer);
      process.off("unhandledRejection", watch);
    }
  }

  it("refuses the upload and leaves no rejection loose — raw bytes", async () => {
    const { checked, loose } = await verified(await readbackOf(randomBytes(3 << 20)), "none");
    expect(loose).toEqual([]);
    expect(checked).toMatchObject({
      ok: false,
      why: "changed",
      message: expect.stringContaining("changed while it was being read"),
    });
  }, 30_000);

  it("refuses the upload and leaves no rejection loose — through the decompressor", async () => {
    const compressed = spawnSync("zstd", ["-c"], { input: randomBytes(3 << 20), maxBuffer: 8 << 20 });
    expect(compressed.status).toBe(0);
    const { checked, loose } = await verified(await readbackOf(compressed.stdout), "zstd");
    expect(loose).toEqual([]);
    expect(checked).toMatchObject({
      ok: false,
      why: "changed",
      message: expect.stringContaining("changed while it was being read"),
    });
  }, 30_000);
});
