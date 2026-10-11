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
  type AgentDerivation,
  type ClosedInfo,
  ConnectError,
  type Connection,
  type Connector,
  type ResolveDrvPathContext,
  type SshProv,
  surfaceLiveProbe,
} from "@kolu/surface-remote";
import {
  type CloudflareConfig,
  cloudflareConfigPath,
  cloudflareInstance,
  readCloudflareConfig,
} from "../../common/cloudflareConfig";
import type { ResolveRunnerDrv } from "../runnerFlake";
import { publishToLaneCache, realiseLocally } from "./laneCache";
import { shipClosure } from "./shipClosure";
import { lineSplitter, openLaneSocket, startContainer } from "./workerApi";

const STDOUT = 0x01;
const STDERR = 0x02;

/** The container realises the runner closure between the start message and
 *  the banner, so this budget covers a cold substitution of a few hundred MiB
 *  (measured: 12.6 s from the R2 lane cache) with a wide margin — not the ssh
 *  connector's three minutes, which assume an already-realised agent. Progress
 *  lines keep the session's own pre-connected backstop at bay meanwhile. */
const READINESS_DEADLINE_MS = 20 * 60_000;

/** Bound on runner output received but not yet read by the RPC link. The link
 *  reads continuously and frames are ≤ 16 MiB, so reaching this means the
 *  consumer is wedged: fail the dial rather than buffer without limit. */
const MAX_UNREAD_STDOUT = 64 * 1024 * 1024;

/** How the runner closure reaches a container. Production publishes to the
 *  lane cache (or ships it over /import); a test injects one that does no Nix
 *  work at all. */
export interface LaneProvisioner {
  /** Before the container starts: the runner's out path, available locally
   *  and — when there is one — in the lane cache. */
  prepare(derivation: AgentDerivation, onProgress: (line: string) => void, signal: AbortSignal): Promise<string>;
  /** After it started: anything the container still needs to realise it. */
  deliver(instance: string, agentPath: string, onProgress: (line: string) => void, signal: AbortSignal): Promise<void>;
}

