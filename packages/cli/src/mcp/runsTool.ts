/**
 * The `runs` bespoke MCP tool — the durable run history, for the agent face.
 *
 * The live agent surface (`nodes` / `logs` / `node.rerun`) projects the
 * *running* coordinator: once it exits, `nodes` reports `{ run: false }` and an
 * agent has no way to ask "what runs happened, and how did each end?". The CLI
 * answers that with `odu runs`, reading the on-disk ledger (packages/execution/src/coordinator/
 * ledger.ts); this tool gives the agent face the same reach.
 *
 * It rides the bespoke-tool slot alongside `run` / `wait_for_settle` rather
 * than an exposed surface procedure because the ledger is an *off-disk* concern,
 * not a projection of the live client — it is consulted precisely when no
 * coordinator is live, so it reads the trail directly (via `gitRunContext`),
 * exactly as the `logs` collection's durable fallback does. Read-only: it
 * observes history, it changes nothing.
 *
 * One more thing it owes the agent: a run whose coordinator was KILLED (its
 * host restarted — the cgroup answer, never a clean exit) finalizes no record,
 * so the ledger alone answers as if it never ran. The answer then carries
 * `dead_run` — the corpse's name (sha7#seq), its last sign of life, and the
 * sentence (`deadRun` in `@odu/run-client`) — rather than answering an empty
 * ledger over the residue.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { Effect, Schema } from "effect";
import { type DeadRun, deadRun, describeDeadRun } from "@odu/run-client/deadRun";
import type { RunRecord } from "@odu/run-history/legacy/record";
import { readLedger } from "@odu/run-history/legacy/ledger";
import { checkoutField, checkoutOf } from "./checkout";

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
  /** A run killed mid-flight with its host — never finalized, so the ledger
   *  alone would swear it never ran. `null` in the steady state: either a
   *  run is live, or nothing died here. */
  dead_run: (DeadRun & { message: string }) | null;
}

const DEFAULT_LIMIT = 20;

export interface RunsOptions {
  limit?: number;
  /** Named checkout whose ledger to read (the tool's `checkout` argument — a
   *  validated root). Absent: the process's cwd, via `checkoutOf` — the same
   *  default every other bespoke tool uses. */
  checkout?: string;
  /** Injected for tests; defaults to reading the ledger of the target
   *  checkout. Returns `[]` where no ledger exists, mirroring a no-history
   *  read. */
  loadLedger?: () => RunRecord[];
  /** Injected for tests; defaults to the real corpse read of the same
   *  checkout. Answer `null` for the steady state. */
  detectDead?: () => Promise<DeadRun | null>;
}

function defaultLoadLedger(checkout?: string): RunRecord[] {
  // The default is the server's cwd — `checkoutOf`, the one rule the other
  // eight tools already follow (and this tool's own description already
  // claims). The prior `gitTopLevel` probe was CLI-shaped rescue: it made
  // `runs()` from a subdirectory-spawned server read the toplevel ledger that
  // `run`/`wait`/`cancel` in that same broken arrangement address as
  // `<cwd>/.ci` — "helpfully correct" here, divergent everywhere. A NAMED
  // checkout is a validated root (./checkout.ts), so both directions of the
  // fold now read a root's `.ci` or loudly nothing else's.
  return readLedger(checkoutOf({ checkout }));
}

/** The newest `limit` run records (the ledger is already newest-first), plus
 *  the corpse the ledger is blind to (a run killed with its host answers
 *  through no record it ever wrote). Pure over its injected answers so the
 *  fold is testable without a real `.ci`. */
export async function listRuns(opts: RunsOptions = {}): Promise<RunsResult> {
  const root = checkoutOf({ checkout: opts.checkout });
  const load = opts.loadLedger ?? (() => defaultLoadLedger(opts.checkout));
  const detect = opts.detectDead ?? ((): Promise<DeadRun | null> => deadRun(root));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dead = await detect();
  return {
    runs: load().slice(0, limit),
    dead_run: dead === null ? null : { ...dead, message: describeDeadRun(dead) },
  };
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
    "coordinator has exited. A run whose coordinator was KILLED with its " +
    "host finalized no record — the answer names it separately as " +
    "`dead_run` (sha#seq, last sign of life) instead of answering an empty " +
    "ledger over its residue; `dead_run` is null in the steady state. " +
    "Targets `checkout`, defaulting to this server's own working directory. " +
    "Optional `limit` (default 20).",
  input: runsInput,
  mutates: false,
  // Async: the ledger read is sync, the corpse answer dials once.
  handler: (args) =>
    Effect.promise(() => {
      const a = args as RunsInput;
      return listRuns({ limit: a.limit, checkout: a.checkout });
    }),
};
