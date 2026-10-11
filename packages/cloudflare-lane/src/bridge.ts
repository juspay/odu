/**
 * The in-container half of a Cloudflare lane: a WebSocket ↔ stdio bridge.
 *
 * It plays the part sshd plays on an ssh lane. Each WebSocket is ONE dial, and
 * one dial is one `odu-runner --stdio` process, exactly as one `ssh host
 * odu-runner --stdio` is — so a lease hold and the lane that follows it are two
 * processes in the same container, the venue flock is local to the container,
 * and the runner exits when its stdin closes (the WebSocket going away).
 *
 * Run by the container entrypoint with odu's pinned bun, from source text the
 * Worker carries, so the container image stays the stock `nixos/nix` one.
 *
 * Wire (deliberately tiny — the coordinator's `cloudflare/connector.ts` and
 * `shipClosure.ts` are the other end, and all three ship in one odu build, the
 * Worker keying containers by a hash of this file):
 *
 *   /lane/<i>/agent
 *     client → bridge, text   {"agentPath": "/nix/store/…", "binary": "odu-runner", "args": ["--stdio"]}  (first, once)
 *     client → bridge, binary agent stdin bytes
 *     bridge → client, binary tag byte + payload: 0x01 agent stdout, 0x02 progress/stderr
 *     bridge → client, text   {"exit": number|null, "signal": string|null}, then close
 *
 *   /lane/<i>/import  (no-cache provisioning)
 *     client → bridge, text   {"paths": ["/nix/store/…", …]}   the closure, dependencies first
 *     bridge → client, binary 0x02 progress while it substitutes what public caches have
 *     bridge → client, text   {"missing": [...]}                what the client must send
 *     client → bridge, binary gzip(`nix-store --export <missing…>`)
 *     bridge → client, text   {"ack": bytes}                    consumed so far (flow control)
 *     client → bridge, text   {"done": true}
 *     bridge → client, text   {"exit": number|null, "signal": null}, then close
 *
 * Every buffer on the splice is bounded. Toward the coordinator, the runner's
 * output is paused while the WebSocket's send buffer is above HIGH_WATER and
 * resumed on `drain`, so a slow link backs up into the runner's own pipe. The
 * import stream is credit-based (`ack`). The stdin direction is request/response
 * RPC with bounded frames, so it is only guarded: past MAX_PENDING the dial
 * fails rather than grows.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, symlinkSync } from "node:fs";
import { availableParallelism, setPriority } from "node:os";
import { createGunzip } from "node:zlib";

const PORT = 8080;
const STDOUT = 0x01;
const STDERR = 0x02;
const STORE_PATH = /^\/nix\/store\/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+$/;
const BINARY = /^[A-Za-z0-9._-]+$/;
const HIGH_WATER = 8 * 1024 * 1024;
const MAX_PENDING = 64 * 1024 * 1024;
const ACK_EVERY = 1024 * 1024;
/** After the WebSocket closes, how long the runner gets to exit on stdin EOF
 *  (it reaps its recipe process groups first) before SIGTERM. */
const EOF_GRACE_MS = 10_000;

interface Start {
  agentPath: string;
  binary: string;
  args: string[];
}

interface DialState {
  kind: "agent" | "import";
  started: boolean;
  closed: boolean;
  /** The process whose output this dial relays (agent, or `nix-store --import`). */
  child: ChildProcess | null;
  /** `/import`: where received NAR bytes go, once the missing set is known. */
  importer: { write: (chunk: Uint8Array) => void; end: () => void } | null;
}

type Socket = Bun.ServerWebSocket<DialState>;

function frame(tag: number, chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.byteLength + 1);
  out[0] = tag;
  out.set(chunk, 1);
  return out;
}

/** Send, and pause the child's output while the socket is backed up. */
/** Coalesce output into few, large messages. Measured on odu's own CI (seven
 *  recipes logging at once): one message per stdout chunk queued the RPC
 *  ping replies behind thousands of tiny frames, and the lane died to the
 *  pinger 30 s in — `@cloudflare/containers` forwards every message through
 *  the Durable Object's single JS thread, shared by the instance's lease and
 *  lane. Consecutive chunks of one stream join until COALESCE_BYTES or
 *  COALESCE_MS; a change of stream flushes first, so order is kept. */
