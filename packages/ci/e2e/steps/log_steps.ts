import * as assert from "node:assert";
import { Then, When } from "@cucumber/cucumber";
import type { Locator } from "playwright";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

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

const BYTE_SIZE = /\d+(\.\d+)?\s(B|KiB|MiB)/;

async function logHeader(world: OduWorld): Promise<string> {
  await world.waitUntil(
    async () => BYTE_SIZE.test(await world.page.locator(".log-meta").innerText()),
    "the output header to state a byte size",
  );
  return await world.page.locator(".log-meta").innerText();
}

Then("the output header states a byte size", async function (this: OduWorld) {
  const meta = await logHeader(this);
  assert.match(
    meta,
    BYTE_SIZE,
    `the output header states no byte size — it read ${JSON.stringify(meta)}`,
  );
});

Then("the output header does not say {string}", async function (this: OduWorld, text: string) {
  const meta = await logHeader(this);
  assert.ok(
    !meta.includes(text),
    `the output header said ${JSON.stringify(text)}: ${JSON.stringify(meta)}`,
  );
});

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

Then(
  "the attempt picker offers {string} and {string}",
  async function (this: OduWorld, first: string, second: string) {
    for (const label of [first, second]) {
      await attemptButton(this, label).waitFor({ timeout: 30_000 });
    }
  },
);

Then("{string} is the chosen attempt", async function (this: OduWorld, label: string) {
  try {
    await this.waitUntil(
      async () => (await attemptButton(this, label).getAttribute("aria-pressed")) === "true",
      `"${label}" to be announced as the chosen attempt`,
    );
  } catch (cause) {
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

Then("every line of the output appears exactly once", async function (this: OduWorld) {
  const said = await this.page.locator("pre.log-text").innerText();
  const seen = new Map<string, number>();
  for (const line of said.split("\n")) {
    const numbered = /^burst line (\d{6})/.exec(line);
    if (numbered === null) continue;
    const at = numbered[1] as string;
    seen.set(at, (seen.get(at) ?? 0) + 1);
  }
  const twice = [...seen.entries()].filter(([, count]) => count > 1);
  assert.ok(
    twice.length === 0,
    `these lines arrived more than once: ${twice
      .slice(0, 5)
      .map(([at, count]) => `${at} x${count}`)
      .join(", ")}`,
  );
  assert.ok(seen.size > 0, "the output panel held no numbered lines at all");
});
