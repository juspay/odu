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
 * - **No package is the registry, and none is needed.** The door's registry is
 *   "the one package in no row that names every row"; this repo's roster is
 *   `packages/host/src/web.ts`, which is a ROOT file, and the door treats "a
 *   consumer that mounts rows from a root file alone" as a state rather than a
 *   defect (`fence.ts` ~1266). Rows are fixed at boot and named in one root, so
 *   there is no second place a row could be added and forgotten. What still
 *   holds is the reason a row may not import `@odu/host`: a face that reached it
 *   to bootstrap would carry every row's server to reach the code that starts
 *   one — which is what `@odu/cordis` exists to avoid.
 * - **The collision table** names the files where a row's word appears outside
 *   its own packages and outside the roots, with the count each one carries.
 *   Growing it is a diff somebody agrees to.
 *
 * ## What it costs to be green
 *
 * Two shape changes, both made in round 2/3 rather than declared away: the run
 * views moved into `@odu/ci/face` (a row's face, in the row's package) so the
 * board shell holds no row contract outside a root, and the `/mcp` path is
 * PASSED IN to the host's route rather than imported by it. Those were the only
 * files the host-package rule was catching.
 *
 * ## The green report is PROVEN, not asserted
 *
 * `prove(declaration)` breaks a copy of this tree once per claim and reports
 * whether the claim that names the defect refused it — and whether it refused
 * ONLY that one. It is asserted below, because a green report is worth exactly
 * what its machinery is worth: a sweep whose pattern stopped matching, whose
 * corpus came back short, or whose resolver walked one file is every one of
 * them green, and `0 findings` cannot tell a fence that is holding from a fence
 * that is not running.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fence, prove, rowsFromManifests } from "@olai/effect-cordis/fence";

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
      "packages/cli/src/serviceCli.ts": 4,
      "packages/cli/src/serviceMcp.ts": 4,
      // The composed wire, and the composed faces' needs: the row's key and
      // surface, and its `CACHE_NEEDS` read only when mounted.
      "packages/cli/src/wire.ts": 4,
      "packages/execution/src/coordinator/spawn.ts": 1,
      "packages/execution/src/runner/workspace.ts": 22,
      // `nix-cache-info` — Nix's protocol path, not odu's cache row. The probe
      // URL a tunnel's name is confirmed with is the protocol's own spelling.
      "packages/cloudflare/src/server.ts": 1,
      // The browser suite's Cloudflare stub answers the protocol probe.
      "packages/web-acceptance/support/cloudflareStub.ts": 1,
      // `cache-control` on three responses — an HTTP header, not a bucket.
      "packages/host/src/principal.ts": 3,
      // The bucket-domain gate: the page rewrite's `/cache/` and its own
      // 404 sentence. The path GRAMMAR moved to the row's `bucketOf` fact.
      "packages/host/src/bucketDomain.ts": 2,
      // The same header, on the shared door reader's one request.
      "packages/cordis/src/services.ts": 4,
      "packages/launch/src/webDaemonLaunch.ts": 1,
      "packages/web-acceptance/support/corpus.ts": 5,
      "packages/web-acceptance/support/world.ts": 5,
    },
    ci: {
      "packages/web-acceptance/support/service.ts": 7,
    },
    // THE DOOR'S WORD, and every one of these is a price of a row named after
    // a common noun: the daemon's roster and its gate, the shared vocabulary
    // that carries the `AuthDoor` fact and the broker tag, the composed wires a
    // CLI and a bridge read, and the runs' own service cell — which publishes
    // "does this daemon have a door" so a browser knows whether to sign in.
    auth: {
      "packages/cache/src/cache.ts": 2,
      // The refusal a private bucket gets names the command that fixes it.
      "packages/cache/src/cli.ts": 2,
      "packages/ci/src/protect.ts": 2,
      "packages/cli/src/serviceMcp.ts": 4,
      "packages/cli/src/wire.ts": 4,
      "packages/service/src/service.ts": 1,
      // The 401's sentence names the command a person runs to fix it.
      "packages/host/src/principal.ts": 1,
      // The harness names the row's world: a scenario's tags say whether the
      // browser meets a door, and the stub's environment is the door's.
      "packages/web-acceptance/support/authWorld.ts": 1,
      "packages/web-acceptance/support/hooks.ts": 3,
    },
    // THE TUNNEL'S WORD, where it is not a row: the NIX protocol's own path
    // `/nix-cache-info` is what a domain is probed for, and "cache" there
    // belongs to Nix. The row's own instructions are prose on the wire.
    cloudflare: {
      // The harness names the row's world and stubs the API it calls, the way
      // the door's world names the auth stub.
      "packages/web-acceptance/support/cloudflareStub.ts": 2,
      "packages/web-acceptance/support/hooks.ts": 15,
      // The composed wires that speak the sibling's key — the tunnel's argv
      // face and the MCP bridge beside the cache's and the door's — and the
      // row's own needs, read when mounted.
      "packages/cli/src/wire.ts": 4,
      "packages/cli/src/serviceMcp.ts": 5,
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

/** The door READS AND PARSES the tree, and `prove` copies it once per claim, so
 *  these are the slowest tests in the tree by an order of magnitude — seconds
 *  alone, and over a minute when the rest of the suite competes for the machine.
 *  The bound is generous because it exists to turn a HANG into a failure, not to
 *  police a runner's speed. */
const FENCE_TIMEOUT_MS = 240_000;

describe("the fence over this repo", () => {
  it("is green, every claim", () => {
    const report = fence(declaration);
    expect(
      report.findings,
      report.findings.map((one) => `${one.claim}: ${one.said}`).join("\n"),
    ).toEqual([]);
  }, FENCE_TIMEOUT_MS);

  it("has no registry, and needs none", () => {
    // The roster is in `packages/host/src/web.ts`, which is a ROOT file. The
    // door treats "a consumer that mounts rows from a root file alone" as a
    // STATE rather than a defect (`fence.ts` ~1266), and it is the truth here:
    // this repo's rows are fixed at boot and named in one root, so there is no
    // second place a row could be added and forgotten.
    expect(fence(declaration).reading.registry).toBeUndefined();
  });

  // A GREEN REPORT IS ONLY EVIDENCE IF IT WOULD GO RED. `prove` is the door's
  // own answer to that: it copies this tree, plants one defect per claim, and
  // requires each one to be caught BY ITS OWN CLAIM and to spill into none of
  // the others. Hand-written wrong declarations were what stood here before,
  // and they proved less — three levers out of six, over one claim's edges,
  // with nothing saying the other three were still turning.
  it("proves every claim, on a broken copy of this tree", () => {
    const proof = prove(declaration);
    expect(
      proof.ok,
      proof.baseline.length > 0
        ? `the baseline is red: ${proof.baseline.map((one) => `${one.claim}: ${one.said}`).join("; ")}`
        : proof.mutations
            .filter((one) => !one.caught || one.spill.length > 0)
            .map(
              (one) =>
                `${one.claim}: ${one.caught ? "caught" : "NOT caught"}` +
                (one.spill.length === 0 ? "" : ` and spilled into ${one.spill.join(", ")}`) +
                ` (${one.what})`,
            )
            .join("; "),
    ).toBe(true);
  }, FENCE_TIMEOUT_MS);
});

/**
 * THE THIRD ROW, and the shape that makes it a row rather than a folder.
 *
 * Declared by its manifest (so the walk above already found it), named by the
 * roots that may name rows, and imported by NOBODY else — `ci` and `cache` must
 * not be able to reach sign-in, which is the whole reason it is a separate
 * package rather than a module inside either.
 */
describe("four rows, each reachable only from the roots", () => {
  const manifestOf = (member: string): { dependencies?: Record<string, string> } =>
    JSON.parse(source(`${member}/package.json`)) as {
      dependencies?: Record<string, string>;
    };

  it("is four rows, read off the manifests", () => {
    expect(Object.keys(FENCE_ROWS).sort()).toEqual(["auth", "cache", "ci", "cloudflare"]);
  });

  it("no package of the ci or cache row depends on auth", () => {
    // EVERY member of those rows, read off the manifests — not the two
    // directories somebody remembered. A row is a set of packages, and a
    // dependency added to any one of them is the import the fence exists to
    // refuse.
    const members = ["ci", "cache"]
      .flatMap((row) => FENCE_ROWS[row] ?? [])
      // `packages/cli` projects EVERY row's argv face (it names
      // `@odu/cache/cli` for the same reason), so it is a root-shaped member
      // rather than one row's engine. The engines are what must not reach the
      // door.
      .filter((member) => member !== "packages/cli");
    expect(members.length).toBeGreaterThan(2);
    for (const member of members) {
      expect(
        Object.keys(manifestOf(member).dependencies ?? {}),
        `${member} declares @odu/auth`,
      ).not.toContain("@odu/auth");
    }
  });

  it("no package of the tunnel row depends on the cache row", () => {
    // THE TUNNEL REACTS TO A PUBLISHED FACT, not to the cache's database or
    // verbs. A dependency added here would be the row reaching across, which is
    // the shape `@odu/cordis`'s `BucketDomains` exists to avoid.
    for (const member of FENCE_ROWS.cloudflare ?? []) {
      expect(
        Object.keys(manifestOf(member).dependencies ?? {}),
        `${member} declares @odu/cache`,
      ).not.toContain("@odu/cache");
    }
  });

  it("the roots are what name it", () => {
    // The daemon mounts it, the browser opens its face, and the shell's boot
    // dials its surface — each is a root, which is the only place a row may be
    // named.
    expect(source("packages/host/src/web.ts")).toContain('"@odu/auth/server"');
    expect(source("packages/web-ui/src/main.tsx")).toContain('"@odu/auth/surface"');
    expect(source("packages/web-ui/src/app.tsx")).toContain('"@odu/auth/face"');
  });
});

/**
 * THE ONE CLAIM THE FRAMEWORK CANNOT MAKE, because it is about call sites rather
 * than about a package graph: **the word a row is mounted under, and the word
 * every face spells, are one constant.**
 *
 * The mount happens in the row's own `apply` (`bundle.mount(...)`), the roster
 * names it, and four faces build their view of the wire from it: the browser's
 * `connectSurfaces`, the argv projection, the stdio bridge and the cache's own
 * client. A mismatch is the quietest failure the bundle has — the page connects,
 * the health fold is green, and every call into that row answers "unknown
 * member" — and a LITERAL at five sites is how the mismatch happens. So the
 * claim is not "these five strings are equal" (the type system stopped needing
 * that the day the constant existed) but "these five sites use the constant, and
 * it is declared once, behind a door all five may open".
 */
describe("the row's word", () => {
  /** The contract, which is the browser-safe door every face can open. */
  const CONTRACT = source("packages/cache/src/surface.ts");
  const value = /export const CACHE_KEY = "([a-z0-9-]+)"/.exec(CONTRACT)?.[1];

  /** Every place that has to know it. */
  const FACES = [
    "packages/host/src/web.ts",
    "packages/web-ui/src/main.tsx",
    "packages/cli/src/serviceCli.ts",
    "packages/cli/src/serviceMcp.ts",
    "packages/cli/src/wire.ts",
    "packages/cache/src/cli.ts",
  ];

  it("reads the constant it thinks it is reading", () => {
    // The non-vacuity floor: a pattern that stopped matching would make every
    // assertion below true of `undefined`.
    expect(value).toBeDefined();
  });

  it("is declared once, in the contract both sides may open", () => {
    expect(CONTRACT).toContain(`export const CACHE_KEY = "${value as string}"`);
    // Not beside the plugin: `./server` is a door four of the five faces cannot
    // open, and a constant behind it is a literal they each retype.
    expect(source("packages/cache/src/server.ts")).not.toMatch(/export const CACHE_KEY/);
  });

  it("is the word the row mounts itself at", () => {
    expect(source("packages/cache/src/server.ts")).toMatch(/bundle\.mount\(CACHE_KEY,/);
  });

  it("is the word every face spells", () => {
    for (const file of FACES) {
      expect(source(file), `${file} does not name CACHE_KEY`).toContain("CACHE_KEY");
      // …and none of them spells the word itself as a sibling key.
      expect(source(file), `${file} spells the row's word`).not.toMatch(
        new RegExp(`\\b${value as string}:`),
      );
    }
  });

  it("is the key the roster serves it under", () => {
    const roster = source("packages/host/src/web.ts");
    expect(roster).toMatch(/\{\s*name:\s*CI_KEY,\s*key:\s*null,/);
    expect(roster).toMatch(/\{\s*name:\s*CACHE_KEY,\s*key:\s*CACHE_KEY,/);
  });
});
