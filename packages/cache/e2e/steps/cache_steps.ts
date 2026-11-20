import * as assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { After, AfterAll, Given, Then, When } from "@cucumber/cucumber";
import type { Locator } from "playwright";
import { type Gateway, startGateway } from "@odu/objects/testing";
import {
  oduCli,
  readOduBin,
  ROOT_TOKEN,
  type Service,
  startService,
  stopService,
  until,
} from "../../../web-acceptance/support/service.ts";
import { type OduWorld, RUN_SETUP_TIMEOUT } from "../../../web-acceptance/support/world.ts";

function unique(what: string): string {
  return `wa-${what}-${Math.random().toString(36).slice(2, 10)}`;
}

function cacheVerb(
  world: OduWorld,
  verb: string,
  input: unknown,
  env: NodeJS.ProcessEnv = {},
) {
  return oduCli(
    world.service,
    ["surface", "cache", verb, "--input", JSON.stringify(input), "--json"],
    env,
  );
}

function mintedToken(answer: { stdout: string }): string {
  const payload = JSON.parse(answer.stdout) as { token?: unknown };
  assert.ok(
    typeof payload.token === "string" && payload.token !== "",
    `token_mint answered no plaintext token: ${answer.stdout}`,
  );
  return payload.token;
}

interface FileSpec {
  readonly name: string;
  readonly body: string;
}

function arrangePush(world: OduWorld, howMany = 1, states: readonly string[] = []): void {
  arrangeFiles(
    world,
    Array.from({ length: howMany }, (_, index) => {
      const name = unique(index === 0 ? "path" : `path-${index}`);
      return { name, body: `odu web acceptance: ${name}\n` };
    }),
    states,
  );
}

function arrangeFiles(
  world: OduWorld,
  specs: readonly FileSpec[],
  states: readonly string[] = [],
): void {
  const bucket = unique("bucket");
  const paths: string[] = [];
  for (const spec of specs) {
    const file = join(mkdtempSync(join(tmpdir(), "odu-wa-cache-")), spec.name);
    writeFileSync(file, spec.body);
    const added = spawnSync("nix", ["store", "add-file", file], {
      env: world.service.env,
      encoding: "utf-8",
    });
    assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
    paths.push(added.stdout.trim());
  }
  const path = paths[0] as string;

  const created = cacheVerb(world, "bucket_create", {
    rootToken: ROOT_TOKEN,
    name: bucket,
    public: true,
    retentionDays: 90,
  });
  assert.strictEqual(
    created.status,
    0,
    `cache bucket_create failed: ${created.stderr}`,
  );

  const minted = cacheVerb(world, "token_mint", {
    rootToken: ROOT_TOKEN,
    bucket,
    scope: "write",
  });
  assert.strictEqual(minted.status, 0, `cache token_mint failed: ${minted.stderr}`);

  const pushed = oduCli(
    world.service,
    ["cache", "push", bucket, ...paths, ...states, "-o", "json"],
    { ODU_CACHE_TOKEN: mintedToken(minted) },
  );
  assert.strictEqual(pushed.status, 0, `odu cache push failed: ${pushed.stderr}`);

  world.cacheBucket = bucket;
  world.cachePath = path;
  world.cachePathName = path.split("/").pop()?.replace(/^[a-z0-9]{32}-/, "") ?? "";
  world.cachePaths = paths;
  world.cachePathNames = paths.map(
    (one) => one.split("/").pop()?.replace(/^[a-z0-9]{32}-/, "") ?? "",
  );
}

function addLeafPath(world: OduWorld): string {
  const name = unique("door-path");
  const file = join(mkdtempSync(join(tmpdir(), "odu-wa-cache-")), name);
  writeFileSync(file, `odu web acceptance: ${name}\n`);
  const added = spawnSync("nix", ["store", "add-file", file], {
    env: world.service.env,
    encoding: "utf-8",
  });
  assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
  return added.stdout.trim();
}

When(
  "one path is pushed to it with a bucket token and no session",
  function (this: OduWorld) {
    const bucket = this.cacheBucket;
    assert.ok(bucket !== undefined, "no bucket was created for this scenario");
    assert.ok(this.mintedToken !== undefined, "no personal token was minted");
    const mint = cacheVerb(
      this,
      "token_mint",
      { rootToken: "", bucket, scope: "write" },
      { ODU_TOKEN: this.mintedToken },
    );
    assert.strictEqual(mint.status, 0, `cache token_mint failed: ${mint.stderr}`);
    const path = addLeafPath(this);
    const token = mintedToken(mint);
    const pushed = oduCli(this.service, ["cache", "push", bucket, path, "-o", "json"], {
      ODU_CACHE_TOKEN: token,
    });
    assert.strictEqual(
      pushed.status,
      0,
      `odu cache push through the door failed: ${pushed.stderr}${pushed.stdout}`,
    );
    this.cachePath = path;
    minted(this).token = token;
  },
);

