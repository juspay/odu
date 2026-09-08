/**
 * The argv every Chromium this package launches is launched with.
 *
 * ONE list, because the reason for each flag is about where the browser RUNS and
 * not about what it is being asked to do: under Nix, in a container, on a CI
 * runner with no display and a small `/dev/shm`. Every one of them is
 * load-bearing there and harmless on a laptop, which is why the same argv is
 * used everywhere rather than branched on `CI` — a browser configured
 * differently in CI than on a laptop is a class of bug that only ever
 * reproduces where it is hardest to debug. `--disable-dev-shm-usage` is the one
 * whose absence is quietest: without it a browser on a 64 MB `/dev/shm` dies
 * mid-run, and what the suite reports is a page that stopped answering.
 *
 * It lives in its own module rather than beside the launch in `./hooks.ts`,
 * because importing that module REGISTERS cucumber hooks — a driver that is not
 * the suite cannot reach for the argv without also enrolling itself in a run.
 * This file imports nothing at all, so anything can share it.
 */
export const BROWSER_ARGS: ReadonlyArray<string> = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--headless=new",
];
