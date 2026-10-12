/**
 * `cloudflareConnector` against a loopback stand-in for the odu-lane Worker.
 *
 * The stand-in speaks the Worker's routes and the bridge's wire (bridge.ts)
 * and, behind `/agent`, runs the REAL `runner-main.ts --stdio` — so readiness,
 * the RPC link and the runner's exit on stdin EOF are the production ones.
 * Only Cloudflare itself (the DO, the container boot) and Nix provisioning
 * (injected as a no-op provisioner) are absent.
 *
 * What it pins, case by case, is how a Cloudflare lane FAILS, because that is
 * what `makeSession` and `lane.ts` build their verdicts on:
 *   - a normal dial reaches the runner and a normal close is the runner's exit;
 *   - a close before the banner is `network` (retry), like ssh's 255;
 *   - a refused secret is terminal, at /start and at the upgrade;
 *   - a link that goes silent dies within the RPC pinger's 5–10 s, exactly as
 *     an ssh lane's does — no Cloudflare-specific grace hides a dead lane.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  agentBinaryCache,
  ConnectError,
  directAgentDerivation,
  makeSession,
  type AgentClient,
  type SessionState,
  type SshProv,
} from "@kolu/surface-remote";
import type { CloudflareConfig } from "../../common/cloudflareConfig";
import { runUnary } from "../../common/effectEdge";
import { laneSurface } from "../../common/laneSurface";
import { pinLaneFace } from "../surfaceRemoteOpts";
import { closeNote, cloudflareConnector, describeDrop, type LaneProvisioner, lastCloseByHost } from "./connector";
import { laneDeathReason, transportWording } from "../surfaceRemoteOpts";
import { openLaneSocket } from "./workerApi";

const BUN = process.execPath;
const MAIN = join(process.cwd(), "src", "runner-main.ts");
const SECRET = "test-secret-0123456789abcdef";
const STDOUT = 0x01;
const STDERR = 0x02;

type Mode = "normal" | "close-before-banner";

interface Dial {
  child: ChildProcess | null;
  frozen: boolean;
  ws?: { close(code?: number, reason?: string): void };
}

/** The Worker + bridge, in one Bun server. */
function fakeWorker(mode: Mode) {
  const dials: Dial[] = [];
  /** The Durable Object's lifecycle journal, as /state serves it. */
  const journal: { t: number; kind: string; exitCode?: number; reason?: string }[] = [];
  const server = Bun.serve<Dial>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${SECRET}`) {
        return new Response("unauthorized\n", { status: 401 });
      }
      const action = /^\/lane\/[A-Za-z0-9_-]+\/(\w+)$/.exec(url.pathname)?.[1];
      if (action === "start") return new Response("container cold; starting\nready (cold, 0s)\n");
      if (action === "state") return Response.json({ running: true, journal });
      if (action === "agent") {
        const dial: Dial = { child: null, frozen: false };
        dials.push(dial);
        if (srv.upgrade(req, { data: dial })) return undefined;
      }
      return new Response("not found\n", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.ws = ws;
      },
      message(ws, message) {
        const dial = ws.data;
        if (dial.frozen) return;
        if (dial.child === null) {
          if (mode === "close-before-banner") {
            ws.close(1011, "container went away");
            return;
          }
          const child = spawn(BUN, [MAIN, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
          dial.child = child;
          const relay = (tag: number) => (chunk: Buffer) => {
            if (dial.frozen) return;
            const out = new Uint8Array(chunk.byteLength + 1);
            out[0] = tag;
            out.set(chunk, 1);
            ws.send(out);
          };
          child.stdout?.on("data", relay(STDOUT));
          child.stderr?.on("data", relay(STDERR));
          child.on("close", (code, signal) => {
            if (dial.frozen) return;
            ws.send(JSON.stringify({ exit: code, signal }));
            ws.close(1000, "exited");
          });
          return;
        }
        dial.child.stdin?.write(typeof message === "string" ? Buffer.from(message) : message);
      },
      close(ws) {
        ws.data.child?.stdin?.end();
      },
    },
  });
  return { server, dials, journal, url: `http://127.0.0.1:${server.port}` };
}

const noopProvisioner = (): LaneProvisioner => ({
  prepare: async () => "/nix/store/00000000000000000000000000000000-odu-runner",
  deliver: async () => {},
});

const derivation = directAgentDerivation(
  "/nix/store/00000000000000000000000000000000-odu-runner.drv",
  agentBinaryCache({ substituters: ["https://cache.example"], trustedPublicKeys: ["k:AAAA"] }),
);

