/**
 * Cancel a live run from a *second* process — the shared core behind the
 * `odu cancel` CLI, the MCP `cancel` tool, and a `--supersede` run.
 *
 * The coordinator owns the run; everyone else only holds a socket to it. So
 * cancellation is "dial the coordinator, call `run.cancel`, then wait until its
 * socket is gone." The ack is best-effort: `run.cancel` routes into the
 * coordinator's teardown, which exits the process — the reply can be cut off by
 * the socket closing, so we never depend on it. The *proof* a run is cancelled
 * is the socket no longer answering, which is exactly the precondition a
 * following `run` needs before it can re-bind the checkout's one-run lock.
 */

import { SOCKET_PATH, tryDialSocket } from "./socket";

export interface CancelResult {
  /** A live run was found and asked to stop. `false` means there was nothing
   *  to cancel (no socket) — an idempotent no-op, not a failure. */
  cancelled: boolean;
  /** The coordinator's socket was confirmed gone (it tore down). `false` after
   *  a cancelled run means it was still shutting down when the wait window
   *  elapsed — a following `run` may still hit the one-run lock. */
  confirmed: boolean;
}

export interface CancelDeps {
  /** Injected for tests; defaults to the real unix-socket dial. */
  dial?: (path: string) => ReturnType<typeof tryDialSocket>;
  /** Total time to wait for the socket to disappear after the cancel call. */
  settleTimeoutMs?: number;
  /** Poll interval while waiting for the socket to disappear. */
  pollMs?: number;
  /** Injected for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Tell the live coordinator (if any) to stop, then wait until its socket is
 *  gone. Idempotent: no live run → `{ cancelled: false, confirmed: true }`. */
export async function cancelRun(
  socketPath: string = SOCKET_PATH,
  deps: CancelDeps = {},
): Promise<CancelResult> {
  const dial = deps.dial ?? tryDialSocket;
  const sleep = deps.sleep ?? defaultSleep;
  const settleTimeoutMs = deps.settleTimeoutMs ?? 10_000;
  const pollMs = deps.pollMs ?? 100;

  const dialed = await dial(socketPath);
  if (dialed === null) return { cancelled: false, confirmed: true };
  try {
    // The coordinator tears down and exits in response, which can sever this
    // call before the ack arrives — that's the cancel taking effect, not a
    // failure, so swallow the rejection and confirm via the socket below.
    await dialed.client.surface.run.cancel({}).catch(() => {});
  } finally {
    dialed.close();
  }

  // Confirm teardown: poll until the socket no longer answers, so a following
  // `run` can re-bind the checkout lock without colliding on a dying run.
  const attempts = Math.max(1, Math.ceil(settleTimeoutMs / pollMs));
  for (let i = 0; i < attempts; i += 1) {
    const probe = await dial(socketPath);
    if (probe === null) return { cancelled: true, confirmed: true };
    probe.close();
    await sleep(pollMs);
  }
  return { cancelled: true, confirmed: false };
}
