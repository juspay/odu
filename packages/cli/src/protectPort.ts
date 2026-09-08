/**
 * BRANCH PROTECTION, for the service.
 *
 * `./protect` owns the decision — which contexts the DAG produces, which
 * ruleset governs the branch, and what to do when there is none. This module is
 * only the seam that hands that decision to the daemon, and it is thin on
 * purpose: a port that reshaped the answer would be a second protect policy,
 * and the whole point of the shared authority is that there is one.
 *
 * On the daemon spending the operator's `gh` credential — it is not a new
 * exposure, and the reasoning is written down at the top of `./protect`. The
 * mechanical half of it is in `coordinator/spawn.ts`: `gh` has to RESOLVE
 * inside the daemon, which is what `GH_TOKEN` / `GH_HOST` / `GH_CONFIG_DIR` on
 * `ODU_CHILD_ENV_KEYS` are for.
 */

import { applyProtection } from "./protect";
import type { RulesetWriter } from "@odu/service/ports";

/** Set a branch's required status checks to exactly the contexts odu posts. */
export const protectBranch: RulesetWriter = (request) =>
  applyProtection({
    checkout: request.checkout,
    // ABSENT, not `undefined`: `branch` absent means "resolve the repo's default
    // branch through gh", and that is a different request from one naming a
    // branch — spelling it `undefined` would read as the second in the shape of
    // the first.
    ...(request.branch === undefined ? {} : { branch: request.branch }),
    platforms: request.platforms,
    hostsFile: request.hostsFile,
    dryRun: request.dryRun,
    create: request.create,
  });
