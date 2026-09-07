/**
 * Lifecycle: one browser and one service per worker, one fresh context and page
 * per scenario.
 *
 * ## The browser is REQUIRED, and that is the whole point
 *
 * odu's previous browser coverage skipped itself where no browser was on PATH —
 * so on a CI runner it silently graded nothing, and the one environment where a
 * regression would be caught by somebody other than its author was the one
 * environment that never checked. This suite has no skip in it. If the browsers
 * are not there, {@link BeforeAll} throws once, before the first scenario, with
 * the sentence that gets them.
 *
 * ## The two gates, and why the second one exists
 *
 * The first gate is the browsers themselves: `PLAYWRIGHT_BROWSERS_PATH`, set by
 * the `e2e` devShell (`flake.nix`), which points at `pkgs.playwright-driver.browsers`.
 *
 * The second is the VERSION MATCH between the npm `playwright` package and that
 * nixpkgs driver, and it exists because nothing else enforces it. The npm side
 * ships only the driver's JavaScript; the browser binaries come from the Nix
 * store, and the driver refuses a build it was not compiled against. A drift
 * installs cleanly, typechecks cleanly, and then fails at `chromium.launch()`
 * with `Executable doesn't exist` naming a store path that IS there — the least
 * legible failure in the whole stack, reached minutes into a lane. Comparing two
 * strings before anything launches turns it into a sentence that names both
 * numbers and says to move them together.
 *
 * ## Isolation is by context, not by browser
 *
 * `After` closes the CONTEXT: storage, cookies and any in-flight WebSocket go
 * with it, so the next scenario's first frame is a genuine cold load. Closing
 * the browser instead would pay a launch per scenario for the same property.
 *
 * ## Teardown order
 *
 * `AfterAll` stops the service BEFORE closing the browser. A Chromium still
 * holding a socket to a live daemon is a `close()` that never returns, and
 * cucumber then never reaches its summary — a hung leg rather than a red one.
 */

import { After, AfterAll, Before, BeforeAll, setDefaultTimeout, Status } from "@cucumber/cucumber";
import { chromium, type Browser } from "playwright";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_ARGS } from "./browser.ts";
import { clearCorpus } from "./corpus.ts";
import {
  readOduBin,
  removeFixture,
  startService,
  stopService,
  verb,
  workerPort,
  type Service,
} from "./service.ts";
import { OduWorld, RUN_SETUP_TIMEOUT, STEP_TIMEOUT } from "./world.ts";

setDefaultTimeout(STEP_TIMEOUT);

const HERE = import.meta.dirname;
const REPORTS = join(HERE, "..", "reports");
const workerId = (): string => process.env.CUCUMBER_WORKER_ID ?? "0";

/** A desktop this app was designed for, and the phone-width viewport the
 *  `@narrow` scenarios ask for. 380 px is narrower than the 44 rem breakpoint
 *  `styles.css` reflows the board at, so a scenario tagged `@narrow` is on the
 *  other side of that media query rather than near it. */
const DESKTOP = { width: 1280, height: 900 } as const;
const NARROW = { width: 380, height: 720 } as const;

let browser: Browser | undefined;
let service: Service | undefined;

/** What the npm `playwright` in THIS tree says its version is. Read from the
 *  installed manifest rather than from our own `devDependencies`, because the
 *  question the gate asks is about the code that will run, not about what was
 *  asked for. (`pins.test.ts` asks the other half — that what was asked for is
 *  an exact version and cannot float.) */
function installedPlaywrightVersion(): string {
  const resolve = createRequire(import.meta.url);
  const manifest = JSON.parse(
    readFileSync(resolve.resolve("playwright/package.json"), "utf-8"),
  ) as { version: string };
  return manifest.version;
}

