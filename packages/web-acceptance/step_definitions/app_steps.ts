import * as assert from "node:assert";
import { Given, Then, When } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

function errorsBeyondExpectedResponses(
  errors: readonly string[],
  expectedResponses: readonly { status: number; url: string }[],
): string[] {
  const allowance = new Map<string, number>();
  for (const expected of expectedResponses) {
    const key = `${expected.status} (`;
    allowance.set(key, (allowance.get(key) ?? 0) + 1);
  }
  return errors.filter((error) => {
    for (const [key, left] of allowance) {
      if (left > 0 && error.includes(key)) {
        allowance.set(key, left - 1);
        return false;
      }
    }
    return true;
  });
}

Given("I open the board", async function (this: OduWorld) {
  await this.open("#/");
  await this.page.getByRole("heading", { name: "Runs", exact: true }).waitFor();
});

Given("I open odu", async function (this: OduWorld) {
  await this.open("#/");
});

Given("I open the create form", async function (this: OduWorld) {
  await this.open("#/new");
  await this.page.getByRole("heading", { name: "New run", exact: true }).waitFor();
});

When("I press {string}", async function (this: OduWorld, label: string) {
  await this.page.getByRole("button", { name: label, exact: true }).click();
});

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

Then("the run page offers {string}", async function (this: OduWorld, name: string) {
  await this.page.getByRole("button", { name }).first().waitFor({ timeout: 30_000 });
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

Then("there is no alert", async function (this: OduWorld) {
  assert.strictEqual(
    await this.page.getByRole("alert").count(),
    0,
    "the page raised an alert, but this answer is not a refusal",
  );
});

Then("there should be no page errors", function (this: OduWorld) {
  const unexpected = this.failedResponses.filter(
    (failed) =>
      !this.expectedResponses.some(
        (expected) => expected.status === failed.status && expected.url === failed.url,
      ),
  );
  assert.deepStrictEqual(
    unexpected,
    [],
    `the page received ${unexpected.length} unexpected failed response(s):\n` +
      unexpected.map((one) => `${one.status} ${one.url}`).join("\n"),
  );
  const others = errorsBeyondExpectedResponses(this.errors, this.expectedResponses);
  assert.deepStrictEqual(
    others,
    [],
    `the page reported ${others.length} error(s):\n${others.join("\n---\n")}`,
  );
});

Then("the page reports no errors other than the refused sign-in", function (this: OduWorld) {
  const others = this.errors.filter((one) => !one.includes("403 (Forbidden)"));
  assert.deepStrictEqual(
    others,
    [],
    `the page reported ${others.length} error(s) besides the 403:\n${others.join("\n---\n")}`,
  );
});
