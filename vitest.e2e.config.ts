import { defineConfig } from "vitest/config";

// E2E suite: spawns the nix-built `odu` binary against throwaway fixture repos
// (see tests/e2e/README.md). Kept separate from the unit config so
// `pnpm test:unit` stays fast and hermetic — this suite shells out to `nix`
// and `git` and is wired into CI as its own `e2e` step.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // A cold `nix build` of odu dominates the first run; per-test specs add
    // their own tighter timeouts on top.
    testTimeout: 300_000,
    hookTimeout: 600_000,
    // The whole suite shares one built binary and spawns real subprocesses;
    // running files in parallel would race on the build and the nix store.
    fileParallelism: false,
  },
});
