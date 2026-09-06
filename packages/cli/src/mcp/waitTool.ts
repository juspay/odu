/**
 * The `wait_for_settle` bespoke MCP tool shell — input schema + host adapter
 * over the face-neutral settle core in `coordinator/waitForSettle.ts`.
 *
 * The blocking read loop, fail-fast / settle policy, and ledger fallback live
 * below both faces (CLI `odu wait` and this tool). This file only speaks MCP.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { Effect, Schema } from "effect";
import { runSocketPath } from "@odu/run-client/dial";
import { gitRunContext, gitRunContextFor } from "@odu/execution/common/git";
import { waitForSettle } from "@odu/execution/coordinator/waitForSettle";
import {
  type AgentNodesReader,
  type ResolveRunContext,
} from "./agentSurface";
import {
  agentReaderForSocket,
} from "@odu/execution/coordinator/agentReader";
import { checkoutField } from "./checkout";

export const waitInput = Schema.Struct({
  checkout: checkoutField,
  /** `Schema.Int`, not `Schema.Number`: a millisecond bound is an integer, and
   *  `Number`'s JSON Schema offers a host the string `"NaN"` (PLAN D8). The
   *  bounds are the same ones `waitForSettle` re-checks face-neutrally: a
   *  negative delay is nonsense and anything past setTimeout's signed-32-bit
   *  limit clamps to ~1ms and looks like a genuine timeout (odu#49 class).
   *  `Schema.Int` already rejects the non-finite values `z.number().finite()`
   *  had to exclude by hand. */
  timeout_ms: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(2_147_483_647),
    ),
  ),
  fail_fast: Schema.optionalKey(Schema.Boolean),
  /** Refuse loudly unless the live run's commit matches this sha (a prefix
   *  either way, so a 7- or 40-char sha both work) — the "wait for the run I
   *  just dispatched, not a stale one" guard (juspay/odu#49 ask 3). */
  // `.describe(...)` becomes an ANNOTATION — the description is what a host
  // shows an agent about this argument, so it has to survive the port.
  expected_sha: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description:
        "Refuse loudly unless the live run's commit matches this. Prefix-matched " +
        "against the run's sha7 either way, so a full 40-char sha or the 7-char " +
        "sha7 from a prior verdict both work.",
    }),
  ),
});
export type WaitInput = typeof waitInput.Type;

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
      "finalized record on disk (never green for a run torn down mid-flight). " +
      "And when the residue in `.ci` says the run DIED with its host — stale " +
      "lock/socket, a reservation never finalized — the error names that " +
      "death (`<sha7>#<seq>` and the last sign of life) instead of the bare " +
      "'no run in progress'; a killed run is never a silent wait.",
    input: waitInput,
    mutates: false,
    // `waitForSettle` stays Promise-shaped and keeps its OWN `AbortSignal`:
    // it owns a timeout/cancel/settle race whose losing arms must be unwound in
    // a specific order, and the signal is the vocabulary that race is written
    // in. `BespokeTool.handler` keeps the `signal` parameter for exactly this
    // case (see its doc), so the MCP request's cancellation still reaches the
    // wait.
    //
    // `tryPromise` with an explicit `catch` that passes the error THROUGH, not
    // the bare form. `NoLiveRunError` is a declared refusal the settle core
    // raises on purpose (juspay/odu#49) and whose MESSAGE is the contract —
    // surface-mcp renders a failure as an `isError` result carrying that text.
    // The bare `tryPromise` wraps a rejection in `Cause.UnknownError`, which
    // swaps the loud "no run in progress in this checkout" for a generic string
    // and silently guts the refusal. (`Effect.promise` would be worse still: a
    // defect, escaping as a protocol error rather than a tool result.)
    handler: (args, client, signal) =>
      Effect.tryPromise({
        catch: (e) => e,
        try: () => {
          const a = args as WaitInput;
          // A named `checkout` switches the wait from the server-wired client
          // (the HOME checkout's projection) to a per-call reader that dials
          // and reads THAT checkout (./checkout.ts): its socket for the live
          // stream, its `.ci` for the durable-file fallback and the refusal's
          // path text. The settle core and its policies are untouched — only
          // the addressing (client, socket path, run context) bends, so the
          // shared policy tail is built once and both forks spread it.
          //
          // The two wirings are NOT interchangeable, and that is deliberate:
          // the named fork's reader (`agentReaderForSocket`) is CLI `odu
          // wait`'s own and keeps the upstream stream failure, while the
          // default fork's is the projection's B-client, whose `deriveStream`
          // `orDie`s a transport death into a defect — different error
          // channel, classified by the core's `isDeadTransportError` either
          // way (this asymmetry is agentSurface.ts's documented pairing).
          // `clientForCheckout` is NOT used here so the home path keeps its
          // established wiring: a future "unify on clientForCheckout" would
          // silently swap that defect handling — decide it, don't sed it.
          const policy = {
            timeoutMs: a.timeout_ms,
            failFast: a.fail_fast,
            expectedSha: a.expected_sha,
            signal,
          };
          if (a.checkout !== undefined) {
            const socketPath = runSocketPath(a.checkout);
            return waitForSettle({
              ...policy,
              client: agentReaderForSocket(socketPath),
              socketPath,
              resolveRunContext: gitRunContextFor(a.checkout),
            });
          }
          return waitForSettle({
            ...policy,
            client: client as AgentNodesReader,
            resolveRunContext,
          });
        },
      }),
  };
}
