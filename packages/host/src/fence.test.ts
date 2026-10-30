/**
 * THE FENCE — the claims no runtime can check, over this repo.
 *
 * `@olai/effect-cordis/fence` reads SOURCES and MODULE GRAPHS: which package
 * imported which, what a root's walk carries, where a row's name appears as
 * text, which module a second package can open holds live state, and whether
 * the rows the host supplied, the rows on disk and the rows the roots compose
 * are one set. It imports no plugin and evaluates no plugin, so a row that will
 * not even load still gets every claim run against it.
 *
 * ## The declaration, in this repo's nouns
 *
 * - **Three roots**: `src/main.ts` (the CLI — Node), `packages/host/src/web.ts`
 *   (the daemon — Node) and `packages/web-ui/src/app.tsx` (the route table —
 *   browser). These are the files that may name more than one row.
 * - **Rows from manifests.** Every package says `"cordis": { "row": … }`; the
 *   fence resolves them itself, so a new package that forgets to say which row
 *   it is behind is a finding rather than a silent member of nothing.
 * - **The collision table** names the files where a row's word appears outside
 *   its own packages and outside the roots, with the count each one carries.
 *   Growing it is a diff somebody agrees to.
 *
 * ## What the first green run cost
 *
 * Two structure changes came out of the fence rather than into it, and both are
 * the point of running one:
 *
 *   - **`@odu/launch`.** The CLI (a row) reached `@odu/host` to learn how to
 *     bootstrap — and the host names every row, so that was a row importing the
 *     registry. The launch facts and adopt/spawn/refuse moved to a package that
 *     names no row, and the wire group moved beside the clients that use it.
 *   - **THE ROW SET IS WIDER THAN THE DIAGRAM SAYS.** The fence's vocabulary has
 *     two kinds — a ROW, and the REGISTRY that names every row — and exactly one
 *     package can be the registry. `@odu/host` is it, so the host belongs to a
 *     row too; and the board (`@odu/web-ui`) is a row's FACE, because it names
 *     row CONTRACTS in files that are not roots. So `ci` is the runs, the
 *     daemon, its launch seam and its page, and `cache` stays the one row that
 *     can be lifted out whole. That is what this PR demonstrates.
 *
 * ## One claim beside the fence, and it is odu's
 *
 * The framework cannot know that the key a row is MOUNTED under and the key its
 * CLIENT is built against are one word — that is a fact about two call sites in
 * this repo. So the last test reads both and holds them equal, because a
 * mismatch is the quietest failure in the bundle: the page connects, and every
 * call into that row answers "unknown member".
 *
 * ## `prove`
 *
 * A green fence is only evidence if it would go red, so `prove` breaks a COPY of
 * the tree once per claim and asserts the claim that names each defect refused
 * it. Nothing is edited in place: the copy is the fence's, and the repo is read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fence, rowsFromManifests } from "@olai/effect-cordis/fence";
import { ROWS } from "./roster";

/** The workspace root: the directory whose `package.json` carries the
 *  `workspaces` globs. */
const REPO = join(import.meta.dirname, "..", "..", "..");

const FENCE_ROWS = rowsFromManifests(REPO);

