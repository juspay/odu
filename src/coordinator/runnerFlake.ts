/**
 * Where the GENERIC lane runner (`odu-runner`) comes from.
 *
 * The runner is odu's own tsx wrapper + a fixed toolchain — it carries none of
 * the repo-under-test's code — so it is resolved from odu's OWN flake, never
 * from the consumer's. The `odu` wrapper bakes `ODU_RUNNER_FLAKE` = odu's
 * `self.outPath` at build time (default.nix); `--runner-flake` overrides it to
 * pin or fork a runner.
 *
 * There is deliberately NO fallback to the repo under test: a coordinator that
 * carries neither knob is misbuilt (a raw `tsx src/cli/main.ts`, or a non-flake
 * `nix-build`), and resolving the runner from the consumer's flake is exactly
 * the silent failure this indirection exists to remove. So we refuse loudly.
 */
export function resolveRunnerFlake(
  runnerFlake: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const flake = runnerFlake ?? env.ODU_RUNNER_FLAKE;
  if (flake === undefined || flake === "") {
    throw new Error(
      "odu: no runner flake — the coordinator resolves the lane runner from " +
        "odu's own flake, baked as ODU_RUNNER_FLAKE into the `odu` wrapper at " +
        "build time. This binary carries none (a raw `tsx src/cli/main.ts`, or " +
        "a non-flake `nix-build`). Pass `--runner-flake <ref>` or set " +
        "ODU_RUNNER_FLAKE (e.g. `github:juspay/odu`, or `path:$PWD` in an odu " +
        "checkout).",
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
    `odu resolves the lane runner from this flake (--runner-flake / ` +
    `ODU_RUNNER_FLAKE), not the repo under test. Point it at a flake that ` +
    `exports odu-runner (e.g. github:juspay/odu).`
  );
}
