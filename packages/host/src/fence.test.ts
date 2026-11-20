import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fence, prove, rowsFromManifests } from "@olai/effect-cordis/fence";

const REPO = join(import.meta.dirname, "..", "..", "..");
const source = (file: string): string => readFileSync(join(REPO, file), "utf-8");

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
  collisions: {
    cache: {
      "packages/cli/src/serviceMcp.ts": 2,
      "packages/cli/src/wire.ts": 2,
      "packages/execution/src/coordinator/spawn.ts": 1,
      "packages/execution/src/runner/workspace.ts": 24,
      "packages/cloudflare/src/server.ts": 4,
      "packages/cloudflare/src/api.ts": 1,
      "packages/web-acceptance/support/cloudflareStub.ts": 1,
      "packages/host/src/principal.ts": 3,
      "packages/host/src/metricsRoute.ts": 2,
      "packages/objects/src/objectStore.ts": 1,
      "packages/objects/src/s3Store.ts": 3,
      "packages/host/src/bucketDomain.ts": 2,
      "packages/cordis/src/services.ts": 20,
      "packages/ci/src/webPorts.ts": 6,
      "packages/ci/src/row.ts": 3,
      "packages/execution/src/coordinator/run.ts": 1,
      "packages/execution/src/runner/pushResults.ts": 6,
      "packages/service/src/start.ts": 1,
      "packages/cli/src/ciCli.ts": 1,
      "packages/service-client/src/verbs.ts": 2,
      "packages/launch/src/webDaemonLaunch.ts": 1,
      "packages/web-acceptance/support/corpus.ts": 5,
      "packages/web-acceptance/support/world.ts": 5,
      "packages/web-acceptance/board-shots.ts": 7,
    },
    ci: {
      "packages/web-acceptance/support/service.ts": 7,
    },
    auth: {
      "packages/cache/src/cache.ts": 2,
      "packages/cache/src/cli.ts": 2,
      "packages/ci/src/protect.ts": 2,
      "packages/cli/src/wire.ts": 2,
      "packages/service/src/service.ts": 1,
      "packages/host/src/principal.ts": 1,
      "packages/web-acceptance/support/authWorld.ts": 1,
      "packages/web-acceptance/support/hooks.ts": 3,
      "packages/web-acceptance/board-shots.ts": 1,
    },
    cloudflare: {
      "packages/web-acceptance/support/cloudflareStub.ts": 2,
      "packages/web-acceptance/support/hooks.ts": 15,
      "packages/web-acceptance/board-shots.ts": 9,
      "packages/cli/src/wire.ts": 2,
    },
  },
  allowances: {
    "packages/execution/src/coordinator/spawn.ts":
      "`liveRuns` is the spawn module's own registry of the runs it started — " +
      "written only here, read only to report a child that died, and the one " +
      "piece of state a launcher has no caller to carry it through.",
  },
} as const;

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
    expect(fence(declaration).reading.registry).toBeUndefined();
  });

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

describe("four rows, each reachable only from the roots", () => {
  const manifestOf = (member: string): { dependencies?: Record<string, string> } =>
    JSON.parse(source(`${member}/package.json`)) as {
      dependencies?: Record<string, string>;
    };

  it("is four rows, read off the manifests", () => {
    expect(Object.keys(FENCE_ROWS).sort()).toEqual(["auth", "cache", "ci", "cloudflare"]);
  });

  it("no package of the ci or cache row depends on auth", () => {
    const members = ["ci", "cache"]
      .flatMap((row) => FENCE_ROWS[row] ?? [])
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
    for (const member of FENCE_ROWS.cloudflare ?? []) {
      expect(
        Object.keys(manifestOf(member).dependencies ?? {}),
        `${member} declares @odu/cache`,
      ).not.toContain("@odu/cache");
    }
  });

  it("the roots are what name it", () => {
    expect(source("packages/host/src/web.ts")).toContain('"@odu/auth/server"');
    expect(source("packages/web-ui/src/main.tsx")).toContain('"@odu/auth/surface"');
    expect(source("packages/web-ui/src/app.tsx")).toContain('"@odu/auth/face"');
  });
});

describe("the row's word", () => {
  const CONTRACT = source("packages/cache/src/surface.ts");
  const value = /export const CACHE_KEY = "([a-z0-9-]+)"/.exec(CONTRACT)?.[1];

  const FACES = [
    "packages/host/src/web.ts",
    "packages/web-ui/src/main.tsx",
    "packages/cli/src/serviceMcp.ts",
    "packages/cli/src/wire.ts",
    "packages/cache/src/cli.ts",
  ];

  it("reads the constant it thinks it is reading", () => {
    expect(value).toBeDefined();
  });

  it("is declared once, in the contract both sides may open", () => {
    expect(CONTRACT).toContain(`export const CACHE_KEY = "${value as string}"`);
    expect(source("packages/cache/src/server.ts")).not.toMatch(/export const CACHE_KEY/);
  });

  it("is the word the row mounts itself at", () => {
    expect(source("packages/cache/src/server.ts")).toMatch(/bundle\.mount\(CACHE_KEY,/);
  });

  it("is the word every face spells", () => {
    for (const file of FACES) {
      expect(source(file), `${file} names neither CACHE_KEY nor CACHE_ROW`).toMatch(
        /\bCACHE_(KEY|ROW)\b/,
      );
      expect(source(file), `${file} spells the row's word`).not.toMatch(
        new RegExp(`\\b${value as string}:(?!\\s*\\{\\s*type:)`),
      );
    }
  });

  it("is the key the row's own record serves it under, and the roster lists that record", () => {
    expect(source("packages/ci/src/row.ts")).toMatch(/\{\s*name:\s*CI_ROW,\s*key:\s*null,/);
    expect(source("packages/cache/src/surface.ts")).toMatch(
      /CACHE_ROW: RowFacts = \{\s*name:\s*CACHE_KEY,\s*key:\s*CACHE_KEY,/,
    );
    expect(source("packages/cache/src/server.ts")).toMatch(/\.\.\.CACHE_ROW,/);
    const roster = source("packages/host/src/web.ts");
    expect(roster).toMatch(/ROWS: ReadonlyArray<Row> = \[\s*ciRowRecord,\s*cacheRowRecord\(cacheStores\.stores\),/);
    expect(roster).not.toMatch(/_CONTRACT_VERSION/);
  });
});
