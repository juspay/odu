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
 * Wire (deliberately tiny — the coordinator's `cloudflare/connector.ts` is the
 * other end, and the two always ship in the same odu build):
 *
 *   client → bridge, text   {"agentPath": "/nix/store/…", "binary": "odu-runner", "args": ["--stdio"]}
 *                           first message, exactly once
 *   client → bridge, binary agent stdin bytes
 *   bridge → client, binary tag byte + payload: 0x01 agent stdout, 0x02 progress/stderr
 *   bridge → client, text   {"exit": number|null, "signal": string|null}, then close
 *
 * `/import` is the no-cache provisioning path (no R2 lane cache configured):
 *
 *   client → bridge, text   {"paths": ["/nix/store/…", …]}   the closure, dependencies first
 *   bridge → client, binary 0x02 progress while it substitutes what public caches have
 *   bridge → client, text   {"missing": [...]}                what the client must send
 *   client → bridge, binary gzip(`nix-store --export <missing…>`)
 *   client → bridge, text   {"done": true}
 *   bridge → client, text   {"exit": number|null, "signal": null}, then close
 */

import { spawn as spawnNode } from "node:child_process";
import { createGunzip } from "node:zlib";

const PORT = 8080;
const STDOUT = 0x01;
const STDERR = 0x02;
const STORE_PATH = /^\/nix\/store\/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+$/;
const BINARY = /^[A-Za-z0-9._-]+$/;

interface Start {
  agentPath: string;
  binary: string;
  args: string[];
}

interface DialState {
  kind: "agent" | "import";
  started: boolean;
  /** `/import`: gunzip → `nix-store --import`, once the missing set is known. */
  importer: { write: (chunk: Uint8Array) => void; end: () => void } | null;
  child: ReturnType<typeof Bun.spawn> | null;
  closed: boolean;
}

type Socket = Bun.ServerWebSocket<DialState>;

function frame(tag: number, chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.byteLength + 1);
  out[0] = tag;
  out.set(chunk, 1);
  return out;
}

function say(ws: Socket, line: string): void {
  if (ws.data.closed) return;
  ws.send(frame(STDERR, new TextEncoder().encode(`${line}\n`)));
}

function finish(ws: Socket, exit: number | null, signal: string | null): void {
  if (ws.data.closed) return;
  ws.send(JSON.stringify({ exit, signal }));
  ws.data.closed = true;
  ws.close(1000, "agent exited");
}

async function pump(
  ws: Socket,
  tag: number,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (!ws.data.closed) ws.send(frame(tag, value));
  }
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

/** Realise the agent's closure from the configured substituters (the lane
 *  cache first — see entrypoint.sh), narrating Nix's progress to the
 *  coordinator, which shows it in `_ci-setup` exactly as an ssh lane's
 *  provisioning output is shown. */
