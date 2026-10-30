/**
 * THE FENCE — the claims no runtime can check, over this repo.
 *
 * `@olai/effect-cordis/fence` reads SOURCES and MODULE GRAPHS: which package
 * imported which, what a root's walk carries, where a row's name appears as
 * text, which module a second package can open holds live state, and whether the
 * rows the host supplied, the rows on disk and the rows the roots compose are one
 * set. It imports no plugin and evaluates no plugin, so a row that will not load
 * still gets every claim run against it.
 *
 * ## The declaration, in this repo's nouns
 *
 * - **Four roots**: `src/main.ts` (the CLI — Node), `packages/host/src/web.ts`
 *   (the daemon — Node), `packages/web-ui/src/main.tsx` (the browser's boot —
 *   it is where `connectSurfaces` is called) and `packages/web-ui/src/app.tsx`
 *   (the route table — browser). These are the files that may name more than one
 *   row.
 * - **Rows from manifests.** Every package says `"cordis": { "row": … }`; the
 *   fence resolves them itself, so a new package that forgets to say which row
 *   it is behind is a finding rather than a silent member of nothing.
 * - **`@odu/host` is the REGISTRY** — the one package in no row that names every
 *   row, which is why its own imports of the rows are legal while a row's
 *   import of IT would be the cycle the manifests cannot express.
 * - **The collision table** names the files where a row's word appears outside
 *   its own packages and outside the roots, with the count each one carries.
 *   Growing it is a diff somebody agrees to.
 *
 * ## Two door defects this declaration is waiting on
 *
 * `juspay/olai#676` is in flight and its fence door is pinned at the branch
 * head; until it lands, two defects keep the report from being what it should
 * be, and this file says so rather than working around them:
 *
 *   (a) registry CANDIDATES are computed from `tree.sources`, which includes
 *       tests and every string literal — so a closure test that merely LISTS the
 *       packages it refuses can make its package look like a roster;
 *   (b) the candidate test asks whether a package names every row PACKAGE, when
 *       a roster names every row — `@odu/host` names `@odu/cli` for the runs'
 *       bundle, so today it happens to satisfy (b) anyway.
 *
 * When the door is re-pinned, the three wrong-declaration tests below are
 * replaced by `expect(prove(declaration).ok)`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fence, rowsFromManifests } from "@olai/effect-cordis/fence";

/** The workspace root: the directory whose `package.json` carries the
 *  `workspaces` globs. */
const REPO = join(import.meta.dirname, "..", "..", "..");
const source = (file: string): string => readFileSync(join(REPO, file), "utf-8");

/** The rows on disk, from the manifests. */
const FENCE_ROWS = rowsFromManifests(REPO);

const declaration = {
  repo: REPO,
  rows: FENCE_ROWS,
  roots: [
    { entry: "src/main.ts", graph: "node" as const },
    { entry: "packages/host/src/web.ts", graph: "node" as const },
    { entry: "packages/web-ui/src/main.tsx", graph: "browser" as const },
    { entry: "packages/web-ui/src/app.tsx", graph: "browser" as const },
  ],
  // WHERE A ROW'S WORD LEGITIMATELY APPEARS OUTSIDE ITS OWN PACKAGES, and how
  // many times. A COUNT rather than a boolean, because "it is mentioned there"
  // and "it is mentioned there twenty-nine times" are different dependencies on
  // the same decision.
  //
  // Two kinds of entry, and both are the price of a row named after a common
  // noun: the projections that must speak the sibling's key (they compose that
  // row's client over one connection), and THE WORD ITSELF in code that has
  // nothing to do with buckets (a runner's build cache, a `nix` cache flag, the
  // acceptance suite's fixtures, a bucket's class names).
  collisions: {
    cache: {
      "packages/cli/src/serviceCli.ts": 3,
      "packages/cli/src/serviceMcp.ts": 3,
      "packages/cli/src/wire.ts": 2,
      "packages/execution/src/coordinator/spawn.ts": 1,
      "packages/execution/src/runner/workspace.ts": 22,
      "packages/launch/src/webDaemonLaunch.ts": 1,
      "packages/web-acceptance/step_definitions/cache_steps.ts": 27,
      "packages/web-acceptance/support/corpus.ts": 5,
      "packages/web-acceptance/support/world.ts": 3,
    },
    ci: {
      "packages/web-acceptance/support/service.ts": 7,
      "packages/web-ui/src/create.tsx": 1,
    },
  },
  // A MODULE THAT HOLDS LIVE STATE BEHIND A DOOR, and why: the spawn module's
  // registry of runs it started — written only there, read only to report a
  // child that died, and the one fact a launcher has no caller to carry.
  allowances: {
    "packages/execution/src/coordinator/spawn.ts":
      "`liveRuns` is the spawn module's own registry of the runs it started — " +
      "written only here, read only to report a child that died, and the one " +
      "piece of state a launcher has no caller to carry it through.",
  },
} as const;

