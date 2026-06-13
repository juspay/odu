/**
 * Where the GENERIC lane runner (`odu-runner`) comes from.
 *
 * The runner is odu's own tsx wrapper + a fixed toolchain — it carries none of
 * the repo-under-test's code — so it is resolved from odu's OWN flake, never
 * the consumer's. The `odu` wrapper bakes `ODU_RUNNER_FLAKE` = odu's
 * `self.outPath` at build time (default.nix), and that is the SINGLE source: the
 * coordinator and the runner share an RPC contract (`laneSurface`), so the
 * runner must be the exact build that shipped the coordinator. There is no
 * override — "use a different runner" means "run a different odu"; pointing one
 * odu at another's runner is a version-skew footgun, not a feature.
 *
 * There is deliberately NO fallback either: a coordinator that carries no baked
 * flake is misbuilt (a raw `tsx src/cli/main.ts`, or a non-flake `nix-build`),
 * and resolving the runner from the consumer's flake is exactly the silent
 * failure this indirection exists to remove. So we refuse loudly.
 */
export function resolveRunnerFlake(env: NodeJS.ProcessEnv): string {
  const flake = env.ODU_RUNNER_FLAKE;
  if (flake === undefined || flake === "") {
    throw new Error(
      "odu: ODU_RUNNER_FLAKE is unset — the coordinator resolves the lane " +
        "runner from odu's own flake, baked onto the `odu` wrapper at build " +
        "time. This binary carries none (a raw `tsx src/cli/main.ts`, or a " +
        "non-flake `nix-build`). Set ODU_RUNNER_FLAKE to an odu flake " +
        "(`github:juspay/odu`, or `git+file://$PWD` in an odu checkout).",
    );
  }
  return flake;
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
