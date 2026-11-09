/**
 * The cache's steps — a bucket pushed from a terminal, read from the page.
 *
 * The ARRANGE half is the terminal, deliberately: a path gets into a bucket by
 * somebody running `odu cache push` (or a hook on a lane host), and no control
 * on this page creates one. The bucket and its token come from the API face
 * (`odu surface cache …`), which is where administration lives.
 * `nix store add-file` is the cheapest real path there is — one small file, no
 * references, no build — so the scenario is about the page rather than about
 * nix.
 *
 * The ASSERT half is the page: the row, the bucket, the filter. Every locator
 * is a role and an accessible name where one exists, and the app's own class
 * names where the shape is the contract (`./support/world.ts` keeps those).
 */

import * as assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AfterAll, Given, Then, When } from "@cucumber/cucumber";
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

/**
 * One cache verb through `odu surface cache …` — the face that administers.
 *
 * The root token is a FIELD of the input: a call with no session names the
 * operator's token, and a call carrying one (`ODU_TOKEN`) names the empty
 * string, because the row reads a signed-in person's ROLE instead
 * (`packages/cache/src/server.ts`'s `authorityOf`).
 */
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

/** The plaintext a `token_mint` answered — shown once, by the verb that minted
 *  it. `--json` prints the member's own payload, so this is `{ token, facts }`
 *  and nothing wrapping it. */
function mintedToken(answer: { stdout: string }): string {
  const payload = JSON.parse(answer.stdout) as { token?: unknown };
  assert.ok(
    typeof payload.token === "string" && payload.token !== "",
    `token_mint answered no plaintext token: ${answer.stdout}`,
  );
  return payload.token;
}

/** WHAT A SCENARIO WANTS IN A BUCKET: a file's base NAME — which becomes the
 *  store path's name, and therefore the table's group — and the bytes it
 *  holds, which decide the NAR's size. Two specs of the same name are two
 *  builds of one package; two sizes are what a sort by size is about. */
interface FileSpec {
  readonly name: string;
  readonly body: string;
}

/** THE ARRANGE, registered under several texts: a scenario that pushes BEFORE
 *  it opens the page (the page is then read as it stands), and one that opens
 *  the page FIRST and pushes into it — which is the scenario that grades the
 *  property the row exists for, a push arriving with no reload. */
function arrangePush(world: OduWorld, howMany = 1): void {
  arrangeFiles(
    world,
    Array.from({ length: howMany }, (_, index) => {
      const name = unique(index === 0 ? "path" : `path-${index}`);
      return { name, body: `odu web acceptance: ${name}\n` };
    }),
  );
}

function arrangeFiles(world: OduWorld, specs: readonly FileSpec[]): void {
  const bucket = unique("bucket");
  // LEAF FILES, added straight to the store: a path with no references, so the
  // narinfo needs no referrers and the import cannot sit at 202 waiting for
  // them. A DIRECTORY EACH, because two builds of one package are the same
  // base name with different bytes and one directory cannot hold both.
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

  // A WRITE TOKEN, not the root token: pushing is the cache's HTTP API with a
  // scoped credential — the arrangement is a person's `cache token_mint`
  // followed by `ODU_CACHE_TOKEN=… odu cache push`, which is the documented CI
  // shape and the one an operator actually uses.
  const minted = cacheVerb(world, "token_mint", {
    rootToken: ROOT_TOKEN,
    bucket,
    scope: "write",
  });
  assert.strictEqual(minted.status, 0, `cache token_mint failed: ${minted.stderr}`);

  const pushed = oduCli(world.service, ["cache", "push", bucket, ...paths, "-o", "json"], {
    ODU_CACHE_TOKEN: mintedToken(minted),
  });
  assert.strictEqual(pushed.status, 0, `odu cache push failed: ${pushed.stderr}`);

  world.cacheBucket = bucket;
  world.cachePath = path;
  // The store path's own base name — what a person types into the filter box.
  world.cachePathName = path.split("/").pop()?.replace(/^[a-z0-9]{32}-/, "") ?? "";
  world.cachePaths = paths;
  world.cachePathNames = paths.map(
    (one) => one.split("/").pop()?.replace(/^[a-z0-9]{32}-/, "") ?? "",
  );
}

/** One leaf path added to the store — no references, so its narinfo imports
 *  at once rather than waiting at 202. */
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
    // The person mints the bucket's write token through `/mcp` (their own
    // credential); the PUSH then speaks only the cache's HTTP protocol, with
    // that bucket token and no cookie — the shape a CI job on a door has.
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