function connectorFor(url: string, secret = SECRET) {
  const config: CloudflareConfig = { workerUrl: url, secret, cache: null };
  return cloudflareConnector({
    surface: laneSurface,
    host: "cloudflare:test",
    binary: "odu-runner",
    resolveDrvPath: async () => derivation,
    config: () => config,
    provisioner: noopProvisioner,
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A ConnectContext that records what the connector narrated. */
function context() {
  const lines: string[] = [];
  const controller = new AbortController();
  return {
    lines,
    controller,
    ctx: {
      localProgress: (line: string) => lines.push(`local ${line}`),
      remoteProgress: (line: string) => lines.push(`remote ${line}`),
      activity: () => {},
      provisioning: () => {},
      connecting: () => lines.push("connecting"),
      signal: controller.signal,
      campaignEpoch: 1,
    },
  };
}

describe("cloudflareConnector", () => {
  it("dials the runner through the Worker, and teardown terminates it", async () => {
    const worker = fakeWorker("normal");
    cleanups.push(() => worker.server.stop(true));
    const { ctx, lines } = context();
    const connection = await connectorFor(worker.url)(ctx);
    expect(lines).toContain("local [cloudflare:test] ready (cold, 0s)");
    expect(lines).toContain("connecting");
    await connection.isAlive();
    connection.teardown();
    expect(await connection.closed).toEqual({ kind: "exit", code: null, signal: "SIGTERM" });
    // …and the runner really goes: the bridge EOFs its stdin.
    const child = worker.dials[0]?.child;
    await new Promise<void>((resolve) => {
      if (child?.exitCode !== null) return resolve();
      child?.once("close", () => resolve());
    });
    expect(child?.exitCode).toBe(0);
  }, 30_000);

  it("reads a close before the readiness banner as the network (retry), like ssh's 255", async () => {
    const worker = fakeWorker("close-before-banner");
    cleanups.push(() => worker.server.stop(true));
    const { ctx } = context();
    const error = await connectorFor(worker.url)(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).failureCause).toBe("network");
    expect((error as ConnectError).terminal).toBe(false);
  }, 30_000);

  it("gives up at once on a refused secret at /start", async () => {
    const worker = fakeWorker("normal");
    cleanups.push(() => worker.server.stop(true));
    const { ctx } = context();
    const error = await connectorFor(worker.url, "wrong-secret-0123456789").call(null, ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).failureCause).toBe("remote");
    expect((error as ConnectError).terminal).toBe(true);
    // The secret is never part of what an operator reads.
    expect((error as Error).message).not.toContain("wrong-secret");
  }, 30_000);

  it("classifies a refused WebSocket upgrade as terminal too", async () => {
    const worker = fakeWorker("normal");
    cleanups.push(() => worker.server.stop(true));
    const config: CloudflareConfig = { workerUrl: worker.url, secret: "wrong-secret-0123456789", cache: null };
    const error = await openLaneSocket({ config, instance: "test", action: "agent", signal: new AbortController().signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).terminal).toBe(true);
  }, 30_000);

  it("asks the Durable Object why after an abnormal close, and says what it recorded", async () => {
    const worker = fakeWorker("normal");
    cleanups.push(() => worker.server.stop(true));
    const { ctx, lines } = context();
    const connection = await connectorFor(worker.url)(ctx);
    await connection.isAlive();
    // Cloudflare reset the object after the lane attached; the socket drops.
    worker.journal.push({ t: Date.now() - 60_000, kind: "container-start" }, { t: Date.now(), kind: "object-start" });
    // As the containers library relays a container that went away: 1000.
    worker.dials[0]?.ws?.close(1000, "WebSocket disconnected without sending Close frame.");
    expect(await connection.closed).toEqual({ kind: "transport-failed" });
    const deadline = Date.now() + 5_000;
    while (!lines.some((l) => l.includes("after the drop")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const explained = lines.find((l) => l.includes("after the drop"));
    expect(explained).toContain("local [cloudflare] cloudflare:test: after the drop, the Durable Object says: the lane's Durable Object restarted");
    expect(explained).not.toContain("a container started");
    for (const dial of worker.dials) dial.child?.kill();
  }, 30_000);

  it("dies within the RPC pinger's bound when the link goes silent, as an ssh lane does", async () => {
    const worker = fakeWorker("normal");
    cleanups.push(() => worker.server.stop(true));
    const session = makeSession<AgentClient, SshProv>({
      connectOnce: connectorFor(worker.url),
      initialConnection: "probing",
      label: "test",
    });
    cleanups.push(() => session.destroy());
    const client = await pinLaneFace(session);
    session.markConnected();
    expect((await runUnary(client.surface.lease.probe({}))).state).toBeDefined();

    const down = new Promise<number>((resolve) => {
      session.onState((state: SessionState<SshProv>) => {
        if (state.phase === "disconnected" || state.phase === "failed") resolve(Date.now());
      });
    });
    const silentFrom = Date.now();
    for (const dial of worker.dials) dial.frozen = true; // the link carries nothing either way
    const diedAt = await down;
    const silentForMs = diedAt - silentFrom;
    // Effect RPC pings every 5 s and ends the link when a ping goes unanswered.
    expect(silentForMs).toBeGreaterThan(4_000);
    expect(silentForMs).toBeLessThan(20_000);
    for (const dial of worker.dials) dial.child?.kill();
  }, 45_000);
});

describe("laneDeathReason", () => {
  it("never words a Cloudflare lane's death as ssh", () => {
    const ssh = "ssh transport connection failed — host unreachable or link dropped";
    lastCloseByHost.set("cloudflare:k-0", "cloudflare:k-0: the WebSocket to the odu-lane Worker closed (1006) without the runner exiting — …");
    expect(laneDeathReason("cloudflare:k-0", ssh)).toContain("WebSocket to the odu-lane Worker closed (1006)");
    expect(laneDeathReason("cloudflare:k-9", ssh)).toBe("cloudflare:k-9: the WebSocket to the odu-lane Worker closed without the runner exiting");
    expect(laneDeathReason("cloudflare:k-0", "surface stdio transport closed: the peer stopped answering")).toBe(
      "surface stdio transport closed: the peer stopped answering",
    );
    expect(laneDeathReason("ci-1.example", ssh)).toBe(ssh);
  });
});

describe("transport wording on a Cloudflare lane", () => {
  const ssh = "ssh transport connection failed — host unreachable or link dropped";
  it("rewrites surface-remote's retry and error lines, which odu does not write", () => {
    // kolu run 10, coordinator.log 1671–1674: the lease session's own lines.
    lastCloseByHost.set("cloudflare:k-6", "cloudflare:k-6: the WebSocket to the odu-lane Worker closed (1006 Connection ended) without the runner exiting");
    for (const line of [
      `[lease:cloudflare:k-6 local] ${ssh}`,
      `[lease:cloudflare:k-6 local] attempt 1 failed: ${ssh} — retrying in 2000ms…`,
    ]) {
      const out = transportWording("cloudflare:k-6", line);
      expect(out).not.toContain("ssh");
      expect(out).toContain("WebSocket to the odu-lane Worker closed (1006 Connection ended)");
    }
    expect(transportWording("ci-1.example", `x ${ssh}`)).toBe(`x ${ssh}`);
  });

  it("does not claim a deploy it cannot know about on a 1006", () => {
    const note = closeNote("cloudflare:k-6", 1006, "Connection ended");
    expect(note).not.toContain("deploy");
    expect(note).toContain("(1006 Connection ended)");
  });
});

describe("describeDrop", () => {
  const since = Date.parse("2026-10-12T02:00:00Z");
  it("names a container stop with its exit code", () => {
    const line = describeDrop(
      "cloudflare:k-6",
      { running: false, journal: [{ t: since - 60_000, kind: "container-start" }, { t: since + 1_000, kind: "container-stop", exitCode: 137, reason: "runtime_signal" }] },
      since,
    );
    expect(line).toContain("the container stopped at 02:00:01 UTC (exit 137, runtime_signal)");
    expect(line).not.toContain("a container started");
    expect(line).toContain("now the container is not running");
  });
  it("names a Durable Object restart", () => {
    const line = describeDrop("cloudflare:k-6", { running: true, journal: [{ t: since + 5_000, kind: "object-start" }] }, since);
    expect(line).toContain("the lane's Durable Object restarted at 02:00:05 UTC");
  });
  it("says the connection itself failed when nothing on Cloudflare's side changed", () => {
    const line = describeDrop("cloudflare:k-6", { running: true, journal: [{ t: since - 1, kind: "object-start" }] }, since);
    expect(line).toContain("no restart and no container stop");
    expect(line).toContain("the container is running");
  });
  it("says so when the Worker cannot be asked", () => {
    expect(describeDrop("cloudflare:k-6", null, since)).toContain("could not be asked");
  });
});
