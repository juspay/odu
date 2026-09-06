/**
 * The join between a node's VERDICT and a node's OUTPUT.
 *
 * They are two halves of one fact — "this node is done" — and they travel on
 * two different streams, of which the verdict's is always the faster: a few
 * bytes on the state cell against a backlog on the log stream. So a run that
 * publishes a status the moment it arrives promises a finished node while its
 * output is still on the wire, and every reader that acts on the promise —
 * `odu wait --settle`, the MCP `wait_for_settle` an agent loops on, the durable
 * record, the commit status pointing at a log path — reads a file that stops
 * mid-recipe with nothing saying so (juspay/odu#87, and the settle-shaped
 * residual left after #88 fixed it at teardown only).
 *
 * This gate is where the promise is kept: a node's TERMINAL status is withheld
 * until its log has ended. "Settled" then means what every reader already took
 * it to mean, on every path — the lingering coordinator that never tears down
 * included — and no reader has to learn that logs exist.
 *
 * A module rather than a cluster of closures inside `orchestrate` because it
 * encapsulates ONE axis of change with a name: **when a node's outcome may be
 * told to the world.** Hold until the log ends, hold until a checksum matches,
 * hold nothing at all for a class of node — every one of those edits lands
 * here. And because a rule about what a run may CLAIM is worth being able to
 * falsify directly: the bug this exists to kill needs a 14 MB recipe and a real
 * socket to reproduce end-to-end, but every rule the gate follows is a unit
 * test (`verdictGate.test.ts`).
 */

import type { NodeState, NodeStatus } from "@odu/run-client/surface";
import { NON_TERMINAL_STATUSES } from "../common/verdict";

export interface VerdictGateDeps {
  /** Has this node's log published its terminal — is the run done expecting
   *  bytes for it? The log sink's own fact, asked rather than re-derived. */
  isLogEnded: (id: string) => boolean;
  /** The status this run has already PUBLISHED for a node (undefined for a
   *  node it does not know). Not "the status the lane last reported" — the
   *  distinction is the whole point of the gate. */
  publishedStatus: (id: string) => NodeStatus | undefined;
  /** Every node in the run. */
  nodeIds: () => readonly string[];
  /** Put a node's state on the fan-in. */
  publish: (id: string, patch: Partial<NodeState>) => void;
  /** Wait for the lanes to deliver the output they still owe, stamping into
   *  the log itself whatever never arrives. The BOUND on a hold — see
   *  {@link VerdictGate.boundIfOnlyLogsOutstanding}. */
  drainLogs: () => Promise<void>;
}

export interface VerdictGate {
  /** Route a node's state onto the run, holding a TERMINAL verdict until that
   *  node's log has ended. The one publication path for lane nodes, so there
   *  is no second way for a verdict to get out ahead of its output. */
  offer: (id: string, patch: Partial<NodeState>) => void;
  /** This node's log has had its last word — an `end` frame, or a truncation
   *  notice standing in for one. Publish what was held for it. */
  release: (id: string) => void;
  /** Publish every held verdict this predicate admits (default: all of them).
   *  For the paths that take a node's outcome out of the lane's hands — a lane
   *  dying, an operator cancel, the run being torn down. */
  releaseAll: (of?: (id: string) => boolean) => void;
  /** Is this run waiting on nothing but output still in flight? Then bound the
   *  wait for it. Nothing else can end a hold if a lane simply stops talking,
   *  and a verdict held forever would leave the run un-settleable — a worse
   *  failure than the one this gate exists to fix. */
  boundIfOnlyLogsOutstanding: () => void;
}

const isTerminal = (status: NodeStatus | undefined): boolean =>
  status !== undefined && !NON_TERMINAL_STATUSES.has(status);

export function createVerdictGate(deps: VerdictGateDeps): VerdictGate {
  /** Terminal patches withheld because their node's log has not ended. */
  const held = new Map<string, Partial<NodeState>>();

  const release = (id: string): void => {
    const patch = held.get(id);
    if (patch === undefined) return;
    held.delete(id);
    deps.publish(id, patch);
  };

  const releaseAll = (of: (id: string) => boolean = () => true): void => {
    for (const id of [...held.keys()]) {
      if (of(id)) release(id);
    }
  };

  /** Every node has reached a terminal status, and some of those statuses are
   *  ones being held back. That is the moment the logs, and only the logs,
   *  stand between this run and a settle it can honestly announce. */
  const onlyLogsOutstanding = (): boolean =>
    held.size > 0 &&
    deps.nodeIds().every((id) => held.has(id) || isTerminal(deps.publishedStatus(id)));

  /** The happy path never comes through here: an `end` frame releases its own
   *  node's verdict as it lands, which is also the moment that node's file is
   *  whole — so a run whose lanes deliver settles at the speed of its slowest
   *  backlog and no slower. This is the other case, a lane that will never
   *  deliver. The drain it waits on is bounded by SILENCE rather than by a
   *  clock, so a genuine backlog still costs time instead of output; what it
   *  gives up on, it stamps. The verdicts are then published regardless —
   *  against logs that SAY they are short, which is the honest end of a bad
   *  case and the one thing this whole mechanism refuses to leave unsaid. */
  let bounding = false;
  const boundIfOnlyLogsOutstanding = (): void => {
    if (bounding || !onlyLogsOutstanding()) return;
    bounding = true;
    void (async () => {
      try {
        await deps.drainLogs();
      } finally {
        bounding = false;
        releaseAll();
      }
    })();
  };

  return {
    offer: (id, patch) => {
      const status = patch.status;
      if (!isTerminal(status)) {
        // A node that (re)started is owed no hold: a rerun's snapshot re-opens
        // its log, and any verdict held for it described the invocation that
        // rerun just replaced.
        held.delete(id);
        deps.publish(id, patch);
        return;
      }
      // Already out — a repeated frame for a node whose verdict this run has
      // published (including one released against a log that will never end)
      // must not put it back on hold.
      if (isTerminal(deps.publishedStatus(id)) || deps.isLogEnded(id)) {
        deps.publish(id, patch);
        return;
      }
      held.set(id, patch);
      boundIfOnlyLogsOutstanding();
    },
    release,
    releaseAll,
    boundIfOnlyLogsOutstanding,
  };
}