Then("the bucket serves that path's narinfo to the token", async function (this: OduWorld) {
  const path = this.cachePath;
  assert.ok(path !== undefined && this.cacheBucket !== undefined, "nothing was pushed");
  const hash = (path.split("/").pop() ?? "").slice(0, 32);
  const answer = await fetch(
    new URL(`/cache/${this.cacheBucket}/${hash}.narinfo`, this.service.origin),
    { headers: { authorization: `Bearer ${minted(this).token}` } },
  );
  const body = await answer.text();
  assert.strictEqual(answer.status, 200, `the narinfo answered ${answer.status}: ${body}`);
  assert.match(answer.headers.get("content-type") ?? "", /narinfo/);
  assert.ok(body.includes(`StorePath: ${path}`), `the narinfo names another path:\n${body}`);
});

Given("a bucket with one path pushed from the CLI", function (this: OduWorld) {
  arrangePush(this);
});

Given("a bucket with two paths pushed from the CLI", function (this: OduWorld) {
  arrangePush(this, 2);
});

Given(
  "a bucket with one path pushed from the CLI with a run and a commit",
  function (this: OduWorld) {
    const stated: StatedProvenance = {
      run: unique("run"),
      commit: "abcdef0123456789".repeat(3).slice(0, 40),
    };
    this.rowState.set(PROVENANCE, stated);
    arrangePush(this, 1, ["--run", stated.run, "--commit", stated.commit]);
  },
);

Given(
  "a bucket with three builds of one package pushed from the CLI",
  function (this: OduWorld) {
    const name = unique("widget");
    arrangeFiles(this, [1, 2, 3].map((build) => ({ name, body: `build ${build}\n` })));
  },
);

Given("a bucket with a large and a small path pushed from the CLI", function (this: OduWorld) {
  arrangeFiles(this, [
    { name: unique("large"), body: "x".repeat(400_000) },
    { name: unique("small"), body: "x\n" },
  ]);
});

Given("a bucket with {int} paths pushed from the CLI", function (this: OduWorld, count: number) {
  arrangePush(this, count);
});

When("a bucket with one path is pushed from the CLI", function (this: OduWorld) {
  arrangePush(this);
});

Given("I open the cache", async function (this: OduWorld) {
  await this.open("#/cache");
  await this.page.getByRole("heading", { name: "Cache", exact: true }).waitFor();
});

When("I open that bucket", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await this.open(`#/cache/${name}`);
  await this.page.getByRole("heading", { name, exact: true }).waitFor();
});

When("I open a bucket the cache does not have", async function (this: OduWorld) {
  await this.open("#/cache/wa-no-such-bucket");
  await this.page.getByRole("heading", { name: "wa-no-such-bucket", exact: true }).waitFor();
  await this.page
    .locator("p.empty", { hasText: "This bucket is not on the board" })
    .first()
    .waitFor({ timeout: 30_000 });
});

When("I filter the paths by {string}", async function (this: OduWorld, text: string) {
  const box = this.page.getByRole("searchbox", { name: "filter paths" });
  await box.fill(text);
});

When("I filter the paths by the first path's name", async function (this: OduWorld) {
  const name = this.cachePathNames?.[0];
  assert.ok(name !== undefined && name !== "", "no path was arranged");
  await this.page.getByRole("searchbox", { name: "filter paths" }).fill(name);
});

function pathRow(world: OduWorld, name: string): Locator {
  return world.page.locator("table.paths-table tbody tr", { hasText: name }).first();
}

async function cellUnder(world: OduWorld, row: Locator, header: string): Promise<Locator> {
  const headers = world.page.locator("table.paths-table thead th");
  await headers.first().waitFor({ timeout: 30_000 });
  const words = (await headers.allInnerTexts()).map((text) =>
    text.replace(/[↑↓]/g, "").trim().toLowerCase(),
  );
  const index = words.indexOf(header);
  assert.ok(index >= 0, `no "${header}" column in the paths table (it has ${words.join(", ")})`);
  return row.locator("td").nth(index);
}

function pushedRow(world: OduWorld, which: 0 | 1): Locator {
  const path = world.cachePaths?.[which];
  assert.ok(path !== undefined, `path ${which + 1} was not pushed`);
  return pathRow(world, path.slice(path.indexOf("-") + 1));
}

async function keptBySays(world: OduWorld, which: 0 | 1, expected: RegExp | string): Promise<Locator> {
  const cell = await cellUnder(world, pushedRow(world, which), "kept by");
  await until(`path ${which + 1} to be kept by ${String(expected)}`, async () => {
    const text = (await cell.innerText().catch(() => "")).trim();
    return (typeof expected === "string" ? text === expected : expected.test(text)) ? true : null;
  });
  return cell;
}

Then("the first path is kept by {string}", async function (this: OduWorld, text: string) {
  await keptBySays(this, 0, text);
});

Then("the second path is kept by {string}", async function (this: OduWorld, text: string) {
  await keptBySays(this, 1, text);
});

Then("the second path is kept by retention, with a day it leaves", async function (this: OduWorld) {
  const cell = await keptBySays(this, 1, /^retention · in \d+d$/);
  const title = await cell.locator("span").getAttribute("title");
  assert.match(title ?? "", /leaves at the first collection after \d{4}-\d{2}-\d{2}$/);
});

Then("both pushed paths are listed", async function (this: OduWorld) {
  for (const name of this.cachePathNames ?? []) {
    await pathRow(this, name).waitFor({ timeout: 30_000 });
  }
});

