/**
 * The `wait_for_settle` bespoke MCP tool shell — input schema + host adapter
 * over the face-neutral settle core in `coordinator/waitForSettle.ts`.
 *
 * The blocking read loop, fail-fast / settle policy, and ledger fallback live
 * below both faces (CLI `odu wait` and this tool). This file only speaks MCP.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { z } from "zod";
import { gitRunContext } from "../common/git";
import {
  waitForSettle,
  type WaitOptions,
} from "../coordinator/waitForSettle";
import {
  type AgentNodesReader,
  type ResolveRunContext,
} from "./agentSurface";

export const waitInput = z.object({
  // Finite + non-negative: NaN/negative would fire setTimeout immediately and
  // look like a genuine timeout verdict rather than bad input.
  timeout_ms: z.number().finite().nonnegative().optional(),
  fail_fast: z.boolean().optional(),
  /** Refuse loudly unless the live run's commit matches this sha (a prefix
   *  either way, so a 7- or 40-char sha both work) — the "wait for the run I
   *  just dispatched, not a stale one" guard (juspay/odu#49 ask 3). */
  expected_sha: z
    .string()
    .describe(
      "Refuse loudly unless the live run's commit matches this. Prefix-matched " +
        "against the run's sha7 either way, so a full 40-char sha or the 7-char " +
        "sha7 from a prior verdict both work.",
    )
    .optional(),
});
export type WaitInput = z.infer<typeof waitInput>;

/** The `wait_for_settle` bespoke tool, over one injected view of the world.
 *  Read-only (`mutates: false`): it observes the run, it doesn't change it. The
 *  explicit `mutates: false` opts into `readOnlyHint: true` under
 *  `@kolu/surface-mcp`'s conservative default (an unannotated tool is now
 *  treated as MUTATING so a host can't auto-run it unconfirmed). Typed as the
 *  loose `BespokeTool` (the package's `tools` slot is invariant in the input
 *  type); `input` validates, handler narrows.
 *
 *  A factory rather than a const so `resolveRunContext` reaches the handler:
 *  `mcp.ts` hands it the same resolver the projection's durable-log fallback
 *  gets, and a test hands it a stub — so the shipping handler is the one under
 *  test, not a parallel path reachable only through an injected option. */
export function makeWaitTool(
  resolveRunContext: ResolveRunContext = gitRunContext,
): BespokeTool {
  return {
    description:
      "Block until the run settles, or — fail-fast (default) — the instant a " +
      "node goes red, so you can drill into a failure without waiting for the " +
      "slow lanes. Returns the verdict {settled, passed, failed[], errored[], " +
      "sha7, seq, unposted[]}: sha7 names the commit, a non-null seq " +
      "completes the unique run ref sha7#seq (seq is null only when no ordinal " +
      "was reserved), and unposted is full owed rows " +
      "({context, lastError, attempts}) not yet confirmed (reporting debt does " +
      "not block settle). Fails LOUD (an error, not an empty verdict) when no " +
      "run is live in this checkout, or when the live run's commit doesn't " +
      "prefix-match `expected_sha`. If the coordinator's socket closes before " +
      "it publishes a terminal frame, the verdict comes from the run's " +
      "finalized record on disk (never green for a run torn down mid-flight).",
    input: waitInput,
    mutates: false,
    handler: (args, client, signal) => {
      const a = args as WaitInput;
      const opts: WaitOptions = {
        client: client as AgentNodesReader,
        timeoutMs: a.timeout_ms,
        failFast: a.fail_fast,
        expectedSha: a.expected_sha,
        signal,
        resolveRunContext,
      };
      return waitForSettle(opts);
    },
  };
}
