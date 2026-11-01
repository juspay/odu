/**
 * THE POD'S FAILURE, OUT OF PROCESS. A server process serves a real 96 MB NAR
 * to a `curl --limit-rate` reader; the test samples the SERVER's RSS. An
 * in-process loopback reader is not this test: the kernel and Bun's fetch
 * apply pressure the pod's path (cloudflared, Cloudflare, a slow client) does
 * not.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const LINUX = process.platform === "linux";
const LIMIT = 96 * 1024 * 1024;

/** The child's RSS in bytes, from /proc; Linux only. */
function childRss(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /VmRSS:\s+(\d+) kB/.exec(status);
  return match === null ? 0 : Number(match[1]) * 1024;
}

describe.skipIf(!LINUX)("a slow socket and the server's memory", () => {
  it("serves a 96 MB NAR with RSS bound, and the bytes verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-nar-memory-"));
    const source = join(dir, "source.bin");
    const downloaded = join(dir, "downloaded.nar.zst");
    const chunk = Buffer.alloc(1024 * 1024);
    let x = 0x9e3779b9;
    const file = Buffer.alloc(96 * 1024 * 1024);
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
    const added = spawnSync("nix", ["store", "add-file", source], { encoding: "utf-8" });
    expect(added.status).toBe(0);
    const path = added.stdout.trim();

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
      let peak = baseline;
      const sampler = setInterval(() => {
        if (server.pid !== undefined) peak = Math.max(peak, childRss(server.pid));
      }, 50);
      const slow = spawnSync(
        "curl",
        ["--silent", "--limit-rate", "4M", "-o", "/dev/null", `http://127.0.0.1:${port}/`],
        { encoding: "utf-8", timeout: 120_000 },
      );
      clearInterval(sampler);
      expect({ status: slow.status, stderr: slow.stderr }).toMatchObject({ status: 0 });
      const growth = peak - baseline;
      expect({ growth, within: growth < LIMIT }).toEqual({ growth, within: true });

      // AND THE BYTES ARE THE NAR: one unthrottled read, hashed against the
      // store's own dump. Backpressure must not reorder or drop a piece.
      const fast = spawnSync(
        "curl",
        ["--silent", "-o", downloaded, `http://127.0.0.1:${port}/`],
        { timeout: 120_000 },
      );
      expect(fast.status).toBe(0);
      const expected = spawnSync("bash", ["-c", `nix store dump-path '${path}' | sha256sum`], {
        encoding: "utf-8",
      });
      expect(expected.status).toBe(0);
      const actual = spawnSync("bash", ["-c", `zstd -d -c '${downloaded}' | sha256sum`], {
        encoding: "utf-8",
      });
      expect(actual.status).toBe(0);
      expect(actual.stdout.split(" ")[0]).toBe(expected.stdout.split(" ")[0]);
    } finally {
      server.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
