/**
 * The cache's steps — a bucket pushed from a CLI, read from the page.
 *
 * The ARRANGE half is the CLI, deliberately: a path gets into a bucket by
 * somebody running `odu cache push` (or a hook on a lane host), and no control
 * on this page creates one. `nix store add-file` is the cheapest real path
 * there is — one small file, no references, no build — so the scenario is about
 * the page rather than about nix.
 *
 * The ASSERT half is the page: the row, the bucket, the filter. Every locator
 * is a role and an accessible name where one exists, and the app's own class
 * names where the shape is the contract (`./support/world.ts` keeps those).
 */

import * as assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Given, Then, When } from "@cucumber/cucumber";
import { oduCli } from "../../../web-acceptance/support/service.ts";
import type { OduWorld } from "../../../web-acceptance/support/world.ts";

function unique(what: string): string {
  return `wa-${what}-${Math.random().toString(36).slice(2, 10)}`;
}

/** THE ARRANGE, registered under two texts: a scenario that pushes BEFORE it
 *  opens the page (the page is then read as it stands), and one that opens the
 *  page FIRST and pushes into it — which is the scenario that grades the
 *  property the row exists for, a push arriving with no reload. */
function arrangePush(world: OduWorld, howMany = 1): void {
  const bucket = unique("bucket");
  // LEAF FILES, added straight to the store: a path with no references, so the
  // narinfo needs no referrers and the import cannot sit at 202 waiting for
  // them. More than one when the scenario is about NARROWING a list.
  const paths: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "odu-wa-cache-"));
  for (let index = 0; index < howMany; index += 1) {
    const name = unique(index === 0 ? "path" : `path-${index}`);
    const file = join(dir, name);
    writeFileSync(file, `odu web acceptance: ${name}\n`);
    const added = spawnSync("nix", ["store", "add-file", file], {
      env: world.service.env,
      encoding: "utf-8",
    });
    assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
    paths.push(added.stdout.trim());
  }
  const path = paths[0] as string;

  const created = oduCli(world.service, ["cache", "create", bucket, "-o", "json"]);
  assert.strictEqual(
    created.status,
    0,
    `odu cache create failed: ${created.stderr}`,
  );

  // A WRITE TOKEN, not the root token: pushing is the cache's HTTP API with a
  // scoped credential — the arrangement is a person's `odu cache token mint`
  // followed by `ODU_CACHE_TOKEN=… odu cache push`, which is the documented CI
  // shape and the one an operator actually uses.
  const minted = oduCli(world.service, ["cache", "token", "mint", bucket, "--write", "-o", "json"]);
  assert.strictEqual(minted.status, 0, `odu cache token mint failed: ${minted.stderr}`);
  const token = (JSON.parse(minted.stdout) as { token: string }).token;

  const pushed = oduCli(world.service, ["cache", "push", bucket, ...paths, "-o", "json"], {
    ODU_CACHE_TOKEN: token,
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
    const minted = oduCli(
      this.service,
      ["cache", "token", "mint", bucket, "--write", "-o", "json"],
      { ODU_TOKEN: this.mintedToken },
    );
    assert.strictEqual(minted.status, 0, `odu cache token mint failed: ${minted.stderr}`);
    const token = (JSON.parse(minted.stdout) as { token: string }).token;
    const path = addLeafPath(this);
    const pushed = oduCli(this.service, ["cache", "push", bucket, path, "-o", "json"], {
      ODU_CACHE_TOKEN: token,
    });
    assert.strictEqual(
      pushed.status,
      0,
      `odu cache push through the door failed: ${pushed.stderr}${pushed.stdout}`,
    );
    this.cachePath = path;
    this.cacheToken = token;
  },
);

