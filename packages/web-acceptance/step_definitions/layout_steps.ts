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

/**
 * ONE TRACK BOX, down the whole list and up to the axis.
 *
 * A timeline is a set of bars that share a scale. The share is geometric, not
 * notional: if two rows' tracks are different widths, `left: 50%` on one is a
 * different instant from `left: 50%` on the other, and the axis above them
 * labels neither. That is what shipped before this step existed — the track
 * lived inside the row's BUTTON, which is `flex: 1` beside a controls cell that
 * is empty on a pending row, one button wide on a settled one and wider again
 * on a running one.
 *
 * So this measures boxes (the file's doctrine: a rule that stopped applying
 * leaves every class exactly where it was) and demands the run show all three
 * row states, because a scenario that happened to hold only settled rows would
 * pass over the very defect it is here for.
 */
Then(
  "every node's timeline track is the same box as the axis",
  async function (this: OduWorld) {
    const axis = await this.page.locator(".node-axis-track").boundingBox();
    assert.ok(axis !== null, "the timeline axis is not laid out at all");

    const states = await this.page.evaluate(() =>
      [...document.querySelectorAll("li.node")].map((node) => {
        const track = node.querySelector(".node-track");
        const box = track?.getBoundingClientRect();
        return {
          id: node.querySelector(".node-id")?.textContent ?? "(unnamed)",
          // What the row's CONTROLS cell holds — the thing that used to decide
          // the track's width, read as what it is rather than as a status.
          controls: (node.querySelector(".node-controls")?.textContent ?? "").trim(),
          box: box === undefined ? null : { x: box.x, width: box.width },
        };
      }),
    );
    assert.ok(states.length > 0, "the run listed no nodes, so this asserted nothing");

    // The three row shapes whose controls cell differs — the exact thing that
    // used to vary the track: nothing (a node that has not started), `Cancel
    // node` (one still running), `Retry` (one that has stopped). A run holding
    // only one of them cannot speak to the defect.
    const shapes: Record<string, (controls: string) => boolean> = {
      "no controls": (controls) => controls === "",
      "a running node's Cancel": (controls) => controls.includes("Cancel node"),
      "a stopped node's Retry": (controls) => controls.includes("Retry"),
    };
    for (const [wanted, holds] of Object.entries(shapes)) {
      assert.ok(
        states.some((node) => holds(node.controls)),
        `no row with ${wanted} on this run — rows are ${states
          .map((node) => `${node.id}:[${node.controls}]`)
          .join(", ")}`,
      );
    }

    for (const node of states) {
      assert.ok(node.box !== null, `${node.id} has no timeline track`);
      assert.ok(
        Math.abs(node.box.x - axis.x) <= 1 &&
          Math.abs(node.box.width - axis.width) <= 1,
        `${node.id} has a track at x=${node.box.x} w=${node.box.width}, ` +
          `but the axis is x=${axis.x} w=${axis.width} — they do not share a scale`,
      );
    }
  },
);
