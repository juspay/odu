/**
 * THE POD'S FAILURE, OUT OF PROCESS. A server process serves a real 320 MB NAR
 * to a `curl --limit-rate 2M` reader; the test samples the SERVER's RSS ten
 * seconds in, by which time the dump and the compressor have long finished.
 * The old child-stdout source has buffered most of the NAR by then; a
 * pull-based source has not. An in-process loopback reader is not this test:
 * the kernel and Bun's fetch apply pressure the pod's path does not.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createCache } from "./cache";
import { openCacheRepo } from "./db";
import { asRoot } from "./testlib";

const LINUX = process.platform === "linux";
const LIMIT = 64 * 1024 * 1024;
const SAMPLE_AFTER_MS = 10_000;
const MB = 1024 * 1024;

/** The child's RSS in bytes, from /proc; Linux only. */
function childRss(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /VmRSS:\s+(\d+) kB/.exec(status);
  return match === null ? 0 : Number(match[1]) * 1024;
}

describe.skipIf(!LINUX)("a slow socket and the server's memory", () => {
  // THREE NUMBERS, one harness: at 10 s into a 2 MB/s read of a 320 MB NAR,
  // node:child_process grew 345,026,560 B, Bun.spawn 337,645,568 B, and the
  // FIFO (read 64 KiB per pull) stays under the bound.
  it("has not buffered the NAR ten seconds into a 2 MB/s read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-nar-memory-"));
    const source = join(dir, "source.bin");
    const chunk = Buffer.alloc(MB);
    let x = 0x9e3779b9;
    const file = Buffer.alloc(320 * MB);
    for (let at = 0; at < file.length; at += chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        chunk[i] = x & 0xff;
      }
      chunk.copy(file, at);
    }
    writeFileSync(source, file);
    const added = spawn("nix", ["store", "add-file", source], { stdio: ["ignore", "pipe", "inherit"] });
    let addedOut = "";
    added.stdout?.on("data", (data: Buffer) => (addedOut += data.toString("utf8")));
    const addedCode = await new Promise<number>((resolve) => added.on("close", (code) => resolve(code ?? -1)));
    expect(addedCode).toBe(0);
    const path = addedOut.trim();

    const server = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "test", "narServer.ts"), path],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new Error("narServer did not become ready")), 30_000);
        server.stdout?.on("data", (data: Buffer) => {
          buffered += data.toString("utf8");
          const match = /ready (\d+)/.exec(buffered);
          if (match === null) return;
          clearTimeout(timer);
          resolve(Number(match[1]));
        });
      });
      const baseline = childRss(server.pid as number);
      const slow = spawn(
        "curl",
        [
          "--silent",
          "--limit-rate",
          "2M",
          "-o",
          "/dev/null",
          `http://127.0.0.1:${port}/`,
        ],
        { stdio: "ignore" },
      );
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_AFTER_MS));
      const growth = childRss(server.pid as number) - baseline;
      slow.kill("SIGKILL");
      expect({ growth, within: growth < LIMIT }).toEqual({ growth, within: true });
    } finally {
      server.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("serves the KEPT file at constant memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-file-memory-"));
    const source = join(dir, "source.bin");
    const chunk = Buffer.alloc(MB);
    let x = 0x9e3779b9;
    const file = Buffer.alloc(320 * MB);
    for (let at = 0; at < file.length; at += chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        chunk[i] = x & 0xff;
      }
      chunk.copy(file, at);
    }
    // THE REAL ROUTE, with a seeded cache: one bucket, one row, one object.
    const stateRoot = join(dir, "state");
    const hash = "a".repeat(52);
    const storePath = `/nix/store/${"a".repeat(32)}-big`;
    const cache = createCache({ stateRoot, rootToken: "root" });
    await cache.admin.create({
      ...asRoot("root"),
      name: "main",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    const objectDir = join(stateRoot, "cache", "objects", "main", "nar");
    mkdirSync(objectDir, { recursive: true });
    writeFileSync(join(objectDir, `${hash}.nar.zst`), file);
    const repo = openCacheRepo(join(stateRoot, "cache", "cache.sqlite"));
    repo.putObject({
      bucket: "main",
      storePath,
      hash: hash.slice(0, 32),
      narHash: `sha256:${hash}`,
      narSize: file.length,
      references: [],
      deriver: null,
      ca: null,
      caProof: "unknown",
      compression: "zstd",
      fileHash: `sha256:${"b".repeat(52)}`,
      fileSize: file.length,
      sigs: [],
      hits: 0,
      created: 0,
      lastAccessed: 0,
    });
    repo.close();
    await cache.close();
    const server = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "..", "test", "narServer.ts"),
        "routes",
        stateRoot,
        "main",
        hash,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new Error("file server did not become ready")), 30_000);
        server.stdout?.on("data", (data: Buffer) => {
          buffered += data.toString("utf8");
          const match = /ready (\d+)/.exec(buffered);
          if (match === null) return;
          clearTimeout(timer);
          resolve(Number(match[1]));
        });
      });
      // THE SAME ADAPTER, OBSERVED FROM OUTSIDE: a Range byte-for-byte check
      // and the headers a client actually receives.
      const url = `http://127.0.0.1:${port}/cache/main/nar/${hash}.nar.zst`;
      const ranged = spawnSync(
        "curl",
        ["-s", "-H", "Range: bytes=100-1099", url],
        { maxBuffer: 1 << 20 },
      );
      expect(ranged.status).toBe(0);
      expect(ranged.stdout.length).toBe(1000);
      expect(createHash("sha256").update(ranged.stdout).digest("hex")).toBe(
        createHash("sha256").update(file.subarray(100, 1100)).digest("hex"),
      );
      const headers = spawnSync("curl", ["-s", "-D", "-", "-o", "/dev/null", url], {
        encoding: "utf-8",
        maxBuffer: 1 << 20,
      });
      expect(headers.stdout.toLowerCase()).toContain(`content-length: ${file.length}`);

      const baseline = childRss(server.pid as number);
      const slow = spawn(
        "curl",
        [
          "--silent",
          "--limit-rate",
          "2M",
          "-o",
          "/dev/null",
          `http://127.0.0.1:${port}/cache/main/nar/${hash}.nar.zst`,
        ],
        { stdio: "ignore" },
      );
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_AFTER_MS));
      const growth = childRss(server.pid as number) - baseline;
      slow.kill("SIGKILL");
      expect({ growth, within: growth < LIMIT }).toEqual({ growth, within: true });
    } finally {
      server.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
 });
