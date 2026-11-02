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
