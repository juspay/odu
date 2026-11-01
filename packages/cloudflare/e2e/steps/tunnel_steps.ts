/**
 * The tunnel row's steps — the page's two facts and the CLI's parity read.
 *
 * The arrange half is the CACHE row's vocabulary (`I open the cache`, the root
 * token, the bucket form): a tunnel carries a bucket's name, so a scenario
 * starts by making one. Everything asserted here is this row's: the route's
 * state, the connector's state, the reason, and `odu cloudflare status`.
 */

import * as assert from "node:assert";
import { Then, When } from "@cucumber/cucumber";
import { oduCli, ROOT_TOKEN, until } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

When("I open the tunnel", async function (this: OduWorld) {
  await this.open("#/tunnel");
  await this.page.getByRole("heading", { name: "Tunnel", exact: true }).waitFor();
});

Then("the tunnel says it is idle", async function (this: OduWorld) {
  const section = this.page.locator('section[aria-label="tunnel"]');
  await until("the tunnel to say it is idle", async () =>
    (await section.innerText()).includes("The tunnel is idle — no name is routed") ? true : null,
  );
});

Then("the tunnel shows no connector state", async function (this: OduWorld) {
  const section = this.page.locator('section[aria-label="tunnel"]');
  assert.ok(
    !(await section.innerText()).includes("connector "),
    "the idle tunnel read as a stopped connector",
  );
});

Then(
  "the tunnel panel shows {string} as {string}",
  async function (this: OduWorld, domain: string, state: string) {
    const row = this.page.locator("ol.paths li", { hasText: domain });
    await row.waitFor({ timeout: 30_000 });
    await until(`the tunnel to report ${domain} ${state}`, async () =>
      (await row.innerText()).includes(state) ? true : null,
    );
  },
);

Then(
  "the tunnel panel's reason for {string} names {string}",
  async function (this: OduWorld, domain: string, text: string) {
    const row = this.page.locator("ol.paths li", { hasText: domain });
    await row.waitFor({ timeout: 30_000 });
    await until(`the tunnel's reason to name ${text}`, async () =>
      (await row.innerText()).includes(text) ? true : null,
    );
  },
);

Then("the tunnel panel has no route for {string}", async function (this: OduWorld, domain: string) {
  const row = this.page.locator("ol.paths li", { hasText: domain });
  await until(`the route for ${domain} to go`, async () => ((await row.count()) === 0 ? true : null));
});

Then("the tunnel connector is {string}", async function (this: OduWorld, state: string) {
  const section = this.page.locator('section[aria-label="tunnel"]');
  await until(`the connector to be ${state}`, async () =>
    (await section.innerText()).includes(`connector ${state}`) ? true : null,
  );
});

Then("the bucket page shows the domain route as {string}", async function (this: OduWorld, state: string) {
  const strip = this.page.locator('[aria-label="domain route"]');
  await strip.waitFor({ timeout: 30_000 });
  await until(`the bucket's route to be ${state}`, async () =>
    (await strip.innerText()).includes(state) ? true : null,
  );
});

When("I clear the bucket's domain", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await this.open(`#/cache/${name}`);
  await this.page.getByRole("heading", { name, exact: true }).waitFor();
  // OPENING THE BUCKET AGAIN IS A FRESH PAGE, so the in-memory root token the
  // earlier step typed is gone on a daemon with no door; a person types it
  // again, and so does this step.
  const token = this.page.getByLabel("root token", { exact: true });
  if ((await token.count()) > 0) await token.fill(ROOT_TOKEN);
  await this.page.getByRole("button", { name: "Clear domain", exact: true }).click();
  // The USE BLOCK goes back to the path form: the row accepted the clear.
  await until("the substituter block to drop the name", async () =>
    (await this.page.locator("pre.consume-block").innerText()).includes(`/cache/${name}`)
      ? true
      : null,
  );
  await this.open("#/tunnel");
  await this.page.getByRole("heading", { name: "Tunnel", exact: true }).waitFor();
});

Then(
  "odu cloudflare status reports {string} as {string}",
  async function (this: OduWorld, domain: string, state: string) {
    const answer = oduCli(this.service, ["cloudflare", "status", "-o", "json"]);
    assert.strictEqual(answer.status, 0, `status failed: ${answer.stderr}`);
    const status = JSON.parse(answer.stdout) as {
      tunnel?: { state?: string };
      routes?: { domain: string; state: string }[];
    };
    const route = status.routes?.find((one) => one.domain === domain);
    assert.ok(route !== undefined, `status does not name ${domain}: ${answer.stdout}`);
    assert.strictEqual(route.state, state);
    assert.ok(status.tunnel !== undefined, "status carries no tunnel");
  },
);
