/**
 * The runs' operations — the machines page, the maintenance page, and the
 * create form's pipeline preview.
 *
 * Every field is reached by its LABEL and every control by its NAME, as the
 * create form's steps do, so a step that passes is also a page a screen reader
 * can operate. The platform is the service's own word for this machine
 * (`currentNixSystem`), the same one the harness pins a localhost lane to.
 */

import { Given, Then, When } from "@cucumber/cucumber";
import { currentNixSystem } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

Given("I open the machines page", async function (this: OduWorld) {
  // Through the board's control: being DRAWN there is half of the promise.
  await this.open("#/");
  await this.page.getByRole("button", { name: "Machines", exact: true }).click();
  await this.page.getByRole("heading", { name: "Machines", exact: true }).waitFor();
});

Given("I open the maintenance page", async function (this: OduWorld) {
  await this.open("#/");
  await this.page.getByRole("button", { name: "Maintenance", exact: true }).click();
  await this.page.getByRole("heading", { name: "Maintenance", exact: true }).waitFor();
});

When(
  "I fill {string} with this machine's platform",
  async function (this: OduWorld, label: string) {
    await this.page.getByLabel(label, { exact: true }).fill(currentNixSystem());
  },
);

Then("the pipeline preview names {string}", async function (this: OduWorld, recipe: string) {
  await this.saysThat(this.page.locator(".pipeline-preview"), "the pipeline preview", recipe);
});

Then("the machines page lists this machine's platform", async function (this: OduWorld) {
  // The harness's hosts file pins this platform to a localhost lane, so its
  // row is the answer the kept probe draws.
  await this.saysThat(this.page.locator("ul.venues"), "the venue list", currentNixSystem());
});

Then("the machines page says how old its reading is", async function (this: OduWorld) {
  await this.saysThat(this.page.locator(".venue-age"), "the probe's age", "Probed ");
});

/** A hold's answer depends on the lane (a localhost lane takes no remote lock),
 *  so what is graded is that the control reached the verb and came back with a
 *  sentence — an answer or a refusal — rather than going quiet. */
Then("the page answers with a receipt", async function (this: OduWorld) {
  await this.receipt().first().waitFor({ timeout: 30_000 });
});

/** The RELEASE's own sentence, not merely the platform — the hold's receipt
 *  before it names the platform too, and a check that matched that would pass
 *  on a release that never answered. */
Then("a status reports the release of this machine's platform", async function (this: OduWorld) {
  const platform = currentNixSystem();
  await this.waitUntil(async () => {
    const text = await this.receipt().first().innerText().catch(() => "");
    return text.includes(`Released ${platform}`) || text.includes(`Nothing held for ${platform}`);
  }, `the release receipt to name ${platform}`);
});
