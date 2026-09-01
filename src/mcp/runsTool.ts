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
import { Effect, Schema } from "effect";
import { gitTopLevel } from "../common/git";
import type { RunRecord } from "../common/runRecord";
import { readLedger } from "../coordinator/ledger";
import { checkoutField } from "./checkout";

export const runsInput = Schema.Struct({
  checkout: checkoutField,
  /** Cap the number of (newest-first) runs returned; default `DEFAULT_LIMIT`
   *  so a long-lived checkout.s ledger never floods the agent.s context.
   *
   *  `Schema.Int`, not `Schema.Number`: this is a count, and `Number` is a
   *  codec tolerant of Infinity/NaN whose JSON Schema offers a host the string
   *  `"NaN"` as a valid limit (kolu PLAN D8, divergence 2). */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type RunsInput = typeof runsInput.Type;

export interface RunsResult {
  runs: RunRecord[];
}

const DEFAULT_LIMIT = 20;

export interface RunsOptions {
  limit?: number;
  /** Named checkout whose ledger to read (the tool's `checkout` argument).
   *  Used as-is — it IS the checkout root by contract; absent falls back to
   *  the process's git probe (below). */
  checkout?: string;
  /** Injected for tests; defaults to reading the ledger of the target
   *  checkout. Returns `[]` outside a checkout, mirroring a no-history read. */
  loadLedger?: () => RunRecord[];
}

function defaultLoadLedger(checkout?: string): RunRecord[] {
  // A NAMED checkout is the root by contract — read it directly. The
  // un-named default resolves the process's own checkout via `gitTopLevel`
  // (what `odu runs` uses) rather than assuming cwd == top-level; note the
  // read needs no readable HEAD, which is why it isn't `gitRunContext`
  // (which would return null on an unborn HEAD).
  const repoRoot = checkout ?? gitTopLevel();
  return repoRoot === null ? [] : readLedger(repoRoot);
}

/** The newest `limit` run records (the ledger is already newest-first). Pure
 *  over its injected loader so the slice/limit logic is testable without a
 *  real `.ci`. */
export function listRuns(opts: RunsOptions = {}): RunsResult {
  const load = opts.loadLedger ?? (() => defaultLoadLedger(opts.checkout));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return { runs: load().slice(0, limit) };
}

/** The `runs` bespoke tool. Read-only (`mutates: false`): it reads the durable
 *  ledger off disk and ignores the live client the adapter hands it. The explicit
 *  `mutates: false` is now load-bearing — `@kolu/surface-mcp` defaults an unannotated
 *  tool to MUTATING (a host can auto-run a `readOnlyHint: true` tool unconfirmed, so
 *  an absent flag must fail SAFE), so a genuinely read-only tool has to say so to keep
 *  its `readOnlyHint: true`. */
export const runsTool: BespokeTool = {
  description:
    "List a checkout's durable run history — each recorded run's identity " +
    "(sha#seq), outcome (passed/failed/incomplete), timing, lanes, and " +
    "per-node results — newest first. Works with no run live: it reads the " +
    "on-disk ledger, so it answers 'what happened on the last run?' after the " +
    "coordinator has exited. Targets `checkout`, defaulting to this server's " +
    "own working directory. Optional `limit` (default 20).",
  input: runsInput,
  mutates: false,
  // Synchronous work (a disk read), so `Effect.sync` — the handler is a
  // description either way, and surface-mcp runs it at its one edge.
  handler: (args) =>
    Effect.sync(() => {
      const a = args as RunsInput;
      return listRuns({ limit: a.limit, checkout: a.checkout });
    }),
};
