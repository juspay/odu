import * as assert from "node:assert";
import { Then, When } from "@cucumber/cucumber";
import { headOf } from "../support/service.ts";
import type { OduWorld } from "../support/world.ts";

const TAB_BUDGET = 40;

const tabBudgetFor = (controls: readonly string[]): number => controls.length * 2 + 4;

async function focused(world: OduWorld): Promise<string> {
  return await world.page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return "(nothing)";
    const text = (el.textContent ?? "").trim().slice(0, 60);
    return `<${el.tagName.toLowerCase()}${el.id === "" ? "" : `#${el.id}`} class="${el.className}"> ${text}`;
  });
}

async function tabUntil(
  world: OduWorld,
  landed: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let press = 0; press < TAB_BUDGET; press += 1) {
    await world.page.keyboard.press("Tab");
    if (await landed()) return;
  }
  throw new Error(
    `web-acceptance: ${TAB_BUDGET} presses of Tab never reached ${what}. ` +
      `The focus ended on ${await focused(world)}.`,
  );
}

When("I tab to the {string} filter", async function (this: OduWorld, label: string) {
  await tabUntil(
    this,
    async () =>
      await this.page.evaluate((wanted) => {
        const el = document.activeElement;
        return (
          el !== null &&
          el.tagName === "BUTTON" &&
          (el.textContent ?? "").trim() === wanted &&
          el.closest(".filters") !== null
        );
      }, label),
    `the "${label}" filter`,
  );
});

When("I tab to the first run row", async function (this: OduWorld) {
  await this.page.locator("tbody tr.row, .row").first().waitFor({ timeout: 30_000 });
  await tabUntil(
    this,
    async () =>
      await this.page.evaluate(
        () => document.activeElement?.classList.contains("row") === true,
      ),
    "a run row",
  );
});

When("I press Enter", async function (this: OduWorld) {
  await this.page.keyboard.press("Enter");
});

When("I press Space", async function (this: OduWorld) {
  await this.page.keyboard.press("Space");
});

When("I tab to the {string} option", async function (this: OduWorld, label: string) {
  await tabUntil(
    this,
    async () =>
      await this.page.evaluate((wanted) => {
        const el = document.activeElement;
        return (
          el instanceof HTMLInputElement &&
          el.type === "checkbox" &&
          (el.closest("label")?.textContent ?? "").trim() === wanted
        );
      }, label),
    `the "${label}" option`,
  );
});

Then("that option is ticked", async function (this: OduWorld) {
  const ticked = await this.page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : null;
  });
  assert.strictEqual(ticked, true, "Space did not tick the focused option");
});

When("I shift-tab back to the {string} field", async function (this: OduWorld, label: string) {
  const id = await this.page.evaluate(
    (wanted) =>
      [...document.querySelectorAll("label[for]")].find(
        (el) => (el.textContent ?? "").trim() === wanted,
      )?.getAttribute("for") ?? null,
    label,
  );
  assert.ok(id !== null, `no label reads "${label}", so nothing binds it to a field`);
  for (let press = 0; press < TAB_BUDGET; press += 1) {
    await this.page.keyboard.press("Shift+Tab");
    if (await this.page.evaluate((wanted) => document.activeElement?.id === wanted, id)) return;
  }
  throw new Error(
    `web-acceptance: ${TAB_BUDGET} presses of Shift+Tab never reached the "${label}" field. ` +
      `The focus ended on ${await focused(this)}.`,
  );
});

When("I focus {string} and type the fixture path", async function (this: OduWorld, label: string) {
  const dir = this.checkout;
  assert.ok(dir !== undefined, "no fixture checkout has been made yet");
  await this.page.getByLabel(label, { exact: true }).focus();
  await this.page.keyboard.type(dir);
});

When("I press Tab and type the fixture HEAD", async function (this: OduWorld) {
  const dir = this.checkout;
  assert.ok(dir !== undefined, "no fixture checkout has been made yet");
  await this.page.keyboard.press("Tab");
  await this.page.keyboard.type(headOf(dir));
});

Then("every control on the page is a real button", async function (this: OduWorld) {
  const wrong = await this.page.evaluate(() =>
    [...document.querySelectorAll(".row, .btn, .node-open, [onclick]")]
      .filter((el) => el.tagName !== "BUTTON")
      .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">`),
  );
  assert.deepStrictEqual(
    wrong,
    [],
    `these look like controls but are not buttons: ${wrong.join(", ")}`,
  );
});

Then("every visible control can be reached by tabbing", async function (this: OduWorld) {
  const expected = await this.page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, input, select, textarea")].filter(
      (el) => !(el as HTMLButtonElement).disabled && (el as HTMLElement).offsetParent !== null,
    );
    controls.forEach((el, index) => {
      (el as HTMLElement).dataset.waTab = String(index);
    });
    return controls.map((_, index) => String(index));
  });
  assert.ok(expected.length > 0, "the page offered no controls, so this asserted nothing");

  await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const reached = new Set<string>();
  const budget = tabBudgetFor(expected);
  for (let press = 0; press < budget; press += 1) {
    await this.page.keyboard.press("Tab");
    const mark = await this.page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.waTab,
    );
    if (mark !== undefined) reached.add(mark);
    if (reached.size === expected.length) break;
  }

  const missed = expected.filter((mark) => !reached.has(mark));
  if (missed.length > 0) {
    const names = await this.page.evaluate(
      (marks) =>
        marks.map((mark) => {
          const el = document.querySelector(`[data-wa-tab="${mark}"]`);
          return el === null ? mark : `<${el.tagName.toLowerCase()}> ${(el.textContent ?? "").trim()}`;
        }),
      missed,
    );
    assert.fail(`tabbing never reached ${missed.length} visible control(s): ${names.join(" · ")}`);
  }
});
