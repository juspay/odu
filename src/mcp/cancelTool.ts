/**
 * The `cancel` bespoke MCP tool — stop the live run in a checkout.
 *
 * Like `run`, it's call-shaped over the *process*, not the live surface: it
 * dials the coordinator socket directly and drives `cancelRun` (ask the run
 * to stop, then wait until its socket is gone). It rides the bespoke-tool
 * slot rather than exposing `run.cancel` through the projected agent surface
 * so the agent gets one verb that also confirms teardown — the precondition a
 * following `run` needs to re-bind the checkout's one-run lock.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { Effect, Schema } from "effect";
import { cancelRun } from "../coordinator/cancel";
import { checkoutField, checkoutOf } from "./checkout";
import { runSocketPath } from "@odu/run-client/dial";

/** Never `Schema.Void`: a no-other-arg tool must still advertise
 *  `{"type":"object"}` to a host (see `runInput` for the one annotated field
 *  every tool carries — `checkout` is always present, so this struct has
 *  exactly one member). */
export const cancelInput = Schema.Struct({
  checkout: checkoutField,
});
export type CancelInput = typeof cancelInput.Type;

export interface CancelToolResult {
  ok: boolean;
  /** A live run was found and asked to stop (false = nothing to cancel). */
  cancelled: boolean;
  /** The coordinator's socket was confirmed gone (it tore down). */
  confirmed: boolean;
}

/** Cancel the in-progress run in the target checkout (if any). Mutating: it
 *  tears a run down and frees the run lock. Typed as the loose `BespokeTool`
 *  (the package's `tools` slot is invariant in the input type). */
export const cancelTool: BespokeTool = {
  description:
    "Cancel the in-progress run in a checkout: tell its coordinator to stop " +
    "and wait until it's torn down, so a following `run` can start. No run " +
    "live there is a clean no-op (nothing to cancel). Use it to call off a " +
    "run you no longer need (wrong commit, an already-visible failure) " +
    "instead of waiting it out. Targets `checkout`, defaulting to this " +
    "server's own working directory.",
  input: cancelInput,
  mutates: true,
  // A bespoke handler DESCRIBES its work now; surface-mcp runs it at its one
  // request edge, under the MCP request's own signal — so a cancelled
  // `tools/call` interrupts this for free, with nothing to thread.
  // `Effect.promise`, not `tryPromise`: `cancelRun` swallows its own dial and
  // ack failures by design (the proof a run is cancelled is the socket going
  // away, not the reply), so a rejection here is a defect, not an outcome.
  handler: (args) =>
    Effect.promise(async (): Promise<CancelToolResult> => {
      const result = await cancelRun(
        runSocketPath(checkoutOf(args as CancelInput)),
      );
      return {
        ok: true,
        cancelled: result.cancelled,
        confirmed: result.confirmed,
      };
    }),
};