Then("the first path is listed", async function (this: OduWorld) {
  const name = this.cachePathNames?.[0];
  assert.ok(name !== undefined, "no path was arranged");
  await pathRow(this, name).waitFor({ timeout: 30_000 });
});

Then("the second path is not listed", async function (this: OduWorld) {
  const name = this.cachePathNames?.[1];
  assert.ok(name !== undefined, "no second path was arranged");
  await this.waitUntil(
    async () =>
      (await this.page.locator("table.paths-table tbody tr", { hasText: name }).count()) === 0,
    "the second path to disappear",
  );
});

Then("the tab counts the failing run", async function (this: OduWorld) {
  await this.waitUntil(
    async () => (await this.page.title()) === "✗ 1 failing · odu",
    `the tab to read "✗ 1 failing · odu" (it read ${JSON.stringify(await this.page.title())})`,
  );
});

Then("a bucket row names it", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await this.page.locator("button.bucket", { hasText: name }).first().waitFor({
    timeout: 30_000,
  });
});

Then("that row says it holds {int} paths", async function (this: OduWorld, count: number) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const row = this.page.locator("button.bucket", { hasText: name }).first();
  await this.waitUntil(
    async () => (await row.innerText()).replace(/\s+/g, " ").includes(`${count} paths`),
    `the bucket row to say "${count} paths"`,
  );
});

Then("that row shows a recent push", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const row = this.page.locator("button.bucket", { hasText: name }).first();
  await this.waitUntil(
    async () => !(await row.innerText()).includes("nothing pushed"),
    "the bucket row to show a push",
  );
});

Then("the page shows its substituter URL", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await this.saysThat(this.page.locator("pre.use-block"), "the use block", `/cache/${name}`);
});

Then("the page shows its public key", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await this.saysThat(this.page.locator("pre.use-block"), "the use block", `${name}-1:`);
});

Then("the page's nix.conf block carries no netrc lines", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const block = this.page.locator("pre.use-block");
  await this.saysThat(block, "the use block", `${name}-1:`);
  const text = await block.innerText();
  assert.ok(!text.includes("netrc-file"), `a public bucket's nix.conf tab has netrc: ${text}`);
  assert.ok(
    !text.split("\n").some((line) => line.startsWith("machine ")),
    `a public bucket's nix.conf tab has netrc: ${text}`,
  );
});

Then("the pushed path is listed", async function (this: OduWorld) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no path was arranged");
  await pathRow(this, name).waitFor({ timeout: 30_000 });
});

interface StatedProvenance {
  run: string;
  commit: string;
}
const PROVENANCE = "cache.provenance";
function statedProvenance(world: OduWorld): StatedProvenance {
  const held = world.rowState.get(PROVENANCE) as StatedProvenance | undefined;
  assert.ok(held !== undefined, "this scenario pushed nothing with a run and a commit");
  return held;
}

Then(
  "that path shows the commit it was built from, abbreviated",
  async function (this: OduWorld) {
    const name = this.cachePathName;
    assert.ok(name !== undefined && name !== "", "no path was arranged");
    const { commit } = statedProvenance(this);
    const cell = pathRow(this, name).locator(`[title="${commit}"]`).first();
    await cell.waitFor({ timeout: 30_000 });
    assert.strictEqual((await cell.innerText()).trim(), commit.slice(0, 7));
  },
);

Then("that path links to the run that pushed it", async function (this: OduWorld) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no path was arranged");
  const { run } = statedProvenance(this);
  const link = pathRow(this, name).locator(`a.link[href="#/run/${run}"]`).first();
  await link.waitFor({ timeout: 30_000 });
  assert.strictEqual((await link.innerText()).trim(), run);
});

Then("that path says when it was last wanted", async function (this: OduWorld) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no path was arranged");
  const cell = await cellUnder(this, pathRow(this, name), "wanted");
  await cell.waitFor({ timeout: 30_000 });
  await until("the path's row to say when it was last wanted", async () =>
    /^\d+[smhd] ago$/.test((await cell.innerText()).trim()) ? true : null,
  );
});

Then("no path is listed", async function (this: OduWorld) {
  await this.page
    .locator("table.paths-table tbody tr")
    .first()
    .waitFor({ state: "detached", timeout: 30_000 });
});

Then("one path is listed", async function (this: OduWorld) {
  const rows = this.page.locator("table.paths-table tbody tr.table-row");
  await this.waitUntil(
    async () => (await rows.count()) === 1,
    "the path table to hold exactly one row",
  );
});

Then("the paths table holds {int} rows", async function (this: OduWorld, count: number) {
  const rows = this.page.locator("table.paths-table tbody tr.table-row");
  await this.waitUntil(
    async () => (await rows.count()) === count,
    `the paths table to hold ${count} rows`,
  );
});

Then(
  "the paths table holds {int} version rows",
  async function (this: OduWorld, count: number) {
    const rows = this.page.locator("table.paths-table tbody tr.table-sub-row");
    await this.waitUntil(
      async () => (await rows.count()) === count,
      `the paths table to hold ${count} version rows`,
    );
  },
);