BeforeAll({ timeout: RUN_SETUP_TIMEOUT }, async () => {
  // Once, here, rather than per scenario: an unset ODU_BIN is a setup mistake,
  // and reporting it twenty-six times buries it.
  const odu = readOduBin();

  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers === undefined || browsers === "") {
    throw new Error(
      "PLAYWRIGHT_BROWSERS_PATH is unset. This suite drives a REAL browser and " +
        "never skips: a browser gate that can skip is a gate that grades nothing " +
        "on the machine where it matters most. Get the browsers from nixpkgs — " +
        "`just web-acceptance` does it for you, or enter the shell yourself with " +
        "`nix develop .#e2e --accept-flake-config`.",
    );
  }

  const npm = installedPlaywrightVersion();
  const driver = process.env.PLAYWRIGHT_DRIVER_VERSION;
  if (driver === undefined || driver === "") {
    throw new Error(
      `PLAYWRIGHT_BROWSERS_PATH is set (${browsers}) but PLAYWRIGHT_DRIVER_VERSION is not, ` +
        "so the version match cannot be checked. Both are exported together by the `e2e` " +
        "devShell in flake.nix; a shell that supplies browsers without saying which driver " +
        "built them is a shell this suite will not trust.",
    );
  }
  if (npm !== driver) {
    throw new Error(
      `playwright ${npm} (npm) against playwright-driver ${driver} (nixpkgs). The driver ` +
        "refuses a browser build it was not compiled against, and the way it says so is " +
        "`Executable doesn't exist` at a store path that is real but wrong — minutes into a " +
        "lane, with nothing pointing at the version. Move the two together: set " +
        `packages/web-acceptance/package.json's "playwright" to ${driver}, or move the ` +
        "nixpkgs pin back. Never one without the other.",
    );
  }

  browser = await chromium.launch({
    // `HEADLESS=false` is for a person watching a scenario fail, and is the one
    // knob here that changes what the browser IS rather than where it runs.
    headless: process.env.HEADLESS !== "false",
    args: [...BROWSER_ARGS],
  });
  service = await startService(odu, workerPort());
});

Before({ timeout: RUN_SETUP_TIMEOUT }, async function (this: OduWorld, scenario) {
  if (browser === undefined || service === undefined) {
    throw new Error("web-acceptance: BeforeAll did not complete, so there is nothing to drive");
  }
  this.browser = browser;
  this.service = service;
  this.scenarioName = scenario.pickle.name;

  const narrow = scenario.pickle.tags.some((tag) => tag.name === "@narrow");
  this.context = await browser.newContext({
    viewport: narrow ? { ...NARROW } : { ...DESKTOP },
    baseURL: service.origin,
  });
  this.page = await this.context.newPage();

  this.errors = [];
  this.requests = [];
  this.ownFixtures = [];
  this.ownRuns = [];

  // Registered before the first navigation, because the throw this is here to
  // catch is the app's own boot. A page that renders a plausible board over a
  // client-side exception is exactly what a DOM snapshot cannot tell from a
  // healthy one, and what "there should be no page errors" turns into a failure.
  this.page.on("pageerror", (error) => {
    this.errors.push(`pageerror: ${error.message}\n${error.stack ?? "(no stack)"}`);
  });
  this.page.on("console", (message) => {
    if (message.type() === "error") this.errors.push(`console.error: ${message.text()}`);
  });
  this.page.on("request", (request) => {
    this.requests.push(request.url());
  });
});

After({ timeout: RUN_SETUP_TIMEOUT }, async function (this: OduWorld, scenario) {
  const failed = scenario.result?.status === Status.FAILED;
  // A screenshot of a FAILURE always, because a failure on a CI runner nobody
  // can attach to is otherwise a locator and a timeout. `ODU_WA_SHOTS` adds the
  // passing ones, which is how this suite produces evidence that the browser
  // really drove the page rather than that the assertions merely agreed.
  if (this.page !== undefined && (failed || process.env.ODU_WA_SHOTS === "1")) {
    const slug =
      scenario.pickle.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "scenario";
    const dir = join(REPORTS, "screenshots");
    try {
      mkdirSync(dir, { recursive: true });
      await this.page.screenshot({
        path: join(dir, `${workerId()}-${failed ? "failed" : "passed"}-${slug}.png`),
        fullPage: true,
      });
    } catch (cause) {
      process.stderr.write(`web-acceptance: could not capture a screenshot: ${String(cause)}\n`);
    }
  }

  // The CONTEXT, not the browser — see this file's header.
  if (this.context !== undefined) await this.context.close();

  // A private run goes down before its checkout does: `SLOW` and `FAST_RED` both
  // sleep for minutes, and a coordinator left running holds a core and a lock on
  // a directory this is about to remove.
  for (const runId of this.ownRuns) {
    verb(this.service, "run_cancel", {
      runId,
      scope: { kind: "run" },
      requestId: `wa-teardown-${crypto.randomUUID()}`,
    });
  }
  for (const dir of this.ownFixtures) removeFixture(dir);
});

AfterAll({ timeout: RUN_SETUP_TIMEOUT }, async () => {
  await clearCorpus();
  if (service !== undefined) {
    stopService(service);
    service = undefined;
  }
  if (browser !== undefined) {
    await browser.close();
    browser = undefined;
  }
});
