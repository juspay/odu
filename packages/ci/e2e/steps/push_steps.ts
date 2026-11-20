import * as assert from "node:assert";
import { Given, Then, When } from "@cucumber/cucumber";
import { arrangePushingRun, type PushingRun } from "../support/pushFixture.ts";
import { type OduWorld } from "../../../web-acceptance/support/world.ts";
import { RUN_SETUP_TIMEOUT } from "../../../web-acceptance/support/budgets.ts";

function arranged(world: OduWorld): PushingRun {
  const state = world.rowState.get("ci.push");
  assert.ok(state !== undefined, "no pushing run was arranged, so there is nothing to read");
  return state as PushingRun;
}

Given(
  "a settled run whose node pushed to a bucket of this daemon",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const run = await arrangePushingRun(this.service, {
      requestId: `wa-push-${crypto.randomUUID()}`,
      timeoutMs: RUN_SETUP_TIMEOUT,
    });
    this.ownFixtures.push(run.checkout);
    this.ownRuns.push(run.runId);
    this.checkout = run.checkout;
    this.runId = run.runId;
    this.rowState.set("ci.push", run);
  },
);

Then("the run header says it pushes to that bucket", async function (this: OduWorld) {
  await this.saysThat(
    this.page.locator(".detail-push"),
    "the run header",
    `pushes to ${arranged(this).bucket}`,
  );
});

Then("the run header totals what the run pushed", async function (this: OduWorld) {
  await this.saysThat(
    this.page.locator(".detail-push-total"),
    "the run header's push total",
    "1 pushed",
  );
});

Then("the node {string} shows its push step", async function (this: OduWorld, id: string) {
  const step = this.nodeRow(id).first().locator(".node-push-step");
  await this.saysThat(step, `the push step of ${id}`, `pushed → ${arranged(this).bucket}`);
  await this.saysThat(step, `the push step of ${id}`, "1 pushed");
});

Then("the node {string} shows no push step", async function (this: OduWorld, id: string) {
  const row = this.nodeRow(id).first();
  await row.waitFor({ state: "attached", timeout: 30_000 });
  const steps = await row.locator(".node-push-step").count();
  assert.strictEqual(
    steps,
    0,
    `${id} drew a push step, but it pushed nothing — a node with no push has no step`,
  );
});

When("I read the push log", async function (this: OduWorld) {
  await this.page
    .getByRole("group", { name: "Log" })
    .getByRole("button", { name: "Push", exact: true })
    .click();
});

Then("I note the log panel's size", async function (this: OduWorld) {
  const meta = this.page.locator(".log-meta").first();
  await this.waitUntil(
    async () => (await meta.innerText()).trim() !== "",
    "the log panel to report the recipe's size",
  );
  this.rowState.set("ci.push.recipeMeta", (await meta.innerText()).trim());
});

Then(
  "the log panel names the push log at a size of its own",
  async function (this: OduWorld) {
    const noted = this.rowState.get("ci.push.recipeMeta");
    assert.ok(typeof noted === "string", "the recipe tab's size was never noted");
    const meta = this.page.locator(".log-meta").first();
    await this.saysThat(meta, "the log panel on the Push tab", "push log · ");
    const said = (await meta.innerText()).trim();
    assert.notStrictEqual(
      said,
      noted,
      `the Push tab reports the recipe's own readout (${JSON.stringify(said)})`,
    );
    assert.ok(
      !said.includes(noted),
      `the Push tab's size is the recipe's: it read ${JSON.stringify(said)} ` +
        `and the recipe tab read ${JSON.stringify(noted)}`,
    );
  },
);