/**
 * THE REDS THIS ROUND IS WAITING ON — door defects, not this repo's.
 *
 * `juspay/olai#676`'s fence computes its registry CANDIDATES from every source a
 * member has (tests and string literals included) and asks whether one names
 * every row PACKAGE. Fixed, the candidates are exactly `packages/host` and the
 * registry is found; today it is `undefined`, so the host's own rows imports are
 * judged by the host-package rule and come back red, as do the board's views.
 *
 * These six are what that costs. They are PINNED rather than declared away: a
 * seventh is a finding, and a fix to the door makes this list wrong on purpose
 * — the assertion below is what tells you to switch to `prove(declaration).ok`.
 */
const KNOWN_RED_IMPORTS = [
  "packages/host/src/mcpRoute.ts",
  "packages/web-ui/src/board.tsx",
  "packages/web-ui/src/detail.tsx",
  "packages/web-ui/src/format.ts",
  "packages/web-ui/src/types.ts",
];

describe("the fence over this repo", () => {
  it("is green on everything the door can see today", () => {
    const report = fence(declaration);
    for (const claim of ["door-graphs", "names", "live-state", "registry"] as const) {
      expect(report.red(claim), `${claim}:\n${report.red(claim).join("\n")}`).toEqual([]);
    }
    // The three faults the door still has are all in ONE claim, and the distinct
    // FILES they name are the whole of it.
    const files = [...new Set(report.red("imports").map((said) => said.split(":")[0] as string))];
    expect(files.sort()).toEqual(KNOWN_RED_IMPORTS);
  });

  it("finds no registry yet, and that is the door's defect", () => {
    // `packages/host` names every row (it imports the runs' bundle, their
    // runtime's type, the cache's row and launch), which is what a roster is.
    // The door cannot see it: its candidates are drawn from a member's non-root
    // sources only, and it asks for every row PACKAGE. When #676 lands this
    // assertion fails, and the six names above become `prove(declaration).ok`.
    expect(fence(declaration).reading.registry).toBeUndefined();
  });

  // A GREEN REPORT IS ONLY EVIDENCE IF IT WOULD GO RED, so each lever this
  // declaration pulls is pulled the wrong way once. No temp tree and no copy:
  // the claims are functions of the DECLARATION, so a wrong declaration over
  // the same sources is the defect, and a reviewer can read it.
  //
  // (`prove(declaration).ok` replaces these three when olai#676 lands — see the
  // header on defects (a) and (b).)
  it("goes red when a row the packages declare is not in the roster", () => {
    const { cache: _dropped, ...rest } = FENCE_ROWS;
    const report = fence({ ...declaration, rows: rest });
    expect(report.red("registry").join("\n")).toContain("cache");
  });

  it("goes red when a collision is not recorded", () => {
    const report = fence({ ...declaration, collisions: {} });
    expect(report.red("names").length).toBeGreaterThan(0);
  });

  it("goes red when an allowance is withdrawn", () => {
    const report = fence({ ...declaration, allowances: {} });
    expect(report.red("live-state").join("\n")).toContain("liveRuns");
  });
});

