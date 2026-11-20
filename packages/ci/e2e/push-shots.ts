#!/usr/bin/env bun

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

const VIEWPORTS = [
  { name: "1280", width: 1280, height: 1000 },
  { name: "1440", width: 1440, height: 1000 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

const THEMES = ["dark", "light"] as const;

async function settleForScreenshot(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
}

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
      await context.addInitScript(
        ([key, value]) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
          }
        },
        ["odu.web.theme", theme] as const,
      );
      const page = await context.newPage();
      await page.goto(new URL(`#/run/${run.runId}`, service.origin).href, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("li.node").first().waitFor({ timeout: 60_000 });
      await page
        .locator("li.node", { hasText: "warm@" })
        .first()
        .locator("button.node-open")
        .click();
      await page.locator("pre.log-text").first().waitFor({ timeout: 60_000 });
      await settleForScreenshot(page);
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      const recipeShot = join(outDir, `${label}-run-recipe-${theme}-${viewport.name}.png`);
      await page.screenshot({ path: recipeShot, fullPage: true });
      process.stdout.write(`  ${recipeShot}  (overflow ${await overflow(page)}px)\n`);

      await page
        .getByRole("group", { name: "Log" })
        .getByRole("button", { name: "Push", exact: true })
        .click();
      await page.waitForTimeout(500);
      await settleForScreenshot(page);
      const pushShot = join(outDir, `${label}-run-push-${theme}-${viewport.name}.png`);
      await page.screenshot({ path: pushShot, fullPage: true });
      process.stdout.write(`  ${pushShot}  (overflow ${await overflow(page)}px)\n`);
      await context.close();
    }
  }

  for (const theme of THEMES) {
    process.stdout.write(`push-shots: arranging a slow push (${theme})…\n`);
    const live = await arrangePushingRun(service, {
      bucket: `warming-${theme}`,
      requestId: `push-shots-live-${theme}`,
      payloadBytes: 512 * 1024 * 1024,
      settle: false,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: theme,
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      ([key, value]) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
        }
      },
      ["odu.web.theme", theme] as const,
    );
    const page = await context.newPage();
    await page.goto(new URL(`#/run/${live.runId}`, service.origin).href, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("li.node .node-push-step", { hasText: "pushing" })
      .first()
      .waitFor({ timeout: 300_000 });
    const shot = join(outDir, `${label}-run-pushing-${theme}-1440.png`);
    await page.screenshot({ path: shot, fullPage: true });
    process.stdout.write(`  ${shot}  (overflow ${await overflow(page)}px)\n`);
    await context.close();
  }
  process.stdout.write(`push-shots: wrote ${label} shots to ${outDir}\n`);
} finally {
  await browser?.close();
  for (const service of services) stopService(service);
}
