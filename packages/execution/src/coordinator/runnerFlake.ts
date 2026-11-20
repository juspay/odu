import {
  readBakedAgentSource,
  resolveBakedAgentDrv,
  type SshConnectorOptions,
} from "@kolu/surface-remote";
import type { SurfaceSpec } from "@kolu/surface/define";

export type ResolveRunnerDrv =
  SshConnectorOptions<SurfaceSpec>["resolveDrvPath"];

const RUNNER_ATTR = "odu-runner";

/**
 * The source flake baked onto the `odu` wrapper, or a refusal.
 */
export function requireBakedRunnerSource(): string {
  const source = readBakedAgentSource();
  if (source.isErr()) throw source.error;
  return source.value;
}

export const laneRunnerDrvPath: ResolveRunnerDrv = (ctx) =>
  resolveBakedAgentDrv(RUNNER_ATTR, ctx);
