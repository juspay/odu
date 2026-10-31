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
 * sentence pointing a member at a form they cannot see, or an admin at a CLI
 * they do not need. Pure, so it is pinned here rather than in a browser.
 */
describe("the empty state names what this person can do", () => {
  it("points an admin at the form above it", async () => {
    const { emptyBucketsText } = await import("./face");
    expect(emptyBucketsText({ canAdminister: true, local: false })).toContain("form above");
    expect(emptyBucketsText({ canAdminister: true, local: false })).not.toContain("odu cache");
  });

  it("tells a member only that there are none", async () => {
    const { emptyBucketsText } = await import("./face");
    expect(emptyBucketsText({ canAdminister: false, local: false })).toBe(
      "There are no buckets yet.",
    );
  });

  it("keeps the CLI hint only for a daemon with no door", async () => {
    const { emptyBucketsText } = await import("./face");
    expect(emptyBucketsText({ canAdminister: true, local: true })).toContain(
      "odu cache create",
    );
  });
});