/** THREE BUILDS OF ONE PACKAGE: the same base name, different bytes, so the
 *  store gives each its own hash and the table has a group to draw. */
Given(
  "a bucket with three builds of one package pushed from the CLI",
  function (this: OduWorld) {
    const name = unique("widget");
    arrangeFiles(this, [1, 2, 3].map((build) => ({ name, body: `build ${build}\n` })));
  },
);

/** A BIG ONE AND A SMALL ONE, the big one pushed FIRST so the default order
 *  (newest push at the top) is not already the order a sort by size would
 *  produce. `cachePathNames[0]` is the large path. */
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
  // THE SCREEN'S ONE HEADING IS THE ROW'S NAME. The buckets under it are a
  // labelled grid of cards, not a second heading saying "Buckets".
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
  // THE PAGE HAS TO HAVE ANSWERED before "no page errors" is worth asserting.
  // A bucket the board does not carry has no panels at all — the page says so
  // in one sentence — so that sentence is what this waits for.
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

/** A ROW OF THE PATHS TABLE — the grouped row for a package, or a version
 *  under an open one. The GC panel keeps an `ol.paths` of its own, so these
 *  are addressed through the table rather than by the word "path". */
function pathRow(world: OduWorld, name: string): Locator {
  return world.page.locator("table.paths-table tbody tr", { hasText: name }).first();
}

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

/**
 * The TAB, while another row is on screen.
 *
 * The title is the page's ambient monitor: it counts runs whether or not they
 * are being drawn. A second row must not switch it off — a run that fails while
 * somebody reads buckets is exactly the fact a title bar exists to carry — so
 * this is asserted from the cache's own scenario rather than the board's.
 */
Then("the tab counts the failing run", async function (this: OduWorld) {
  await this.waitUntil(
    async () => (await this.page.title()) === "✗ 1 failing · odu",
    `the tab to read "✗ 1 failing · odu" (it read ${JSON.stringify(await this.page.title())})`,
  );
});

Then("a bucket row names it", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  // A ROW is the control: `button.bucket`, found by the bucket's name. The page
  // was opened BEFORE the push with no reload after it, which is the property —
  // the row arrives over the wire the cache publishes on.
  await this.page.locator("button.bucket", { hasText: name }).first().waitFor({
    timeout: 30_000,
  });
});

Then("that row says it holds {int} paths", async function (this: OduWorld, count: number) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  // THE COUNT AND ITS WORD ARE A STAT — a number over the thing it counts — so
  // the card's text carries them on two lines. The claim is about the pair, not
  // about how they are stacked, so the row's text is normalised before it.
  const row = this.page.locator("button.bucket", { hasText: name }).first();
  await this.waitUntil(
    async () => (await row.innerText()).replace(/\s+/g, " ").includes(`${count} paths`),
    `the bucket row to say "${count} paths"`,
  );
});

Then("that row shows a recent push", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was arranged");
  // Not an exact age — the point is that the counter moved off "nothing
  // pushed", which is the fact a fresh bucket shows and a used one does not.
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
  // A bucket's key is `<bucket>-1:<base64>` by construction, so the name is
  // enough to know the line is the KEY rather than the URL.
  await this.saysThat(this.page.locator("pre.use-block"), "the use block", `${name}-1:`);
});

Then("the page offers the netrc lines a Nix client needs", async function (this: OduWorld) {
  const block = this.page.locator("pre.use-block");
  await this.saysThat(block, "the use block", "netrc-file");
  await this.saysThat(block, "the use block", "machine ");
});

Then("the pushed path is listed", async function (this: OduWorld) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no path was arranged");
  await pathRow(this, name).waitFor({ timeout: 30_000 });
});

/** WANTED, not read. The table's last column is the clock GC decides by, and
 *  the push that arranged this scenario has just renewed it — so what is
 *  asserted is the SHAPE of the fact rather than a number that moves while
 *  the page is open. The column is read by position because that is what a
 *  reader compares it by: the one under the `wanted` header. */