Then("the bucket serves that path's narinfo to the token", async function (this: OduWorld) {
  const path = this.cachePath;
  assert.ok(path !== undefined && this.cacheBucket !== undefined, "nothing was pushed");
  const hash = (path.split("/").pop() ?? "").slice(0, 32);
  const answer = await fetch(
    new URL(`/cache/${this.cacheBucket}/${hash}.narinfo`, this.service.origin),
    { headers: { authorization: `Bearer ${this.cacheToken}` } },
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

When("a bucket with one path is pushed from the CLI", function (this: OduWorld) {
  arrangePush(this);
});

Given("I open the cache", async function (this: OduWorld) {
  await this.open("#/cache");
  await this.page.getByRole("heading", { name: "Buckets", exact: true }).waitFor();
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
  // THE PAGE HAS TO HAVE ANSWERED before "no page errors" is worth asserting:
  // the paths read is refused (`unknown_bucket`), and a check that ran before
  // that refusal settled would grade a page that had not asked yet. The view
  // draws the refusal and offers a retry, so the refusal itself is what this
  // waits for.
  await this.page
    .getByRole("button", { name: "try again" })
    .or(this.page.locator("p.refused"))
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

Then("both pushed paths are listed", async function (this: OduWorld) {
  for (const name of this.cachePathNames ?? []) {
    await this.page.locator("ol.paths li", { hasText: name }).first().waitFor({ timeout: 30_000 });
  }
});

Then("the first path is listed", async function (this: OduWorld) {
  const name = this.cachePathNames?.[0];
  assert.ok(name !== undefined, "no path was arranged");
  await this.page.locator("ol.paths li", { hasText: name }).first().waitFor({ timeout: 30_000 });
});

Then("the second path is not listed", async function (this: OduWorld) {
  const name = this.cachePathNames?.[1];
  assert.ok(name !== undefined, "no second path was arranged");
  await this.waitUntil(
    async () => (await this.page.locator("ol.paths li", { hasText: name }).count()) === 0,
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
  await this.saysThat(
    this.page.locator("button.bucket", { hasText: name }).first(),
    "the bucket row",
    `${count} paths`,
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
  await this.page.locator("li", { hasText: name }).first().waitFor({ timeout: 30_000 });
});

Then("no path is listed", async function (this: OduWorld) {
  await this.page.locator("ol.paths li").first().waitFor({ state: "detached", timeout: 30_000 });
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

Then("the cache says {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator(".cache"), "the cache view", text);
});

When("I name a new bucket", async function (this: OduWorld) {
  const name = unique("board");
  this.cacheBucket = name;
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

Given("a bucket created from the board", async function (this: OduWorld) {
  await this.open("#/cache");
  await this.page.getByRole("heading", { name: "Buckets", exact: true }).waitFor();
  const name = unique("board");
  this.cacheBucket = name;
  await this.page.getByPlaceholder("new bucket name").fill(name);
  await this.page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await this.page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 30_000 });
});

When("I mint a {string} token", async function (this: OduWorld, scope: string) {
  await this.page.getByLabel("token scope").selectOption(scope);
  await this.page.getByRole("button", { name: "Mint token", exact: true }).click();
  const block = this.page.locator("pre.minted-token");
  await block.waitFor({ timeout: 30_000 });
  this.bucketToken = (await block.innerText()).trim();
  // The id is read off the LIST, where the row the mint just added says so —
  // the plaintext and the id are two halves the page shows in two places.
  const row = this.page.locator("ul.tokens li", { hasText: "just minted" });
  await row.waitFor({ timeout: 30_000 });
  this.bucketTokenId = (await row.locator("code").first().innerText()).trim();
});

Then("the page shows the cache token once", function (this: OduWorld) {
  assert.ok(
    this.bucketToken !== undefined && this.bucketToken.length > 16,
    `no token was shown: ${JSON.stringify(this.bucketToken)}`,
  );
});

Then("the minted token is listed as {string}", async function (this: OduWorld, word: string) {
  const id = this.bucketTokenId;
  assert.ok(id !== undefined, "no token was minted");
  await this.saysThat(
    this.page.locator("ul.tokens li", { hasText: id }),
    "the token's row",
    word,
  );
});

When("I revoke the minted token", async function (this: OduWorld) {
  const id = this.bucketTokenId;
  assert.ok(id !== undefined, "no token was minted");
  await this.page.getByRole("button", { name: `revoke ${id}`, exact: true }).click();
});

When("a path is pushed with that token from the CLI", function (this: OduWorld) {
  const bucket = this.cacheBucket;
  const token = this.bucketToken;
  assert.ok(bucket !== undefined && token !== undefined, "no bucket or token");
  const dir = mkdtempSync(join(tmpdir(), "odu-wa-cache-"));
  const name = unique("pinned");
  const file = join(dir, name);
  writeFileSync(file, `odu web acceptance: ${name}\n`);
  const added = spawnSync("nix", ["store", "add-file", file], {
    env: this.service.env,
    encoding: "utf-8",
  });
  assert.strictEqual(added.status, 0, `nix store add-file failed: ${added.stderr}`);
  const path = added.stdout.trim();
  // THE PAGE'S TOKEN, and only it: the push talks to the cache's HTTP API with
  // a bucket credential, so a token the page minted wrongly fails right here.
  const pushed = oduCli(this.service, ["cache", "push", bucket, path, "-o", "json"], {
    ODU_CACHE_TOKEN: token,
  });
  assert.strictEqual(pushed.status, 0, `odu cache push failed: ${pushed.stderr}`);
  this.cachePath = path;
});

When("I pin that path as {string}", async function (this: OduWorld, name: string) {
  const path = this.cachePath;
  assert.ok(path !== undefined, "no path was pushed");
  await this.page.getByLabel("pin name", { exact: true }).fill(name);
  await this.page.getByLabel("store paths to pin", { exact: true }).fill(path);
  await this.page.getByRole("button", { name: "Pin closure", exact: true }).click();
});

Then("the stats say {string}", async function (this: OduWorld, text: string) {
  await this.saysThat(this.page.locator("dl.stats"), "the stats", text);
});
