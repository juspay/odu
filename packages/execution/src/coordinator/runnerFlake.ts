/**
 * Where the GENERIC lane runner (`odu-runner`) comes from.
 *
 * The runner is odu's own bun wrapper + a fixed toolchain — it carries none of
 * the repo-under-test's code — so it is resolved from odu's OWN flake, never
 * the consumer's. The `odu` wrapper bakes `ODU_RUNNER_FLAKE` = odu's
 * `self.outPath` at build time (default.nix), and that is the SINGLE source: the
 * coordinator and the runner share an RPC contract (`laneSurface`), so the
 * runner must be the exact build that shipped the coordinator. There is no
 * override — "use a different runner" means "run a different odu"; pointing one
 * odu at another's runner is a version-skew footgun, not a feature.
 *
 * Venue lease dials the same agent (surface-remote + `lease.*` procedures);
 * pool claim/probe and lane CI share this resolution path.
 *
 * There is deliberately NO fallback either: a coordinator that carries no baked
 * flake is misbuilt (a raw `bun src/main.ts`, or a non-flake `nix-build`),
 * and resolving the runner from the consumer's flake is exactly the silent
 * failure this indirection exists to remove. So we refuse loudly.
 */

import { execFile } from "node:child_process";
import {
  type AgentBinaryCache,
  agentBinaryCache,
  type AgentDerivation,
  directAgentDerivation,
  type SshConnectorOptions,
} from "@kolu/surface-remote";
import type { SurfaceSpec } from "@kolu/surface/define";

export type ResolveRunnerDrv =
  SshConnectorOptions<SurfaceSpec>["resolveDrvPath"];

const PROCESS_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Run a coordinator-side helper without blocking Effect/OpenTUI's event loop.
 * Setup progress, socket RPC and the live spinner all share that thread; a
 * `spawnSync("nix", …)` here made every cold-host resolver pause all three. */
export function captureProcess(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf-8", maxBuffer: PROCESS_OUTPUT_LIMIT },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function resolveRunnerFlake(env: NodeJS.ProcessEnv): string {
  const flake = env.ODU_RUNNER_FLAKE;
  if (flake === undefined || flake === "") {
    throw new Error(
      "odu: ODU_RUNNER_FLAKE is unset — the coordinator resolves the lane " +
        "runner from odu's own flake, baked onto the `odu` wrapper at build " +
        "time. This binary carries none (a raw `bun src/main.ts`, or a " +
        "non-flake `nix-build`). Set ODU_RUNNER_FLAKE to an odu flake " +
        "(`github:juspay/odu`, or `git+file://$PWD` in an odu checkout).",
    );
  }
  return flake;
}

/**
 * Where the runner's closure may be prefetched from (kolu#2018).
 *
 * surface-remote's provisioning copies the agent's OUTPUT closure into the
 * coordinator's local store before shipping it to the lane host, because a
 * declared substituter can only act in the local store — a remote-store
 * realisation substitutes with the far daemon's own nix.conf, and the cold
 * build ships only the `.drv` closure. So the caches odu trusts have to travel
 * with the derivation, and `directAgentDerivation` makes that REQUIRED rather
 * than opt-in: there is no cache-blind arm to accidentally construct.
 *
 * Baked onto the `odu` wrapper from `nix/binary-cache.nix` (default.nix), the
 * same way `ODU_RUNNER_FLAKE` is, and for the same reason: the values are one
 * fact odu's flake already states in its `nixConfig`, and hand-writing them in
 * TypeScript would be a second authority that drifts silently. No fallback and
 * no override — a coordinator built without them is misbuilt, and the honest
 * response to a misbuilt binary is to refuse.
 */
export function resolveAgentBinaryCache(
  env: NodeJS.ProcessEnv,
): AgentBinaryCache {
  const substituters = splitList(env.ODU_AGENT_SUBSTITUTERS);
  const trustedPublicKeys = splitList(env.ODU_AGENT_TRUSTED_PUBLIC_KEYS);
  if (substituters.length === 0 || trustedPublicKeys.length === 0) {
    throw new Error(
      "odu: ODU_AGENT_SUBSTITUTERS / ODU_AGENT_TRUSTED_PUBLIC_KEYS are unset " +
        "— the coordinator prefetches the lane runner's closure from odu's own " +
        "binary cache, baked onto the `odu` wrapper at build time from " +
        "nix/binary-cache.nix. This binary carries none (a raw " +
        "`bun src/main.ts`, or a non-flake `nix-build`), and provisioning " +
        "refuses to run cache-blind.",
    );
  }
  return agentBinaryCache({ substituters, trustedPublicKeys });
}

/** Nix's own spelling for these settings is a space-separated list, so the
 *  baked env vars use it too — one format across the flake and the wrapper. */
function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(/\s+/).filter((s) => s !== "");
}

/**
 * A directed message for the common `resolveDrvPath` miss: the runner flake
 * resolved, but doesn't export `odu-runner` (for this platform). Returns null
 * for any other nix failure (network, a broken/absent flake) so the caller
 * surfaces the raw stderr and never masks unrelated breakage. Keyed off nix's
 * missing-attribute wording — the only attribute we ever evaluate against the
 * runner flake is `odu-runner`, so a missing-attribute error is necessarily
 * about it.
 */
export function missingRunnerError(
  runnerFlake: string,
  platform: string,
  stderr: string,
): string | null {
  if (!/does not provide attribute|attribute .* missing/i.test(stderr)) {
    return null;
  }
  return (
    `${runnerFlake} does not export packages.${platform}.odu-runner — ` +
    `ODU_RUNNER_FLAKE must point at an odu flake (it is baked onto the binary ` +
    `from odu's own source; in a dev checkout, git+file://$PWD).`
  );
}

/**
 * Evaluate `packages.<platform>.odu-runner.drvPath` from the runner flake.
 * Shared by venue lease (claim/probe) and lane start — one agent, one drv.
 */
export async function evalOduRunnerDrv(
  runnerFlake: string,
  platform: string,
  binaryCache: AgentBinaryCache = resolveAgentBinaryCache(process.env),
): Promise<AgentDerivation> {
  const attr = `${runnerFlake}#packages.${platform}.odu-runner.drvPath`;
  try {
    const result = await captureProcess("nix", [
      "eval",
      "--raw",
      "--accept-flake-config",
      attr,
    ]);
    return directAgentDerivation(result.stdout.trim(), binaryCache);
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : error instanceof Error
          ? error.message
          : String(error);
    const directed = missingRunnerError(
      runnerFlake,
      platform,
      stderr,
    );
    if (directed !== null) throw new Error(directed);
    throw new Error(`nix eval odu-runner drv failed:\n${stderr}`);
  }
}

/** Bind one platform's runner evaluation to surface-remote's dial contract.
 *  The binary cache is resolved ONCE here rather than per dial: it is a
 *  property of this build, and reading it at bind time means a misbuilt
 *  coordinator refuses before it starts spawning ssh sessions. */
export function runnerDrvResolver(
  runnerFlake: string,
  platform: string,
): ResolveRunnerDrv {
  const binaryCache = resolveAgentBinaryCache(process.env);
  let resolved: Promise<AgentDerivation> | undefined;
  return () => {
    resolved ??= evalOduRunnerDrv(runnerFlake, platform, binaryCache);
    return resolved;
  };
}
