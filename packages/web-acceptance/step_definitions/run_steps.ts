/**
 * Arranging a run, opening it, and asserting on its nodes.
 *
 * **What the wire is allowed to do here.** The `Given` steps below start runs
 * through `run_start` rather than through the form. That is ARRANGEMENT: a
 * scenario about the retry button needs a failed node to press it on, and
 * spending forty seconds driving the create form to get one would be testing the
 * form again in every feature. Nothing below ACTS through the wire — every
 * retry, cancel and selection in this suite goes through a control, because
 * "clicking through these workflows" is the acceptance criterion and a verb call
 * dressed as a step would quietly not meet it.
 *
 * **Shared versus fresh.** "a settled red run" is the worker's cached one and is
 * READ ONLY; "a fresh settled red run" builds its own and may be mutated. See
 * `support/corpus.ts` for the guard that catches the mistake.
 */

import * as assert from "node:assert";
import { basename } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { sharedRun } from "../support/corpus.ts";
import {
  currentNixSystem,
  FAILING,
  FAST_RED,
  headOf,
  LONG_LOG,
  makeFixture,
  SLOW,
  startRun,
  waitSettled,
} from "../support/service.ts";
import { RUN_SETUP_TIMEOUT, type OduWorld } from "../support/world.ts";

/** A private fixture, remembered so `After` removes it. */
function ownFixture(world: OduWorld, justfile: string): string {
  const dir = makeFixture(justfile);
  world.ownFixtures.push(dir);
  world.checkout = dir;
  return dir;
}

// ── arranging ───────────────────────────────────────────────────────────────

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
    // No wait here. The run is live by construction — `slow` sleeps for two
    // minutes — and every assertion that follows is made in the browser, which
    // is where the coordinator's progress is supposed to show up. A wait on the
    // wire before opening the page would be this suite checking the service and
    // then hoping the browser agreed.
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

// ── opening ─────────────────────────────────────────────────────────────────

Given("I open that run", { timeout: RUN_SETUP_TIMEOUT }, async function (this: OduWorld) {
  assert.ok(this.runId !== undefined, "no run has been arranged for this scenario");
  await this.open(`#/run/${this.runId}`);
  await this.page.locator("section.detail").waitFor();
  // The `<sha7>#<seq>` ref this run is KNOWN BY, remembered while it is on
  // screen. It is the only handle a board row offers — rows carry no run id —
  // so a later step that has to tell two runs of one checkout apart needs it.
  //
  // WAITED FOR, not read on arrival. The detail view renders as soon as the
  // route moves and draws the placeholder "run" until the row itself lands, so
  // reading immediately captured that word — and a later step then looked for a
  // board row containing "run", found none, and clicked whichever came first.
  const header = this.page.locator(".detail-head h1");
  await this.waitUntil(
    async () => /^[0-9a-f]{7}/.test((await header.innerText()).trim()),
    "the run header to name the run rather than the placeholder",
  );
  this.runRef = (await header.innerText()).trim();
});

/**
 * Open the OTHER run of this checkout.
 *
 * Not "the newest", and not by POSITION either. Both were tried and both were
 * wrong for the same underlying reason: the board is a live collection sorted by
 * creation time, and a linked replay lands in it while the page is open. "The
 * newest" picked the parent. Reading row 1's ref and then clicking row 1 read
 * one run and clicked another, because the rows had re-sorted in between —
 * which is exactly the race a positional selector cannot see.
 *
 * So the ref is read first and then used to ADDRESS the row. The two runs of one
 * checkout differ in the ordinal half of their `<sha7>#<seq>` ref, which is what
 * a person telling them apart on the board would use too.
 */
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

// ── asserting ───────────────────────────────────────────────────────────────

/** Wait for one node's row to carry a status class, and say what it carried
 *  instead. The class is `node-<status>` and the status comes straight off the
 *  wire, so this is an assertion about what the SERVICE said, drawn. */
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

/** No outcome pill in the header. The detail header renders one only when the
 *  run HAS reached a verdict, so its absence is the run still being live —
 *  asserted on the page rather than on a stopwatch, because "the sibling had not
 *  finished yet" is a claim about state and never about elapsed time. */
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

/** A node's attempt ordinal, drawn as `attempt N` beside its id — which the row
 *  only renders past the first, because "attempt 1" on every node would be
 *  noise. Registered once and read as either keyword: logs.feature uses it as an
 *  `And` in the middle of a When block, and cucumber matches on TEXT. */
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

/**
 * The per-lane cancel button.
 *
 * Its label is `Cancel <platform>`, and the platform is the `@…` half of a node
 * id — which the coordinator mints from `builtins.currentSystem`. So the name is
 * asked of Nix rather than spelled here: a suite that hardcoded `x86_64-linux`
 * would pass on one runner and fail on the other for a reason having nothing to
 * do with the button.
 */
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
