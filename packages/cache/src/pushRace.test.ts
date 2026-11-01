/**
 * CONCURRENT PUSHES OF ONE PATH, through the real routes and the real adapter.
 *
 * kolu #2335's publish job had two NARs refused by the server's own verify
 * (`zstd exited 1`) while other pushers were sending overlapping closures to
 * the same bucket. Every push of a store path names ONE staged file —
 * `nar/<narHash>.nar.zst` — whoever sends it and at whatever zstd level, so two
 * pushers of one path share a name on the server's disk. These tests push the
 * same paths from several clients at once, over a socket, into a server in its
 * OWN process (`test/narServer.ts routes`, the Node adapter `odu web` uses), and
 * then read back what a substituter would: every narinfo PUT must be accepted,
 * and the served NAR must hash to the served `FileHash`/`FileSize` and
 * decompress to the `NarHash`.
 *
 * **The server's object reads yield (`slow`).** On a local disk a `get` stream
 * drains without giving the loop to another request; the pod's volume does
 * not, and neither will an S3 store. Without it the twin windows never open.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createCache } from "./cache";
import { base32 } from "./narinfo";
import { asRoot } from "./testlib";

const LINUX = process.platform === "linux";
const NIX32 = "0123456789abcdfghijklmnpqrsvwxyz";

/** A seeded generator, so a failing interleaving is the same one next time. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Path {
  storePath: string;
  hash: string;
  narHash: string;
  narSize: number;
  /** The same NAR at two zstd levels: different compressed bytes, one name. */
  variants: Uint8Array[];
  file: string;
}

/** A NAR big enough that a verify takes real time, compressible enough that
 *  levels 1 and 19 produce different files. */
function makePath(random: () => number, size: number, name: string): Path {
  const hash = Array.from({ length: 32 }, () => NIX32[Math.floor(random() * 32)]).join("");
  const nar = Buffer.alloc(size);
  const words = ["closure", "narinfo", "substituter", "zstd", "store", "bucket"];
  let at = 0;
  while (at < size) {
    const word = `${words[Math.floor(random() * words.length)]}${Math.floor(random() * 1000)} `;
    at += nar.write(word, at);
  }
  const narHash = `sha256:${base32(createHash("sha256").update(nar).digest())}`;
  const variants = [1, 19].map((level) => {
    const out = spawnSync("zstd", [`-${level}`, "-c", "-q"], { input: nar, maxBuffer: 1 << 28 });
    if (out.status !== 0) throw new Error(`zstd -${level} exited ${out.status}`);
    return new Uint8Array(out.stdout);
  });
  if (Buffer.compare(variants[0] as Uint8Array, variants[1] as Uint8Array) === 0) {
    throw new Error("zstd levels 1 and 19 produced the same bytes; the race needs two");
  }
  return {
    storePath: `/nix/store/${hash}-${name}`,
    hash,
    narHash,
    narSize: size,
    variants,
    file: `${narHash.slice("sha256:".length)}.nar.zst`,
  };
}

let dir: string;
let server: ChildProcess;
let base: string;
let token: string;
const logs: Record<string, unknown>[] = [];

beforeAll(async () => {
  if (!LINUX) return;
  dir = mkdtempSync(join(tmpdir(), "odu-push-race-"));
  const stateRoot = join(dir, "state");
  const cache = createCache({ stateRoot, rootToken: "root" });
  const created = await cache.admin.create({
    ...asRoot("root"),
    name: "main",
    public: true,
    retentionDays: 30,
    upstreamKeys: [],
  });
  expect(created.ok).toBe(true);
  const minted = await cache.admin.tokenMint({
    ...asRoot("root"),
    bucket: "main",
    bucketGlob: null,
    scope: "write",
    expiresDays: null,
  });
  if (!minted.ok) throw new Error(minted.message);
  token = minted.value.token;
  await cache.close();

  server = spawn(
    process.execPath,
    [join(import.meta.dirname, "..", "test", "narServer.ts"), "routes", stateRoot, "main", "-", "log", "slow"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "";
  server.stderr?.on("data", (data: Buffer) => {
    pending += data.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        process.stderr.write(`${line}\n`);
      }
    }
  });
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
  base = `http://127.0.0.1:${port}/cache/main`;
});

