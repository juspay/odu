/**
 * THE DOOR'S STEPS — the sign-in page, the header, the two credentials.
 *
 * The arrange half is a person's route wherever one exists: the sign-in is the
 * link on the page, a token is the profile's form, and only a grant (which has
 * no control yet — it is the operator's bootstrap) goes through the CLI with the
 * root token. The assert half is the page, by role and accessible name.
 *
 * `mintToken` is the one helper several scenarios share: a member's and an
 * admin's CLI credential is minted on the profile page exactly as a person would
 * mint it, because that is the only way a token comes into existence at all.
 */

import * as assert from "node:assert";
import { Given, Then, When } from "@cucumber/cucumber";
import { signIn } from "../../../web-acceptance/support/authWorld.ts";
import { oduCli, until } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

/** One `odu …` call as the signed-in person, through the token this scenario
 *  minted. */
function asPerson(world: OduWorld, argv: string[]) {
  assert.ok(world.mintedToken !== undefined, "no token was minted for this scenario");
  return oduCli(world.service, argv, { ODU_TOKEN: world.mintedToken });
}

/** Mint a token on the profile page, and keep its ONE showing. */
async function mintToken(world: OduWorld, name: string): Promise<string> {
  await world.open("#/profile");
  await world.page
    .getByRole("heading", { name: new RegExp(world.signInLogin) })
    .first()
    .waitFor({ timeout: 30_000 });
  const box = world.page.getByPlaceholder("token name, e.g. laptop");
  await box.fill(name);
  await world.page.getByRole("button", { name: "Create token" }).click();
  const block = world.page.locator("pre.use-block").first();
  await block.waitFor({ timeout: 30_000 });
  const token = (await block.innerText()).trim();
  world.mintedToken = token;
  return token;
}

// ── the worlds ──────────────────────────────────────────────────────────────

Given("the stub says this account is not in the organisation", function (this: OduWorld) {
  this.stub.mode = { ...this.stub.mode, orgMember: false };
});

When("I start a sign-in", async function (this: OduWorld) {
  await signIn(this);
});

// ── the page ────────────────────────────────────────────────────────────────

Then("the page asks me to sign in", async function (this: OduWorld) {
  await this.page
    .getByRole("heading", { name: "Sign in to odu" })
    .waitFor({ timeout: 30_000 });
});

Then("the page offers no board rows", async function (this: OduWorld) {
  // The switch is `hidden` rather than unmounted for a signed-in page, so
  // "no board rows" is asked of what a reader can reach: no Runs control.
  const runs = await this.page.getByRole("button", { name: "Runs" }).count();
  assert.strictEqual(runs, 0, "the board's row switch is reachable while anonymous");
});

Then("the page offers the board rows", async function (this: OduWorld) {
  await this.page.getByRole("button", { name: "Runs" }).waitFor({ timeout: 30_000 });
});

Then(
  "the header names {string} as {string}",
  async function (this: OduWorld, login: string, role: string) {
    await this.saysThat(this.page.locator(".account-name"), "the header", login);
    await this.saysThat(this.page.locator(".account-name"), "the header", role);
  },
);

Then("the page refuses the sign-in naming the allow-list", async function (this: OduWorld) {
  // The refusal is a PAGE the daemon wrote, not a redirect: a person who is not
  // allowed in has to be told why and by whom.
  await this.saysThat(
    this.page.locator("main"),
    "the refusal page",
    "not allowed to sign in",
  );
  await this.saysThat(this.page.locator("main"), "the refusal page", "org:juspay");
});

// ── the CLI ─────────────────────────────────────────────────────────────────

When("the CLI creates a bucket as this person", async function (this: OduWorld) {
  await mintToken(this, "cli");
  const name = `auth-${Math.random().toString(36).slice(2, 8)}`;
  this.cacheBucket = name;
  this.cliAnswer = asPerson(this, ["cache", "create", name, "-o", "json"]);
});

