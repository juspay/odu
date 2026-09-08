/**
 * Filling the create form.
 *
 * Every field is reached by its LABEL, which works because `packages/web-ui`'s
 * `field()` emits a `<label for=…>` bound to the input — so a step that finds
 * "Checkout" is asserting the same binding a screen reader depends on. A step
 * that reached for `#checkout` would pass just as well with the label removed.
 */

import * as assert from "node:assert";
import { Then, When } from "@cucumber/cucumber";
import { headOf } from "../support/service.ts";
import type { OduWorld } from "../support/world.ts";

When("I fill {string} with {string}", async function (this: OduWorld, label: string, value: string) {
  await this.page.getByLabel(label, { exact: true }).fill(value);
});

When("I fill {string} with the fixture path", async function (this: OduWorld, label: string) {
  const dir = this.checkout;
  assert.ok(dir !== undefined, "no fixture checkout has been made yet");
  await this.page.getByLabel(label, { exact: true }).fill(dir);
});

When("I fill {string} with the fixture HEAD", async function (this: OduWorld, label: string) {
  const dir = this.checkout;
  assert.ok(dir !== undefined, "no fixture checkout has been made yet");
  await this.page.getByLabel(label, { exact: true }).fill(headOf(dir));
});

/** `check()` rather than `click()`: it asserts the box ended up ticked, so a
 *  label whose `for` stopped pointing at its input fails here rather than
 *  producing a run started without the option nobody noticed was dropped. */
When("I tick {string}", async function (this: OduWorld, label: string) {
  await this.page.getByLabel(label, { exact: true }).check();
});

/**
 * The form KEPT what was typed.
 *
 * The refusal is the feature, and a form that cleared itself on one would make a
 * person retype an absolute path to find out they had made the same mistake.
 */
Then(
  "the {string} field still holds {string}",
  async function (this: OduWorld, label: string, value: string) {
    assert.strictEqual(
      await this.page.getByLabel(label, { exact: true }).inputValue(),
      value,
      `the ${label} field did not keep what was typed into it`,
    );
  },
);

Then("the address names the run that was already live", async function (this: OduWorld) {
  const runId = this.runId;
  assert.ok(runId !== undefined, "no run was arranged for this scenario");
  await this.waitUntil(
    async () => (await this.page.evaluate(() => location.hash)) === `#/run/${runId}`,
    `the address to name ${runId}`,
  );
});

Then("the address does not name the run that was already live", async function (this: OduWorld) {
  const runId = this.runId;
  assert.ok(runId !== undefined, "no run was arranged for this scenario");
  const hash = await this.page.evaluate(() => location.hash);
  assert.notStrictEqual(
    hash,
    `#/run/${runId}`,
    "superseding was supposed to start a NEW run, and the address still names the old one",
  );
});