const COALESCE_BYTES = 64 * 1024;
const COALESCE_MS = 5;
const pending = new WeakMap<Socket, { tag: number; chunks: Uint8Array[]; bytes: number; timer: ReturnType<typeof setTimeout> | null }>();

function flush(ws: Socket): void {
  const batch = pending.get(ws);
  if (batch === undefined || batch.chunks.length === 0) return;
  if (batch.timer !== null) clearTimeout(batch.timer);
  const body = new Uint8Array(batch.bytes);
  let offset = 0;
  for (const chunk of batch.chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  pending.delete(ws);
  if (ws.data.closed) return;
  ws.send(frame(batch.tag, body));
  if (ws.getBufferedAmount() > HIGH_WATER) {
    ws.data.child?.stdout?.pause();
    ws.data.child?.stderr?.pause();
  }
}

/** A control message, after whatever output was queued before it. */
function sendText(ws: Socket, message: object): void {
  flush(ws);
  if (!ws.data.closed) ws.send(JSON.stringify(message));
}

function relay(ws: Socket, tag: number, chunk: Uint8Array): void {
  if (ws.data.closed) return;
  let batch = pending.get(ws);
  if (batch !== undefined && batch.tag !== tag) {
    flush(ws);
    batch = undefined;
  }
  if (batch === undefined) {
    batch = { tag, chunks: [], bytes: 0, timer: null };
    pending.set(ws, batch);
  }
  batch.chunks.push(new Uint8Array(chunk));
  batch.bytes += chunk.byteLength;
  if (batch.bytes >= COALESCE_BYTES) return flush(ws);
  batch.timer ??= setTimeout(() => flush(ws), COALESCE_MS);
}

function say(ws: Socket, line: string): void {
  relay(ws, STDERR, new TextEncoder().encode(`${line}\n`));
}

function finish(ws: Socket, exit: number | null, signal: string | null): void {
  if (ws.data.closed) return;
  flush(ws);
  ws.send(JSON.stringify({ exit, signal }));
  ws.data.closed = true;
  ws.close(1000, "exited");
}

function fail(ws: Socket, why: string): void {
  say(ws, `[cloudflare] ${why}`);
  ws.data.child?.kill("SIGTERM");
  finish(ws, 1, null);
}

/** Run a short helper, narrating its stderr, and collect its stdout. */
async function run(ws: Socket, argv: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const reader = proc.stderr.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    relay(ws, STDERR, value);
  }
  return { code: await proc.exited, stdout: await stdout };
}

function parseStart(raw: string): Start {
  const value = JSON.parse(raw) as Partial<Start>;
  if (typeof value.agentPath !== "string" || !STORE_PATH.test(value.agentPath))
    throw new Error(`agentPath must be a /nix/store path, got ${JSON.stringify(value.agentPath)}`);
  if (typeof value.binary !== "string" || !BINARY.test(value.binary))
    throw new Error(`binary must be a bare name, got ${JSON.stringify(value.binary)}`);
  const args = Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === "string") : [];
  return { agentPath: value.agentPath, binary: value.binary, args };
}

/** The container's root filesystem — ext4, 18 GB usable and ~2.76 M inodes on
 *  a standard-4 (measured), shared by every lane it serves. The store, /tmp
 *  and Nix's build directories all live on it; nothing a recipe writes lands
 *  on a small tmpfs. */
interface Disk {
  freeBytes: number;
  totalBytes: number;
  freeInodes: number;
  totalInodes: number;
}
function disk(): Disk | null {
  try {
    const st = statfsSync("/");
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize, freeInodes: st.ffree, totalInodes: st.files };
  } catch {
    return null;
  }
}

/** Below this fraction free — of bytes OR inodes (a pnpm tree runs out of
 *  inodes before bytes) — the store is collected. Measured on kolu's CI: a
 *  container that had 16 GiB free at run start hit "No space left on
 *  device" with four nodes writing closures at once, so a check only at dial
 *  time is not enough. */
const GC_BELOW_FRACTION = 0.25;
const WATCH_EVERY_MS = 10_000;

const low = (d: Disk): boolean =>
  d.freeBytes / d.totalBytes < GC_BELOW_FRACTION || d.freeInodes / d.totalInodes < GC_BELOW_FRACTION;

