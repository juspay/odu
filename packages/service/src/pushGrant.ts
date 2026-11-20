import type { LaunchPush, PushPort } from "./ports";

export type PreparedPush =
  | {
      readonly kind: "prepared";
      readonly push: LaunchPush | null;
      readonly skipped: string | null;
      /** Never set at the same time as `skipped`: they describe opposite
       *  states, which is why they are two fields. */
      readonly keyWarning: string | null;
    }
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