afterAll(() => {
  if (!LINUX) return;
  server?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function putNar(path: Path, variant: number): Promise<string | null> {
  const response = await fetch(`${base}/nar/${path.file}`, {
    method: "PUT",
    headers: auth(),
    body: path.variants[variant] as unknown as BodyInit,
  });
  await response.arrayBuffer();
  return response.status === 200 ? null : `nar PUT answered ${response.status}`;
}

async function putNarinfo(path: Path, variant: number): Promise<string | null> {
  const bytes = path.variants[variant] as Uint8Array;
  const narinfo = [
    `StorePath: ${path.storePath}`,
    `URL: nar/${path.file}`,
    "Compression: zstd",
    `FileHash: sha256:${base32(createHash("sha256").update(bytes).digest())}`,
    `FileSize: ${bytes.length}`,
    `NarHash: ${path.narHash}`,
    `NarSize: ${path.narSize}`,
    "References: ",
    "",
  ].join("\n");
  const response = await fetch(`${base}/${path.hash}.narinfo`, {
    method: "PUT",
    headers: auth(),
    body: narinfo,
  });
  const text = await response.text();
  return response.status === 200 ? null : `narinfo PUT answered ${response.status}: ${text}`;
}

/** What a substituter reads back must be one consistent object: the served
 *  bytes ARE the narinfo's FileHash/FileSize, and they decompress to NarHash. */
async function readBack(path: Path): Promise<string | null> {
  const info = await fetch(`${base}/${path.hash}.narinfo`);
  if (info.status !== 200) return `narinfo GET answered ${info.status}`;
  const text = await info.text();
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}: (.*)$`, "m").exec(text)?.[1];
  const nar = await fetch(`${base}/${field("URL")}`);
  if (nar.status !== 200) return `NAR GET answered ${nar.status}`;
  const bytes = new Uint8Array(await nar.arrayBuffer());
  const fileHash = `sha256:${base32(createHash("sha256").update(bytes).digest())}`;
  if (fileHash !== field("FileHash") || String(bytes.length) !== field("FileSize")) {
    return `served ${bytes.length} B hashing to ${fileHash}, narinfo says ${field("FileSize")} B ${field("FileHash")}`;
  }
  const plain = spawnSync("zstd", ["-d", "-c", "-q"], { input: bytes, maxBuffer: 1 << 28 });
  if (plain.status !== 0) return `served NAR does not decompress (zstd exited ${plain.status})`;
  const narHash = `sha256:${base32(createHash("sha256").update(plain.stdout).digest())}`;
  return narHash === path.narHash ? null : `served NAR decompresses to ${narHash}, not ${path.narHash}`;
}

/** Every order two clients' `[nar, narinfo]` can interleave in. */
function interleavings(): ("A" | "B")[][] {
  const out: ("A" | "B")[][] = [];
  const walk = (prefix: ("A" | "B")[], a: number, b: number): void => {
    if (a === 2 && b === 2) out.push(prefix);
    if (a < 2) walk([...prefix, "A"], a + 1, b);
    if (b < 2) walk([...prefix, "B"], a, b + 1);
  };
  walk([], 0, 0);
  return out;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!LINUX)("concurrent pushes of one path", () => {
  // TWO CLIENTS, ONE PATH, LEVELS 1 AND 19: every order the protocol allows,
  // run once strictly in sequence and once with each step started before the
  // previous one answered (a client's own narinfo still waits for its NAR).
  it("accepts both pushes and serves one consistent object, in every order", async () => {
    const random = rng(2335);
    const failures: string[] = [];
    for (const order of interleavings()) {
      for (const overlapped of [false, true]) {
        const path = makePath(random, 1 << 20, "pair");
        const variant = { A: 0, B: 1 } as const;
        const nars: Partial<Record<"A" | "B", Promise<string | null>>> = {};
        const results: Promise<string | null>[] = [];
        const seen = { A: 0, B: 0 };
        for (const who of order) {
          const step = seen[who]++;
          const run =
            step === 0
              ? putNar(path, variant[who])
              : (nars[who] as Promise<string | null>).then(() => putNarinfo(path, variant[who]));
          if (step === 0) nars[who] = run;
          results.push(run);
          if (overlapped) await pause(1);
          else await run;
        }
        const label = `${order.join("")}${overlapped ? " overlapped" : ""}`;
        for (const failure of await Promise.all(results)) {
          if (failure !== null) failures.push(`${label}: ${failure}`);
        }
        const served = await readBack(path);
        if (served !== null) failures.push(`${label}: ${served}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  // A TWIN'S PROOF WHILE ANOTHER TWIN'S IS IN FLIGHT: store paths with one
  // NarHash share one staged name, and a twin whose narinfo arrives after the
  // first was recorded finds only the object. Twelve of them, a millisecond
  // apart, against a store whose reads yield as the pod's volume does.
  it("accepts every twin of a recorded path when their narinfos overlap", async () => {
    const random = rng(77);
    const failures: string[] = [];
    for (let round = 0; round < 10; round++) {
      const path = makePath(random, 1 << 20, `t${round}`);
      expect(await putNar(path, 0)).toBeNull();
      expect(await putNarinfo(path, 0)).toBeNull();
      const twins = Array.from({ length: 12 }, (_, i) => {
        const hash = Array.from({ length: 32 }, () => NIX32[Math.floor(random() * 32)]).join("");
        return { ...path, hash, storePath: `/nix/store/${hash}-twin${i}` };
      });
      const runs: Promise<string | null>[] = [];
      for (const twin of twins) {
        runs.push(putNarinfo(twin, 0));
        await pause(1);
      }
      const answers = await Promise.all(runs);
      answers.forEach((failure, i) => {
        if (failure !== null) failures.push(`round ${round} twin ${i}: ${failure}`);
      });
      for (const twin of twins) {
        const served = await readBack(twin);
        if (served !== null) failures.push(`round ${round} ${twin.storePath}: ${served}`);
      }
    }
    console.log(`push race (twins): ${failures.length} failures in 120 twin narinfos`);
    expect(failures).toEqual([]);
  }, 120_000);

  // THE INCIDENT'S SHAPE: N pushers × M paths, each pushing every path in its
  // own order, with a few waves in flight per pusher. "identical" is kolu's
  // case — every pusher runs the same odu, so every NAR is the same bytes;
  // "mixed" draws level 1 or 19 per push.
  it.each(["identical", "mixed"] as const)(
    "survives N pushers of M shared paths with no refusal and no corruption (%s bytes)",
    async (levels) => {
      const random = rng(levels === "identical" ? 1101 : 139);
      const PUSHERS = 6;
      const PATHS = 8;
      const ROUNDS = 5;
      const WAVE = 4;
      const failures: string[] = [];
      let pushes = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const paths = Array.from({ length: PATHS }, (_, i) => makePath(random, 256 << 10, `r${round}p${i}`));
        const plans = Array.from({ length: PUSHERS }, () =>
          paths
            .map((path) => ({
              path,
              variant: levels === "mixed" && random() < 0.5 ? 1 : 0,
              jitter: random() * 3,
              key: random(),
            }))
            .sort((x, y) => x.key - y.key),
        );
        await Promise.all(
          plans.map(async (plan, pusher) => {
            let next = 0;
            const lane = async (): Promise<void> => {
              while (next < plan.length) {
                const { path, variant, jitter } = plan[next++] as (typeof plan)[number];
                pushes += 1;
                const failure =
                  (await putNar(path, variant)) ??
                  (await pause(jitter).then(() => putNarinfo(path, variant)));
                if (failure !== null) failures.push(`round ${round} pusher ${pusher} ${path.storePath}: ${failure}`);
              }
            };
            await Promise.all(Array.from({ length: WAVE }, lane));
          }),
        );
        for (const path of paths) {
          const served = await readBack(path);
          if (served !== null) failures.push(`round ${round} ${path.storePath}: ${served}`);
        }
      }
      console.log(`push race (${levels}): ${failures.length} failures in ${pushes} pushes`);
      expect(failures).toEqual([]);
    },
    300_000,
  );
});