Then("that package is one row saying {string}", async function (this: OduWorld, text: string) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no package was arranged");
  await this.saysThat(pathRow(this, name), `the row for ${name}`, text);
});

When("I expand that package", async function (this: OduWorld) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no package was arranged");
  await pathRow(this, name).locator("button.disclosure-summary").click();
});

When("I sort the paths by {string}", async function (this: OduWorld, column: string) {
  await this.page
    .locator("table.paths-table thead")
    .getByRole("button", { name: column, exact: true })
    .click();
});

Then(
  "the {string} column says it is sorted {string}",
  async function (this: OduWorld, column: string, direction: string) {
    const head = this.page.locator(`table.paths-table th:has(button:text-is("${column}"))`);
    await this.waitUntil(
      async () => (await head.getAttribute("aria-sort")) === direction,
      `the ${column} column to say it is sorted ${direction}`,
    );
  },
);

Then("the {string} path is first", async function (this: OduWorld, which: string) {
  const names = this.cachePathNames ?? [];
  const wanted = which === "large" ? names[0] : names[1];
  assert.ok(wanted !== undefined, "no large and small path were arranged");
  const first = this.page.locator("table.paths-table tbody tr.table-row").first();
  await this.saysThat(first, "the table's first row", wanted);
});

Then("the page says nothing matches", async function (this: OduWorld) {
  await this.saysThat(
    this.page.locator(".cache-paths"),
    "the path list",
    "No path matches that filter",
  );
});

Then("the page says that bucket is not there", async function (this: OduWorld) {
  await this.saysThat(
    this.page.locator(".cache"),
    "the bucket page",
    "This bucket is not on the board",
  );
});

interface MintedHere {
  token?: string;
  id?: string;
}
function minted(world: OduWorld): MintedHere {
  let held = world.rowState.get("cache.minted") as MintedHere | undefined;
  if (held === undefined) {
    held = {};
    world.rowState.set("cache.minted", held);
  }
  return held;
}

Then("the cache says {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator(".cache"), "the cache view", text);
});

async function openCreateForm(world: OduWorld): Promise<void> {
  const summary = world.page
    .locator('section[aria-label="new bucket"] button.disclosure-summary')
    .first();
  await summary.waitFor({ timeout: 30_000 });
  if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
}

When("I open the new bucket form", async function (this: OduWorld) {
  await openCreateForm(this);
});

When("I name a new bucket", async function (this: OduWorld) {
  const name = unique("board");
  this.cacheBucket = name;
  await openCreateForm(this);
  await this.page.getByPlaceholder("new bucket name").fill(name);
});

When("I untick {string}", async function (this: OduWorld, label: string) {
  await this.page.getByLabel(label, { exact: true }).uncheck();
});

Then("the page opens that bucket", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was named");
  await this.page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 30_000 });
});

async function typeRootTokenIfAsked(page: OduWorld["page"]): Promise<void> {
  const field = page.getByLabel("root token", { exact: true });
  if ((await field.count()) > 0) await field.fill(ROOT_TOKEN);
}

Given("a bucket created from the board", async function (this: OduWorld) {
  await this.open("#/cache");
  await this.page.getByRole("heading", { name: "Cache", exact: true }).waitFor();
  await typeRootTokenIfAsked(this.page);
  const name = unique("board");
  this.cacheBucket = name;
  await openCreateForm(this);
  await this.page.getByPlaceholder("new bucket name").fill(name);
  await this.page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await this.page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 30_000 });
});

When("I mint a {string} token", async function (this: OduWorld, scope: string) {
  await this.page.getByLabel("token scope").selectOption(scope);
  await this.page.getByRole("button", { name: "Mint token", exact: true }).click();
  const block = this.page.locator("pre.minted-token");
  await block.waitFor({ timeout: 30_000 });
  minted(this).token = (await block.innerText()).trim();
  const row = this.page.locator("ul.tokens li", { hasText: "just minted" });
  await row.waitFor({ timeout: 30_000 });
  minted(this).id = (await row.locator("code").first().innerText()).trim();
});

When("I name the bucket {string}", async function (this: OduWorld, domain: string) {
  await this.page.getByPlaceholder("cache.example.org").fill(domain);
  await this.page.getByRole("button", { name: "Set domain", exact: true }).click();
  const refusal = this.page
    .getByRole("region", { name: "domain" })
    .locator("p.receipt-bad .receipt-text");
  await until(`the substituter block to name ${domain}`, async () => {
    if ((await this.page.locator("pre.consume-block").innerText()).includes(domain)) return true;
    if ((await refusal.count()) === 0) return null;
    throw new Error(`the row refused "${domain}": ${(await refusal.first().innerText()).trim()}`);
  });
});

Then("the domain answer says {string}", async function (this: OduWorld, text: string) {
  const answer = this.page.locator("p.receipt", { hasText: "Named this bucket" });
  await answer.waitFor({ timeout: 30_000 });
  await until(`the domain answer to say ${text}`, async () =>
    (await answer.innerText()).includes(text) ? true : null,
  );
});

