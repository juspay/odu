/**
 * The `node_rerun` bespoke MCP tool — restart one node (and its dependents) on
 * the run that is still live.
 *
 * IT IS BESPOKE FOR ONE REASON: A DESCRIPTION. The verb itself is `node.rerun`
 * on the projected agent surface and always has been, and `expose` could
 * publish it as a tool in one line — but `ToolExposure` (`@kolu/surface/expose`)
 * is `"tool" | { tool: { mutates?: boolean } }` and has no slot for prose, so a
 * procedure-exposed tool reaches a host with `description: undefined` by
 * construction. surface-mcp says so where it builds the advertisement: "`title`
 * and `description` are bespoke-only TODAY because `ToolExposure` has no field
 * for either — a gap in the consumer's authoring map".
 *
 * That gap is not cosmetic here, because of WHICH verb fell into it. An agent
 * reading odu's tool surface saw `node_rerun` as a bare `id` parameter with no
 * hint of what it was for, while `run` — described, and offering `supersede`
 * prominently — reads like the way to have another go. So the cheap, correct,
 * non-destructive operation was invisible and the expensive destructive one was
 * documented, and an agent reasoned its way into throwing away a running darwin
 * lane to retry a flaky linux one. A person had to correct it.
 *
 * So `node_rerun` comes through the door that carries words. The name, the
 * input (`{ id }`) and the behaviour are unchanged — this is the same
 * `node.rerun` call an agent was already making, with the sentence it needed
 * attached. `node_cancel` / `lane_cancel` went bespoke later, for a different
 * axis: an exposed procedure's input is the A-side wire shape, so it can
 * never carry a per-call `checkout` — see partialCancelTools.ts.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { Effect, Schema } from "effect";
import { runSocketPath } from "@odu/run-client/dial";
import { dialAFor, redialingAClient } from "./agentSurface";
import { checkoutField } from "./checkout";

export const rerunInput = Schema.Struct({
  checkout: checkoutField,
  // `.describe` on the FIELD is an annotation, which is what a host shows an
  // agent about an argument — the JSDoc above a field is not (see `waitInput`'s
  // `expected_sha`). This is the one that was blank.
  id: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "The fan-in node id to restart, exactly as the `nodes` resource and a " +
      "wait verdict spell it: `<recipe>@<platform>`, e.g. " +
      "`ci::e2e@x86_64-linux`. One node — the whole lane is not a node id.",
  }),
});
export type RerunInput = typeof rerunInput.Type;

/** The A-side procedure this forwards to, through the projected B client the
 *  face hands the handler. Narrow on purpose: a bespoke handler is given the
 *  consumer's own client as `any`, and naming the one member it calls is what
 *  keeps that `any` from spreading past this line. */
interface RerunClient {
  surface: {
    node: { rerun: (input: { id: string }) => Effect.Effect<{ ok: boolean }> };
  };
}

/** Restart one node on the live run. Mutating: it resets node state and puts
 *  work back on a lane. Typed as the loose `BespokeTool` (the package's `tools`
 *  slot is invariant in the input type); `input` validates, handler narrows. */
export const rerunTool: BespokeTool = {
  description:
    "Re-run ONE node on the run that is still live, and only its transitive " +
    "dependents with it. THIS is how you retry a single failed or flaky lane: " +
    "it works mid-run, alongside the sibling lanes, and cancels nothing — the " +
    "other platforms keep going and the run keeps its coordinator, its venue " +
    "leases and its GitHub statuses. Reach for it the moment `wait_for_settle` " +
    "fail-fasts on a red node: read that node's log, fix the source, " +
    "`node_rerun` that node, `wait_for_settle` again. Do NOT reach for " +
    "`run({supersede: true})` to retry a lane — that cancels the whole run and " +
    "throws away every other lane's work; it is for replacing a run with a " +
    "different commit. Ids are `<recipe>@<platform>` (`ci::e2e@x86_64-linux`), " +
    "as the `nodes` resource spells them. Returns `{ok}`: false means there " +
    "was no live run to rerun on — start one with `run`, or use `run({linger: " +
    "true})` next time so the coordinator outlives settle and a node can be " +
    "rerun afterwards. Targets `checkout`, defaulting to this server's own " +
    "working directory.",
  input: rerunInput,
  mutates: true,
  // The default path is just the upstream call through the face's projected
  // client — both sides are Effects, so there is no lift and no
  // `Effect.promise` (which over an already-Effect value would succeed with the
  // Effect object rather than the result). Interruption reaches the call
  // through the face's own request scope, so the `signal` parameter is ignored.
  //
  // A named `checkout` dials THAT checkout per call instead (./checkout.ts) —
  // the same `redialingAClient` the face is wired with, whose re-dial already
  // happens per call; only the path becomes a function of the input. The
  // A-side procedure takes `{ id }` exactly — the call is narrowed, the whole
  // input struct is never forwarded.
  handler: (args, client) => {
    const a = args as RerunInput;
    if (a.checkout === undefined) {
      return (client as RerunClient).surface.node.rerun(a);
    }
    return redialingAClient(dialAFor(runSocketPath(a.checkout))).surface.node.rerun({
      id: a.id,
    });
  },
};
