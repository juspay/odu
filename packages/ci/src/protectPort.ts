import { applyProtection, previewProtection } from "./protect";
import type { Forge } from "@odu/execution/common/forge";
import type { RulesetWriter } from "@odu/service/ports";

export const protectBranch =
  (forge: Forge): RulesetWriter =>
  async (request) => {
    const args = {
      checkout: request.checkout,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      platforms: request.platforms,
      caller: request.caller,
      create: request.create,
    };
    return request.dryRun
      ? previewProtection(args)
      : await applyProtection(args, forge);
  };
