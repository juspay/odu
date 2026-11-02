#!/usr/bin/env bun
/**
 * REPRODUCIBLE SCREENSHOT EVIDENCE for the board — every screen, both themes,
 * desktop and phone.
 *
 * odu's other evidence is a terminal recording (`dev/skills/pr-evidence`),
 * because odu is a terminal tool. The BOARD is not, and a redesign's evidence
 * is what it looks like — so this is the same idea in the same shape: a script
 * committed beside the gifs' scripts, driving the REAL nix-built binary
 * against throwaway worlds, which anybody can re-run to regenerate the images
 * when the design moves.
 *
 *   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
 *   nix develop .#e2e -c bun tests/evidence/board-shots.ts "$odu" /tmp/shots after
 *
 * It reuses `packages/web-acceptance/support` rather than re-implementing a
 * harness: those modules already know how to start a private daemon, a door
 * daemon with a GitHub stub, a tunnel daemon with a Cloudflare stub, and how
 * to make a fixture checkout and run it. A second copy of that would be a
 * second thing to keep true.
 *
 * THREE WORLDS, because three facts cannot coexist in one daemon:
 *
 *   - **loopback** — no door, every caller its owner: the runs, a run, the new
 *     run form, machines, maintenance, the cache and a bucket;
 *   - **door** — `ODU_GITHUB_*` pointed at the stub: the sign-in screen (never
 *     signed in) and then the profile and people pages (signed in as owner);
 *   - **tunnel** — the cloudflare row mounted against its stub: the tunnel.
 *
 * Each shot is taken twice per viewport: once with the theme pinned `dark` and
 * once `light`. The pin is written into `localStorage` before the page's first
 * script runs, which is the same thing the toggle does — and `emulateMedia` is
 * set to match, so a build that has no toggle (the BEFORE half of this
 * comparison) still answers in both schemes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

import {
  FAILING,
  TIMELINE_SHAPES,
  doorPort,
  headOf,
  makeFixture,
  oduCli,
  reserveWorldPorts,
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

/** The two viewports the evidence is taken at: a 1440 desktop, which is what
 *  the design canvas was drawn at, and a 390 phone, which is the width the
 *  "no horizontal page scroll" gate is about. */
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "phone", width: 390, height: 844 },
] as const;

const THEMES = ["dark", "light"] as const;

/** One screenshot: a world's origin, a hash route, a name. */
interface Shot {
  readonly name: string;
  readonly origin: string;
  readonly hash: string;
  /** Something to wait for before the shutter — a selector that only exists
   *  once the wire has delivered the screen. Without it the shot is of a page
   *  mid-subscription, which is evidence of nothing. */
  readonly settle?: string;
  /** Run before the shot, for a screen that needs a control pressed to exist
   *  (a log pane needs a node chosen). */
  readonly act?: (page: Page) => Promise<void>;
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
      // BEFORE THE PAGE'S FIRST SCRIPT. The shell's `<head>` reads this key to
      // set `data-theme` before the first paint; writing it here is exactly
      // what the toggle does, so the shot is of a real pinned theme rather
      // than of a page somebody clicked.
      await context.addInitScript(
        ([key, value]) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            /* a build without a toggle ignores this and follows emulateMedia */
          }
        },
        ["odu.web.theme", theme] as const,
      );
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
        // One beat for the fonts: a shot taken before Geist arrives is a shot
        // of the fallback face, which is the one thing this evidence must not
        // show.
        await page.evaluate(() => document.fonts.ready).catch(() => undefined);
        const file = join(outDir, `${label}-${shot.name}-${theme}-${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        process.stdout.write(`  ${file}\n`);
      }
      await context.close();
    }
  }
}

/** A bucket to photograph, made the way a person makes one — the CLI, which is
 *  the arrange step the cache feature already uses. A token is minted and a
 *  path pushed so the page has numbers on it: a bucket page of zeroes is
 *  evidence that the page renders, not evidence of what it looks like. */
function makeBucket(service: Service, name: string, push: string | null): void {
  const made = oduCli(service, ["cache", "create", name, "-o", "json"]);
  if (made.status !== 0) {
    process.stderr.write(`  ! bucket ${name}: ${made.stderr}\n`);
    return;
  }
  if (push === null) return;
  const minted = oduCli(service, ["cache", "token", "mint", name, "--write", "-o", "json"]);
  if (minted.status !== 0) {
    process.stderr.write(`  ! token for ${name}: ${minted.stderr}\n`);
    return;
  }
  const token = (JSON.parse(minted.stdout) as { token: string }).token;
  const pushed = oduCli(service, ["cache", "push", name, push, "-o", "json"], {
    ODU_CACHE_TOKEN: token,
  });
  if (pushed.status !== 0) process.stderr.write(`  ! push to ${name}: ${pushed.stderr}\n`);
}

const services: Service[] = [];
let browser: Browser | undefined;

try {
  await reserveWorldPorts();

  // ── the loopback world ──
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
  // The odu binary's own closure is a real store path with a real NAR, so it
  // is the one thing every machine running this script is guaranteed to have
  // to push.
  makeBucket(loopback, "kolu", odu);
  makeBucket(loopback, "localtest", null);

  // ── the door world ──
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

  // ── the tunnel world ──
  const cloudflare = startCloudflareStub();
  const tokenFile = join(secretDir, "cloudflare-token");
  writeFileSync(tokenFile, "stub-cloudflare-token\n", { mode: 0o600 });
  const tunnel = await startService(odu, tunnelPort(), {
    ODU_CLOUDFLARE_API_TOKEN_FILE: tokenFile,
    ODU_CLOUDFLARE_API: cloudflare.origin,
    ODU_CLOUDFLARE_PROBE_BASE: cloudflare.origin,
    PATH: `${cloudflare.binDir}:${process.env.PATH ?? ""}`,
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
      // THE LOG IS THE POINT of this screen, and it is empty until a node is
      // chosen, so the shot opens the first failed one the way a person does.
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

  // THE SIGNED-IN SCREENS, in their own pass: the door world's browser has to
  // complete a sign-in first, and a context that has is a different context.
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
            /* see above */
          }
        },
        ["odu.web.theme", theme] as const,
      );
      const page = await context.newPage();
      // The way a person signs in: follow the link and let the stub authorise.
      await page.goto(new URL("/auth/github", door.origin).href, {
        waitUntil: "domcontentloaded",
      });
      for (const [name, hash] of [
        ["profile", "#/profile"],
        ["people", "#/people"],
      ] as const) {
        await page.goto(new URL(hash, door.origin).href, { waitUntil: "domcontentloaded" });
        await page.locator("h1").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
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
