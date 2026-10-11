/**
 * `cloudflareConnector` — surface-remote's `Connector` for a lane that lives in
 * a Cloudflare container, the sibling of its `sshConnector`.
 *
 * It hands `makeSession` the same thing the ssh connector does — one
 * `Connection` over one `odu-runner --stdio` process — so the lane, the venue
 * lease and the probe built on top of a session cannot tell which transport
 * carried them. What differs is everything below the stdio pair:
 *
 *   ssh lane                               cloudflare lane
 *   ───────────────────────────────────    ─────────────────────────────────────────
 *   arch probe over ssh                    none: the container is x86_64-linux
 *   nix copy --to ssh-ng://host            nix copy --to <lane cache> (laneCache.ts),
 *                                          or, with no cache, NAR export over /import (shipClosure.ts)
 *   nix build --store ssh-ng://host        container: nix-store --realise from it
 *   ssh host …/odu-runner --stdio          WebSocket → Worker → DO → bridge.ts → odu-runner --stdio
 *   ssh exit 255 = transport failed        WebSocket closed without an exit frame
 *
 * The bytes on the wire are the runner's own stdio, readiness banner first, so
 * the epoch gate (`awaitStdioReadiness`) and the link (`stdioLink`) are the
 * very ones the ssh connector uses — this file only builds the stream pair.
 * NOT `@kolu/surface/links/websocket`: that link reconnects on its own, and a
 * lane is one-shot (lane.ts) — a respawned idle runner must never be mistaken
 * for the one that held the run.
 */

import { PassThrough, Writable } from "node:stream";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { Surface, SurfaceSpec } from "@kolu/surface/define";
import {
  awaitStdioReadiness,
  isStdioReadinessError,
} from "@kolu/surface/links/readiness";
import { stdioLink } from "@kolu/surface/links/stdio";
import {
  type AgentClient,
  type ClosedInfo,
  ConnectError,
  type Connection,
  type Connector,
  type ResolveDrvPathContext,
  type SshProv,
  surfaceLiveProbe,
} from "@kolu/surface-remote";
import type { ResolveRunnerDrv } from "../runnerFlake";
import {
  type CloudflareConfig,
  cloudflareInstance,
  readCloudflareConfig,
  cloudflareConfigPath,
} from "../../common/cloudflareConfig";
import { publishToLaneCache, realiseLocally } from "./laneCache";
import { shipClosure } from "./shipClosure";

const STDOUT = 0x01;
const STDERR = 0x02;

/** The container realises the runner closure between the start message and
 *  the banner, so this budget covers a cold substitution of a few hundred MiB
 *  — not the ssh connector's three minutes, which assume a realised agent. Its
 *  progress keeps the session's own pre-connected backstop at bay meanwhile. */
const READINESS_DEADLINE_MS = 20 * 60_000;

export interface CloudflareConnectorOptions<S extends SurfaceSpec> {
  surface: Surface<S>;
  /** `cloudflare` or `cloudflare:<instance>` (see config.ts). */
  host: string;
  binary: string;
  resolveDrvPath: ResolveRunnerDrv;
  /** Injected for tests; production reads ~/.config/odu/cloudflare.json. */
  config?: () => CloudflareConfig | null;
}

/** odu's resolver ignores its context (the runner flake names the platform
 *  outright), and a container has no arch to probe — so the ssh-shaped context
 *  is filled with answers that say so instead of inventing an ssh dial. */
function resolverContext(signal: AbortSignal, onProgress: (line: string) => void): ResolveDrvPathContext {
  const noSsh = (): never => {
    throw new Error("cloudflare lanes have no ssh host to resolve against");
  };
  return {
    signal,
    onProgress,
    localProgress: onProgress,
    resolveSystem: async () => "x86_64-linux",
    resolveAgentDrv: noSsh,
    keepalive: undefined as never,
  } as unknown as ResolveDrvPathContext;
}

/** POST /start and relay the Worker's narration until the container's port
 *  answers. A separate request from the agent dial so a cold start (minutes)
 *  is visible progress rather than one silent WebSocket upgrade. */
async function startContainer(
  config: CloudflareConfig,
  instance: string,
  onLine: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${config.workerUrl}/lane/${instance}/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}` },
    signal,
  });
  if (response.status === 401) {
    throw new ConnectError(
      `odu-lane Worker refused our secret — re-run \`odu cloudflare setup\` (${cloudflareConfigPath()})`,
      "remote",
      true,
    );
  }
  if (!response.ok || response.body === null) {
    throw new ConnectError(`odu-lane /start answered ${response.status}`, "network");
  }
  const decoder = new TextDecoder();
  let pending = "";
  let last = "";
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      last = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      onLine(`[cloudflare:${instance}] ${last}`);
    }
  }
  if (!last.startsWith("ready")) {
    throw new ConnectError(`container ${instance} did not start: ${last || "no answer"}`, "network");
  }
}

/** Split a byte stream into lines for a progress sink. */
function lineSplitter(sink: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let pending = "";
  return (chunk) => {
    pending += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trimEnd();
      pending = pending.slice(nl + 1);
      if (line !== "") sink(line);
    }
  };
}