Then("the page's substituter URL is {string}", async function (this: OduWorld, host: string) {
  const text = await this.page.locator("pre.consume-block").innerText();
  assert.match(
    text,
    new RegExp(`extra-substituters = \\S*${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    `the substituter URL does not name ${host}: ${text}`,
  );
});

async function openSetupTab(world: OduWorld, name: string): Promise<void> {
  const tab = world.page.getByRole("tab", { name, exact: true });
  await tab.waitFor({ timeout: 30_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

Then("the push block names the same cache the nix.conf block does", async function (
  this: OduWorld,
) {
  const conf = await this.page.locator("pre.consume-block").innerText();
  const url = /extra-substituters = (\S+)/.exec(conf)?.[1];
  assert.ok(url !== undefined, `the nix.conf block names no substituter: ${conf}`);
  await openSetupTab(this, "push");
  await this.saysThat(
    this.page.locator("pre.push-block"),
    "the push block",
    `odu cache push --cache ${url} <paths>`,
  );
});

When("the API creates a private bucket as this person", function (this: OduWorld) {
  assert.ok(this.mintedToken !== undefined, "no token was minted for this scenario");
  const name = unique("private");
  this.cacheBucket = name;
  this.cliAnswer = cacheVerb(
    this,
    "bucket_create",
    { rootToken: "", name, public: false, retentionDays: 90 },
    { ODU_TOKEN: this.mintedToken },
  );
  assert.strictEqual(this.cliAnswer.status, 0, `create failed: ${this.cliAnswer.stderr}`);
});

When("the CLI reads the bucket's facts with no account", function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  this.cliAnswer = oduCli(this.service, ["cache", "use", name, "--origin", this.service.origin], {
    ODU_TOKEN: "",
    ODU_ROOT_TOKEN: "",
  });
});

Then("it prints the bucket's public key", function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  assert.ok(this.cliAnswer !== undefined, "no CLI call was made");
  assert.strictEqual(this.cliAnswer.status, 0, `use failed: ${this.cliAnswer.stderr}`);
  assert.match(this.cliAnswer.stdout, new RegExp(`${name}-1:`));
  assert.ok(this.cliAnswer.stdout.includes("extra-substituters"));
});

Then("an anonymous HTTP GET of the bucket's page shows the key", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const response = await fetch(`${this.service.origin}/cache/${name}`);
  assert.strictEqual(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(`${name}-1:`), "the page does not show the public key");
});

Then("it is refused as private", function (this: OduWorld) {
  assert.ok(this.cliAnswer !== undefined, "no CLI call was made");
  assert.strictEqual(this.cliAnswer.status, 1);
  assert.ok(
    this.cliAnswer.stderr.includes("if it is private"),
    `the refusal does not name privacy: ${this.cliAnswer.stderr}`,
  );
});

When("I open the bucket's substituter URL in a browser", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const response = await this.page.goto(`${this.service.origin}/cache/${name}`);
  this.visited = { status: response?.status() ?? null, body: await this.page.content() };
});

Then("the page is the bucket's public page", function (this: OduWorld) {
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.strictEqual(visited.status, 200, "the substituter URL did not answer 200");
  assert.ok(visited.body.includes("extra-substituters"), "the page carries no nix.conf lines");
  assert.ok(visited.body.includes("odu cache use "), "the page carries no `odu cache use` line");
  assert.ok(!visited.body.includes('aria-label="board rows"'), "the board's SPA answered");
});

Then("the page has the four blocks a person pastes", async function (this: OduWorld) {
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  for (const title of ["nix.conf", "NixOS / nix-darwin", "flake.nix", "GitHub Actions"]) {
    assert.ok(
      visited.body.includes(`<h3>${title}</h3>`),
      `the page has no ${title} block`,
    );
  }
  assert.strictEqual(
    await this.page.locator("button[data-copy]").count(),
    5,
    "the page does not offer a copy button per block (four use blocks and the push)",
  );
});

Then("the page carries no netrc block", function (this: OduWorld) {
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.ok(
    !visited.body.includes("netrc-file"),
    "a public bucket's page carries netrc, which reading it does not need",
  );
});

Then("the page links its substituter's health file", function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.ok(
    visited.body.includes(
      `<a href="${this.service.origin}/cache/${name}/nix-cache-info">nix-cache-info</a>`,
    ),
    "the page does not link the substituter's nix-cache-info",
  );
});

Then("the page credits odu at {string}", function (this: OduWorld, site: string) {
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.ok(
    visited.body.includes(`served by <a href="${site}">odu</a>`),
    `the page does not credit odu at ${site}`,
  );
});

When("the API makes a private bucket and mints a read token", function (this: OduWorld) {
  const name = unique("private");
  this.cacheBucket = name;
  const created = cacheVerb(this, "bucket_create", {
    rootToken: ROOT_TOKEN,
    name,
    public: false,
    retentionDays: 90,
  });
  assert.strictEqual(created.status, 0, `create failed: ${created.stderr}`);
  const minted = cacheVerb(this, "token_mint", {
    rootToken: ROOT_TOKEN,
    bucket: name,
    scope: "read",
  });
  assert.strictEqual(minted.status, 0, `token mint failed: ${minted.stderr}`);
  this.rowState.set("cache.readToken", (JSON.parse(minted.stdout) as { token: string }).token);
});

When("I open that bucket's page as its reader", async function (this: OduWorld) {
  const name = this.cacheBucket;
  const token = this.rowState.get("cache.readToken") as string | undefined;
  assert.ok(name !== undefined && token !== undefined, "no private bucket was arranged");
  const response = await fetch(`${this.service.origin}/cache/${name}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  this.visited = { status: response.status, body: await response.text() };
});

Then("the page has the netrc block", function (this: OduWorld) {
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.strictEqual(visited.status, 200, "the private page was not answered to its reader");
  assert.ok(visited.body.includes("<h3>netrc</h3>"), "the private page has no netrc block");
  assert.ok(visited.body.includes("netrc-file"), "the netrc block names no netrc-file");
});

Then("the page names the bucket's public key", function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.match(visited.body, new RegExp(`${name}-1:`), "the page does not name the public key");
});

When("I open a path under the cache that names nothing", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  const url = `${this.service.origin}/cache/${name}/nope`;
  this.expectedResponses.push({ status: 404, url });
  const response = await this.page.goto(url);
  this.visited = { status: response?.status() ?? null, body: await this.page.content() };
});

