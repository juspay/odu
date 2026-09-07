/**
 * What a narrow viewport actually does, measured.
 *
 * Every assertion here is GEOMETRY read out of the live layout, never a class
 * name. A media query that stopped applying — a breakpoint edited, a rule moved
 * behind a more specific one — leaves every class exactly where it was, so a
 * test that read classes would go on passing over a board scrolling sideways.
 * Bounding boxes cannot be fooled that way.
 */

import * as assert from "node:assert";
import { Then } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

/** No horizontal overflow on the DOCUMENT. Scoped to the document on purpose:
 *  `pre.log-text` scrolls sideways by design, because wrapping a log line
 *  changes what it says, and that box is explicitly `overflow: auto` so its
 *  content never reaches this measurement. */
Then("the page does not scroll sideways", async function (this: OduWorld) {
  const measured = await this.page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  assert.ok(
    measured.scroll <= measured.view,
    `the page is ${measured.scroll}px wide in a ${measured.view}px viewport, so it scrolls sideways`,
  );
});

/**
 * The two facts a narrow row must not drop.
 *
 * `row-scope` is what a green actually covers and `row-attention` is whether
 * anything is waiting on you — the two columns a reflow is most tempted to hide,
 * and the two whose absence turns the board back into a thing you have to click
 * through. Both must be laid out AND inside the viewport, so a rule that moved
 * one off the right edge instead of onto its own line fails here.
 */
Then("every run row's scope and attention are within the viewport", async function (this: OduWorld) {
  const view = await this.page.evaluate(() => window.innerWidth);
  const rows = await this.page.locator("button.row").count();
  assert.ok(rows > 0, "the board listed no rows, so this scenario asserted nothing");
  for (let index = 0; index < rows; index += 1) {
    const row = this.page.locator("button.row").nth(index);
    for (const part of ["row-scope", "row-attention"]) {
      const box = await row.locator(`.${part}`).boundingBox();
      assert.ok(box !== null, `row ${index}'s .${part} is not laid out at all`);
      assert.ok(
        box.x >= 0 && box.x + box.width <= view + 1,
        `row ${index}'s .${part} runs from ${box.x} to ${box.x + box.width} in a ${view}px viewport`,
      );
    }
  }
});

/** Stacked, not side by side — asserted as one box being BELOW the other rather
 *  than as a grid-template-columns value, because what a person cares about is
 *  that neither panel got squeezed to a column too narrow to read. */
Then("the nodes and the output are stacked, not side by side", async function (this: OduWorld) {
  const nodes = await this.page.locator('[aria-label="Nodes"]').boundingBox();
  const output = await this.page.locator('[aria-label="Node output"]').boundingBox();
  assert.ok(nodes !== null && output !== null, "one of the two detail panels is not laid out");
  assert.ok(
    output.y >= nodes.y + nodes.height - 1,
    `the output panel starts at y=${output.y}, but the nodes panel still runs to ` +
      `y=${nodes.y + nodes.height} — they are side by side`,
  );
});
