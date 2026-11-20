import { After, AfterAll, Before, BeforeAll, setDefaultTimeout, Status } from "@cucumber/cucumber";
import { chromium, type Browser } from "playwright";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_ARGS } from "./browser.ts";
import { clearCorpus } from "./corpus.ts";
import { doorEnv, identityOf, OPERATOR_LOGIN, signIn, STUB_LOGIN } from "./authWorld.ts";
import { DEFAULT_STUB_MODE, startGithubStub, withStubMode, type GithubStub } from "./githubStub.ts";
import {
  activeRunsOf,
  cancelRun,
  doorPort,
  oduCli,
  readOduBin,
  removeFixture,
  ROOT_TOKEN,
  startService,
  stopService,
  stubPort,
  reserveWorldPortsBeforeAnyWorldStarts,
  tunnelPort,
  workerPort,
  type Service,
} from "./service.ts";
import { startCloudflareStub, type CloudflareStub } from "./cloudflareStub.ts";
import { OduWorld } from "./world.ts";
import { RUN_SETUP_TIMEOUT, STEP_TIMEOUT } from "./budgets.ts";

setDefaultTimeout(STEP_TIMEOUT);

const HERE = import.meta.dirname;
const REPORTS = join(HERE, "..", "reports");
const workerId = (): string => process.env.CUCUMBER_WORKER_ID ?? "0";

const DESKTOP = { width: 1280, height: 900 } as const;
const NARROW = { width: 380, height: 720 } as const;

let browser: Browser | undefined;
let loopback: Service | undefined;
let door: Service | undefined;
let tunnel: Service | undefined;
let cloudflare: CloudflareStub | undefined;
let service: Service | undefined;
let github: GithubStub | undefined;
let secretDir: string | undefined;

async function loopbackService(odu: string): Promise<Service> {
  loopback ??= await startService(odu, workerPort());
  return loopback;
}

async function doorService(odu: string): Promise<Service> {
  if (door !== undefined) return door;
  if (github === undefined) throw new Error("web-acceptance: the GitHub stub never started");
  secretDir = mkdtempSync(join(tmpdir(), "odu-wa-secret-"));
  const secretFile = join(secretDir, "client-secret");
  writeFileSync(secretFile, "stub-client-secret\n", { mode: 0o600 });
  door = await startService(
    odu,
    doorPort(),
    doorEnv({
      origin: `http://127.0.0.1:${doorPort()}`,
      stubOrigin: github.origin,
      secretFile,
    }),
  );
  return door;
}

async function tunnelService(odu: string): Promise<Service> {
  if (tunnel !== undefined) return tunnel;
  cloudflare ??= startCloudflareStub();
  const dir = mkdtempSync(join(tmpdir(), "odu-wa-tunnel-"));
  const tokenFile = join(dir, "cloudflare-token");
  writeFileSync(tokenFile, "stub-cloudflare-token\n", { mode: 0o600 });
  tunnel = await startService(odu, tunnelPort(), {
    ODU_CLOUDFLARE_API_TOKEN_FILE: tokenFile,
    ODU_CLOUDFLARE_API: cloudflare.origin,
    ODU_CLOUDFLARE_PROBE_BASE: cloudflare.origin,
    PATH: `${cloudflare.cloudflaredBinDirForPath}:${process.env.PATH ?? ""}`,
  });
  return tunnel;
}

type Granting = { readonly kind: "root" } | { readonly kind: "session"; readonly token: string };

function grantInput(by: Granting, login: string, role: string): string {
  return JSON.stringify({ rootToken: by.kind === "root" ? ROOT_TOKEN : "", login, role });
}

function grantEnv(by: Granting): NodeJS.ProcessEnv {
  return by.kind === "session" ? { ODU_TOKEN: by.token } : {};
}

let operatorToken: string | undefined;

