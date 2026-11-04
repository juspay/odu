/**
 * THE COMPILER IS PART OF THIS VIEW TOO.
 *
 * `./face` is Solid JSX in a package that is mostly not — and it ships into
 * `@odu/web-ui`'s bundle, where `scripts/build-web-ui.ts` claims every `.tsx`
 * there is. That is what makes a compiler check worth repeating here: the day
 * the view moves again, or a bundler changes its loader, the failure is a page
 * that looks right in a screenshot and loses the caret in a field, the focus
 * ring on a button and the scroll position of a list somebody was reading. It
 * passes a typecheck and it bundles.
 *
 * The claim is the same one `@odu/web-ui`'s `compile.test.ts` makes for its own
 * views, over the same pinned presets: DOM-mode Solid, cloned templates, no
 * `jsx-runtime`. The presets are reached through the ROOT's toolchain — they are
 * build-time dependencies, never runtime ones.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { CacheMigration } from "./surface";

const require_ = createRequire(import.meta.url);
const babel = require_("@babel/core") as {
  transformSync: (
    code: string,
    options: Record<string, unknown>,
  ) => { code?: string | null } | null;
};
const solidPreset: unknown = require_("babel-preset-solid");
const typescriptPreset: unknown = require_("@babel/preset-typescript");

describe("the Solid compiler that builds the Cache view", () => {
  it("compiles ./face to cloned templates, not to component calls", () => {
    const source = readFileSync(join(import.meta.dirname, "face.tsx"), "utf-8");
    const out = babel.transformSync(source, {
      filename: "face.tsx",
      babelrc: false,
      configFile: false,
      presets: [
        [typescriptPreset, { isTSX: true, allExtensions: true }],
        [solidPreset, {}],
      ],
    });
    const code = out?.code;
    expect(code).toBeTruthy();
    // `template` is dom-expressions' clone-a-parsed-fragment helper: its
    // presence is the signature of the DOM-mode Solid transform.
    expect(code).toContain('from "solid-js/web"');
    expect(code).toContain("_$template(");
    // The tell of a generic React-shaped transform, which would bundle and
    // render and re-run the whole component on every update.
    expect(code).not.toContain("jsx-runtime");
  });
});

/**
 * WHAT AN EMPTY CACHE SAYS DEPENDS ON WHO IS LOOKING — and a mistake here is a
 * sentence pointing a member at a form they cannot see, or an admin at a verb
 * they do not need. Pure, so it is pinned here rather than in a browser.
 */
describe("the empty state names what this person can do", () => {
  it("points an admin at the form below it", async () => {
    const { emptyBucketsText } = await import("./face");
    expect(emptyBucketsText({ canAdminister: true, local: false })).toContain("form below");
    expect(emptyBucketsText({ canAdminister: true, local: false })).not.toContain("odu cache");
  });

  it("tells a member only that there are none", async () => {
    const { emptyBucketsText } = await import("./face");
    expect(emptyBucketsText({ canAdminister: false, local: false })).toBe(
      "There are no buckets yet.",
    );
  });

  it("keeps the API verb only for a daemon with no door", async () => {
    const { emptyBucketsText } = await import("./face");
    expect(emptyBucketsText({ canAdminister: true, local: true })).toContain(
      "odu surface cache bucket_create",
    );
  });
});

/**
 * A PIN'S NAME IS THREE FACTS, and the page reads them out of it.
 *
 * CI never types a pin name: the push action derives
 * `<owner>/<repo>@<ref>/<system>`, so a busy bucket's list is forty of them
 * and the only way to scan it is grouped. The parse is the whole of that
 * grouping, and it is pure, so it is pinned here rather than in a browser.
 *
 * The cases that matter are the ones a regex gets wrong: a ref with a slash
 * in it (`release/2.0`), which is legal and common, and a name that is NOT a
 * derived one at all — inventing a repository for `release-1.2` would be a
 * guess printed as a fact.
 */
