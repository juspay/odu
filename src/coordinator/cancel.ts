/**
 * Cancel a live run (or a node/lane of it) from a *second* process — the
 * shared core behind the `odu cancel` CLI, the MCP `cancel` / `node_cancel`
 * tools, and a `--supersede` run.
 *
 * The coordinator owns the run; everyone else only holds a socket to it. Full
 * cancellation is "dial the coordinator, call `run.cancel`, then wait until its
 * socket is gone." The ack is best-effort: `run.cancel` routes into the
 * coordinator's teardown, which exits the process — the reply can be cut off by
 * the socket closing, so we never depend on it. The *proof* a run is cancelled
 * is the socket no longer answering, which is exactly the precondition a
 * following `run` needs before it can re-bind the checkout's one-run lock.
 *
 * Per-node / per-lane cancel (juspay/odu#68) is `node.cancel` over the same
 * socket and leaves the coordinator up so the rest of the run can settle.
 */

import { dialRun, SOCKET_PATH } from "@odu/run-client/dial";
import { runUnary } from "../common/effectEdge";
import { parseAtPlatform } from "../common/nodeId";

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
  dial?: (path: string) => ReturnType<typeof dialRun>;
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
  const dial = deps.dial ?? dialRun;
  const sleep = deps.sleep ?? defaultSleep;
  const settleTimeoutMs = deps.settleTimeoutMs ?? 10_000;
  const pollMs = deps.pollMs ?? 100;

  const dialed = await dial(socketPath);
  if (dialed === null) return { cancelled: false, confirmed: true };
  try {
    // The coordinator tears down and exits in response, which can sever this
    // call before the ack arrives — that's the cancel taking effect, not a
    // failure, so swallow the rejection and confirm via the socket below.
    await runUnary(dialed.client.surface.run.cancel({})).catch(() => {});
  } finally {
    await dialed.close();
  }

  // Confirm teardown: poll until the socket no longer answers, so a following
  // `run` can re-bind the checkout lock without colliding on a dying run.
  const attempts = Math.max(1, Math.ceil(settleTimeoutMs / pollMs));
  for (let i = 0; i < attempts; i += 1) {
    const probe = await dial(socketPath);
    if (probe === null) return { cancelled: true, confirmed: true };
    await probe.close();
    await sleep(pollMs);
  }
  return { cancelled: true, confirmed: false };
}

/** Result of a partial cancel attempt against a live (or missing) run. */
export type PartialCancelResult =
  | { kind: "bad_target" }
  | { kind: "no_run" }
  | { kind: "delivered"; ok: boolean; error?: string };

/** Parse CLI/MCP sugar: `@plat` → platform drop; else fan-in node id. */
export function parsePartialCancelTarget(
  target: string,
):
  | { kind: "platform"; platform: string }
  | { kind: "node"; id: string }
  | null {
  const platform = parseAtPlatform(target);
  if (platform !== null) return { kind: "platform", platform };
  // Bare `@` / `@a@b` are invalid platform sugar, not node ids.
  if (target.startsWith("@")) return null;
  if (target === "") return null;
  return { kind: "node", id: target };
}

/** Cancel one node (`ci::fmt@plat`) or a whole platform lane (`@plat`) on the
 *  live run. Routes to fan-in `node.cancel` / `lane.cancel`. The coordinator
 *  stays up (juspay/odu#68). */
export async function cancelNodeOrPlatform(
  target: string,
  socketPath: string = SOCKET_PATH,
  deps: Pick<CancelDeps, "dial"> = {},
): Promise<PartialCancelResult> {
  const parsed = parsePartialCancelTarget(target);
  if (parsed === null) return { kind: "bad_target" };
  const dial = deps.dial ?? dialRun;
  const dialed = await dial(socketPath);
  if (dialed === null) return { kind: "no_run" };
  try {
    const result = await runUnary(
      parsed.kind === "platform"
        ? dialed.client.surface.lane.cancel({ platform: parsed.platform })
        : dialed.client.surface.node.cancel({ id: parsed.id }),
    );
    return { kind: "delivered", ok: result.ok };
  } catch (err) {
    return {
      kind: "delivered",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await dialed.close();
  }
}
