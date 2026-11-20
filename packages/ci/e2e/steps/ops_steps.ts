import { Given, Then, When } from "@cucumber/cucumber";
import { currentNixSystem } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

Given("I open the machines page", async function (this: OduWorld) {
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
  await this.saysThat(this.page.locator(".venues"), "the venue list", currentNixSystem());
});

Then("the machines page says how old its reading is", async function (this: OduWorld) {
  await this.saysThat(this.page.locator(".venue-age"), "the probe's age", "Probed ");
});

Then("the page answers with a receipt", async function (this: OduWorld) {
  await this.receipt().first().waitFor({ timeout: 30_000 });
});

Then("a status reports the release of this machine's platform", async function (this: OduWorld) {
  const platform = currentNixSystem();
  await this.waitUntil(async () => {
    const text = await this.receipt().first().innerText().catch(() => "");
    return text.includes(`Released ${platform}`) || text.includes(`Nothing held for ${platform}`);
  }, `the release receipt to name ${platform}`);
});