async function realise(ws: Socket, agentPath: string): Promise<boolean> {
  const t0 = Date.now();
  say(ws, `[cloudflare] realising ${agentPath}`);
  const proc = Bun.spawn(["nix-store", "--realise", agentPath], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  await pump(ws, STDERR, proc.stderr);
  const code = await proc.exited;
  say(ws, `[cloudflare] realise exited ${code} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return code === 0;
}

async function start(ws: Socket, spec: Start): Promise<void> {
  if (!(await realise(ws, spec.agentPath))) {
    finish(ws, 1, null);
    return;
  }
  if (ws.data.closed) return;
  const child = Bun.spawn([`${spec.agentPath}/bin/${spec.binary}`, ...spec.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME ?? "/root" },
  });
  ws.data.child = child;
  const out = pump(ws, STDOUT, child.stdout as ReadableStream<Uint8Array>);
  const err = pump(ws, STDERR, child.stderr as ReadableStream<Uint8Array>);
  const code = await child.exited;
  await Promise.allSettled([out, err]);
  finish(ws, child.signalCode === null ? code : null, child.signalCode ?? null);
}

/** Run a command, narrating its stderr, and collect its stdout. */
async function run(ws: Socket, argv: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  await pump(ws, STDERR, proc.stderr);
  return { code: await proc.exited, stdout: await stdout };
}

/** First half of an import: substitute whatever the public caches have (most
 *  of a runner closure is plain nixpkgs), then name what is still missing. */
async function importPrepare(ws: Socket, paths: string[]): Promise<void> {
  const t0 = Date.now();
  say(ws, `[cloudflare] substituting ${paths.length} closure paths from public caches`);
  await run(ws, ["nix-store", "--realise", "--keep-going", ...paths]);
  const { stdout } = await run(ws, ["nix-store", "--check-validity", "--print-invalid", ...paths]);
  const invalid = new Set(stdout.split("\n").filter((p) => p !== ""));
  const missing = paths.filter((p) => invalid.has(p));
  say(ws, `[cloudflare] substituted in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${missing.length} path(s) must be shipped`);
  if (missing.length === 0) {
    ws.send(JSON.stringify({ missing }));
    finish(ws, 0, null);
    return;
  }
  const child = spawnNode("nix-store", ["--import"], { stdio: ["pipe", "ignore", "pipe"] });
  const gunzip = createGunzip();
  gunzip.pipe(child.stdin);
  child.stderr.on("data", (chunk: Buffer) => {
    if (!ws.data.closed) ws.send(frame(STDERR, chunk));
  });
  child.on("exit", (code, signal) => {
    say(ws, `[cloudflare] nix-store --import exited ${code ?? signal}`);
    finish(ws, code, signal);
  });
  ws.data.importer = {
    write: (chunk) => void gunzip.write(chunk),
    end: () => gunzip.end(),
  };
  ws.send(JSON.stringify({ missing }));
}

function importMessage(ws: Socket, message: string | Uint8Array): void {
  if (!ws.data.started) {
    ws.data.started = true;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const { paths } = JSON.parse(raw) as { paths?: unknown };
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && STORE_PATH.test(p))) {
      say(ws, "[cloudflare] bad import request");
      finish(ws, 2, null);
      return;
    }
    void importPrepare(ws, paths as string[]).catch((error: unknown) => {
      say(ws, `[cloudflare] import failed: ${(error as Error).message}`);
      finish(ws, 1, null);
    });
    return;
  }
  if (typeof message === "string") {
    if (JSON.parse(message).done === true) ws.data.importer?.end();
    return;
  }
  ws.data.importer?.write(message);
}

Bun.serve<DialState>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch(req, server) {
    const url = new URL(req.url);
    // The DO forwards the Worker's path unchanged (`/lane/<instance>/agent`).
    const route = url.pathname.slice(url.pathname.lastIndexOf("/"));
    if (route === "/agent" || route === "/import") {
      const kind = route === "/agent" ? "agent" : "import";
      if (server.upgrade(req, { data: { kind, started: false, importer: null, child: null, closed: false } }))
        return undefined;
      return new Response("expected a WebSocket upgrade\n", { status: 426 });
    }
    if (route === "/healthz") return new Response("ok\n");
    return new Response("not found\n", { status: 404 });
  },
  websocket: {
    // A snapshot chunk is 2 MiB base64 inside one RPC frame; leave headroom.
    maxPayloadLength: 64 * 1024 * 1024,
    idleTimeout: 0,
    sendPings: true,
    message(ws, message) {
      if (ws.data.kind === "import") {
        importMessage(ws, message);
        return;
      }
      if (!ws.data.started) {
        ws.data.started = true;
        let spec: Start;
        try {
          spec = parseStart(typeof message === "string" ? message : new TextDecoder().decode(message));
        } catch (error) {
          say(ws, `[cloudflare] bad start message: ${(error as Error).message}`);
          finish(ws, 2, null);
          return;
        }
        void start(ws, spec).catch((error: unknown) => {
          say(ws, `[cloudflare] bridge failed: ${(error as Error).message}`);
          finish(ws, 1, null);
        });
        return;
      }
      const stdin = ws.data.child?.stdin;
      if (stdin === undefined || stdin === null || typeof stdin === "number") return;
      stdin.write(typeof message === "string" ? new TextEncoder().encode(message) : message);
      stdin.flush();
    },
    close(ws) {
      ws.data.closed = true;
      const child = ws.data.child;
      if (child === null) return;
      // EOF is the runner's own teardown signal (it reaps its recipe process
      // groups and exits); SIGTERM after a grace is the backstop.
      const stdin = child.stdin;
      if (stdin !== undefined && stdin !== null && typeof stdin !== "number") void stdin.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }, 10_000);
    },
  },
});

console.log(`odu-lane bridge listening on :${PORT}`);
