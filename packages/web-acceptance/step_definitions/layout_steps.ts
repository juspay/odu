import * as assert from "node:assert";
import { Then } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

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

Then("every run row's scope and attention are within the viewport", async function (this: OduWorld) {
  await this.page
    .locator("button.row")
    .first()
    .waitFor({ timeout: 30_000 });
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
          controls: (node.querySelector(".node-controls")?.textContent ?? "").trim(),
          box: box === undefined ? null : { x: box.x, width: box.width },
        };
      }),
    );
    assert.ok(states.length > 0, "the run listed no nodes, so this asserted nothing");

    const requiredRowShapes: Record<string, (controls: string) => boolean> = {
      "no controls": (controls) => controls === "",
      "a running node's Cancel": (controls) => controls.includes("Cancel node"),
      "a failed node's Retry": (controls) => controls.includes("Retry"),
    };
    for (const [wanted, holds] of Object.entries(requiredRowShapes)) {
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
