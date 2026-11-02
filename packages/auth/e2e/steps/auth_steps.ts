/**
 * THE DOOR'S STEPS — the sign-in page, the header, the two credentials.
 *
 * The arrange half is a person's route wherever one exists: the sign-in is the
 * link on the page, a token is the profile's form, a grant is the people page —
 * and only the FIRST owner (the operator's bootstrap, which has no session to
 * draw a page for) goes through `odu surface auth user_grant` with the root
 * token. The assert half is the page, by role and accessible name.
 *
 * `mintToken` is the one helper several scenarios share: a member's and an
 * admin's API credential is minted on the profile page exactly as a person
 * would mint it, because that is the only way a token comes into existence at
 * all.
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

/**
 * One API verb as the signed-in person — `odu surface <row> <verb>`, the face
 * that administers now.
 *
 * The input's `rootToken` is empty on purpose: a call carrying a session is a
 * ROLE authority, and the row ignores the operator's secret for it
 * (`packages/cache/src/server.ts`'s `authorityOf`). A refusal arrives as JSON
 * on STDERR with exit 1.
 */
function verbAsPerson(world: OduWorld, row: string, verb: string, input?: unknown) {
  return asPerson(world, [
    "surface",
    row,
    verb,
    ...(input === undefined ? [] : ["--input", JSON.stringify(input)]),
    "--json",
  ]);
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
    // TWO ELEMENTS, because the rail's account card draws them as two: the
    // login is the control that opens the profile, and the role is the line
    // under it. One `.account-name` holding both was the old masthead.
    await this.saysThat(this.page.locator(".account-name"), "the header", login);
    await this.saysThat(this.page.locator(".whoami-role"), "the header", role);
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

// ── the API ─────────────────────────────────────────────────────────────────

When("the API creates a bucket as this person", async function (this: OduWorld) {
  await mintToken(this, "cli");
  const name = `auth-${Math.random().toString(36).slice(2, 8)}`;
  this.cacheBucket = name;
  this.cliAnswer = verbAsPerson(this, "cache", "bucket_create", {
    rootToken: "",
    name,
    public: true,
    retentionDays: 90,
  });
});

Then("the API refuses it as not permitted", function (this: OduWorld) {
  assert.ok(this.cliAnswer !== undefined, "no API call was made");
  assert.strictEqual(this.cliAnswer.status, 1, `expected a refusal, got ${this.cliAnswer.stdout}`);
  // A refusal is JSON on STDERR — exit 1, the verb's own declared error.
  const answer = JSON.parse(this.cliAnswer.stderr) as { code?: string; message?: string };
  assert.strictEqual(answer.code, "not_permitted");
});

Then("the API reports the bucket", function (this: OduWorld) {
  assert.ok(this.cliAnswer !== undefined, "no API call was made");
  assert.strictEqual(this.cliAnswer.status, 0, `the create failed: ${this.cliAnswer.stderr}`);
  const created = JSON.parse(this.cliAnswer.stdout) as { name?: string };
  assert.strictEqual(created.name, this.cacheBucket);
});

Then("the page shows the bucket list", async function (this: OduWorld) {
  // The cache SCREEN is what loaded; its bucket grid is a labelled list rather
  // than a section with a heading of its own.
  await this.page.getByRole("heading", { name: "Cache", exact: true }).waitFor({
    timeout: 30_000,
  });
});

Then("the page offers a Create bucket control", async function (this: OduWorld) {
  // The ADMIN's half of the pair: the row's floor is `admin`, and the shell
  // draws the form only when the person holds it.
  await this.page
    .getByRole("button", { name: "Create bucket" })
    .waitFor({ timeout: 30_000 });
});

Then("the page offers no Create bucket control", async function (this: OduWorld) {
  // THE MEMBER's half, and it is the same control the admin scenario presses —
  // a hidden button is not a permission, so the CLI refusal above is the other
  // half of the proof.
  const controls = await this.page.getByRole("button", { name: "Create bucket" }).count();
  assert.strictEqual(controls, 0, "a member was drawn a Create bucket control");
});

Then("the API lists buckets as this person", function (this: OduWorld) {
  // A member READS the cache: buckets are rows of the board, and
  // `odu surface cache bucket_list` is the terminal's view of the same rows.
  const answer = verbAsPerson(this, "cache", "bucket_list", { rootToken: "" });
  assert.strictEqual(answer.status, 0, `a member's bucket_list failed: ${answer.stderr}`);
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

Then("the profile shows an expiry for {string}", async function (this: OduWorld, name: string) {
  const row = this.page.locator("ul.tokens li", { hasText: name });
  await row.waitFor({ timeout: 30_000 });
  const text = await row.innerText();
  assert.match(text, /expires \d{4}-\d{2}-\d{2}/, `the token's row names no expiry: ${text}`);
});

Then("the API with that token answers whoami as this person", function (this: OduWorld) {
  // `user_whoami` takes NO input, and answers the principal under `who`.
  const answer = verbAsPerson(this, "auth", "user_whoami");
  assert.strictEqual(answer.status, 0, `whoami failed: ${answer.stderr}`);
  const { who } = JSON.parse(answer.stdout) as { who: { kind?: string; login?: string } };
  assert.strictEqual(who.kind, "user");
  assert.strictEqual(who.login, this.signInLogin);
});

Then("the API lists buckets with that token", function (this: OduWorld) {
  const answer = verbAsPerson(this, "cache", "bucket_list", { rootToken: "" });
  assert.strictEqual(answer.status, 0, `bucket_list failed: ${answer.stderr}`);
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

// ── the people page ─────────────────────────────────────────────────────────

/** The login this scenario granted on the people page — the door's own state,
 *  in the harness's row bag. */
const GRANTED = "auth.granted";
function grantedLogin(world: OduWorld): string | undefined {
  return world.rowState.get(GRANTED) as string | undefined;
}

When("I open the people page", async function (this: OduWorld) {
  // Through the header's control, not the address: the control being DRAWN for
  // an owner is half of what this page promises.
  await this.open("#/");
  await this.page.getByRole("button", { name: "People", exact: true }).click();
  await this.page.getByRole("heading", { name: "People", exact: true }).waitFor({
    timeout: 30_000,
  });
});

Then("the people page says {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator(".people-page"), "the people page", text);
});

/** A person's role is the VALUE of their row's select — what a reader reads and
 *  what the next change starts from. */
async function roleShown(world: OduWorld, login: string, role: string): Promise<void> {
  const select = world.page.getByLabel(`role of ${login}`, { exact: true });
  await world.waitUntil(
    async () => (await select.count()) > 0 && (await select.inputValue()) === role,
    `the people list to show ${login} as ${role}`,
  );
}

Then(
  "the people list shows {string} as {string}",
  async function (this: OduWorld, login: string, role: string) {
    await roleShown(this, login, role);
  },
);

When("I grant a new login the role {string}", async function (this: OduWorld, role: string) {
  const login = `wa-${Math.random().toString(36).slice(2, 10)}`;
  this.rowState.set(GRANTED, login);
  await this.page.getByPlaceholder("GitHub login, e.g. octocat").fill(login);
  await this.page.getByLabel("role to grant", { exact: true }).selectOption(role);
  await this.page.getByRole("button", { name: "Grant", exact: true }).click();
});

Then("the people list shows the new login as {string}", async function (this: OduWorld, role: string) {
  const login = grantedLogin(this);
  assert.ok(login !== undefined, "no login was granted");
  await roleShown(this, login, role);
});

When("I change the new login's role to {string}", async function (this: OduWorld, role: string) {
  const login = grantedLogin(this);
  assert.ok(login !== undefined, "no login was granted");
  await this.page
    .getByLabel(`role of ${login}`, { exact: true })
    .selectOption(role);
});

Then("the header offers no People control", async function (this: OduWorld) {
  // Asked once the header has drawn the person, so "absent" is an answer and
  // not a page that has not finished arriving.
  await this.page.locator(".account-name").waitFor({ timeout: 30_000 });
  const controls = await this.page.getByRole("button", { name: "People", exact: true }).count();
  assert.strictEqual(controls, 0, "a non-owner was drawn the People control");
});

Then("the API refuses the people list as not permitted", async function (this: OduWorld) {
  await mintToken(this, "people");
  // `grant_list` takes NO input; the refusal is JSON on stderr, exit 1.
  const answer = verbAsPerson(this, "auth", "grant_list");
  assert.strictEqual(answer.status, 1, `expected a refusal, got ${answer.stdout}`);
  const refused = JSON.parse(answer.stderr) as { code?: string };
  assert.strictEqual(refused.code, "not_permitted");
});