describe("pins are grouped by the repository their name derives from", () => {
  const pin = (name: string) => ({
    bucket: "kolu",
    name,
    rootPaths: ["/nix/store/aaa-x"],
    created: 0,
    createdBy: "write" as const,
  });

  it("splits a derived name into repository, ref and system", async () => {
    const { pinGroups } = await import("./face");
    const [group] = pinGroups([pin("juspay/odu@master/x86_64-linux")]);
    expect(group?.repo).toBe("juspay/odu");
    expect(group?.pins[0]?.parsed).toEqual({
      repo: "juspay/odu",
      ref: "master",
      system: "x86_64-linux",
    });
  });

  it("keeps a slash inside the ref, where it belongs", async () => {
    const { pinGroups } = await import("./face");
    const [group] = pinGroups([pin("juspay/odu@release/2.0/aarch64-darwin")]);
    expect(group?.pins[0]?.parsed.ref).toBe("release/2.0");
    expect(group?.pins[0]?.parsed.system).toBe("aarch64-darwin");
  });

  it("gathers one repository's refs under one heading, newest first", async () => {
    const { pinGroups } = await import("./face");
    const groups = pinGroups([
      pin("juspay/odu@master/x86_64-linux"),
      pin("juspay/kolu@main/x86_64-linux"),
      pin("juspay/odu@topic/x86_64-linux"),
    ]);
    expect(groups.map((one) => one.repo)).toEqual(["juspay/odu", "juspay/kolu"]);
    expect(groups[0]?.pins.map((one) => one.parsed.ref)).toEqual(["master", "topic"]);
  });

  it("invents no repository for a pin somebody named by hand, and lists it last", async () => {
    const { pinGroups } = await import("./face");
    const groups = pinGroups([pin("release-1.2"), pin("juspay/odu@master/x86_64-linux")]);
    expect(groups.map((one) => one.repo)).toEqual(["juspay/odu", "Pinned by hand"]);
    expect(groups[1]?.pins[0]?.parsed).toEqual({ repo: null, ref: "release-1.2", system: null });
  });
});

/**
 * A HOSTILE NAME IS JUST A NAME — bounded, whatever it looks like.
 *
 * The parse used to be a regex with `.+` between the `@` and the last `/`,
 * and CodeQL was right about it: `a/b@!/!/!/…` is quadratic backtracking,
 * and a pin name comes off the API, so a bucket with one of these in it
 * would hang the tab that listed it. The parse is three index scans now, so
 * the claim is a BUDGET rather than a shape — ten thousand slashes, answered
 * at once, and still answered correctly.
 */
describe("a pin name is parsed in one pass", () => {
  it("answers a pathological name promptly, and reads it as nobody's repository", async () => {
    const { pinGroups } = await import("./face");
    const hostile = `a/b@${"!/".repeat(10_000)}`;
    const started = performance.now();
    const groups = pinGroups([
      { bucket: "kolu", name: hostile, rootPaths: [], created: 0, createdBy: "admin" as const },
    ]);
    const took = performance.now() - started;
    // A trailing `/` means no system, so the whole string is the name.
    expect(groups[0]?.repo).toBe("Pinned by hand");
    expect(groups[0]?.pins[0]?.parsed).toEqual({ repo: null, ref: hostile, system: null });
    expect(took, `the parse took ${took}ms on a 20k-character name`).toBeLessThan(100);
  });

  it("still finds the system when a hostile ref ends in one", async () => {
    const { pinGroups } = await import("./face");
    const name = `a/b@${"!/".repeat(10_000)}x86_64-linux`;
    const started = performance.now();
    const groups = pinGroups([
      { bucket: "kolu", name, rootPaths: [], created: 0, createdBy: "admin" as const },
    ]);
    const took = performance.now() - started;
    expect(groups[0]?.repo).toBe("a/b");
    expect(groups[0]?.pins[0]?.parsed.system).toBe("x86_64-linux");
    expect(took, `the parse took ${took}ms on a 20k-character name`).toBeLessThan(100);
  });
});

/**
 * WHERE A READ IS ANSWERED is the fact 2.8 added to the bucket page, and it is
 * the one fact on that line a person checks after binding a domain: a bucket
 * whose reads still come from odu looks identical otherwise. What is pinned
 * here is the HOST it extracts from a substituter URL — the part that can be
 * wrong — and not the sentence it is put in.
 */