const describeDisk = (d: Disk): string =>
  `${(d.freeBytes / 1024 ** 3).toFixed(1)} of ${(d.totalBytes / 1024 ** 3).toFixed(1)} GiB, ` +
  `${Math.round((100 * d.freeInodes) / d.totalInodes)}% of inodes free`;

/** Every open dial, so the watchdog can narrate to the lanes it protects. */
const dials = new Set<Socket>();
let collecting: Promise<void> | null = null;

/** Linux's USER_HZ: the unit of /proc/<pid>/stat's start time, 100 on x86_64. */
const USER_HZ = 100;

/** Epoch seconds at which the oldest recipe still running on any lane
 *  started, or null when none is. A recipe is a direct child of a runner (the
 *  runner spawns each node as its own process group), so its start time is in
 *  /proc. */
function oldestRecipeStart(): number | null {
  const runners = new Set<number>();
  for (const ws of dials) {
    const pid = ws.data.kind === "agent" ? ws.data.child?.pid : undefined;
    if (pid !== undefined) runners.add(pid);
  }
  if (runners.size === 0) return null;
  const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf-8"))?.[1] ?? 0);
  let oldest: number | null = null;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf-8");
    } catch {
      continue; // gone between readdir and read
    }
    // Fields after the parenthesised command: state ppid pgrp ... starttime (22nd overall).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!runners.has(Number(fields[1]))) continue;
    const started = btime + Number(fields[19]) / USER_HZ;
    oldest = oldest === null ? started : Math.min(oldest, started);
  }
  return oldest;
}

/** Roots that keep a running recipe's work alive through a collection. */
const PROTECT_DIR = "/nix/var/nix/gcroots/odu-lane-running-recipes";

/** Root every store path registered since `since` (epoch seconds): whatever
 *  a still-running recipe built or substituted. Measured on kolu's CI: a
 *  recipe ran `nix build --no-link X` then `nix build --rebuild X`, and a
 *  collection between the two deleted X — `--no-link` leaves no root, and the
 *  first nix process had exited. In-progress builds need nothing from here:
 *  Nix holds a temp root for outputs it is building, sandbox or not. */
