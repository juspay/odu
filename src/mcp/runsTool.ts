/**
 * The `runs` bespoke MCP tool — the durable run history, for the agent face.
 *
 * The live agent surface (`nodes` / `logs` / `node.rerun`) projects the
 * *running* coordinator: once it exits, `nodes` reports `{ run: false }` and an
 * agent has no way to ask "what runs happened, and how did each end?". The CLI
 * answers that with `odu runs`, reading the on-disk ledger (src/coordinator/
 * ledger.ts); this tool gives the agent face the same reach.
 *
 * It rides the bespoke-tool slot alongside `run` / `wait_for_settle` rather
 * than an exposed surface resource because the ledger is an *off-disk* concern,
 * not a projection of the live client — it is consulted precisely when no
 * coordinator is live, so it reads the trail directly (via `gitRunContext`),
 * exactly as the `logs` collection's durable fallback does. Read-only: it
 * observes history, it changes nothing.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { z } from "zod";
import { gitTopLevel } from "../common/git";
import type { RunRecord } from "../common/runRecord";
import { readLedger } from "../coordinator/ledger";

export const runsInput = z.object({
  /** Cap the number of (newest-first) runs returned; default `DEFAULT_LIMIT`
   *  so a long-lived checkout's ledger never floods the agent's context. */
  limit: z.number().int().positive().optional(),
});
export type RunsInput = z.infer<typeof runsInput>;

export interface RunsResult {
  runs: RunRecord[];
}

const DEFAULT_LIMIT = 20;

export interface RunsOptions {
  limit?: number;
  /** Injected for tests; defaults to reading the ledger from the process's git
   *  checkout. Returns `[]` outside a checkout, mirroring a no-history read. */
  loadLedger?: () => RunRecord[];
}

function defaultLoadLedger(): RunRecord[] {
  // The ledger read needs only the checkout root — not a readable HEAD — so
  // resolve via `gitTopLevel` (what `odu runs` uses), not `gitRunContext`
  // (which also derives the current sha and would return null on an unborn HEAD).
  const repoRoot = gitTopLevel();
  return repoRoot === null ? [] : readLedger(repoRoot);
}

/** The newest `limit` run records (the ledger is already newest-first). Pure
 *  over its injected loader so the slice/limit logic is testable without a
 *  real `.ci`. */
export function listRuns(opts: RunsOptions = {}): RunsResult {
  const load = opts.loadLedger ?? defaultLoadLedger;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return { runs: load().slice(0, limit) };
}

/** The `runs` bespoke tool. Read-only (no `mutates`): it reads the durable
 *  ledger off disk and ignores the live client the adapter hands it. */
export const runsTool: BespokeTool = {
  description:
    "List this checkout's durable run history — each recorded run's identity " +
    "(sha#seq), outcome (passed/failed/incomplete), timing, lanes, and " +
    "per-node results — newest first. Works with no run live: it reads the " +
    "on-disk ledger, so it answers 'what happened on the last run?' after the " +
    "coordinator has exited. Optional `limit` (default 20).",
  input: runsInput,
  handler: (args) => listRuns({ limit: (args as RunsInput).limit }),
};
