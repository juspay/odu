/**
 * The `cancel` bespoke MCP tool — stop the live run in this checkout.
 *
 * Like `run`, it's call-shaped over the *process*, not the live surface: it
 * dials the coordinator socket directly and drives `cancelRun` (ask the run to
 * stop, then wait until its socket is gone). It rides the bespoke-tool slot
 * rather than exposing `run.cancel` through the projected agent surface so the
 * agent gets one verb that also confirms teardown — the precondition a
 * following `run` needs to re-bind the checkout's one-run lock.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { z } from "zod";
import { cancelRun } from "../coordinator/cancel";

export const cancelInput = z.object({});

export interface CancelToolResult {
  ok: boolean;
  /** A live run was found and asked to stop (false = nothing to cancel). */
  cancelled: boolean;
  /** The coordinator's socket was confirmed gone (it tore down). */
  confirmed: boolean;
}

/** Cancel the in-progress run in this checkout (if any). Mutating: it tears a
 *  run down and frees the run lock. Typed as the loose `BespokeTool` (the
 *  package's `tools` slot is invariant in the input type). */
export const cancelTool: BespokeTool = {
  description:
    "Cancel the in-progress run in this checkout: tell its coordinator to stop " +
    "and wait until it's torn down, so a following `run` can start. No run live " +
    "is a clean no-op (nothing to cancel). Use it to call off a run you no " +
    "longer need (wrong commit, an already-visible failure) instead of waiting " +
    "it out.",
  input: cancelInput,
  mutates: true,
  handler: async (): Promise<CancelToolResult> => {
    const result = await cancelRun();
    return { ok: true, cancelled: result.cancelled, confirmed: result.confirmed };
  },
};
