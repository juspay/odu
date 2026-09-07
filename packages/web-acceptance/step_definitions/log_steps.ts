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

/** TWO facts, and this asserts the first: how much output there is. A panel that
 *  said nothing about size would leave "the recipe was quiet" and "the evidence
 *  is truncated" looking identical. */
Then("the output header states a byte size", async function (this: OduWorld) {
  const meta = await this.page.locator(".log-meta").innerText();
  assert.match(
    meta,
    /\d+(\.\d+)?\s(B|KiB|MiB)/,
    `the output header states no byte size — it read ${JSON.stringify(meta)}`,
  );
});

Then("the output header does not say {string}", async function (this: OduWorld, text: string) {
  const meta = await this.page.locator(".log-meta").innerText();
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
