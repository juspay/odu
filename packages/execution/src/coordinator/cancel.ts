import { dialRun, SOCKET_PATH } from "@odu/run-client/dial";
import { runUnary } from "../common/effectEdge";
import { parseAtPlatform } from "../common/nodeId";

export interface CancelResult {
  /** A live run was found and asked to stop; `false` means nothing to cancel. */
  cancelled: boolean;
  /** The coordinator's socket was confirmed gone. */
  confirmed: boolean;
}

export interface CancelDeps {
  dial?: (path: string) => ReturnType<typeof dialRun>;
  settleTimeoutMs?: number;
  pollMs?: number;
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
    await runUnary(dialed.client.surface.run.cancel({})).catch(() => {});
  } finally {
    await dialed.close();
  }

  const attempts = Math.max(1, Math.ceil(settleTimeoutMs / pollMs));
  for (let i = 0; i < attempts; i += 1) {
    const probe = await dial(socketPath);
    if (probe === null) return { cancelled: true, confirmed: true };
    await probe.close();
    await sleep(pollMs);
  }
  return { cancelled: true, confirmed: false };
}

export type PartialCancelResult =
  | { kind: "bad_target" }
  | { kind: "no_run" }
  | { kind: "delivered"; ok: boolean; error?: string };

export function parsePartialCancelTarget(
  target: string,
):
  | { kind: "platform"; platform: string }
  | { kind: "node"; id: string }
  | null {
  const platform = parseAtPlatform(target);
  if (platform !== null) return { kind: "platform", platform };
  if (target.startsWith("@")) return null;
  if (target === "") return null;
  return { kind: "node", id: target };
}

/** Cancel one node (`ci::fmt@plat`) or a whole platform lane (`@plat`) on the
 *  live run; the coordinator stays up. */
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
