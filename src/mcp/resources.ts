/**
 * MCP resources — the live-push face. The `nodes` cell and each node's log are
 * exposed as subscribable MCP resources: `resources/subscribe` +
 * `notifications/resources/updated`, which maps the surface's
 * snapshot-then-delta one-to-one (each delta becomes an `updated`, the client
 * re-reads). This is the "ceiling" — a notification-aware host gets live
 * pushes; the blocking `wait_for_settle` tool is the floor for hosts that
 * don't wake the model on a notification.
 *
 * Reads are stateless (server.ts answers them with the tools). The one piece
 * of state is here: a single live attachment to `.ci/odu.sock`, held only
 * while something is subscribed. The socket comes and goes with each run, so a
 * bounded retry loop (re)attaches whenever there are subscribers and no live
 * link — covering subscribe-before-run and run-after-run alike.
 */

import { SOCKET_PATH, tryDialSocket } from "../coordinator/socket";
import type { OduClient } from "../coordinator/socket";

export const NODES_URI = "odu://nodes";
const LOG_PREFIX = "odu://log/";

export function logUri(node: string): string {
  return `${LOG_PREFIX}${encodeURIComponent(node)}`;
}

/** `odu://log/<node>` → `<node>`, or `null` for any other uri — including a
 *  `odu://log/` with no node or with malformed percent-encoding (a bad
 *  `decodeURIComponent` would otherwise throw downstream). */
export function parseLogUri(uri: string): string | null {
  if (!uri.startsWith(LOG_PREFIX)) return null;
  const encoded = uri.slice(LOG_PREFIX.length);
  if (encoded === "") return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** Whether `uri` is a well-formed `odu://log/<node>` we can subscribe to. */
export function isValidLogUri(uri: string): boolean {
  return parseLogUri(uri) !== null;
}

type Dialer = () => Promise<{ client: OduClient; close: () => void } | null>;

export interface PusherDeps {
  notify: (uri: string) => void;
  socketPath?: string;
  /** Injected for tests; defaults to dialing the real unix socket. */
  dial?: Dialer;
  retryMs?: number;
  /** Debounce window for log `updated` notifications (appends are chatty). */
  logDebounceMs?: number;
}

export class ResourcePusher {
  private readonly subscribed = new Set<string>();
  private attachment: { client: OduClient; close: () => void } | null = null;
  private readonly logAborts = new Map<string, AbortController>();
  private readonly logTimers = new Map<string, NodeJS.Timeout>();
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Bumped on every detach; a stream loop that outlives its generation
   *  knows it was torn down (vs. ended because the run settled) and must not
   *  reschedule. */
  private generation = 0;
  private readonly dial: Dialer;
  private readonly retryMs: number;
  private readonly logDebounceMs: number;

  constructor(private readonly deps: PusherDeps) {
    const socketPath = deps.socketPath ?? SOCKET_PATH;
    this.dial = deps.dial ?? (() => tryDialSocket(socketPath));
    this.retryMs = deps.retryMs ?? 1000;
    this.logDebounceMs = deps.logDebounceMs ?? 200;
  }

  subscribe(uri: string): void {
    if (this.stopped) return;
    this.subscribed.add(uri);
    if (this.attachment !== null) {
      const node = parseLogUri(uri);
      if (node !== null) this.startLogStream(this.attachment.client, node);
    } else {
      void this.ensureAttached();
    }
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri);
    const node = parseLogUri(uri);
    if (node !== null) this.stopLogStream(node);
    if (this.subscribed.size === 0) this.detach();
  }

  stop(): void {
    this.stopped = true;
    this.subscribed.clear();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.detach();
  }

  /** Visible for tests. */
  get attached(): boolean {
    return this.attachment !== null;
  }

  private async ensureAttached(): Promise<void> {
    if (this.attachment !== null || this.stopped) return;
    if (this.subscribed.size === 0) return;
    const dialed = await this.dial();
    if (dialed === null) {
      this.scheduleRetry();
      return;
    }
    // A concurrent ensureAttached won the race, or we were stopped mid-dial.
    if (this.attachment !== null || this.stopped) {
      dialed.close();
      if (this.stopped) return;
      return;
    }
    this.attachment = dialed;
    this.startNodesStream(dialed.client, this.generation);
    for (const uri of this.subscribed) {
      const node = parseLogUri(uri);
      if (node !== null) this.startLogStream(dialed.client, node);
    }
  }

  private startNodesStream(client: OduClient, gen: number): void {
    void (async () => {
      try {
        for await (const _state of await client.surface.nodes.get({})) {
          if (this.subscribed.has(NODES_URI)) this.deps.notify(NODES_URI);
        }
      } catch {
        // link torn down (we detached) or a transport error — either way the
        // generation check below decides whether to stand ready for a re-run.
      }
      // A detach bumped the generation and already disposed the link — don't
      // reschedule. Otherwise the stream ended because the run settled and the
      // coordinator closed the socket: detach and wait for the next run.
      if (gen !== this.generation) return;
      this.detach();
      this.scheduleRetry();
    })();
  }

  private startLogStream(client: OduClient, node: string): void {
    if (this.logAborts.has(node)) return;
    const abort = new AbortController();
    this.logAborts.set(node, abort);
    void (async () => {
      try {
        for await (const _frame of await client.surface.nodeLog.get(
          { id: node },
          { signal: abort.signal },
        )) {
          this.notifyLog(node);
        }
      } catch {
        // node id invalid or link error — the stream just ends
      }
    })();
  }

  private notifyLog(node: string): void {
    if (this.logTimers.has(node)) return;
    const timer = setTimeout(() => {
      this.logTimers.delete(node);
      if (this.subscribed.has(logUri(node))) this.deps.notify(logUri(node));
    }, this.logDebounceMs);
    this.logTimers.set(node, timer);
  }

  private stopLogStream(node: string): void {
    this.logAborts.get(node)?.abort();
    this.logAborts.delete(node);
    const timer = this.logTimers.get(node);
    if (timer !== undefined) clearTimeout(timer);
    this.logTimers.delete(node);
  }

  private detach(): void {
    // Bump the generation BEFORE disposing so the in-flight stream loops see
    // the change and don't reschedule. Disposing the link tears every
    // subscription with it, so we don't abort the controllers here — aborting
    // would race an oRPC cancel-send against the socket close
    // (ERR_STREAM_DESTROYED). Per-stream abort is only for a single live
    // unsubscribe (stopLogStream), where the socket stays open.
    this.generation += 1;
    for (const timer of this.logTimers.values()) clearTimeout(timer);
    this.logTimers.clear();
    this.logAborts.clear();
    const att = this.attachment;
    this.attachment = null;
    att?.close();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.subscribed.size === 0) return;
    if (this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureAttached();
    }, this.retryMs);
  }
}
