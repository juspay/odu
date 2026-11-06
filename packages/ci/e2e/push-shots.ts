#!/usr/bin/env bun
/**
 * REPRODUCIBLE SCREENSHOT EVIDENCE for the push step — the run page at the
 * three widths the UI rules name, in both themes, with a node that really
 * pushed.
 *
 * The same idea and the same shape as `board-shots.ts` beside it, narrowed to
 * one screen: a script committed with the change, driving the REAL nix-built
 * binary against a throwaway world, which anybody can re-run when the design
 * moves. It is not a test — nothing here asserts — it is the way the images in
 * the pull request were made.
 *
 *   odu=$(nix build .#odu --no-link --print-out-paths --accept-flake-config)/bin/odu
 *   nix develop .#e2e -c bun packages/ci/e2e/push-shots.ts "$odu" /tmp/odu-ui
 *
 * The run it photographs is arranged by `./support/pushFixture.ts` — the same
 * arrangement the acceptance scenario uses, so the picture and the assertion
 * are of one thing.
 *
 * TWO SHOTS per width per theme: the page with the Recipe log open, which is
 * where the push step and the header total are, and the same page with the
 * Push tab pressed, which is the log that used to be mixed into the recipe's.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

import { arrangePushingRun } from "./support/pushFixture.ts";
import {
  reserveWorldPorts,
  startService,
  stopService,
  workerPort,
  type Service,
} from "../../web-acceptance/support/service.ts";

const [, , oduArg, outArg, labelArg] = process.argv;
if (oduArg === undefined || outArg === undefined) {
  process.stderr.write(
    "usage: bun packages/ci/e2e/push-shots.ts <odu-binary> <outDir> [label]\n",
  );
  process.exit(2);
}
const odu = oduArg;
const outDir = outArg;
const label = labelArg ?? "after";
mkdirSync(outDir, { recursive: true });

/** The three widths the UI rules name. No phone here: the rule this change is
 *  measured against is "no horizontal overflow at 1280/1440/1920", and the
 *  narrow viewport already has a scenario of its own
 *  (`features/narrow.feature`). */
const VIEWPORTS = [
  { name: "1280", width: 1280, height: 1000 },
  { name: "1440", width: 1440, height: 1000 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

const THEMES = ["dark", "light"] as const;

/** PUT THE PAGE DOWN before the shutter: drop the focus ring and take the
 *  pointer off whatever was last pressed, so no tooltip is standing open over
 *  the screen being photographed. */
async function rest(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
}

/** Did this width leave the page scrollable sideways? Reported rather than
 *  asserted — this script makes evidence, and a number beside each shot is
 *  what makes the overflow rule checkable from the pull request. */
async function overflow(page: Page): Promise<number> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

const services: Service[] = [];
let browser: Browser | undefined;

try {
  await reserveWorldPorts();
  const service = await startService(odu, workerPort());
  services.push(service);

  process.stdout.write("push-shots: arranging a run that pushes…\n");
  const run = await arrangePushingRun(service, { bucket: "warm", requestId: "push-shots" });
  process.stdout.write(`push-shots: run ${run.runId} pushed into ${run.bucket}\n`);

  browser = await chromium.launch();
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      // BEFORE THE PAGE'S FIRST SCRIPT. The shell's `<head>` reads this key to
      // set `data-theme` before the first paint; writing it here is exactly
      // what the toggle does, so the shot is of a real pinned theme rather
      // than of a page somebody clicked.
      await context.addInitScript(
        ([key, value]) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            // A context that refuses storage still renders; it just renders
            // the default theme, which the shot's own name would then lie
            // about. Nothing to do about it here, and nothing worth dying for.
          }
        },
        ["odu.web.theme", theme] as const,
      );
      const page = await context.newPage();
      await page.goto(new URL(`#/run/${run.runId}`, service.origin).href, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("li.node").first().waitFor({ timeout: 60_000 });
      // The push step is on the node row; open the pushing node so the log
      // pane beside it is the one with two tabs.
      await page
        .locator("li.node", { hasText: "warm@" })
        .first()
        .locator("button.node-open")
        .click();
      await page.locator("pre.log-text").first().waitFor({ timeout: 60_000 });
      await rest(page);
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      const recipeShot = join(outDir, `${label}-run-recipe-${theme}-${viewport.name}.png`);
      await page.screenshot({ path: recipeShot, fullPage: true });
      process.stdout.write(`  ${recipeShot}  (overflow ${await overflow(page)}px)\n`);

      await page
        .getByRole("group", { name: "Log" })
        .getByRole("button", { name: "Push", exact: true })
        .click();
      await page.waitForTimeout(500);
      await rest(page);
      const pushShot = join(outDir, `${label}-run-push-${theme}-${viewport.name}.png`);
      await page.screenshot({ path: pushShot, fullPage: true });
      process.stdout.write(`  ${pushShot}  (overflow ${await overflow(page)}px)\n`);
      await context.close();
    }
  }
  process.stdout.write(`push-shots: wrote ${label} shots to ${outDir}\n`);
} finally {
  await browser?.close();
  for (const service of services) stopService(service);
}
