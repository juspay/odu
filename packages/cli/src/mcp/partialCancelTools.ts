/**
 * The `node_cancel` / `lane_cancel` bespoke MCP tools — stop one node or one
 * platform lane on the run that is still live in a checkout.
 *
 * WHY BESPOKE (they began as `expose`d procedure tools): an exposed tool's
 * input IS the A-side wire shape (`{ id }` / `{ platform }`), by construction
 * — so it can never grow a per-call `checkout`, and the one-server-many-
 * checkouts arrangement (./checkout.ts) needs exactly that. The bespoke slot
 * is the door that carries it: the input struct adds the field, and a named
 * `checkout` dials that checkout per call (the `redialingAClient` the face
 * itself is wired with — its re-dial already happens per call; only the path
 * becomes a function of the input).
 *
 * The verbs and their ids/platforms are unchanged from the exposed era — the
 * same `node.cancel` / `lane.cancel` calls forwarded to the same socket, now
 * per target checkout. Like `node_rerun`, they are the CHEAP operations: one
 * unit of work stops and the rest of the run keeps going (the coordinator
 * stays up; per-node cancel is never a lane drop unless the lane's task set
 * drains). See `coordinator/cancel.ts` for the surface mutation both route to.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { Effect, Schema } from "effect";
import { NodeIdSchema } from "@odu/run-client/nodeId";
import { checkoutField, clientForCheckout } from "./checkout";

export const nodeCancelInput = Schema.Struct({
  checkout: checkoutField,
  id: NodeIdSchema,
});
export type NodeCancelInput = typeof nodeCancelInput.Type;

export const laneCancelInput = Schema.Struct({
  checkout: checkoutField,
  platform: Schema.String.check(Schema.isMinLength(1)),
});
export type LaneCancelInput = typeof laneCancelInput.Type;

/** The two A-side verbs these tools forward: the narrow face slice the
 *  handlers are permitted to see. The `any` the bespoke slot hands in stops
 *  at `clientForCheckout` (./checkout.ts) — this slice is what it narrows to. */
interface DriveClient {
  surface: {
    node: { cancel: (input: { id: string }) => Effect.Effect<{ ok: boolean }> };
    lane: {
      cancel: (input: { platform: string }) => Effect.Effect<{ ok: boolean }>;
    };
  };
}

/** Stop ONE node on the target checkout's live run. Mutating: work comes off
 *  a lane. Typed as the loose `BespokeTool`; `input` validates, handler
 *  narrows. */
export const nodeCancelTool: BespokeTool = {
  description:
    "Cancel ONE node on a checkout's live run: `<recipe>@<platform>`, as the " +
    "`nodes` resource spells it. The rest of the run keeps going — the " +
    "coordinator stays up, the sibling lanes are untouched (to drop a whole " +
    "platform, use `lane_cancel`; to cancel EVERYTHING, use `cancel`). " +
    "Targets `checkout`, defaulting to this server's own working directory.",
  input: nodeCancelInput,
  mutates: true,
  handler: (args, client) => {
    const a = args as NodeCancelInput;
    return clientForCheckout<DriveClient>(a.checkout, client).surface.node.cancel({
      id: a.id,
    });
  },
};

/** Drop ONE platform lane on the target checkout's live run. Mutating: the
 *  lane's work ends and its lease frees; the other platforms keep going. */
export const laneCancelTool: BespokeTool = {
  description:
    "Drop ONE platform lane on a checkout's live run: every node of that " +
    "platform is cancelled and the lane's venue lease frees, while the other " +
    "platforms keep going and the run keeps its coordinator (to cancel the " +
    "WHOLE run, use `cancel`). Targets `checkout`, defaulting to this " +
    "server's own working directory.",
  input: laneCancelInput,
  mutates: true,
  handler: (args, client) => {
    const a = args as LaneCancelInput;
    return clientForCheckout<DriveClient>(a.checkout, client).surface.lane.cancel({
      platform: a.platform,
    });
  },
};