Then("that path says when it was last wanted", async function (this: OduWorld) {
  const name = this.cachePathName;
  assert.ok(name !== undefined && name !== "", "no path was arranged");
  const cell = pathRow(this, name).locator("td").last();
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

/** WHAT THE TABLE HOLDS AFTER A REFRESH — a count of grouped rows, because
 *  the question is whether the page asked the row again, not which path
 *  survived. */
Then("one path is listed", async function (this: OduWorld) {
  const rows = this.page.locator("table.paths-table tbody tr.table-row");
  await this.waitUntil(
    async () => (await rows.count()) === 1,
    "the path table to hold exactly one row",
  );
});

/** THE GROUPED ROWS — one per package, whatever each holds. */
Then("the paths table holds {int} rows", async function (this: OduWorld, count: number) {
  const rows = this.page.locator("table.paths-table tbody tr.table-row");
  await this.waitUntil(
    async () => (await rows.count()) === count,
    `the paths table to hold ${count} rows`,
  );
});

/** …and the versions under an open one, which are a different kind of row:
 *  the count is what the group's own line claimed. */
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

/** THE ORDER IS CHOSEN IN THE HEADER, so this presses the header — the same
 *  gesture a person makes, and the one a keyboard can make too. */
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

/** WHICH PATH IS AT THE TOP — by name, because the name is what a person
 *  reads there, and the arrangement knows which one is the large one. */
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

// ── administration, through the page ────────────────────────────────────────

/** The bucket token this scenario minted — on a bucket page (its one showing,
 *  and the id its list row carries) or through the CLI for a door push. The
 *  cache's own state, in the harness's row bag. */
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

/** The create form is folded away until somebody wants it: a list of buckets
 *  is what the screen is, and the form for a new one is a choice. */
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

/** `uncheck()`, not a click: it asserts the box ended up clear, so a switch
 *  whose label stopped naming it fails here instead of creating a bucket with
 *  the filter nobody meant. */
When("I untick {string}", async function (this: OduWorld, label: string) {
  await this.page.getByLabel(label, { exact: true }).uncheck();
});

Then("the page opens that bucket", async function (this: OduWorld) {
  const name = this.cacheBucket;
  assert.ok(name !== undefined, "no bucket was named");
  await this.page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 30_000 });
});

/** On a daemon with NO DOOR the page asks for the operator's root token; a
 *  step that administers from a page IT just opened must type it, exactly as a
 *  person would. Signed-in scenarios draw no field, so this is a no-op there. */
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
  // The id is read off the LIST, where the row the mint just added says so —
  // the plaintext and the id are two halves the page shows in two places.
  const row = this.page.locator("ul.tokens li", { hasText: "just minted" });
  await row.waitFor({ timeout: 30_000 });
  minted(this).id = (await row.locator("code").first().innerText()).trim();
});

