/**
 * The board's rows, its filters and its three empty states.
 *
 * The filters are reached through the group they live in — `role="group"` with
 * `aria-label="Filter runs"` — rather than by class, because that grouping is
 * the thing that makes three buttons read as one control to anybody not looking
 * at the screen. A step that found them by `.filters button` would keep passing
 * after the grouping was lost.
 */

import * as assert from "node:assert";
import { basename } from "node:path";
import { Then, When } from "@cucumber/cucumber";
import type { Locator } from "playwright";
import { headOf } from "../support/service.ts";
import type { OduWorld } from "../support/world.ts";

function filter(world: OduWorld, label: string): Locator {
  return world.page
    .getByRole("group", { name: "Filter runs" })
    .getByRole("button", { name: label, exact: true });
}

/** The row for the run this scenario arranged, found by its project — the last
 *  segment of the checkout, which is what `projectOf` draws. */
function projectRow(world: OduWorld): Locator {
  const checkout = world.checkout;
  assert.ok(checkout !== undefined, "no fixture checkout has been made yet");
  return world.runRow(basename(checkout));
}

Then("a row names the fixture project", async function (this: OduWorld) {
  await projectRow(this).first().waitFor({ timeout: 60_000 });
});

/** `<sha7>#<seq>` — the same ref every other odu face prints, which is what
 *  makes a row a thing a person can match against a terminal they left open. */
Then("that row shows the run's short commit ref", async function (this: OduWorld) {
  const checkout = this.checkout;
  assert.ok(checkout !== undefined, "no fixture checkout has been made yet");
  await this.saysThat(
    projectRow(this).first().locator(".row-sha"),
    "the run row's commit ref",
    headOf(checkout).slice(0, 7),
  );
});

/** The row's ONE status cell. A run that has reached a verdict draws the
 *  verdict there and nothing else, so a red "failed" in `.row-status` is both
 *  "the outcome is drawn" and "it is the only thing the column claims". */
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

/** "N earlier" — how many runs of this checkout the default board folded away.
 *  Reading it is two assertions at once: the checkout is drawn as ONE row, and
 *  the row says how many runs it stands for. */
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

/**
 * Press History and wait until the board says it is showing it.
 *
 * The board is one row per CHECKOUT by default — the latest run of each — so a
 * scenario about two runs of one fixture sees one row until this is pressed.
 * Waited on `aria-pressed` rather than on a row count: the toggle's own state is
 * the thing that has to have landed, and a count would be a wait on whichever
 * rows the live collection happened to have delivered.
 */
When("I show the history", async function (this: OduWorld) {
  const history = this.page.getByRole("button", { name: "History", exact: true });
  await history.click();
  await this.waitUntil(
    async () => (await history.getAttribute("aria-pressed")) === "true",
    "the History toggle to announce itself as pressed",
  );
});

Then("that run is not listed", async function (this: OduWorld) {
  // Retried, because a filter is applied to a LIVE collection: a row that is on
  // its way out has not necessarily gone by the time the click returns.
  await this.waitUntil(
    async () => (await projectRow(this).count()) === 0,
    "the settled run to drop out of the filtered board",
  );
});

Then("that run is listed", async function (this: OduWorld) {
  await projectRow(this).first().waitFor({ timeout: 30_000 });
});

/** The three empty states are three different answers, and telling them apart is
 *  the point: "nothing yet" sends a person to start a run, "nothing matching"
 *  sends them to another filter, and a board that showed one blank panel for
 *  both would send them looking for a run that is right there. */
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
