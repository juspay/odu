/**
 * Where the GENERIC lane runner (`odu-runner`) comes from.
 *
 * The runner is odu's own bun wrapper + a fixed toolchain — it carries none of
 * the repo-under-test's code — so it is resolved from odu's OWN agent source,
 * never the consumer's. `default.nix` assembles that source with the pinned
 * kolu's `mkAgentSourceTree` and bakes its store path onto the `odu` wrapper as
 * `SURFACE_AGENT_FLAKE_REF`; this module is the read side of that bake, and the
 * `resolveDrvPath` every dial hands `sshConnector`. Venue lease dials the same
 * agent (surface-remote + `lease.*` procedures); pool claim/probe and lane CI
 * share this resolution path.
 *
 * WHAT THE FRAMEWORK TOOK OVER, and why this file is now two functions.
 * odu used to evaluate `packages.<platform>.odu-runner.drvPath` itself — a
 * hand-rolled `nix eval` wrapped by `directAgentDerivation` — which forced odu
 * to also bake `ODU_RUNNER_FLAKE` and to spell a binary cache
 * (`ODU_AGENT_SUBSTITUTERS` / `ODU_AGENT_TRUSTED_PUBLIC_KEYS`, kept honest
 * against the flake's `nixConfig` by `nix/binary-cache.nix`). kolu#2294 moved
 * both halves into `@kolu/surface-remote`: `ctx.resolveAgentDrv(source, attr)`
 * probes the DIALED host's Nix and evaluates from the source this wrapper baked,
 * and the published-closure lookup (`ProvisionOptions.published`) rides beside
 * it, derived from the same declaration — the host's own Nix version, per dial.
 * So odu keeps no derivation memo of its own: one resolved against a first host
 * would be handed to a second whose Nix form differs (content-addressed versus
 * signed is a property of the host, not of the build).
 *
 * There is deliberately NO fallback either: a coordinator that carries no baked
 * source is a MISBUILT PACKAGE (a non-flake `nix-build`), and resolving the
 * runner from the consumer's flake is exactly the silent failure this
 * indirection exists to remove. Both entries below refuse through the
 * framework's own typed `AgentSourceUnbakedError`.
 */

import {
  readBakedAgentSource,
  resolveBakedAgentDrv,
  type SshConnectorOptions,
} from "@kolu/surface-remote";
import type { SurfaceSpec } from "@kolu/surface/define";

export type ResolveRunnerDrv =
  SshConnectorOptions<SurfaceSpec>["resolveDrvPath"];

/** The attr odu's agent source exposes the lane runner under. */
const RUNNER_ATTR = "odu-runner";

/**
 * The source flake baked onto the `odu` wrapper, or a refusal.
 *
 * Call it BEFORE a run has done anything it would have to abandon — a worktree
 * snapshot, a socket, a pinned HEAD — so a misbuilt binary refuses instantly
 * rather than after side effects. The same read happens again per dial inside
 * {@link laneRunnerDrvPath}; it is an environment read, and the per-dial one is
 * the framework's, not a second authority.
 */
export function requireBakedRunnerSource(): string {
  const source = readBakedAgentSource();
  if (source.isErr()) throw source.error;
  return source.value;
}

/**
 * odu's routing as a value: surface-remote's dial contract, bound to the attr
 * this repo's agent source exposes.
 *
 * The framework probes the dialed host, evaluates
 * `packages.<that host's system>.odu-runner` from the baked source, and hands
 * back the published lookup for that same host. Nothing is memoised here — the
 * framework's own cache is keyed by installable, so a repeated dial of one
 * platform still evaluates once.
 */
export const laneRunnerDrvPath: ResolveRunnerDrv = (ctx) =>
  resolveBakedAgentDrv(RUNNER_ATTR, ctx);