When("I name the bucket {string}", async function (this: OduWorld, domain: string) {
  await this.page.getByPlaceholder("cache.example.org").fill(domain);
  await this.page.getByRole("button", { name: "Set domain", exact: true }).click();
  // The USE BLOCK is the proof the row accepted it: it is redrawn from the
  // published bucket row, not from the field that was typed.
  //
  // A REFUSAL IS AN ANSWER, and this step reads it. The row refuses a name
  // another bucket already holds, and a step that watched only the block
  // turned that sentence into a two-minute timeout naming nothing — which is
  // the whole of what issue #170 looked like from a lane log.
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
  // Every control on this board answers in a RECEIPT, refusals included.
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

/** WHICH BLOCK THE SET-UP PANEL IS SHOWING. The six things a person pastes
 *  are one block behind a tablist now — the panel used to be three stacked
 *  panels above the paths — so a step that reads the push block chooses it
 *  first. `nix.conf` is the tab the panel opens on, so a reader of
 *  `pre.consume-block` needs nothing. */
async function openSetupTab(world: OduWorld, name: string): Promise<void> {
  const tab = world.page.getByRole("tab", { name, exact: true });
  await tab.waitFor({ timeout: 30_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

Then("the page's netrc block names {string}", async function (this: OduWorld, host: string) {
  const text = await this.page.locator("pre.consume-block").innerText();
  assert.ok(
    text.includes(`machine ${host} password`),
    `the netrc block does not name ${host}: ${text}`,
  );
});

/** ONE FACT, AND IT IS THE ONE ABOVE IT. Since `--cache`, a push names the
 *  substituter URL and the cache states the rest in its own `nix-cache-info`
 *  — so a bucket that has just been given a DOMAIN has a push block that
 *  follows it, and the two blocks on the page cannot name two caches. */
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
  // NO ODU_TOKEN, NO ROOT TOKEN: the substituter URL is what a person with a
  // browser and a terminal has before signing in.
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
  // NOT THE BOARD: the SPA shell has the board's row buttons; this page has a
  // sentence and a pre block.
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
  // THE 404 IS THE ANSWER THIS STEP ASKS FOR. Declared before the navigation,
  // so the generic "no page errors" check allows exactly this URL and status.
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

/** A LEAF PATH PUSHED WITH THE TOKEN THE PAGE MINTED, and only it: the push
 *  talks to the cache's HTTP API with a bucket credential, so a token the page
 *  minted wrongly fails here rather than three steps later. */
function pushWithMintedToken(world: OduWorld): string {
  return pushManyWithMintedToken(world, 1)[0] as string;
}

/** The same push, with `count` leaf paths in one command: a pin over a
 *  dozen-path closure is what the roots disclosure exists for, and twelve
 *  `nix store add-file`s in one push is the cheapest honest way to arrange
 *  one. */
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

/** TWO leaf paths, neither referencing the other, so a pin over the first is
 *  the WHOLE difference between them when the collector comes — no clock has
 *  to move for one to go and the other to stay. */
When("two paths are pushed with that token from the CLI", function (this: OduWorld) {
  const paths = [pushWithMintedToken(this), pushWithMintedToken(this)];
  this.cachePath = paths[0] as string;
  this.cachePaths = paths;
});

/** A CLOSURE BIG ENOUGH TO BE A WALL — twelve leaf paths in one push, which
 *  is two more than a pin row draws before it folds the rest away. */
When("twelve paths are pushed with that token from the CLI", function (this: OduWorld) {
  const paths = pushManyWithMintedToken(this, 12);
  this.cachePath = paths[0] as string;
  this.cachePaths = paths;
});

/** THE PINS ARE A TAB NOW, beside the paths: they are both "what is in this
 *  bucket", and the roots of every pin printed down the sidebar were most of
 *  this page's DOM. */
When("I open the pins", async function (this: OduWorld) {
  await this.page.getByRole("tab", { name: "Pins", exact: true }).click();
  await this.page.locator('section[aria-label="pins"]').waitFor({ timeout: 30_000 });
  // The tab is the list AND the form that adds to it; a scenario that says it
  // opened the pins has both in front of it.
  await openPinForm(this);
});

When("I open the paths", async function (this: OduWorld) {
  await this.page.getByRole("tab", { name: "Paths", exact: true }).click();
  await this.page.locator(".cache-paths").waitFor({ timeout: 30_000 });
});

/** The pin form is folded away until somebody wants it: the list is what the
 *  tab is for, and making one pin is a choice. */
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

/** The same control, said the way a scenario holding TWO paths has to say it. */
When("I pin the first path as {string}", async function (this: OduWorld, name: string) {
  await pinThatPath(this, name);
});

When("I pin every pushed path as {string}", async function (this: OduWorld, name: string) {
  const paths = this.cachePaths;
  assert.ok(paths !== undefined && paths.length > 0, "no paths were pushed");
  await pinPaths(this, name, paths);
});

/** One pin's row in the table. */
function pinRow(world: OduWorld, name: string): Locator {
  return world.page.locator("table.pins-table tr.table-row", { hasText: name }).first();
}

/** What that pin holds, which is a row of its OWN under it: a note row is a
 *  sibling of the row it belongs to, so it carries the pin's name. */
function pinRoots(world: OduWorld, name: string): Locator {
  return world.page.locator(`table.pins-table [data-pin="${name}"]`);
}

/** Open what a pin holds, once. */
async function openRoots(world: OduWorld, name: string): Promise<void> {
  const summary = pinRow(world, name).locator("button.disclosure-summary").first();
  await summary.waitFor({ timeout: 30_000 });
  // The open bit is the LIST's now, not the platform's, and it is announced
  // on the control: a second click would close what this is about to read.
  if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
}

When("I expand what the pin {string} holds", async function (this: OduWorld, name: string) {
  await openRoots(this, name);
});

/** WHAT A PIN HOLDS, beside the button that takes it away: a name on its own
 *  says that something is kept, never what, and a pin nobody can read is a
 *  pin nobody dares remove. The disclosure is opened by the `When` above —
 *  an assertion that acted could not tell "drawn" from "reachable". */
Then(
  "the pin {string} is listed holding that path",
  async function (this: OduWorld, name: string) {
    const path = this.cachePath;
    assert.ok(path !== undefined, "no path was pushed");
    await this.saysThat(pinRoots(this, name), `the pin ${name}`, path);
  },
);

/** THE WALL THIS PAGE NO LONGER DRAWS, counted in the DOM rather than
 *  described: a pin of a big closure renders ten store paths, whatever its
 *  closure holds, until somebody asks for the rest. */
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

/** …and they are not merely off the bottom of a long list: they are not drawn
 *  at all until the disclosure is open. */
Then("the pin {string} keeps its roots folded away", async function (this: OduWorld, name: string) {
  // NOT DRAWN AT ALL, not merely hidden: the disclosure's box is mounted when
  // it is open, which is the whole reason a pin of a 1 789-path closure is one
  // row until somebody asks.
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

/** The list is ASKED AGAIN after an unpin rather than patched in place, so the
 *  empty answer here is `pin.list`'s and not the page's memory of its own
 *  click. */
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

/** THE GATE IS THE CONTROL. A delete has no undo, so the button is dead until
 *  the bucket's own name has been typed — graded here, before it is, because a
 *  confirm field nobody has to satisfy is decoration. */
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

/** EVERY READ ON THAT PAGE IS ABOUT TO REFUSE, so a delete that worked leaves
 *  it: the list is the only page left that can say anything true about this
 *  bucket. */
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

/** THE SAME ADDRESS THAT ANSWERED 200 two steps ago, asked with the same
 *  token: an unknown bucket is a 404 before anything is authorized, so this is
 *  the objects being GONE rather than a credential being refused. */
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

/** THE PLAN'S OWN NUMBER, which is not the bucket's: a different field, with
 *  no "set" button behind it, read when the dry run is asked for. Addressed
 *  by its exact label so it can never resolve to the retention control above
 *  — the two being told apart is most of what this scenario is about. */
When("I set the dry run retention to {string} days", async function (this: OduWorld, days: string) {
  // `retention` INSIDE the collection's own panel: the settings column has a
  // `retention days` field of its own, and the two are different questions —
  // this one asks, that one keeps.
  await gcSection(this).getByLabel("retention", { exact: true }).fill(days);
});

/** THE FACTS LINE at the top of the bucket page, which is drawn from the row
 *  the cache republished — so a number read here is the bucket's, never the
 *  field that was typed into. */
Then("the bucket's facts say {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator("p.page-sub"), "the bucket's facts", text);
});

/** The collection's section — the dry run, the button, and the report the
 *  button leaves. The bucket's own path list carries an `ol.paths` too, so
 *  every GC assertion is scoped to this section. */
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

/** The NEGATIVE half, and it means something only after the positive one: the
 *  list has rendered, so a path missing from it is one the pin holds rather
 *  than one the page has not drawn yet. */
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
  // The once-shown moment is when a person pastes it into a CI secret, so the
  // push block carries it while the page can still show it.
  await openSetupTab(this, "push");
  await this.saysThat(this.page.locator("pre.push-block"), "the push block", token);
});

When("I type the root token", async function (this: OduWorld) {
  await this.page.getByLabel("root token", { exact: true }).fill(ROOT_TOKEN);
});

When("I type a wrong root token", async function (this: OduWorld) {
  await this.page.getByLabel("root token", { exact: true }).fill("not-the-root-token");
});

// ── a second store, and a bucket that moves to it ───────────────────────────

/**
 * A WORLD WITH SOMEWHERE TO MOVE A BUCKET TO.
 *
 * `$ODU_OBJECT_STORES` is read ONCE at boot, so the daemon that declares a
 * second store cannot be the worker's loopback one — it is a daemon of this
 * row's own, beside a real S3 service (versitygw, the same gateway the
 * cache's unit suite runs against), so the objects really do travel.
 *
 * IT IS STARTED HERE rather than in the harness because a store is the
 * CACHE's noun: `support/hooks.ts` owns the three worlds every row shares and
 * names no row's vocabulary, and `@odu/objects/testing` is a dependency only
 * this package has. The step hands it over as `this.service`, which is the
 * handle every cache step already uses — so the whole vocabulary above works
 * unchanged against it.
 *
 * One per WORKER, not per scenario: a daemon is seconds to start and the move
 * is what the scenario is about.
 */
const SECOND_STORE = "gw";
let gateway: Gateway | undefined;
let storesWorld: Service | undefined;

/** A port the kernel vouches for. The harness reserves one per world it owns
 *  and this world is not one of them, so it is asked for the same way: bind
 *  zero, read what was assigned, let it go. */
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

Given(
  "a daemon that declares a second store",
  { timeout: RUN_SETUP_TIMEOUT },
  async function (this: OduWorld) {
    this.service = await storesService();
  },
);

/** The move's own panel. The bucket page draws one card per store it could
 *  move to, and the facts line above is where the move ENDS — so every
 *  assertion about the control itself is scoped here. */
function migrateSection(world: OduWorld): Locator {
  return world.page.locator('section[aria-label="migrate"]');
}

/** A CARD, by its accessible name — which is the store's name followed by the
 *  sentence explaining what kind of store it is, so the match is a prefix
 *  rather than the whole of it. */
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
