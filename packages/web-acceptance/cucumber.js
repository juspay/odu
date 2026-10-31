/**
 * Cucumber profiles. `--profile ui` is the only one: every feature here drives a
 * real browser against a real, nix-built odu, which is the whole point of the
 * package.
 *
 * Everything below is a knob rather than a constant because one profile serves
 * four callers — a laptop running one feature, `just web-acceptance` running all
 * of them, a CI leg on two platforms, and a person re-running the one scenario
 * that just went red.
 */

import { workerCount } from "./support/parallelism.js";

// Unset: derived from the machine. `CUCUMBER_PARALLEL` is the override,
// including `=1` for a serial run. See support/parallelism.js for the cap and
// why it is lower here than in a suite whose worker is only a browser.
const parallel = workerCount();

// Only set default paths when no feature file was passed on the CLI. A profile
// that hardcodes `paths` silently wins over the positional argument, so
// `… cucumber.js features/logs.feature` would run the whole suite instead —
// broadening the run in exactly the case where a person is narrowing it. The
// line-targeted form (`foo.feature:42`) is matched too, for the same reason.
const cliHasFeatureArgs = process.argv
  .slice(2)
  .some((a) => /\.feature(?::\d+)*$/.test(a));

// CUCUMBER_TAGS REPLACES this rather than adding to it. There is deliberately
// no `@skip` in this suite — a browser gate that can be marked away is the
// finding this package exists to close — so the default expression exists only
// so the knob has a shape a person can extend.
//
// `@seam` is NOT a skip: it marks a scenario whose promise needs kolu's
// `SurfaceAppConnection.close` to be live (PR #2330 — odu calls it already and
// needs the re-pin). The TODO is in `packages/host/src/principal.ts`, the e2e
// README and PLAN.md, and the scenario itself is complete — remove the tag at
// the re-pin.
const tags = process.env.CUCUMBER_TAGS || "not @skip and not @seam";

// Scenario retry budget. OFF by default, and off in CI too unless somebody sets
// it: a retry that hides a reproducible failure is worse than a red run, and
// these scenarios drive real coordinators whose failures are usually real.
const retry = parseInt(process.env.CUCUMBER_RETRY || "0", 10);

export const ui = {
  // THE PROFILE'S DEFAULT PATHS, which is two trees: this package's own
  // features (the shell, the wire, the keyboard) and every row's
  // `e2e/features` beside it. A feature passed on the CLI still narrows the
  // run — `cliHasFeatureArgs` above is why this entry is conditional.
  ...(!cliHasFeatureArgs && {
    paths: ["features/**/*.feature", "../*/e2e/features/**/*.feature"],
  }),
  // THE STEPS ARE ALWAYS ALL OF THEM, feature argument or not: a step is a
  // global vocabulary entry, and `board.feature` says "the row is shown"
  // whoever owns the row that draws it.
  import: [
    "step_definitions/**/*.ts",
    "../*/e2e/steps/**/*.ts",
    "support/**/*.ts",
  ],
  tags,
  // progress-bar (stdout): how far along the run is.
  // pretty (stderr): the failing step, inline, the moment it fails — so a CI log
  // read from the top says what broke without scrolling to a summary.
  format: ["progress-bar", "pretty:/dev/stderr"],
  formatOptions: { snippetInterface: "async-await" },
  ...(parallel > 1 && { parallel }),
  ...(retry > 0 && { retry }),
};

export default {};