export function nixProvisioner(config: Readonly<CloudflareConfig>): LaneProvisioner {
  return {
    async prepare(derivation, onProgress, signal) {
      const t0 = Date.now();
      const agentPath = await realiseLocally({
        drvPath: derivation.drvPath,
        binaryCache: derivation.binaryCache,
        onProgress,
        signal,
      });
      if (config.cache === null) {
        onProgress("[cloudflare] no lane cache configured — the closure ships over the Worker once the container is up");
      } else {
        onProgress(`[cloudflare] publishing ${agentPath} to the lane cache`);
        await publishToLaneCache({ outPath: agentPath, cache: config.cache, onProgress, signal });
      }
      onProgress(`[cloudflare] runner provisioned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return agentPath;
    },
    async deliver(instance, agentPath, onProgress, signal) {
      if (config.cache !== null) return; // the container substitutes it from the cache
      await shipClosure({ config, instance, outPath: agentPath, onProgress, signal });
    },
  };
}

export interface CloudflareConnectorOptions<S extends SurfaceSpec> {
  surface: Surface<S>;
  /** `cloudflare` or `cloudflare:<instance>` (see common/cloudflareConfig.ts). */
  host: string;
  binary: string;
  resolveDrvPath: ResolveRunnerDrv;
  /** Injected for tests; production reads ~/.config/odu/cloudflare.json. */
  config?: () => Readonly<CloudflareConfig> | null;
  /** Injected for tests; production is {@link nixProvisioner}. */
  provisioner?: (config: Readonly<CloudflareConfig>) => LaneProvisioner;
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

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What this connector last saw end a host's link, in its own terms.
 *  surface-remote words every transport death as an ssh failure; a lane on
 *  a Cloudflare host reports this instead (surfaceRemoteOpts.laneDeathReason). */
export const lastCloseByHost = new Map<string, string>();

function closeNote(host: string, code: number, reason: string): string {
  const said = reason === "" ? `${code}` : `${code} ${reason}`;
  const why =
    code === 1006
      ? "the connection dropped with no close frame — a data-plane deploy evicts attached lanes 5–10 min later, or the container stopped"
      : code === 1011
        ? "the Worker or bridge failed the connection"
        : "the far end closed it";
  return `${host}: the WebSocket to the odu-lane Worker closed (${said}) without the runner exiting — ${why}`;
}

export function cloudflareConnector<S extends SurfaceSpec>(
  opts: CloudflareConnectorOptions<S>,
): Connector<AgentClient, SshProv> {
  const readConfig = opts.config ?? readCloudflareConfig;
  const makeProvisioner = opts.provisioner ?? nixProvisioner;
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
    const provisioner = makeProvisioner(config);
    const local = (line: string): void => {
      ctx.localProgress(line);
      ctx.activity();
    };

    // ── 1. The runner, realised here (and published to the lane cache) ────
    let derivation: AgentDerivation;
    try {
      derivation = await opts.resolveDrvPath(resolverContext(ctx.signal, local));
    } catch (error) {
      throw new ConnectError(message(error), "network");
    }
    ctx.provisioning("provisioning");
    let agentPath: string;
    try {
      agentPath = await provisioner.prepare(derivation, local, ctx.signal);
    } catch (error) {
      // A local build or cache-upload failure: bounded retries, like a
      // remote-store build failure on the ssh path.
      throw new ConnectError(message(error), "remote");
    }

    // ── 2. The container, and whatever it still lacks ─────────────────────
    const t0 = Date.now();
    await startContainer({ config, instance, onLine: local, signal: ctx.signal });
    try {
      await provisioner.deliver(instance, agentPath, local, ctx.signal);
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError(message(error), "network");
    }

    // ── 3. The dial: one WebSocket, one odu-runner ────────────────────────
    ctx.connecting();
    const ws = await openLaneSocket({ config, instance, action: "agent", signal: ctx.signal });
    const describe = `${opts.binary} on ${opts.host}`;

    const stdout = new PassThrough();
    // Writes in one turn of the event loop go out as one message: every
    // message costs a hop through the Durable Object's JS thread (see
    // bridge.ts, COALESCE_*), so fewer, larger ones keep pings prompt.
    let queued: Buffer[] = [];
    const sendQueued = (): void => {
      const body = queued.length === 1 ? queued[0]! : Buffer.concat(queued);
      queued = [];
      if (ws.readyState === WebSocket.OPEN) ws.send(body);
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (queued.length === 0) setImmediate(sendQueued);
        queued.push(chunk);
        callback();
      },
      final(callback) {
        if (queued.length > 0) sendQueued();
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
          ctx.remoteProgress(`[cloudflare] unexpected text frame (${data.length} bytes)`);
        }
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes.byteLength === 0) return;
      const payload = bytes.subarray(1);
      if (bytes[0] === STDOUT) {
        stdout.write(Buffer.from(payload));
        if (stdout.readableLength > MAX_UNREAD_STDOUT) {
          ctx.remoteProgress(`[cloudflare] ${describe}: more than ${MAX_UNREAD_STDOUT} bytes unread — ending the connection`);
          ws.close(1011, "unread output bound");
        }
      } else if (bytes[0] === STDERR) {
        remote(payload);
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      // An exit frame means the bridge saw the runner exit — the analogue of a
      // child's exit. A close without one is the transport going away, which
      // the session reads as `network` (retry), like ssh's own 255.
      if (exitInfo === null && !settled) {
        const note = closeNote(opts.host, event.code, event.reason);
        lastCloseByHost.set(opts.host, note);
        ctx.remoteProgress(`[cloudflare] ${note}`);
      }
      settle(exitInfo ?? { kind: "transport-failed" });
    });
    const abort = (): void => ws.close(1000, "dial aborted");
    ctx.signal.addEventListener("abort", abort, { once: true });

    // The same verdicts the ssh connector reaches for the same facts: a
    // runner that exits before it greets is `remote` (bounded); a transport
    // that goes away is `network` (retry).
    const exitedBeforeReady = (info: ClosedInfo): ConnectError =>
      new ConnectError(
        info.kind === "exit"
          ? `${describe} exited before it announced readiness (exit ${info.code ?? info.signal})`
          : `${describe}: the connection closed before the runner announced readiness`,
        info.kind === "transport-failed" ? "network" : "remote",
      );
    ws.send(JSON.stringify({ agentPath, binary: opts.binary, args: ["--stdio"] }));
    const readiness = await Promise.race([
      awaitStdioReadiness({ read: stdout, deadlineMs: READINESS_DEADLINE_MS, describe }),
      closed.then((info): never => {
        throw exitedBeforeReady(info);
      }),
    ]).catch(async (error: unknown) => {
      ctx.signal.removeEventListener("abort", abort);
      ws.close(1000, "readiness failed");
      // stdout ENDING is the socket closing, not something the runner said —
      // and it can reach the gate before the close event's own verdict does.
      if (isStdioReadinessError(error) && error.kind === "closed") throw exitedBeforeReady(await closed);
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
        // Closing the socket is how we terminate the runner (the bridge EOFs
        // its stdin, then SIGTERMs it) — say so, as the ssh connector's
        // teardown kills its child, rather than waiting on an exit frame the
        // closed socket can no longer carry. First, so no close event wins.
        settle({ kind: "exit", code: null, signal: "SIGTERM" });
        void link.dispose().catch(() => {});
        ws.close(1000, "teardown");
      },
    };
  };
}