export function cloudflareConnector<S extends SurfaceSpec>(
  opts: CloudflareConnectorOptions<S>,
): Connector<AgentClient, SshProv> {
  const readConfig = opts.config ?? readCloudflareConfig;
  return async (ctx): Promise<Connection<AgentClient>> => {
    const config = readConfig();
    if (config === null) {
      throw new ConnectError(
        `odu: ${opts.host} needs ${cloudflareConfigPath()} — run \`odu cloudflare setup\` once to deploy the odu-lane Worker`,
        "remote",
        true,
      );
    }
    const instance = cloudflareInstance(opts.host);
    const local = (line: string): void => ctx.localProgress(line);

    // ── 1. The runner, realised here and published to the lane cache ──────
    let derivation;
    try {
      derivation = await opts.resolveDrvPath(resolverContext(ctx.signal, local));
    } catch (error) {
      throw new ConnectError(error instanceof Error ? error.message : String(error), "network");
    }
    ctx.provisioning("provisioning");
    let agentPath: string;
    try {
      const t0 = Date.now();
      agentPath = await realiseLocally({
        drvPath: derivation.drvPath,
        binaryCache: derivation.binaryCache,
        onProgress: local,
        signal: ctx.signal,
      });
      if (config.cache === null) {
        local("[cloudflare] no lane cache configured — the closure ships over the Worker once the container is up");
      } else {
        local(`[cloudflare] publishing ${agentPath} to the lane cache`);
        await publishToLaneCache({ outPath: agentPath, cache: config.cache, onProgress: local, signal: ctx.signal });
      }
      local(`[cloudflare] runner provisioned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (error) {
      throw new ConnectError(error instanceof Error ? error.message : String(error), "remote");
    }

    // ── 2. The container ──────────────────────────────────────────────────
    const t0 = Date.now();
    await startContainer(config, instance, (line) => {
      local(line);
      ctx.activity();
    }, ctx.signal);
    if (config.cache === null) {
      try {
        await shipClosure({
          config,
          instance,
          outPath: agentPath,
          onProgress: (line) => {
            local(line);
            ctx.activity();
          },
          signal: ctx.signal,
        });
      } catch (error) {
        throw new ConnectError(error instanceof Error ? error.message : String(error), "network");
      }
    }

    // ── 3. The dial: one WebSocket, one odu-runner ────────────────────────
    ctx.connecting();
    const wsUrl = `${config.workerUrl.replace(/^http/, "ws")}/lane/${instance}/agent`;
    // Bun's WebSocket takes request headers; the Worker authenticates the
    // upgrade like every other route.
    const ws = new (WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket)(wsUrl, { headers: { authorization: `Bearer ${config.secret}` } });
    ws.binaryType = "arraybuffer";

    const stdout = new PassThrough();
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        callback();
      },
      final(callback) {
        ws.close(1000, "coordinator closed stdin");
        callback();
      },
    });
    const remote = lineSplitter((line) => ctx.remoteProgress(line));

    let onClosed!: (info: ClosedInfo) => void;
    const closed = new Promise<ClosedInfo>((resolve) => {
      onClosed = resolve;
    });
    let exitInfo: ClosedInfo | null = null;
    let settled = false;
    const settle = (info: ClosedInfo): void => {
      if (settled) return;
      settled = true;
      stdout.end();
      onClosed(info);
    };

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as ArrayBuffer | string;
      if (typeof data === "string") {
        try {
          const exit = JSON.parse(data) as { exit: number | null; signal: NodeJS.Signals | null };
          exitInfo = { kind: "exit", code: exit.exit, signal: exit.signal };
        } catch {
          ctx.remoteProgress(`[cloudflare] unexpected text frame: ${data.slice(0, 200)}`);
        }
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes.byteLength === 0) return;
      const payload = bytes.subarray(1);
      if (bytes[0] === STDOUT) stdout.write(Buffer.from(payload));
      else if (bytes[0] === STDERR) remote(payload);
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      // An exit frame means the bridge saw the runner exit — the analogue of a
      // child's exit. A close without one is the transport going away, which
      // the session reads as `network` (retry), like ssh's own 255.
      if (exitInfo === null) {
        ctx.remoteProgress(`[cloudflare] WebSocket closed (${event.code} ${event.reason}) without an exit frame`);
      }
      settle(exitInfo ?? { kind: "transport-failed" });
    });
    ws.addEventListener("error", () => {
      // `close` always follows; it carries the verdict.
    });
    const abort = (): void => ws.close(1000, "dial aborted");
    ctx.signal.addEventListener("abort", abort, { once: true });

    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.addEventListener("open", () => resolve(), { once: true });
      void closed.then(() =>
        reject(new ConnectError(`odu-lane WebSocket to ${instance} failed to open`, "network")),
      );
    });
    ws.send(JSON.stringify({ agentPath, binary: opts.binary, args: ["--stdio"] }));

    const describe = `${opts.binary} on ${opts.host}`;
    const readiness = await Promise.race([
      awaitStdioReadiness({ read: stdout, deadlineMs: READINESS_DEADLINE_MS, describe }),
      closed.then((info): never => {
        throw new ConnectError(
          `${describe} exited before it announced readiness (${JSON.stringify(info)})`,
          info.kind === "transport-failed" ? "network" : "remote",
        );
      }),
    ]).catch((error: unknown) => {
      ws.close(1000, "readiness failed");
      if (isStdioReadinessError(error)) {
        throw new ConnectError(error.message, "remote", false, error.anomaly);
      }
      throw error;
    });
    ctx.localProgress(`[cloudflare] ${describe} ready after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const link = await stdioLink({ group: opts.surface.group, read: stdout, write: stdin, readiness });
    const client = buildSurfaceFace(opts.surface, link.dispatch);
    return {
      client,
      dispatch: link.dispatch,
      closed,
      isAlive: surfaceLiveProbe(client),
      teardown: () => {
        ctx.signal.removeEventListener("abort", abort);
        void link.dispose().catch(() => {});
        ws.close(1000, "teardown");
      },
    };
  };
}
