import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createCache } from "./cache";
import { openCacheRepo } from "./db";
import { asRoot, localStores } from "./testlib";

const LINUX = process.platform === "linux";
const LIMIT = 64 * 1024 * 1024;
const SAMPLE_AFTER_MS = 10_000;
const MB = 1024 * 1024;

function childRss(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /VmRSS:\s+(\d+) kB/.exec(status);
  return match === null ? 0 : Number(match[1]) * 1024;
}

describe.skipIf(!LINUX)("a slow socket and the server's memory", () => {
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
    const stateRoot = join(dir, "state");
    const hash = "a".repeat(52);
    const storePath = `/nix/store/${"a".repeat(32)}-big`;
    const cache = createCache({
      stateRoot,
      stores: localStores(stateRoot),
      rootToken: "root",
      publicOrigin: "http://cache.test",
    });
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
      lastWanted: 0,
      run: null,
      commit: null,
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