Then("the cache answers it as its own 404", function (this: OduWorld) {
  const visited = this.visited;
  assert.ok(visited !== undefined, "no page was opened");
  assert.strictEqual(visited.status, 404);
  assert.ok(visited.body.includes("no such cache path"), "the 404 is not the cache row's");
  assert.ok(!visited.body.includes('aria-label="board rows"'), "the board's SPA answered a cache path");
});

Then("the board offers no Tunnel control", async function (this: OduWorld) {
  assert.strictEqual(
    await this.page.getByRole("button", { name: "Tunnel", exact: true }).count(),
    0,
    "the Tunnel control is drawn on a daemon that does not mount the row",
  );
});

Then("the token form defaults to 90 days", async function (this: OduWorld) {
  assert.strictEqual(
    await this.page.getByLabel("token expiry").inputValue(),
    "90",
    "the mint form's expiry is not the ninety-day default",
  );
});

Then("the page shows the cache token once", function (this: OduWorld) {
  const token = minted(this).token;
  assert.ok(
    token !== undefined && token.length > 16,
    `no token was shown: ${JSON.stringify(token)}`,
  );
});

Then("the minted token shows an expiry", async function (this: OduWorld) {
  const id = minted(this).id;
  assert.ok(id !== undefined, "no token was minted");
  const text = await this.page.locator("ul.tokens li", { hasText: id }).innerText();
  assert.match(
    text,
    /expires \d{4}-\d{2}-\d{2}/,
    `the minted token's row names no expiry: ${text}`,
  );
});

Then("the minted token is listed as {string}", async function (this: OduWorld, word: string) {
  const id = minted(this).id;
  assert.ok(id !== undefined, "no token was minted");
  await this.saysThat(
    this.page.locator("ul.tokens li", { hasText: id }),
    "the token's row",
    word,
  );
});

When("I revoke the minted token", async function (this: OduWorld) {
  const id = minted(this).id;
  assert.ok(id !== undefined, "no token was minted");
  await this.page.getByRole("button", { name: `revoke ${id}`, exact: true }).click();
});

function pushWithMintedToken(world: OduWorld): string {
  return pushManyWithMintedToken(world, 1)[0] as string;
}

function pushManyWithMintedToken(world: OduWorld, count: number): string[] {
  const bucket = world.cacheBucket;
  const token = minted(world).token;
  assert.ok(bucket !== undefined && token !== undefined, "no bucket or token");
  const dir = mkdtempSync(join(tmpdir(), "odu-wa-cache-"));
  const paths: string[] = [];
  for (let index = 0; index < count; index++) {
    const name = unique("pinned");
    const file = join(dir, name);
    writeFileSync(file, `odu web acceptance: ${name}\n`);
    const added = spawnSync("nix", ["store", "add-file", file], {
      env: world.service.env,
      encoding: "utf-8",
    });
    assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
    paths.push(added.stdout.trim());
  }
  const pushed = oduCli(world.service, ["cache", "push", bucket, ...paths, "-o", "json"], {
    ODU_CACHE_TOKEN: token,
  });
  assert.strictEqual(pushed.status, 0, `odu cache push failed: ${pushed.stderr}`);
  return paths;
}

When("a path is pushed with that token from the CLI", function (this: OduWorld) {
  const path = pushWithMintedToken(this);
  this.cachePath = path;
  this.cachePaths = [path];
});

When("two paths are pushed with that token from the CLI", function (this: OduWorld) {
  const paths = [pushWithMintedToken(this), pushWithMintedToken(this)];
  this.cachePath = paths[0] as string;
  this.cachePaths = paths;
});

When("twelve paths are pushed with that token from the CLI", function (this: OduWorld) {
  const paths = pushManyWithMintedToken(this, 12);
  this.cachePath = paths[0] as string;
  this.cachePaths = paths;
});

When("I open the pins", async function (this: OduWorld) {
  await this.page.getByRole("tab", { name: "Pins", exact: true }).click();
  await this.page.locator('section[aria-label="pins"]').waitFor({ timeout: 30_000 });
  await openPinForm(this);
});