async function protectSince(since: number | null): Promise<number> {
  rmSync(PROTECT_DIR, { recursive: true, force: true });
  if (since === null) return 0;
  mkdirSync(PROTECT_DIR, { recursive: true });
  const proc = Bun.spawn(["nix", "--extra-experimental-features", "nix-command", "path-info", "--all", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const parsed = JSON.parse(text === "" ? "[]" : text) as
    | Record<string, { registrationTime?: number }>
    | { path: string; registrationTime?: number }[];
  const entries: [string, number | undefined][] = Array.isArray(parsed)
    ? parsed.map((info) => [info.path, info.registrationTime])
    : Object.entries(parsed).map(([path, info]) => [path, info?.registrationTime]);
  let rooted = 0;
  for (const [path, registered] of entries) {
    // A second of slack for registration and process start clocks.
    if (registered === undefined || registered < since - 1) continue;
    try {
      symlinkSync(path, `${PROTECT_DIR}/${path.slice("/nix/store/".length)}`);
      rooted += 1;
    } catch {
      // Already rooted, or vanished: either way nothing to protect.
    }
  }
  return rooted;
}

/** One collection: protect the running recipes' work, then `nix-store --gc`. */
async function collect(why: string, tell: (line: string) => void): Promise<{ rooted: number; after: Disk | null }> {
  const t0 = Date.now();
  const rooted = await protectSince(oldestRecipeStart());
  tell(`[cloudflare] ${why} — collecting the Nix store (${rooted} path(s) of running recipes kept)`);
  const proc = Bun.spawn(["nix-store", "--gc"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  const after = disk();
  tell(`[cloudflare] after ${((Date.now() - t0) / 1000).toFixed(1)}s of gc: ${after === null ? "?" : describeDisk(after)}`);
  return { rooted, after };
}

/** Collect the store when the disk runs low. Safe under running lanes: live
 *  processes' paths are roots, in-progress builds hold temp roots, and
 *  everything a running recipe has registered is rooted by protectSince. One
 *  collection at a time; the lanes attached hear why their recipes may have
 *  paused. */
function collectIfLow(): Promise<void> {
  if (collecting !== null) return collecting;
  const before = disk();
  if (before === null || !low(before)) return Promise.resolve();
  const tell = (line: string): void => {
    for (const ws of dials) say(ws, line);
    console.log(line);
  };
  collecting = collect(`disk low (${describeDisk(before)})`, tell).then(() => undefined).finally(() => {
    collecting = null;
  });
  return collecting;
}
setInterval(() => void collectIfLow(), WATCH_EVERY_MS).unref();

/** Realise the agent from the configured substituters (the lane cache first —
 *  entrypoint.sh), then spawn it with its stdio spliced onto this socket. */
async function startAgent(ws: Socket, spec: Start): Promise<void> {
  await collectIfLow();
  const t0 = Date.now();
  say(ws, `[cloudflare] realising ${spec.agentPath}`);
  const realised = await run(ws, ["nix-store", "--realise", spec.agentPath]);
  say(ws, `[cloudflare] realise exited ${realised.code} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (realised.code !== 0) return finish(ws, 1, null);
  if (ws.data.closed) return;
  // Its own session and process group, as sshd gives each login: a group
  // kill aimed at one dial's runner (or anything it spawns) cannot reach the
  // bridge, the other dials, or — through a shared group 1 — everything.
  const child = spawn(`${spec.agentPath}/bin/${spec.binary}`, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    // One recipe per vCPU at a time (runner.ts, maxParallelFrom): measured on
    // kolu's CI, a whole DAG started at once on 4 vCPU timed out on CPU and
    // ran out of disk.
    env: { ...process.env, ODU_RUNNER_MAX_PARALLEL: process.env.ODU_RUNNER_MAX_PARALLEL ?? String(availableParallelism()) },
  });
  ws.data.child = child;
  // The bridge runs above normal priority (below); its runner does not, so
  // the runner and its recipes are scheduled exactly as on an ssh box.
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, 0);
    } catch {
      // Best effort: a runner at the bridge's priority still works.
    }
  }
  child.stdout.on("data", (chunk: Buffer) => relay(ws, STDOUT, chunk));
  child.stderr.on("data", (chunk: Buffer) => relay(ws, STDERR, chunk));
  child.on("error", (error) => fail(ws, `spawn ${spec.binary}: ${error.message}`));
  child.on("close", (code, signal) => finish(ws, code, signal));
}

/** First half of an import: substitute whatever the public caches have (most
 *  of a runner closure is plain nixpkgs), then name what is still missing. */
async function prepareImport(ws: Socket, paths: string[]): Promise<void> {
  const t0 = Date.now();
  say(ws, `[cloudflare] substituting ${paths.length} closure paths from public caches`);
  await run(ws, ["nix-store", "--realise", "--keep-going", ...paths]);
  const { stdout } = await run(ws, ["nix-store", "--check-validity", "--print-invalid", ...paths]);
  const invalid = new Set(stdout.split("\n").filter((p) => p !== ""));
  const missing = paths.filter((p) => invalid.has(p));
  say(ws, `[cloudflare] substituted in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${missing.length} path(s) must be shipped`);
  if (ws.data.closed) return;
  if (missing.length === 0) {
    sendText(ws, { missing });
    return finish(ws, 0, null);
  }
  const child = spawn("nix-store", ["--import"], { stdio: ["pipe", "ignore", "pipe"] });
  ws.data.child = child;
  const gunzip = createGunzip();
  gunzip.pipe(child.stdin);
  gunzip.on("error", (error) => fail(ws, `import stream: ${error.message}`));
  child.stderr.on("data", (chunk: Buffer) => relay(ws, STDERR, chunk));
  child.on("close", (code, signal) => {
    say(ws, `[cloudflare] nix-store --import exited ${code ?? signal}`);
    finish(ws, code, signal);
  });
  let consumed = 0;
  let lastAck = 0;
  ws.data.importer = {
    write: (chunk) => {
      if (gunzip.writableLength > MAX_PENDING) return fail(ws, "import sender ignored flow control");
      gunzip.write(chunk, () => {
        consumed += chunk.byteLength;
        if (consumed - lastAck >= ACK_EVERY && !ws.data.closed) {
          lastAck = consumed;
          sendText(ws, { ack: consumed });
        }
      });
    },
    end: () => gunzip.end(),
  };
  sendText(ws, { missing });
}

function firstMessage(ws: Socket, message: string | Uint8Array): void {
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  if (ws.data.kind === "agent") {
    let spec: Start;
    try {
      spec = parseStart(raw);
    } catch (error) {
      return fail(ws, `bad start message: ${(error as Error).message}`);
    }
    void startAgent(ws, spec).catch((error: unknown) => fail(ws, `bridge failed: ${(error as Error).message}`));
    return;
  }
  const { paths } = JSON.parse(raw) as { paths?: unknown };
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && STORE_PATH.test(p))) {
    return fail(ws, "bad import request");
  }
  void prepareImport(ws, paths as string[]).catch((error: unknown) => fail(ws, `import failed: ${(error as Error).message}`));
}

function kvmUsable(): boolean {
  try {
    const st = statSync("/dev/kvm");
    return st.isCharacterDevice() && (st.mode & 0o666) === 0o666;
  } catch {
    return false;
  }
}

// Every byte of every lane passes through this process, including the RPC
// pings that decide whether a lane is alive; on a 4-vCPU container running
// seven recipes it must not wait its turn behind them.
try {
  setPriority(-5);
} catch {
  console.log("odu-lane bridge: could not raise its own priority");
}

Bun.serve<DialState>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch(req, server) {
    // The DO forwards the Worker's path unchanged (`/lane/<instance>/agent`).
    const url = new URL(req.url);
    const route = url.pathname.slice(url.pathname.lastIndexOf("/"));
    if (route === "/agent" || route === "/import") {
      const data: DialState = { kind: route === "/agent" ? "agent" : "import", started: false, closed: false, child: null, importer: null };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("expected a WebSocket upgrade\n", { status: 426 });
    }
    // The entrypoint refuses to start without a usable /dev/kvm; this is the
    // same fact, re-checked live, for `odu cloudflare status` and lane start.
    if (route === "/healthz") return Response.json({ ok: true, kvm: kvmUsable(), disk: disk() });
    // Reachable only from inside the container (the Worker forwards no such
    // route): lets a recipe — the live test of the protection above — force
    // a collection now, whatever the disk.
    if (route === "/gc-now" && req.method === "POST") {
      const lines: string[] = [];
      return collect("collection requested from inside the container", (line) => lines.push(line)).then(
        ({ rooted }) => Response.json({ rooted, lines }),
      );
    }
    return new Response("not found\n", { status: 404 });
  },
  websocket: {
    // One frame carries at most one RPC frame (16 MiB, a 2 MiB snapshot chunk
    // base64'd inside one) or one 1 MiB import chunk; leave headroom.
    maxPayloadLength: 32 * 1024 * 1024,
    idleTimeout: 0,
    sendPings: true,
    drain(ws) {
      if (ws.getBufferedAmount() <= HIGH_WATER) {
        ws.data.child?.stdout?.resume();
        ws.data.child?.stderr?.resume();
      }
    },
    open(ws) {
      dials.add(ws);
    },
    message(ws, message) {
      if (!ws.data.started) {
        ws.data.started = true;
        return firstMessage(ws, message);
      }
      if (ws.data.kind === "import") {
        if (typeof message === "string") {
          if ((JSON.parse(message) as { done?: boolean }).done === true) ws.data.importer?.end();
          return;
        }
        return ws.data.importer?.write(message);
      }
      const stdin = ws.data.child?.stdin;
      if (stdin === null || stdin === undefined) return;
      if (stdin.writableLength > MAX_PENDING) return fail(ws, "runner stopped reading its stdin");
      stdin.write(typeof message === "string" ? Buffer.from(message) : message);
    },
    close(ws) {
      dials.delete(ws);
      ws.data.closed = true;
      const child = ws.data.child;
      if (child === null) return;
      // EOF is the runner's own teardown signal (it reaps its recipe process
      // groups and exits); SIGTERM after a grace is the backstop.
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }, EOF_GRACE_MS).unref();
    },
  },
});

console.log(`odu-lane bridge listening on :${PORT}`);
