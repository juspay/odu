import { workerCount } from "./support/parallelism.js";

const parallel = workerCount();

// Only set default paths when no feature file was passed on the CLI. A profile
// that hardcodes `paths` silently wins over the positional argument, so
// `… cucumber.js features/logs.feature` would run the whole suite instead —
// broadening the run in exactly the case where a person is narrowing it. The
// line-targeted form (`foo.feature:42`) is matched too, for the same reason.
const cliHasFeatureArgs = process.argv
  .slice(2)
  .some((a) => /\.feature(?::\d+)*$/.test(a));

const tags = process.env.CUCUMBER_TAGS || "not @skip";

const retry = parseInt(process.env.CUCUMBER_RETRY || "0", 10);

export const ui = {
  ...(!cliHasFeatureArgs && {
    paths: ["features/**/*.feature", "../*/e2e/features/**/*.feature"],
  }),
  import: [
    "step_definitions/**/*.ts",
    "../*/e2e/steps/**/*.ts",
    "support/**/*.ts",
  ],
  tags,
  format: ["progress-bar", "pretty:/dev/stderr"],
  formatOptions: { snippetInterface: "async-await" },
  ...(parallel > 1 && { parallel }),
  ...(retry > 0 && { retry }),
};

export default {};