/**
 * THE ONE CLAIM THE FRAMEWORK CANNOT MAKE, because it is about call sites rather
 * than about a package graph: **the word a row is mounted under and the word
 * every client builds its face from are one word.**
 *
 * The mount happens in the row's own `apply` (`bundle.mount(...)`), the roster
 * repeats the key, and three faces read it: the browser's `connectSurfaces`, the
 * argv projection's `surfaces`, and the stdio bridge's `surfaces`. A mismatch is
 * the quietest failure the bundle has — the page connects, the health fold is
 * green, and every call into that row answers "unknown member" — so this parses
 * those five call sites instead of trusting a name to stay put.
 */
describe("the word the rows are mounted under", () => {
  /** A key as a call site spells it: a literal, or an identifier resolved
   *  through the cache's own constants (the one module that exports them). */
  const resolve = (spelling: string): string | null => {
    // `null` is the ROOT row: its members keep the bare tags, so there is no
    // sibling word to agree on.
    if (spelling === "null") return null;
    const literal = /^"([a-z]+)"$/.exec(spelling);
    if (literal !== null) return literal[1] as string;
    const found = new RegExp(`export const ${spelling} = "([a-z]+)"`).exec(
      source("packages/cache/src/server.ts"),
    );
    expect(found, `${spelling} is not defined where the exports are`).not.toBeNull();
    return found?.[1] as string;
  };

  /** `bundle.mount(KEY, …)` — the row mounting ITSELF. */
  const mounted = resolve(
    /bundle\.mount\((\w+),/.exec(source("packages/cache/src/server.ts"))?.[1] ?? "(none)",
  ) as string;

  /** The roster's sibling entries: `{ name: X, key: Y, … }`. */
  const roster = [
    ...source("packages/host/src/web.ts").matchAll(
      /\{\s*name:\s*([\w$]+|\"[a-z]+\"),\s*key:\s*(null|[\w$]+|\"[a-z]+\")/g,
    ),
  ].map((found) => ({ name: found[1] as string, key: found[2] as string }));

  it("reads the call sites it thinks it is reading", () => {
    // The non-vacuity floor: a pattern that stopped matching would make every
    // assertion below true of an empty list.
    expect(mounted).not.toBe("(none)");
    expect(roster.length).toBeGreaterThanOrEqual(2);
    expect(roster.map((row) => row.key)).toContain("null");
  });

  it("is the key the roster serves it under", () => {
    expect(roster.map((row) => resolve(row.key)).filter((key) => key !== null)).toContain(
      mounted,
    );
  });

  it("is the sibling the browser dials, and the core's name", () => {
    const text = source("packages/web-ui/src/main.tsx");
    const keys = [...text.matchAll(/(\w+):\s*odu[A-Z]\w*Surface/g)].map((one) => one[1]);
    expect(keys).toContain(mounted);
    expect(text).toMatch(/core:\s*\{\s*surface:\s*oduServiceSurface,\s*name:\s*"ci"/);
  });

  it("is the sibling both projections mount", () => {
    for (const file of ["packages/cli/src/serviceCli.ts", "packages/cli/src/serviceMcp.ts"]) {
      const text = source(file);
      // `surfaces: { cache: { surface: oduCacheSurface, expose: … } }` — the
      // entry the projection takes, whichever way the object is laid out.
      expect(text, `${file} does not mount "${mounted}"`).toMatch(
        new RegExp(`surfaces:[\\s\\S]{0,120}\\b${mounted}:`) as never,
      );
      // ...and the argv face builds its client from the same map.
      expect(text, `${file} builds no client for "${mounted}"`).toMatch(
        new RegExp(`\\b${mounted}\\b`) as never,
      );
    }
  });
});