When("I open the paths", async function (this: OduWorld) {
  await this.page.getByRole("tab", { name: "Paths", exact: true }).click();
  await this.page.locator(".cache-paths").waitFor({ timeout: 30_000 });
});

async function openPinForm(world: OduWorld): Promise<void> {
  const summary = world.page
    .locator('section[aria-label="pins"] button.disclosure-summary')
    .first();
  await summary.waitFor({ timeout: 30_000 });
  if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
}

async function pinPaths(world: OduWorld, name: string, paths: readonly string[]): Promise<void> {
  await openPinForm(world);
  await world.page.getByLabel("pin name", { exact: true }).fill(name);
  await world.page.getByLabel("store paths", { exact: true }).fill(paths.join("\n"));
  await world.page.getByRole("button", { name: "Pin closure", exact: true }).click();
}

async function pinThatPath(world: OduWorld, name: string): Promise<void> {
  const path = world.cachePath;
  assert.ok(path !== undefined, "no path was pushed");
  await pinPaths(world, name, [path]);
}

When("I pin that path as {string}", async function (this: OduWorld, name: string) {
  await pinThatPath(this, name);
});

When("I pin the first path as {string}", async function (this: OduWorld, name: string) {
  await pinThatPath(this, name);
});

When("I pin every pushed path as {string}", async function (this: OduWorld, name: string) {
  const paths = this.cachePaths;
  assert.ok(paths !== undefined && paths.length > 0, "no paths were pushed");
  await pinPaths(this, name, paths);
});

function pinRow(world: OduWorld, name: string): Locator {
  return world.page.locator("table.pins-table tr.table-row", { hasText: name }).first();
}

function pinRoots(world: OduWorld, name: string): Locator {
  return world.page.locator(`table.pins-table [data-pin="${name}"]`);
}

async function openRoots(world: OduWorld, name: string): Promise<void> {
  const summary = pinRow(world, name).locator("button.disclosure-summary").first();
  await summary.waitFor({ timeout: 30_000 });
  if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
}

When("I expand what the pin {string} holds", async function (this: OduWorld, name: string) {
  await openRoots(this, name);
});

Then(
  "the pin {string} is listed holding that path",
  async function (this: OduWorld, name: string) {
    const path = this.cachePath;
    assert.ok(path !== undefined, "no path was pushed");
    await this.saysThat(pinRoots(this, name), `the pin ${name}`, path);
  },
);

Then(
  "the pin {string} renders {int} store paths",
  async function (this: OduWorld, name: string, count: number) {
    const roots = pinRoots(this, name).locator("code.path");
    await this.waitUntil(
      async () => (await roots.count()) === count,
      `the pin ${name} to render ${count} store paths`,
    );
  },
);

Then("the pin {string} keeps its roots folded away", async function (this: OduWorld, name: string) {
  await pinRow(this, name).waitFor({ timeout: 30_000 });
  assert.strictEqual(
    await pinRoots(this, name).locator("code.path").count(),
    0,
    `the pin ${name} drew its roots before anybody asked for them`,
  );
});

Then("the pin {string} shows its roots", async function (this: OduWorld, name: string) {
  await pinRoots(this, name)
    .locator("code.path")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
});

When("I unpin {string}", async function (this: OduWorld, name: string) {
  await this.page.getByRole("button", { name: `unpin ${name}`, exact: true }).click();
});

Then("the pin list says nothing is pinned", async function (this: OduWorld) {
  await this.saysThat(
    this.page.locator('section[aria-label="pins"]'),
    "the pin list",
    "Nothing is pinned in this bucket.",
  );
});

function deleteSection(world: OduWorld): Locator {
  return world.page.locator('section[aria-label="delete"]');
}

Then("the delete button is disabled until the name is typed", async function (this: OduWorld) {
  const button = deleteSection(this).getByRole("button", { name: "Delete bucket", exact: true });
  await button.waitFor({ timeout: 30_000 });
  assert.strictEqual(
    await button.isDisabled(),
    true,
    "the delete button was live before the bucket's name was typed",
  );
});

When("I type the bucket's name to confirm", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await deleteSection(this).getByLabel(`type ${name} to confirm`, { exact: true }).fill(name);
});

Then("the page returns to the cache list", async function (this: OduWorld) {
  await this.page.getByRole("heading", { name: "Cache", exact: true }).waitFor({ timeout: 30_000 });
  await this.waitUntil(
    async () => new URL(this.page.url()).hash === "#/cache",
    `the page to return to "#/cache" (it is at ${this.page.url()})`,
  );
});

Then("that bucket is no longer listed", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  await this.page
    .locator("button.bucket", { hasText: name })
    .first()
    .waitFor({ state: "detached", timeout: 30_000 });
});

Then("the bucket's narinfo answers 404", async function (this: OduWorld) {
  const path = this.cachePath;
  assert.ok(path !== undefined && this.cacheBucket !== undefined, "nothing was pushed");
  const hash = (path.split("/").pop() ?? "").slice(0, 32);
  const answer = await fetch(
    new URL(`/cache/${this.cacheBucket}/${hash}.narinfo`, this.service.origin),
    { headers: { authorization: `Bearer ${minted(this).token}` } },
  );
  assert.strictEqual(answer.status, 404, `the narinfo answered ${answer.status}`);
});

