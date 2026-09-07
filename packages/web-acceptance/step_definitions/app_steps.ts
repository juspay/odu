/**
 * The steps that belong to no one feature: opening a route, pressing a button by
 * its visible name, and the two assertions almost every scenario ends with.
 *
 * `I press {string}` is deliberately spelled as a ROLE and an accessible NAME
 * rather than a CSS selector. That is not a stylistic preference: a step that
 * found its button by `.btn:nth-child(3)` would go on passing after the label
 * changed to something nobody can read, which is the opposite of what a browser
 * acceptance suite is for. If a control cannot be found by the name a person
 * reads, that is a finding.
 */

import * as assert from "node:assert";
import { Given, Then, When } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

/**
 * Navigating by address is not a shortcut past a control: the URL hash IS this
 * app's router, so `#/` is a link a person can paste and this is the same
 * arrival they would get. Scenarios that are ABOUT the navigation press the
 * button instead — see create_run.feature's first scenario.
 *
 * Registered as a `Given` and read as either. Cucumber matches step TEXT and
 * ignores the keyword, so a second registration under `When` would not be a
 * synonym — it would be an ambiguity, and every scenario using the step would
 * fail rather than choose.
 */
Given("I open the board", async function (this: OduWorld) {
  await this.open("#/");
  await this.page.getByRole("heading", { name: "Runs", exact: true }).waitFor();
});

Given("I open the create form", async function (this: OduWorld) {
  await this.open("#/new");
  await this.page.getByRole("heading", { name: "New run", exact: true }).waitFor();
});

When("I press {string}", async function (this: OduWorld, label: string) {
  await this.page.getByRole("button", { name: label, exact: true }).click();
});

/**
 * The address moved to a run — and the run is remembered.
 *
 * Registering it here rather than in a step of its own is what keeps the feature
 * files free of housekeeping: a scenario that starts a run is exactly a scenario
 * whose address ends up naming one, and every such run must be stopped in
 * teardown or a `sleep 300` outlives the leg holding a core.
 */
Then("the address names a run", async function (this: OduWorld) {
  await this.waitUntil(
    async () => /^#\/run\/.+/.test(await this.page.evaluate(() => location.hash)),
    "the address to name a run",
  );
  const hash = await this.page.evaluate(() => location.hash);
  const runId = hash.replace(/^#\/run\//, "").split("/")[0];
  if (runId !== undefined && runId !== "") this.ownRuns.push(runId);
});

Then("the wire reads {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.wire(), "the connection indicator", text);
});

Then("a status reads {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.receipt(), "the control receipt", text);
});

Then("an alert reads {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.getByRole("alert"), "the refusal", text);
});

Then("the alert reads {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.getByRole("alert"), "the refusal", text);
});

/** An ANSWER is not a refusal, and the difference is in the DOM: `role=status`
 *  is announced politely, `role=alert` interrupts. A page that reported "that
 *  checkout already has a live run" as an alert would be telling a person
 *  something went wrong when nothing did. */
Then("there is no alert", async function (this: OduWorld) {
  assert.strictEqual(
    await this.page.getByRole("alert").count(),
    0,
    "the page raised an alert, but this answer is not a refusal",
  );
});

/**
 * Nothing threw in the page.
 *
 * The assertion a DOM snapshot cannot make. A Solid view whose effect throws
 * leaves the last rendered frame on screen, so a page that has stopped updating
 * looks exactly like a page with nothing to say — and the only evidence is on
 * the console this listener has been recording since before the first
 * navigation.
 */
Then("there should be no page errors", function (this: OduWorld) {
  assert.deepStrictEqual(
    this.errors,
    [],
    `the page reported ${this.errors.length} error(s):\n${this.errors.join("\n---\n")}`,
  );
});
