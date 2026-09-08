/**
 * Reading a node's output: which node, which attempt, which part.
 *
 * The address assertion is the one worth explaining. A log key encodes a run, a
 * node and an attempt through the catalog's own encoding, and this suite does
 * NOT re-implement that encoding to check it — it takes the key the service
 * minted (carried in `run_wait`'s failure) and asserts the browser's address bar
 * holds exactly that string. A step that spelled the key itself would be
 * checking that this file and the browser agree, which is not the claim; the
 * claim is that the address a person copies is the address an agent echoes.
 */

import * as assert from "node:assert";
import { Then, When } from "@cucumber/cucumber";
import type { Locator } from "playwright";
import type { OduWorld } from "../support/world.ts";

function attemptButton(world: OduWorld, label: string): Locator {
  return world.page
    .getByRole("group", { name: "Attempt" })
    .getByRole("button", { name: label, exact: true });
}

When("I open the output of {string}", async function (this: OduWorld, id: string) {
  await this.nodeRow(id).first().locator("button.node-open").click();
});

Then("the output holds {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator("pre.log-text"), "the output panel", text, 60_000);
});

Then("the output does not hold {string}", async function (this: OduWorld, text: string) {
  const said = await this.page.locator("pre.log-text").innerText();
  assert.ok(
    !said.includes(text),
    `the output still holds ${JSON.stringify(text)}, so the window did not move`,
  );
});

Then("the address holds that node's log key", async function (this: OduWorld) {
  const key = this.failureLogKey;
  assert.ok(key !== undefined, "no failure was arranged, so there is no key to compare against");
  await this.waitUntil(
    async () => (await this.page.evaluate(() => location.hash)) === `#/run/${key}`,
    `the address to hold the log key ${key}`,
  );
});

Then("the node {string} is marked current", async function (this: OduWorld, id: string) {
  const classes =
    (await this.nodeRow(id).first().locator("button.node-open").getAttribute("class")) ?? "";
  assert.ok(
    classes.split(/\s+/).includes("node-current"),
    `the node the address names is not the one marked current — its button read "${classes}"`,
  );
});

/** How big is the log, in bytes — the size a person reads off the header.
 *
 *  WAITED FOR, not sampled. The header's text comes from the `logTails`
 *  subscription, so it is empty between the panel opening and the first frame
 *  arriving; a single sample is a race that a quiet laptop wins and a machine
 *  running the rest of CI beside it loses. That is not hypothetical — it is the
 *  one scenario of twenty-six that failed when this suite first ran inside a
 *  full `odu run`, and it failed for the machine's reasons rather than the
 *  page's. What is being waited for is a page STATE, which is the rule every
 *  other wait in this tree already keeps. */
const BYTE_SIZE = /\d+(\.\d+)?\s(B|KiB|MiB)/;

async function logHeader(world: OduWorld): Promise<string> {
  await world.waitUntil(
    async () => BYTE_SIZE.test(await world.page.locator(".log-meta").innerText()),
    "the output header to state a byte size",
  );
  return await world.page.locator(".log-meta").innerText();
}

/** TWO facts, and this asserts the first: how much output there is. A panel that
 *  said nothing about size would leave "the recipe was quiet" and "the evidence
 *  is truncated" looking identical. */
Then("the output header states a byte size", async function (this: OduWorld) {
  const meta = await logHeader(this);
  assert.match(
    meta,
    BYTE_SIZE,
    `the output header states no byte size — it read ${JSON.stringify(meta)}`,
  );
});

/** The absence of the incompleteness notice — asserted only once the header has
 *  SOMETHING to say.
 *
 *  Sampling immediately made this pass for the wrong reason: an empty header
 *  contains no substring, so the assertion held before the panel had rendered
 *  anything at all. A check that cannot fail while the thing it describes is
 *  still loading is not checking the thing. */
