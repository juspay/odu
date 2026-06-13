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