async function operator(odu: string, world: Service): Promise<string> {
  if (operatorToken !== undefined) return operatorToken;
  if (browser === undefined || github === undefined) {
    throw new Error("web-acceptance: no browser or stub to mint the operator");
  }
  const bootstrapped = oduCli(world, [
    "surface",
    "auth",
    "user_grant",
    "--input",
    grantInput({ kind: "root" }, OPERATOR_LOGIN, "owner"),
    "--json",
  ]);
  if (bootstrapped.status !== 0) {
    throw new Error(
      `web-acceptance: could not bootstrap ${OPERATOR_LOGIN} as the first owner\n` +
        `${bootstrapped.stderr}\n--- daemon log ---\n${readFileSync(world.logPath, "utf-8").slice(-4000)}`,
    );
  }
  const minting = browser;
  const stub = github;
  operatorToken = await withStubMode(
    stub,
    { ...DEFAULT_STUB_MODE, login: OPERATOR_LOGIN },
    async () => {
      const context = await minting.newContext({ baseURL: world.origin });
      try {
        const page = await context.newPage();
        await page.goto(new URL("/auth/github", world.origin).href, {
          waitUntil: "domcontentloaded",
        });
        await page.goto(new URL("#/profile", world.origin).href);
        await page.getByRole("button", { name: "Create token" }).waitFor({ timeout: 60_000 });
        await page.getByPlaceholder("token name, e.g. laptop").fill("operator");
        await page.getByRole("button", { name: "Create token" }).click();
        const block = page.locator("pre.use-block").first();
        await block.waitFor({ timeout: 60_000 });
        return (await block.innerText()).trim();
      } finally {
        await context.close();
      }
    },
  );
  return operatorToken;
}

async function worldFor(odu: string, identity: ReturnType<typeof identityOf>): Promise<Service> {
  if (identity.kind === "loopback") return loopbackService(odu);
  if (identity.kind === "tunnel") return tunnelService(odu);
  return doorService(odu);
}

function playwrightVersionInNodeModules(): string {
  const resolve = createRequire(import.meta.url);
  const manifest = JSON.parse(
    readFileSync(resolve.resolve("playwright/package.json"), "utf-8"),
  ) as { version: string };
  return manifest.version;
}

BeforeAll({ timeout: RUN_SETUP_TIMEOUT }, async () => {
  const odu = readOduBin();

  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers === undefined || browsers === "") {
    throw new Error(
      "PLAYWRIGHT_BROWSERS_PATH is unset. This suite drives a REAL browser and " +
        "never skips: a browser gate that can skip is a gate that grades nothing " +
        "on the machine where it matters most. Get the browsers from nixpkgs — " +
        "`just e2e-web` does it for you, or enter the shell yourself with " +
        "`nix develop .#e2e --accept-flake-config`.",
    );
  }

  const npm = playwrightVersionInNodeModules();
  const driver = process.env.PLAYWRIGHT_DRIVER_VERSION;
  if (driver === undefined || driver === "") {
    throw new Error(
      `PLAYWRIGHT_BROWSERS_PATH is set (${browsers}) but PLAYWRIGHT_DRIVER_VERSION is not, ` +
        "so the version match cannot be checked. Both are exported together by the `e2e` " +
        "devShell in flake.nix; a shell that supplies browsers without saying which driver " +
        "built them is a shell this suite will not trust.",
    );
  }
  if (npm !== driver) {
    throw new Error(
      `playwright ${npm} (npm) against playwright-driver ${driver} (nixpkgs). The driver ` +
        "refuses a browser build it was not compiled against, and the way it says so is " +
        "`Executable doesn't exist` at a store path that is real but wrong — minutes into a " +
        "lane, with nothing pointing at the version. Move the two together: set " +
        `packages/web-acceptance/package.json's "playwright" to ${driver}, or move the ` +
        "nixpkgs pin back. Never one without the other.",
    );
  }

  browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    args: [...BROWSER_ARGS],
  });
  await reserveWorldPortsBeforeAnyWorldStarts();
  github = await startGithubStub(stubPort());
  service = await loopbackService(odu);
});

