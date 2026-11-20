#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  FAILING,
  TIMELINE_SHAPES,
  doorPort,
  headOf,
  makeFixture,
  oduCli,
  reserveWorldPortsBeforeAnyWorldStarts,
  startRun,
  startService,
  stopService,
  stubPort,
  tunnelPort,
  waitSettled,
  workerPort,
  type Service,
} from "./support/service.ts";
import { doorEnv } from "./support/authWorld.ts";
import { startGithubStub } from "./support/githubStub.ts";
import { startCloudflareStub } from "./support/cloudflareStub.ts";

const [, , oduArg, outArg, labelArg] = process.argv;
if (oduArg === undefined || outArg === undefined) {
  process.stderr.write(
    "usage: bun tests/evidence/board-shots.ts <odu-binary> <outDir> [label]\n",
  );
  process.exit(2);
}
const odu = oduArg;
const outDir = outArg;
const label = labelArg ?? "after";
mkdirSync(outDir, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "phone", width: 390, height: 844 },
] as const;

const THEMES = ["dark", "light"] as const;

interface Shot {
  readonly name: string;
  readonly origin: string;
  readonly hash: string;
  readonly settle?: string;
  readonly act?: (page: Page) => Promise<void>;
}

async function settleForShutter(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
}

async function pinTheme(
  context: BrowserContext,
  theme: (typeof THEMES)[number],
): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
      }
    },
    ["odu.web.theme", theme] as const,
  );
}

async function shoot(browser: Browser, shots: ReadonlyArray<Shot>): Promise<void> {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      await pinTheme(context, theme);
      const page = await context.newPage();
      for (const shot of shots) {
        const url = new URL(shot.hash, shot.origin).href;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        if (shot.settle !== undefined) {
          await page
            .locator(shot.settle)
            .first()
            .waitFor({ timeout: 60_000 })
            .catch(() => {
              process.stderr.write(
                `  ! ${shot.name}: never saw ${shot.settle}; shooting anyway\n`,
              );
            });
        }
        await shot.act?.(page);
        await settleForShutter(page);
        await page.evaluate(() => document.fonts.ready).catch(() => undefined);
        const file = join(outDir, `${label}-${shot.name}-${theme}-${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        process.stdout.write(`  ${file}\n`);
      }
      await context.close();
    }
  }
}

function makeBucket(service: Service, name: string): boolean {
  const made = oduCli(service, ["cache", "create", name, "-o", "json"]);
  if (made.status !== 0) {
    process.stderr.write(`  ! bucket ${name}: ${made.stderr}\n`);
    return false;
  }
  return true;
}

function pushStorePath(service: Service, name: string, storePath: string): void {
  const minted = oduCli(service, ["cache", "token", "mint", name, "--write", "-o", "json"]);
  if (minted.status !== 0) {
    process.stderr.write(`  ! token for ${name}: ${minted.stderr}\n`);
    return;
  }
  const token = (JSON.parse(minted.stdout) as { token: string }).token;
  const pushed = oduCli(service, ["cache", "push", name, storePath, "-o", "json"], {
    ODU_CACHE_TOKEN: token,
  });
  if (pushed.status !== 0) process.stderr.write(`  ! push to ${name}: ${pushed.stderr}\n`);
}

const services: Service[] = [];
let browser: Browser | undefined;

try {
  await reserveWorldPortsBeforeAnyWorldStarts();

  const loopback = await startService(odu, workerPort());
  services.push(loopback);

  const red = makeFixture(FAILING);
  const green = makeFixture(TIMELINE_SHAPES);
  const redRun = startRun(loopback, {
    checkout: red,
    expectedSha: headOf(red),
    requestId: `shots-red-${crypto.randomUUID()}`,
  });
  const greenRun = startRun(loopback, {
    checkout: green,
    expectedSha: headOf(green),
    requestId: `shots-green-${crypto.randomUUID()}`,
  });
  await waitSettled(loopback, redRun, 600_000);
  await waitSettled(loopback, greenRun, 600_000);
  if (makeBucket(loopback, "kolu")) pushStorePath(loopback, "kolu", odu);
  makeBucket(loopback, "localtest");

  const github = await startGithubStub(stubPort());
  const secretDir = mkdtempSync(join(tmpdir(), "odu-shots-"));
  const secretFile = join(secretDir, "github-secret");
  writeFileSync(secretFile, "stub-client-secret\n", { mode: 0o600 });
  const door = await startService(
    odu,
    doorPort(),
    doorEnv({
      origin: `http://127.0.0.1:${doorPort()}`,
      stubOrigin: github.origin,
      secretFile,
    }),
  );
  services.push(door);

  const cloudflare = startCloudflareStub();
  const tokenFile = join(secretDir, "cloudflare-token");
  writeFileSync(tokenFile, "stub-cloudflare-token\n", { mode: 0o600 });
  const tunnel = await startService(odu, tunnelPort(), {
    ODU_CLOUDFLARE_API_TOKEN_FILE: tokenFile,
    ODU_CLOUDFLARE_API: cloudflare.origin,
    ODU_CLOUDFLARE_PROBE_BASE: cloudflare.origin,
    PATH: `${cloudflare.cloudflaredBinDirForPath}:${process.env.PATH ?? ""}`,
  });
  services.push(tunnel);

  browser = await chromium.launch();

  await shoot(browser, [
    { name: "runs", origin: loopback.origin, hash: "#/", settle: "button.row" },
    {
      name: "run",
      origin: loopback.origin,
      hash: `#/run/${redRun}`,
      settle: "li.node",
      act: async (page) => {
        const failed = page.locator("button.node-open").first();
        await failed.click().catch(() => undefined);
        await page.locator("pre.log-text").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      },
    },
    { name: "new-run", origin: loopback.origin, hash: "#/new", settle: "form" },
    { name: "machines", origin: loopback.origin, hash: "#/machines", settle: "h1" },
    { name: "maintenance", origin: loopback.origin, hash: "#/maintain", settle: "h1" },
    { name: "cache", origin: loopback.origin, hash: "#/cache", settle: "button.bucket" },
    { name: "bucket", origin: loopback.origin, hash: "#/cache/kolu", settle: "pre" },
    { name: "sign-in", origin: door.origin, hash: "#/", settle: ".signin-action, .action" },
    { name: "tunnel", origin: tunnel.origin, hash: "#/tunnel", settle: "section.tunnel" },
  ]);

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      await pinTheme(context, theme);
      const page = await context.newPage();
      await page.goto(new URL("/auth/github", door.origin).href, {
        waitUntil: "domcontentloaded",
      });
      for (const [name, hash] of [
        ["profile", "#/profile"],
        ["people", "#/people"],
      ] as const) {
        await page.goto(new URL(hash, door.origin).href, { waitUntil: "domcontentloaded" });
        await page.locator("h1").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await settleForShutter(page);
        await page.evaluate(() => document.fonts.ready).catch(() => undefined);
        const file = join(outDir, `${label}-${name}-${theme}-${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        process.stdout.write(`  ${file}\n`);
      }
      await context.close();
    }
  }

  process.stdout.write(`board-shots: wrote ${label} shots to ${outDir}\n`);
} finally {
  await browser?.close();
  for (const service of services) stopService(service);
}
