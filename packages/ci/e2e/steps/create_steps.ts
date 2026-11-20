import * as assert from "node:assert";
import { Then, When } from "@cucumber/cucumber";
import { headOf } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

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

When("I tick {string}", async function (this: OduWorld, label: string) {
  await this.page.getByLabel(label, { exact: true }).check();
});

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
