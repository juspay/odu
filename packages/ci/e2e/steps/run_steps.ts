import * as assert from "node:assert";
import { basename } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { sharedRun } from "../../../web-acceptance/support/corpus.ts";
import {
  currentNixSystem,
  FAILING,
  FAST_RED,
  TIMELINE_SHAPES,
  headOf,
  LIVE_BURST,
  LONG_LOG,
  makeFixture,
  SLOW,
  startRun,
  waitSettled,
} from "../../../web-acceptance/support/service.ts";
import { RUN_SETUP_TIMEOUT, type OduWorld } from "../../../web-acceptance/support/world.ts";

function ownFixture(world: OduWorld, justfile: string): string {
  const dir = makeFixture(justfile);
  world.ownFixtures.push(dir);
  world.checkout = dir;
  return dir;
}

Given(
  "a settled red run of the failing fixture",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const run = await sharedRun(this.service, "failing", FAILING, this.scenarioName);
    this.checkout = run.checkout;
    this.runId = run.runId;
    const failure = run.failures[0];
    assert.ok(
      failure !== undefined,
      "the shared failing fixture settled with no failures, so there is nothing to read",
    );
    this.failureNode = failure.node;
    this.failureLogKey = failure.logKey;
  },
);

Given(
  "a settled run of the fixture whose node prints five thousand lines",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const run = await sharedRun(this.service, "long-log", LONG_LOG, this.scenarioName);
    this.checkout = run.checkout;
    this.runId = run.runId;
  },
);

Given(
  "a fresh settled red run of the failing fixture",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const dir = ownFixture(this, FAILING);
    const runId = startRun(this.service, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: `wa-fresh-${crypto.randomUUID()}`,
    });
    this.ownRuns.push(runId);
    this.runId = runId;
    await waitSettled(this.service, runId, RUN_SETUP_TIMEOUT);
  },
);

Given(
  "a run of the fixture where one lane fails at once and its sibling sleeps",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const dir = ownFixture(this, FAST_RED);
    const runId = startRun(this.service, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: `wa-live-${crypto.randomUUID()}`,
    });
    this.ownRuns.push(runId);
    this.runId = runId;
  },
);

Given(
  "a run of the fixture with a settled, a running and a waiting lane",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const dir = ownFixture(this, TIMELINE_SHAPES);
    const runId = startRun(this.service, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: `wa-timeline-${crypto.randomUUID()}`,
    });
    this.ownRuns.push(runId);
    this.runId = runId;
  },
);

Given(
  "a live run of the fixture whose node bursts and then stops",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    const dir = ownFixture(this, LIVE_BURST);
    const runId = startRun(this.service, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: `wa-burst-${crypto.randomUUID()}`,
    });
    this.ownRuns.push(runId);
    this.runId = runId;
  },
);

Given("a fixture checkout whose pipeline fails", function (this: OduWorld) {
  ownFixture(this, FAILING);
});

Given("a fixture checkout that stays running", function (this: OduWorld) {
  ownFixture(this, SLOW);
});

Given(
  "that checkout has a live run",
  { timeout: RUN_SETUP_TIMEOUT },
  function (this: OduWorld) {
    const dir = this.checkout;
    assert.ok(dir !== undefined, "no fixture checkout has been made yet");
    const runId = startRun(this.service, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: `wa-existing-${crypto.randomUUID()}`,
    });
    this.ownRuns.push(runId);
    this.runId = runId;
  },
);

Given("I open that run", { timeout: RUN_SETUP_TIMEOUT }, async function (this: OduWorld) {
  assert.ok(this.runId !== undefined, "no run has been arranged for this scenario");
  await this.open(`#/run/${this.runId}`);
  await this.page.locator("section.detail").waitFor();
  const header = this.page.locator(".detail-ref");
  await this.waitUntil(
    async () => /^[0-9a-f]{7}/.test((await header.innerText()).trim()),
    "the run header to name the run rather than the placeholder",
  );
  this.runRef = (await header.innerText()).trim();
});

When("I open the run on the board that is not this one", async function (this: OduWorld) {
  const ref = this.runRef;
  assert.ok(ref !== undefined, "no run was opened first, so there is no 'this one'");
  const refs = await this.page.locator("button.row .row-sha").allInnerTexts();
  const other = refs.map((text) => text.trim()).find((text) => text !== ref);
  assert.ok(
    other !== undefined,
    `no row on the board is a run other than ${ref} — the board offered ${refs.join(", ") || "nothing"}`,
  );
  await this.page.locator("button.row", { hasText: other }).first().click();
  await this.page.locator("section.detail").waitFor();
});

async function nodeStatus(world: OduWorld, id: string, status: string): Promise<void> {
  const row = world.nodeRow(id);
  let last = "(the row was never there)";
  await world.waitUntil(
    async () => {
      try {
        last = (await row.first().getAttribute("class", { timeout: 1000 })) ?? "";
      } catch {
        return false;
      }
      return last.split(/\s+/).includes(`node-${status}`);
    },
    `the node ${id} to be ${status} (its row read "${last}")`,
    120_000,
  );
}

Then("the node {string} is failed", async function (this: OduWorld, id: string) {
  await nodeStatus(this, id, "failed");
});

Then("the node {string} is running", async function (this: OduWorld, id: string) {
  await nodeStatus(this, id, "running");
});

Then("the node {string} is ok", async function (this: OduWorld, id: string) {
  await nodeStatus(this, id, "ok");
});

Then("the run has reached no outcome", async function (this: OduWorld) {
  const pills = await this.page.locator(".detail-head .pill").count();
  assert.strictEqual(
    pills,
    0,
    "the run already carries an outcome, so nothing below is about a LIVE run",
  );
});

Then("the run detail shows the node {string}", async function (this: OduWorld, id: string) {
  await this.nodeRow(id).first().waitFor({ timeout: 120_000 });
});

When(
  "I press {string} on {string}",
  async function (this: OduWorld, label: string, id: string) {
    await this.nodeRow(id).first().getByRole("button", { name: label, exact: true }).click();
  },
);

Then(
  "the node {string} reaches {string}",
  async function (this: OduWorld, id: string, text: string) {
    await this.saysThat(
      this.nodeRow(id).first().locator(".node-attempt"),
      `the node ${id}`,
      text,
      180_000,
    );
  },
);

When("I press the cancel button for this machine's lane", async function (this: OduWorld) {
  await this.page
    .getByRole("button", { name: `Cancel ${currentNixSystem()}`, exact: true })
    .click();
});

Then("the header reads {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator(".detail-head"), "the run header", text);
});

Then("the board lists two runs of the fixture project", async function (this: OduWorld) {
  const checkout = this.checkout;
  assert.ok(checkout !== undefined, "no fixture checkout has been made yet");
  const project = basename(checkout);
  const rows = this.page.locator("button.row", { hasText: project });
  await this.waitUntil(
    async () => (await rows.count()) === 2,
    `the board to list two runs of ${project}`,
  );
});
