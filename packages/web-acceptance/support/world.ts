/**
 * The typed World — what every step has, and nothing else.
 *
 * Deliberately small. It holds the two handles a step cannot get anywhere else
 * (the page, and the service the page is talking to), the two LEDGERS a step
 * asserts over afterwards (page errors, requests), the bookkeeping a scenario's
 * teardown needs, and locators for the four elements almost every feature names.
 * Everything else belongs in a step file, because a World that grows helpers per
 * feature becomes the place where the suite's own logic hides from review.
 *
 * The locator helpers are here rather than inlined for one reason: they encode
 * the app's ACCESSIBLE names and structural classes, and those are a contract
 * with `packages/web-ui`. Written once, a rename there is one failing helper
 * with a clear name rather than nine step files that each stop matching.
 */

import { setWorldConstructor, World } from "@cucumber/cucumber";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import type { Service } from "./service.ts";

/**
 * How long a scenario may spend ARRANGING a run before its first assertion.
 *
 * Generous because arranging one is not cheap: the coordinator evaluates a
 * flake, realises `odu-runner`, claims a localhost lane and runs real recipes.
 * `tests/e2e` gives the same work 300 000–900 000 ms for the same reason. This
 * is not patience for a flake — every wait underneath it is on a STATE the
 * service publishes, never on a duration.
 */
export const RUN_SETUP_TIMEOUT = 600_000;

/** The default step budget: long enough for a page to reconnect or a control's
 *  receipt to come back from a cold coordinator, short enough that a genuinely
 *  stuck scenario reports rather than holds the leg open. */
export const STEP_TIMEOUT = 120_000;

export class OduWorld extends World {
  /** Set in `Before`; a step that runs without them is a hook that threw. */
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  service!: Service;

  /** This scenario's name, copied off the pickle in `Before`. Cucumber does not
   *  put it on the World, and `support/corpus.ts`'s guard is only as useful as
   *  the list of scenarios it can name. */
  scenarioName = "(unnamed scenario)";

  /** The fixture checkout this scenario is about, and the run in it. */
  checkout?: string;
  runId?: string;
  /** The `<sha7>#<seq>` ref the opened run is drawn as. A board row carries no
   *  run id, so this is the only handle for telling two runs of one checkout
   *  apart on the board. */
  runRef?: string;

  /** Checkouts this scenario created and must remove. A SHARED fixture is not
   *  in here — it belongs to the worker, not the scenario. */
  ownFixtures: string[] = [];
  /** Runs this scenario started and must stop, so a `sleep 300` does not
   *  outlive the leg holding a core. */
  ownRuns: string[] = [];

  /** Uncaught page errors and `console.error` output, for the whole scenario.
   *  "There should be no page errors" is the assertion that catches a green UI
   *  drawn over a silent client-side throw — the failure mode a DOM snapshot
   *  cannot see at all. */
  errors: string[] = [];
  /** Every URL the page asked for. */
  requests: string[] = [];

  /** The log key the service minted for the failure this scenario is about,
   *  when a step arranged one. Kept so an assertion about the ADDRESS compares
   *  against the service's own encoding rather than a second one spelled here. */
  failureLogKey?: string;
  /** …and the node id it belongs to. */
  failureNode?: string;

  /** Open a route. The hash IS the app's router, so every navigation in this
   *  suite is an address a person could paste. */
  async open(hash = "#/"): Promise<void> {
    await this.page.goto(new URL(hash, this.service.origin).href);
  }

  /** The connection indicator — `packages/web-ui`'s `.wire`, whose text is the
   *  framework's own five-state readout in odu's words. */
  wire(): Locator {
    return this.page.locator(".wire");
  }

  /** A control's receipt: what a button reported, refusal included. */
  receipt(): Locator {
    return this.page.locator("p.receipt");
  }

  /** One node's row in the run detail. Matched on its visible id, because that
   *  is what a person reading the page would point at. */
  nodeRow(id: string): Locator {
    return this.page.locator("li.node", { hasText: id });
  }

  /** A run row on the board. */
  runRow(text: string): Locator {
    return this.page.locator("button.row", { hasText: text });
  }

  /** Poll until `ask` answers true, or fail naming what was waited for.
   *
   *  Every wait in this suite is on a STATE, never on a duration — a `sleep`
   *  long enough to be reliable on a loaded CI runner is a `sleep` that makes
   *  the suite too slow to run, and one short enough to be fast is a flake. */
  async waitUntil(
    ask: () => Promise<boolean>,
    what: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await ask()) return;
      if (Date.now() > deadline) {
        throw new Error(`web-acceptance: ${what} did not happen within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Wait until `locator` holds `text`, or fail saying what it held INSTEAD.
   *
   * The alternative — `locator.filter({ hasText }).waitFor()` — retries just as
   * well and then reports a timeout on a selector, which on a CI runner nobody
   * can attach to is the whole of what a failure gets to say. Nearly every
   * assertion in this suite is "the page eventually says this", so it is worth
   * one helper to make all of them report the sentence the page actually
   * showed.
   */
  async saysThat(
    locator: Locator,
    what: string,
    text: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    let last = "(nothing — the element was never there)";
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const seen = await locator.first().innerText({ timeout: 1000 });
        if (seen.includes(text)) return;
        last = seen;
      } catch {
        // Not attached yet, or replaced mid-read. Both are ordinary while a
        // live page settles, and neither is an answer — so keep asking.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `web-acceptance: ${what} never said ${JSON.stringify(text)} within ${timeoutMs}ms.\n` +
            `It said: ${JSON.stringify(last)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

setWorldConstructor(OduWorld);