Then("the retention form defaults to 90 days", async function (this: OduWorld) {
  assert.strictEqual(
    await this.page.getByLabel("retention days", { exact: true }).inputValue(),
    "90",
    "the retention field is not the ninety-day default",
  );
});

When("I set the retention to {string} days", async function (this: OduWorld, days: string) {
  await this.page.getByLabel("retention days", { exact: true }).fill(days);
  await this.page.getByRole("button", { name: "Set retention", exact: true }).click();
});

When("I set the dry run retention to {string} days", async function (this: OduWorld, days: string) {
  await gcSection(this).getByLabel("retention", { exact: true }).fill(days);
});

Then("the bucket's facts say {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator("p.page-sub"), "the bucket's facts", text);
});

function gcSection(world: OduWorld): Locator {
  return world.page.locator('section[aria-label="garbage collection"]');
}

Then("the dry run says {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(gcSection(this), "the dry run", text);
});

Then("the dry run names the unpinned path", async function (this: OduWorld) {
  const path = this.cachePaths?.[1];
  assert.ok(path !== undefined, "two paths were not pushed");
  await gcSection(this)
    .locator("ol.paths li", { hasText: path })
    .first()
    .waitFor({ timeout: 30_000 });
});

Then("the dry run does not name the pinned path", async function (this: OduWorld) {
  const path = this.cachePath;
  assert.ok(path !== undefined, "no path was pinned");
  assert.strictEqual(
    await gcSection(this).locator("ol.paths li", { hasText: path }).count(),
    0,
    "the dry run would take the pinned path",
  );
});

Then("the push block names the minted token", async function (this: OduWorld) {
  const token = minted(this).token;
  assert.ok(token !== undefined, "no token was minted");
  await openSetupTab(this, "push");
  await this.saysThat(this.page.locator("pre.push-block"), "the push block", token);
});

When("I type the root token", async function (this: OduWorld) {
  await this.page.getByLabel("root token", { exact: true }).fill(ROOT_TOKEN);
});

When("I type a wrong root token", async function (this: OduWorld) {
  await this.page.getByLabel("root token", { exact: true }).fill("not-the-root-token");
});

const SECOND_STORE = "gw";
let gateway: Gateway | undefined;
let storesWorld: Service | undefined;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no free port");
  return address.port;
}

async function storesService(): Promise<Service> {
  if (storesWorld !== undefined) return storesWorld;
  gateway = await startGateway();
  const target = await gateway.bucket();
  const dir = mkdtempSync(join(tmpdir(), "odu-wa-stores-"));
  const credentials = join(dir, "gw-credentials");
  writeFileSync(
    credentials,
    `AWS_ACCESS_KEY_ID=${target.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${target.secretAccessKey}\n`,
    { mode: 0o600 },
  );
  const declarations = join(dir, "object-stores.json");
  writeFileSync(
    declarations,
    JSON.stringify({
      [SECOND_STORE]: {
        kind: "s3",
        endpoint: target.endpoint.origin,
        bucket: target.bucket,
        region: target.region,
        credentialsFile: credentials,
      },
    }),
  );
  storesWorld = await startService(readOduBin(), await freePort(), {
    ODU_OBJECT_STORES: declarations,
  });
  return storesWorld;
}

AfterAll({ timeout: RUN_SETUP_TIMEOUT }, async () => {
  if (storesWorld !== undefined) {
    stopService(storesWorld);
    storesWorld = undefined;
  }
  if (gateway !== undefined) {
    await gateway.stop();
    gateway = undefined;
  }
});

After({ tags: "@tunnel", timeout: RUN_SETUP_TIMEOUT }, function (this: OduWorld) {
  const listed = cacheVerb(this, "bucket_list", { rootToken: ROOT_TOKEN });
  if (listed.status !== 0) {
    process.stderr.write(`web-acceptance: could not list the tunnel world's buckets: ${listed.stderr}\n`);
    return;
  }
  const answer = JSON.parse(listed.stdout) as {
    buckets?: { name: string; domain: string | null }[];
  };
  for (const bucket of answer.buckets ?? []) {
    if (bucket.domain === null) continue;
    const cleared = cacheVerb(this, "bucket_domain", { rootToken: ROOT_TOKEN, bucket: bucket.name });
    if (cleared.status !== 0) {
      process.stderr.write(
        `web-acceptance: could not clear ${bucket.domain} from ${bucket.name}: ${cleared.stderr}\n`,
      );
    }
  }
});

Given(
  "a daemon that declares a second store",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    this.service = await storesService();
  },
);

function migrateSection(world: OduWorld): Locator {
  return world.page.locator('section[aria-label="migrate"]');
}

function storeCard(world: OduWorld, store: string): Locator {
  return migrateSection(world).getByRole("radio", { name: store });
}

Then("the move offers the store {string}", async function (this: OduWorld, store: string) {
  await storeCard(this, store).waitFor({ timeout: 30_000 });
});

When("I move the bucket to {string}", async function (this: OduWorld, store: string) {
  await storeCard(this, store).check();
  await migrateSection(this)
    .getByRole("button", { name: "Start move", exact: true })
    .click();
});