Then("the output header does not say {string}", async function (this: OduWorld, text: string) {
  const meta = await logHeader(this);
  assert.ok(
    !meta.includes(text),
    `the output header said ${JSON.stringify(text)}: ${JSON.stringify(meta)}`,
  );
});

// ── paging ──────────────────────────────────────────────────────────────────

/** The window indicator reads `<from>–<to> of <total>`. Kept as the raw string
 *  rather than parsed into numbers, because what a scenario claims is that a
 *  person can SEE where they are. */
async function window(world: OduWorld): Promise<string> {
  return await world.page.locator(".log-page").innerText();
}

Then("the page window starts at {string}", async function (this: OduWorld, at: string) {
  await this.waitUntil(
    async () => (await window(this)).startsWith(`${at}–`),
    `the page window to start at ${at}`,
  );
});

Then("the page window has moved forward", async function (this: OduWorld) {
  await this.waitUntil(
    async () => !(await window(this)).startsWith("0 B–"),
    "the page window to move off the first page",
  );
});

// ── attempts ────────────────────────────────────────────────────────────────

Then(
  "the attempt picker offers {string} and {string}",
  async function (this: OduWorld, first: string, second: string) {
    for (const label of [first, second]) {
      await attemptButton(this, label).waitFor({ timeout: 30_000 });
    }
  },
);

/** WHICH attempt is being read, announced in the DOM. A picker that only
 *  highlighted the chosen one would be telling a sighted person something it
 *  told nobody else — and would give this scenario nothing to assert on but a
 *  colour. */
Then("{string} is the chosen attempt", async function (this: OduWorld, label: string) {
  try {
    await this.waitUntil(
      async () => (await attemptButton(this, label).getAttribute("aria-pressed")) === "true",
      `"${label}" to be announced as the chosen attempt`,
    );
  } catch (cause) {
    // The picker's whole state is three short elements, so printing it beats
    // a timeout on a locator: "which one DOES claim to be pressed" is the
    // question the failure raises and this is the only chance to answer it.
    const markup = await this.page
      .getByRole("group", { name: "Attempt" })
      .innerHTML()
      .catch(() => "(no attempt picker on the page at all)");
    const hash = await this.page.evaluate(() => location.hash);
    throw new Error(`${String(cause)}\nThe address is ${hash} and the picker is:\n${markup}`);
  }
});

When("I choose {string}", async function (this: OduWorld, label: string) {
  await attemptButton(this, label).click();
});

Then("the address names attempt {int}", async function (this: OduWorld, attempt: number) {
  await this.waitUntil(
    async () => (await this.page.evaluate(() => location.hash)).endsWith(`/${attempt}`),
    `the address to end at attempt ${attempt}`,
  );
});

/**
 * NO LINE TWICE. A follow that resumes has to resume from its cursor, and a
 * follow that resumed from the wrong place would show output it had already
 * shown — which reads as the recipe having run twice, and is indistinguishable
 * from it in the pane.
 *
 * Numbered lines are what make this checkable at all: the fixture prints each
 * one once, so any repeat in the panel came from the follow.
 */
Then("every line of the output appears exactly once", async function (this: OduWorld) {
  const said = await this.page.locator("pre.log-text").innerText();
  const seen = new Map<string, number>();
  for (const line of said.split("\n")) {
    const numbered = /^burst line (\d{6})/.exec(line);
    if (numbered === null) continue;
    const at = numbered[1] as string;
    seen.set(at, (seen.get(at) ?? 0) + 1);
  }
  const twice = [...seen.entries()].filter(([, count]) => count > 1);
  assert.ok(
    twice.length === 0,
    `these lines arrived more than once: ${twice
      .slice(0, 5)
      .map(([at, count]) => `${at} x${count}`)
      .join(", ")}`,
  );
  // And it actually saw some, so an empty pane cannot pass this.
  assert.ok(seen.size > 0, "the output panel held no numbered lines at all");
});
