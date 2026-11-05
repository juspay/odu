/**
 * GETTING A RUN READY TO PUSH (PLAN 4.1) — resolve, mint, and say what the
 * setup log owes — in one place, for the two callers that launch a run.
 *
 * `run.start` and the REPLAY launcher both do the same five things in the same
 * order: resolve the checkout, deal with ambiguity, mint a grant for the
 * resolved bucket, build the launch's `push`, and hand the token back when the
 * launch fails. Written twice, they had already drifted — one of them handled
 * a bucket that disappeared between the resolution and the mint, and the other
 * fell through to printing a trusted-key warning for a run that was pushing
 * nothing.
 *
 * What is NOT here is what *ambiguous* means. A `run.start` refuses two
 * grantable caches, because a repository builds for one; a replay of a
 * recorded run runs without pushing, because a retry must not be refused by a
 * fact about the world that changed after the run it replays. That difference
 * is a policy, it is documented on three surfaces, and it belongs to the
 * caller — so this answers the ambiguity rather than resolving it.
 */

import type { LaunchPush, PushPort } from "./ports";

export type PreparedPush =
  | {
      readonly kind: "prepared";
      /** What the launch carries, or `null` for a run that pushes nothing. */
      readonly push: LaunchPush | null;
      /** WHY nothing is pushed. Null when something is. */
      readonly skipped: string | null;
      /** What is wrong while something IS pushed — the bucket's key missing
       *  from the repository's `trusted-public-keys`. Null when there is
       *  nothing to say, and never set at the same time as `skipped`: they
       *  describe opposite states, which is why they are two fields. */
      readonly keyWarning: string | null;
    }
  /** Two caches this daemon serves. The CALLER decides what that means. */
  | { readonly kind: "ambiguous"; readonly substituters: readonly string[] };

export async function preparePush(
  port: PushPort,
  checkout: string,
  runId: string,
): Promise<PreparedPush> {
  const resolved = await port.resolve(checkout);
  if (resolved.kind === "ambiguous") {
    return { kind: "ambiguous", substituters: resolved.substituters };
  }
  if (resolved.kind === "skipped") {
    return { kind: "prepared", push: null, skipped: resolved.reason, keyWarning: null };
  }
  const target = resolved.target;
  const granted = port.grant({ bucket: target.bucket, runId });
  if (granted === null) {
    // THE BUCKET WENT AWAY between the resolution and the mint — deleted by an
    // operator in that window. Nothing is pushed, and the reason is this
    // rather than the resolution's (which found it, and was right to).
    return {
      kind: "prepared",
      push: null,
      skipped: `the bucket "${target.bucket}" is no longer served here`,
      keyWarning: null,
    };
  }
  return {
    kind: "prepared",
    push: {
      substituter: target.substituter,
      origin: target.origin,
      bucket: target.bucket,
      tokenId: granted.tokenId,
      token: granted.token,
    },
    skipped: null,
    keyWarning: target.keyWarning,
  };
}