const declaration = {
  repo: REPO,
  rows: FENCE_ROWS,
  roots: [
    { entry: "src/main.ts", graph: "node" as const },
    { entry: "packages/host/src/web.ts", graph: "node" as const },
    { entry: "packages/web-ui/src/app.tsx", graph: "browser" as const },
  ],
  // WHERE A ROW'S WORD LEGITIMATELY APPEARS OUTSIDE ITS OWN PACKAGES, and how
  // many times. A COUNT rather than a boolean, because "it is mentioned there"
  // and "it is mentioned there twenty-nine times" are different dependencies on
  // the same decision, and a table that only said the first would let the second
  // grow unwatched.
  //
  // Two kinds of entry, and both are the price of the row being named after a
  // common noun:
  //
  //   - THE PROJECTIONS that must speak the sibling's key — `odu surface`'s,
  //     the stdio bridge's, and the client-side wire group — because they
  //     compose that row's client over the same connection;
  //   - THE WORD ITSELF, in code that has nothing to do with buckets: a runner's
  //     build cache, a `nix` cache flag, the acceptance suite's own fixtures, and
  //     a bucket's HTML class names. Naming a row `cache` means the word is
  //     already everywhere; this table is where that cost is recorded.
  collisions: {
    cache: {
      "packages/cli/src/serviceCli.ts": 6,
      "packages/cli/src/serviceMcp.ts": 6,
      "packages/cli/src/wire.ts": 3,
      "packages/execution/src/coordinator/spawn.ts": 1,
      "packages/execution/src/runner/workspace.ts": 22,
      "packages/host/src/roster.ts": 4,
      "packages/host/src/rows/cache.ts": 29,
      "packages/launch/src/webDaemonLaunch.ts": 1,
      "packages/web-acceptance/step_definitions/cache_steps.ts": 27,
      "packages/web-acceptance/support/corpus.ts": 5,
      "packages/web-acceptance/support/world.ts": 3,
      "packages/web-ui/src/main.tsx": 3,
    },
    ci: {
      "packages/web-acceptance/support/service.ts": 7,
    },
  },
  // A MODULE THAT HOLDS LIVE STATE BEHIND A DOOR, and why. `liveRuns` is the
  // spawn module's registry of runs it started — the one place a launcher
  // remembers what it launched, so a reaped child can be reported rather than
  // silently forgotten. It is module state on purpose: the alternative is
  // threading a table through every spawn call for a fact only this module
  // writes.
  allowances: {
    "packages/execution/src/coordinator/spawn.ts":
      "`liveRuns` is the spawn module's own registry of the runs it started — " +
      "written only here, read only to report a child that died, and the one " +
      "piece of state a launcher has no caller to carry it through.",
  },
} as const;

describe("the fence over this repo", () => {
  it("is green", () => {
    const report = fence(declaration);
    expect(report.findings, report.findings.map((one) => `${one.claim}: ${one.said}`).join("\n")).toEqual([]);
  });

  // A GREEN REPORT IS ONLY EVIDENCE IF IT WOULD GO RED, so each of the levers
  // this declaration pulls is pulled the wrong way once. No temp tree and no
  // copy: the claims are functions of the DECLARATION, so a wrong declaration
  // over the same sources is the defect, and it is one a reviewer can read.
  it("goes red when a row the packages declare is not in the roster", () => {
    const report = fence({ ...declaration, rows: { ci: FENCE_ROWS.ci! } });
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
 * THE ONE CLAIM THE FRAMEWORK CANNOT MAKE, because it is about two call sites.
 *
 * The daemon mounts each row's surface under a key, and each CLIENT builds its
 * face from a key. They are the same word in two files — `packages/host/src/rows.ts`
 * mounts, `packages/web-ui/src/main.tsx` and `packages/cli/src/serviceCli.ts`
 * dial — and a mismatch is the quietest failure the bundle has: the page
 * connects, the health fold is green, and every call into that row answers
 * "unknown member".
 */
describe("the row names the two sides agree on", () => {
  const source = (file: string): string => readFileSync(join(REPO, file), "utf-8");

  /** The rows the DAEMON mounts, read off its own table — the one place that
   *  decides what is served and under which word. */
  const mounted = ROWS.map((row) => ({ name: row.name, key: row.key }));

  it("reads the row set it thinks it is reading", () => {
    // The non-vacuity floor: a regex that stopped matching would make every
    // assertion below true of an empty list.
    expect(mounted.length).toBeGreaterThanOrEqual(2);
    // ...and the manifests agree with it: the roster and the per-package
    // declarations are two readings of one set, and the fence compares them
    // (`registry`). A row added to one and not the other is red there.
    expect(mounted.map((row) => row.name).sort()).toEqual(Object.keys(FENCE_ROWS).sort());
  });

  it("is the key the browser dials", () => {
    const text = source("packages/web-ui/src/main.tsx");
    for (const row of mounted) {
      if (row.key === null) {
        // The ROOT's name is a slot in the health fold, not a wire segment.
        expect(text).toContain(`name: "${row.name}"`);
        continue;
      }
      expect(text, `main.tsx does not mount "${row.key}"`).toContain(`${row.key}: `);
    }
  });

  it("is the key the argv face mounts", () => {
    const text = source("packages/cli/src/serviceCli.ts");
    for (const row of mounted) {
      if (row.key === null) continue;
      expect(text, `serviceCli.ts does not mount "${row.key}"`).toContain(`${row.key}: {`);
    }
  });
});