Then("the CLI refuses it as not permitted", function (this: OduWorld) {
  assert.ok(this.cliAnswer !== undefined, "no CLI call was made");
  assert.strictEqual(this.cliAnswer.status, 1, `expected a refusal, got ${this.cliAnswer.stdout}`);
  const answer = JSON.parse(this.cliAnswer.stdout) as { code?: string; message?: string };
  assert.strictEqual(answer.code, "not_permitted");
});

Then("the CLI reports the bucket", function (this: OduWorld) {
  assert.ok(this.cliAnswer !== undefined, "no CLI call was made");
  assert.strictEqual(this.cliAnswer.status, 0, `the create failed: ${this.cliAnswer.stderr}`);
  const created = JSON.parse(this.cliAnswer.stdout) as { name?: string };
  assert.strictEqual(created.name, this.cacheBucket);
});

Then("the page shows the bucket list", async function (this: OduWorld) {
  await this.page.getByRole("heading", { name: "Buckets", exact: true }).waitFor({
    timeout: 30_000,
  });
});

Then("the page offers no Create bucket control", async function (this: OduWorld) {
  // The cache page has no create control at all yet (a bucket is made with
  // `odu cache create`), and this is the assertion that says a member is not
  // shown one when it gains one.
  const controls = await this.page.getByRole("button", { name: /create bucket/i }).count();
  assert.strictEqual(controls, 0, "a Create bucket control is reachable");
});

// ── the profile ─────────────────────────────────────────────────────────────

When("I open the profile", async function (this: OduWorld) {
  await this.open("#/profile");
  await this.page
    .getByRole("heading", { name: new RegExp(this.signInLogin) })
    .first()
    .waitFor({ timeout: 30_000 });
});

When("I create a token named {string}", async function (this: OduWorld, name: string) {
  await mintToken(this, name);
});

Then("the page shows the token once", function (this: OduWorld) {
  assert.ok(this.mintedToken !== undefined, "no token was minted");
  assert.match(this.mintedToken, /^odu_/, "the token does not look like one odu minted");
});

Then("a CLI with that token answers whoami as this person", function (this: OduWorld) {
  const answer = asPerson(this, ["auth", "whoami", "-o", "json"]);
  assert.strictEqual(answer.status, 0, `whoami failed: ${answer.stderr}`);
  const who = JSON.parse(answer.stdout) as { kind?: string; login?: string };
  assert.strictEqual(who.kind, "user");
  assert.strictEqual(who.login, this.signInLogin);
});

Then("the CLI lists buckets with that token", function (this: OduWorld) {
  const answer = asPerson(this, ["cache", "list", "-o", "json"]);
  assert.strictEqual(answer.status, 0, `cache list failed: ${answer.stderr}`);
});

// ── sign-out, and the tab that is not the one that clicked ──────────────────

Given("I open a second tab on the board", async function (this: OduWorld) {
  this.second = await this.context.newPage();
  await this.second.goto(new URL("#/", this.service.origin).href);
  await this.second.getByRole("button", { name: "Runs" }).waitFor({ timeout: 30_000 });
});

When("I sign out", async function (this: OduWorld) {
  await this.page.getByRole("button", { name: "Sign out" }).click();
  // The form posts, the server clears the cookie and redirects: the tab that
  // signed out lands on the sign-in page itself.
  await this.page.getByRole("heading", { name: "Sign in to odu" }).waitFor({
    timeout: 30_000,
  });
});

Then("the second tab meets the sign-in page", async function (this: OduWorld) {
  const second = this.second;
  assert.ok(second !== undefined, "no second tab was opened");
  // The OTHER tab's session ended with the same one. Its socket stops being
  // served — every heartbeat refused — so the client's watchdog severs and
  // redials it, the dead cookie is refused at the upgrade, and what comes back
  // is nobody. A heartbeat's cadence is seconds, so this waits longer than the
  // other waits in this suite.
  await until(
    "the second tab to meet the sign-in page",
    async () => {
      const heading = second.getByRole("heading", { name: "Sign in to odu" });
      return (await heading.count()) > 0 && (await heading.isVisible());
    },
    120_000,
    500,
  );
});
