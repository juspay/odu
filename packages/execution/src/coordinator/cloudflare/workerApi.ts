/**
 * Every call the coordinator makes to the `odu-lane` Worker, in one module:
 * the routes are spelled by `laneEndpoint`, the bearer leaves the config only
 * through `laneAuthHeaders`, and every wait has a deadline as well as the
 * dial's abort signal.
 */

import { ConnectError } from "@kolu/surface-remote";
import {
  type CloudflareConfig,
  cloudflareConfigPath,
  laneAuthHeaders,
  laneEndpoint,
} from "../../common/cloudflareConfig";

/** The Worker waits up to 2 min for an instance and 10 min for the port
 *  (`worker.ts` — the first boot of a fresh image realises bun before the
 *  bridge listens). Ours is that plus slack, so the Worker's own verdict is
 *  the one an operator sees. */
const START_DEADLINE_MS = 13 * 60_000;
const OPEN_DEADLINE_MS = 60_000;
const STATE_DEADLINE_MS = 15_000;

function deadline(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function refused(status: number): ConnectError | null {
  if (status === 401) {
    return new ConnectError(
      `odu-lane Worker refused our secret — re-run \`odu cloudflare setup\` (${cloudflareConfigPath()})`,
      "remote",
      true,
    );
  }
  if (status >= 400 && status < 500) {
    return new ConnectError(`odu-lane Worker answered ${status} — is it the version this odu deployed? re-run \`odu cloudflare setup\``, "remote", true);
  }
  return null;
}

/** POST /start and relay the Worker's narration until the container's port
 *  answers. A separate request from the agent dial so a cold start is visible
 *  progress rather than one silent WebSocket upgrade. */
export async function startContainer(opts: {
  config: Readonly<CloudflareConfig>;
  instance: string;
  onLine: (line: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const response = await fetch(laneEndpoint(opts.config, opts.instance, "start"), {
    method: "POST",
    headers: laneAuthHeaders(opts.config),
    signal: deadline(opts.signal, START_DEADLINE_MS),
  }).catch((error: unknown) => {
    throw new ConnectError(`odu-lane /start: ${(error as Error).message}`, "network");
  });
  const refusal = refused(response.status);
  if (refusal !== null) throw refusal;
  if (!response.ok || response.body === null) {
    throw new ConnectError(`odu-lane /start answered ${response.status}`, "network");
  }
  let last = "";
  const lines = lineSplitter((line) => {
    last = line;
    opts.onLine(`[cloudflare:${opts.instance}] ${line}`);
  });
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lines(value);
    }
  } catch (error) {
    throw new ConnectError(`odu-lane /start stream: ${(error as Error).message}`, "network");
  }
  if (/maximum number of running container instances/i.test(last)) {
    // Retryable: containers of a previous Worker version still count until
    // they idle out (10 min), as do other runs' lanes.
    throw new ConnectError(
      `container ${opts.instance} did not start: the account's max_instances for odu-lane is reached ` +
        "(containers from a previous deploy count until they stop after 10 idle minutes) — " +
        "raise it with `odu cloudflare setup --max-instances N`",
      "network",
    );
  }
  if (!last.startsWith("ready")) {
    throw new ConnectError(`container ${opts.instance} did not start: ${last || "no answer"}`, "network");
  }
}

/** Is the instance's container running? Answered by its Durable Object
 *  without starting anything — the cheap question a probe asks. */
export async function laneState(
  config: Readonly<CloudflareConfig>,
  instance: string,
  signal: AbortSignal = AbortSignal.timeout(STATE_DEADLINE_MS),
): Promise<{ running: boolean }> {
  const response = await fetch(laneEndpoint(config, instance, "state"), {
    headers: laneAuthHeaders(config),
    signal: deadline(signal, STATE_DEADLINE_MS),
  });
  if (!response.ok) throw new Error(`odu-lane /state answered ${response.status}`);
  const body = (await response.json()) as { running?: unknown };
  return { running: body.running === true };
}

/** Open an authenticated WebSocket to a lane route and wait until it is open.
 *  Bun's WebSocket takes request headers; the Worker authenticates the upgrade
 *  like every other route. Rejects with a classified `ConnectError`: a refused
 *  upgrade (bad secret) is terminal, anything else is the network. */
export async function openLaneSocket(opts: {
  config: Readonly<CloudflareConfig>;
  instance: string;
  action: "agent" | "import";
  signal: AbortSignal;
}): Promise<WebSocket> {
  const ws = new (WebSocket as unknown as new (
    url: URL,
    init: { headers: Record<string, string> },
  ) => WebSocket)(laneEndpoint(opts.config, opts.instance, opts.action, "wss"), { headers: laneAuthHeaders(opts.config) });
  ws.binaryType = "arraybuffer";
  const signal = deadline(opts.signal, OPEN_DEADLINE_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new ConnectError(`odu-lane /${opts.action} to ${opts.instance} did not open in time`, "network"));
      signal.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("open", () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, { once: true });
      ws.addEventListener("close", (event: CloseEvent) => {
        signal.removeEventListener("abort", onAbort);
        // Bun reports a non-101 upgrade answer as 1002 "Expected 101 status
        // code"; the status itself is not exposed. Ask /state with the same
        // credentials to tell a refused secret from a network failure.
        void laneState(opts.config, opts.instance).then(
          () => reject(new ConnectError(`odu-lane /${opts.action} to ${opts.instance} closed before opening (${event.code} ${event.reason})`, "network")),
          (error: Error) => {
            const status = /answered (\d+)/.exec(error.message)?.[1];
            reject(refused(Number(status)) ?? new ConnectError(`odu-lane /${opts.action} to ${opts.instance} failed: ${error.message}`, "network"));
          },
        );
      }, { once: true });
    });
  } catch (error) {
    ws.close();
    throw error;
  }
  return ws;
}

/** Split a byte stream into lines for a progress sink. A line past MAX_LINE
 *  is flushed in pieces rather than buffered without bound. */
export function lineSplitter(sink: (line: string) => void): (chunk: Uint8Array) => void {
  const MAX_LINE = 64 * 1024;
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
    if (pending.length > MAX_LINE) {
      sink(pending);
      pending = "";
    }
  };
}