describe("the facts line says who answers a read", () => {
  it("names the store's host when the reads left odu", async () => {
    const { readsFromText } = await import("./face");
    expect(
      readsFromText({ readsFrom: "store", url: "https://cache.example.org/kolu" }),
    ).toBe("reads served from cache.example.org");
  });

  it("keeps the port, because a host with one is a different origin", async () => {
    const { readsFromText } = await import("./face");
    expect(readsFromText({ readsFrom: "store", url: "http://localhost:9000/kolu" })).toBe(
      "reads served from localhost:9000",
    );
  });

  it("prints a URL it could not parse rather than nothing", async () => {
    const { readsFromText } = await import("./face");
    expect(readsFromText({ readsFrom: "store", url: "not a url" })).toBe(
      "reads served from not a url",
    );
  });
});

/**
 * THE ONE COMPUTATION IN A MOVE'S SENTENCE is its count: "1 object" against
 * "12 objects", on a number that arrives from the row. The wording around it
 * is wording, and is not pinned.
 */
describe("a migration counts what it has moved", () => {
  const moving = (over: Partial<CacheMigration> = {}): CacheMigration => ({
    to: "r2",
    state: "copying",
    copied: 12,
    total: 40,
    bytes: 3_100_000,
    ...over,
  });

  it("keeps the plural for a bucket with many objects in it", async () => {
    const { migrationText } = await import("./face");
    expect(migrationText(moving())).toContain("12 of 40 objects");
  });

  it("keeps the singular for a bucket with one object in it", async () => {
    const { migrationText } = await import("./face");
    expect(migrationText(moving({ copied: 1, total: 1, bytes: 0 }))).toContain("1 of 1 object,");
  });
});

/**
 * THE PATHS TABLE IS A VIEW OVER THE PAGE THE ROW ANSWERED — and since round
 * 3, only a view: the counting, the summing and the order are the database's
 * (`db.test.ts`, "a bucket's paths, by package"), because a client holding
 * one page cannot count a bucket. What is left here is the mapping of two
 * answer shapes onto the one row the table draws.
 */
describe("the paths table draws what the row answered", () => {
  const path = (
    name: string,
    hash: string,
    over: { narSize?: number; created?: number; hits?: number; lastWanted?: number } = {},
  ) => ({
    storePath: `/nix/store/${hash}-${name}`,
    narSize: over.narSize ?? 1_000,
    created: over.created ?? 1_000,
    hits: over.hits ?? 0,
    lastWanted: over.lastWanted ?? 1_000,
  });

  it("draws a group as the row counted it, newest version's path and all", async () => {
    const { pathRows } = await import("./face");
    expect(
      pathRows({
        paths: [],
        groups: [
          {
            name: "odu-base-0.1.0",
            versions: 6,
            bytes: 1_300,
            hits: 7,
            pushed: 30,
            wanted: 50,
            storePath: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-odu-base-0.1.0",
          },
        ],
      }),
    ).toEqual([
      {
        name: "odu-base-0.1.0",
        storePath: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-odu-base-0.1.0",
        versions: 6,
        bytes: 1_300,
        hits: 7,
        pushed: 30,
        wanted: 50,
      },
    ]);
  });

  it("draws a path as a row of one version, in the order it arrived", async () => {
    const { pathRows } = await import("./face");
    const rows = pathRows({
      paths: [
        path("zlib-1.3", "cccccccccccccccccccccccccccccccc", { narSize: 900, hits: 9 }),
        path("odu-base-0.1.0", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { narSize: 100, hits: 1 }),
      ],
    });
    // THE ORDER IS THE ROW'S: the view re-sorts nothing, or a sort click
    // would answer twice and disagree with the next page's cursor.
    expect(rows.map((row) => row.name)).toEqual(["zlib-1.3", "odu-base-0.1.0"]);
    expect(rows.every((row) => row.versions === 1)).toBe(true);
    expect(rows.map((row) => row.bytes)).toEqual([900, 100]);
    expect(rows[0]?.pushed).toBe(1_000);
  });

  it("splits a store path into the hash a person compares and the name they read", async () => {
    const { storePathParts } = await import("./face");
    expect(storePathParts("/nix/store/abcd1234abcd1234abcd1234abcd1234-hello-2.12")).toEqual({
      hash: "abcd1234abcd1234abcd1234abcd1234",
      name: "hello-2.12",
    });
    // A path that is not that shape keeps all of itself rather than being
    // given a hash it does not have.
    expect(storePathParts("not-a-store-path")).toEqual({
      hash: "",
      name: "not-a-store-path",
    });
  });
});
