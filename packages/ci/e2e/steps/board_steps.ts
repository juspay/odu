import * as assert from "node:assert";
import { basename } from "node:path";
import { Then, When } from "@cucumber/cucumber";
import type { Locator } from "playwright";
import { headOf } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

function filter(world: OduWorld, label: string): Locator {
  return world.page
    .getByRole("group", { name: "Filter runs" })
    .getByRole("button", { name: label, exact: true });
}

function projectRow(world: OduWorld): Locator {
  const checkout = world.checkout;
  assert.ok(checkout !== undefined, "no fixture checkout has been made yet");
  return world.runRow(basename(checkout));
}

Then("a row names the fixture project", async function (this: OduWorld) {
  await projectRow(this).first().waitFor({ timeout: 60_000 });
});

Then("that row shows the run's short commit ref", async function (this: OduWorld) {
  const checkout = this.checkout;
  assert.ok(checkout !== undefined, "no fixture checkout has been made yet");
  await this.saysThat(
    projectRow(this).first().locator(".row-sha"),
    "the run row's commit ref",
    headOf(checkout).slice(0, 7),
  );
});

Then("that row shows a red {string} outcome", async function (this: OduWorld, label: string) {
  const pill = projectRow(this).first().locator(".row-status .pill");
  await this.saysThat(pill, "the run row's outcome", label);
  const classes = (await pill.first().getAttribute("class")) ?? "";
  assert.ok(
    classes.split(/\s+/).includes("hue-red"),
    `the "${label}" outcome is not drawn red — its pill read "${classes}"`,
  );
});

Then("that row shows {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(
    projectRow(this).first().locator(".row-attention"),
    "the run row's attention pills",
    text,
  );
});

Then(
  "that row shows {string} in the age cell",
  async function (this: OduWorld, text: string) {
    await this.saysThat(
      projectRow(this).first().locator(".row-age"),
      "the run row's age",
      text,
    );
  },
);

When("I press the {string} filter", async function (this: OduWorld, label: string) {
  await filter(this, label).click();
});

Then("the {string} filter is pressed", async function (this: OduWorld, label: string) {
  assert.strictEqual(
    await filter(this, label).getAttribute("aria-pressed"),
    "true",
    `the "${label}" filter does not announce itself as pressed`,
  );
});

Then("the {string} filter is not pressed", async function (this: OduWorld, label: string) {
  assert.strictEqual(
    await filter(this, label).getAttribute("aria-pressed"),
    "false",
    `the "${label}" filter still announces itself as pressed`,
  );
});

When("I show the history", async function (this: OduWorld) {
  const history = this.page.getByRole("button", { name: "History", exact: true });
  await history.click();
  await this.waitUntil(
    async () => (await history.getAttribute("aria-pressed")) === "true",
    "the History toggle to announce itself as pressed",
  );
});

Then("that run is not listed", async function (this: OduWorld) {
  await this.waitUntil(
    async () => (await projectRow(this).count()) === 0,
    "the settled run to drop out of the filtered board",
  );
});

Then("that run is listed", async function (this: OduWorld) {
  await projectRow(this).first().waitFor({ timeout: 30_000 });
});

Then("the board reads {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator(".board-body"), "the board", text, 60_000);
});

Then("the board does not read {string}", async function (this: OduWorld, text: string) {
  const said = await this.page.locator(".board-body").innerText();
  assert.ok(
    !said.includes(text),
    `the board said ${JSON.stringify(text)}, which is a different kind of empty:\n${said}`,
  );
});
