import { applyProtection } from "./protect";
import type { Forge } from "@odu/execution/common/forge";
import type { RulesetWriter } from "@odu/service/ports";

export const protectBranch = (forge: Forge): RulesetWriter => (request) =>
  applyProtection(
    {
      checkout: request.checkout,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      platforms: request.platforms,
      caller: request.caller,
      dryRun: request.dryRun,
      create: request.create,
    },
    forge,
  );