Before({ timeout: RUN_SETUP_TIMEOUT }, async function (this: OduWorld, scenario) {
  if (browser === undefined || github === undefined) {
    throw new Error("web-acceptance: BeforeAll did not complete, so there is nothing to drive");
  }
  const odu = readOduBin();
  const identity = identityOf(scenario.pickle.tags);
  const world = await worldFor(odu, identity);
  this.identity = identity;
  this.signInLogin = STUB_LOGIN;
  if (identity.kind === "signed-in") {
    const token = await operator(odu, world);
    const by = { kind: "session", token } as const;
    const granted = oduCli(
      world,
      [
        "surface",
        "auth",
        "user_grant",
        "--input",
        grantInput(by, STUB_LOGIN, identity.role),
        "--json",
      ],
      grantEnv(by),
    );
    if (granted.status !== 0) {
      throw new Error(
        `web-acceptance: could not grant ${STUB_LOGIN} ${identity.role}\n` +
          `${granted.stderr}\n--- daemon log ---\n${readFileSync(world.logPath, "utf-8").slice(-4000)}`,
      );
    }
  }
  this.browser = browser;
  this.stub = github;
  github.mode = { ...DEFAULT_STUB_MODE, login: STUB_LOGIN };
  this.service = world;
  this.scenarioName = scenario.pickle.name;

  const narrow = scenario.pickle.tags.some((tag) => tag.name === "@narrow");
  this.context = await browser.newContext({
    viewport: narrow ? { ...NARROW } : { ...DESKTOP },
    baseURL: world.origin,
  });
  this.page = await this.context.newPage();

  this.errors = [];
  this.requests = [];
  this.expectedResponses = [];
  this.failedResponses = [];
  this.ownFixtures = [];
  this.ownRuns = [];

  this.page.on("pageerror", (error) => {
    this.errors.push(`pageerror: ${error.message}\n${error.stack ?? "(no stack)"}`);
  });
  this.page.on("console", (message) => {
    if (message.type() === "error") this.errors.push(`console.error: ${message.text()}`);
  });
  this.page.on("request", (request) => {
    this.requests.push(request.url());
  });
  this.page.on("response", (response) => {
    if (response.status() >= 400) {
      this.failedResponses.push({ status: response.status(), url: response.url() });
    }
  });

  if (identity.kind === "signed-in") await signIn(this);
});

After({ timeout: RUN_SETUP_TIMEOUT }, async function (this: OduWorld, scenario) {
  const failed = scenario.result?.status === Status.FAILED;
  if (this.page !== undefined && (failed || process.env.ODU_WA_SHOTS === "1")) {
    const slug =
      scenario.pickle.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "scenario";
    const dir = join(REPORTS, "screenshots");
    try {
      mkdirSync(dir, { recursive: true });
      await this.page.screenshot({
        path: join(dir, `${workerId()}-${failed ? "failed" : "passed"}-${slug}.png`),
        fullPage: true,
      });
    } catch (cause) {
      process.stderr.write(`web-acceptance: could not capture a screenshot: ${String(cause)}\n`);
    }
  }

  if (this.context !== undefined) await this.context.close();

  if (github !== undefined) github.mode = { ...DEFAULT_STUB_MODE };

  const stopped = new Set(this.ownRuns);
  for (const dir of this.ownFixtures) {
    try {
      for (const runId of activeRunsOf(this.service, dir)) stopped.add(runId);
    } catch (cause) {
      process.stderr.write(`web-acceptance: could not list a fixture's runs: ${String(cause)}\n`);
    }
  }
  for (const runId of stopped) cancelRun(this.service, runId);
  for (const dir of this.ownFixtures) removeFixture(dir);
});

AfterAll({ timeout: RUN_SETUP_TIMEOUT }, async () => {
  await clearCorpus();
  for (const world of [service, loopback, door, tunnel]) {
    if (world === undefined) continue;
    stopService(world);
  }
  service = undefined;
  loopback = undefined;
  door = undefined;
  tunnel = undefined;
  if (github !== undefined) {
    await github.close();
    github = undefined;
  }
  if (cloudflare !== undefined) {
    cloudflare.stop();
    cloudflare = undefined;
  }
  if (secretDir !== undefined) {
    rmSync(secretDir, { recursive: true, force: true });
    secretDir = undefined;
  }
  if (browser !== undefined) {
    await browser.close();
    browser = undefined;
  }
});
