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
    expect(code).not.toContain("jsx-runtime");
  });
});

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

describe("a pin's name is split into the facts it carries", () => {
  it("splits a derived name into repository, ref and system", async () => {
    const { pinName } = await import("./face");
    expect(pinName("juspay/odu@master/x86_64-linux")).toEqual({
      repo: "juspay/odu",
      ref: "master",
      system: "x86_64-linux",
    });
  });

  it("keeps a slash inside the ref, where it belongs", async () => {
    const { pinName } = await import("./face");
    const parsed = pinName("juspay/odu@release/2.0/aarch64-darwin");
    expect(parsed.ref).toBe("release/2.0");
    expect(parsed.system).toBe("aarch64-darwin");
  });

  it("invents no repository for a pin somebody named by hand", async () => {
    const { pinName } = await import("./face");
    expect(pinName("release-1.2")).toEqual({ repo: null, ref: "release-1.2", system: null });
  });
});

describe("a pin name is parsed in one pass", () => {
  it("answers a pathological name promptly, and reads it as nobody's repository", async () => {
    const { pinName } = await import("./face");
    const hostile = `a/b@${"!/".repeat(10_000)}`;
    const started = performance.now();
    const parsed = pinName(hostile);
    const took = performance.now() - started;
    expect(parsed).toEqual({ repo: null, ref: hostile, system: null });
    expect(took, `the parse took ${took}ms on a 20k-character name`).toBeLessThan(100);
  });

  it("still finds the system when a hostile ref ends in one", async () => {
    const { pinName } = await import("./face");
    const name = `a/b@${"!/".repeat(10_000)}x86_64-linux`;
    const started = performance.now();
    const parsed = pinName(name);
    const took = performance.now() - started;
    expect(parsed.repo).toBe("a/b");
    expect(parsed.system).toBe("x86_64-linux");
    expect(took, `the parse took ${took}ms on a 20k-character name`).toBeLessThan(100);
  });
});

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

describe("the paths table draws what the row answered", () => {
  const path = (
    name: string,
    hash: string,
    over: {
      narSize?: number;
      created?: number;
      hits?: number;
      lastWanted?: number;
      run?: string;
      commit?: string;
    } = {},
  ) => ({
    storePath: `/nix/store/${hash}-${name}`,
    narSize: over.narSize ?? 1_000,
    created: over.created ?? 1_000,
    hits: over.hits ?? 0,
    lastWanted: over.lastWanted ?? 1_000,
    ...(over.run === undefined ? {} : { run: over.run }),
    ...(over.commit === undefined ? {} : { commit: over.commit }),
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
            run: "run-9",
            commit: "f".repeat(40),
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
        run: "run-9",
        commit: "f".repeat(40),
        keptBy: null,
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
    expect(rows.map((row) => row.name)).toEqual(["zlib-1.3", "odu-base-0.1.0"]);
    expect(rows.every((row) => row.versions === 1)).toBe(true);
    expect(rows.map((row) => row.bytes)).toEqual([900, 100]);
    expect(rows[0]?.pushed).toBe(1_000);
    expect(rows[0]).toMatchObject({ run: null, commit: null });
  });

  it("carries a path's own run and commit through to its row", async () => {
    const { pathRows } = await import("./face");
    const rows = pathRows({
      paths: [
        path("odu-base-0.1.0", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
          run: "run-3",
          commit: "9".repeat(40),
        }),
      ],
    });
    expect(rows[0]).toMatchObject({ run: "run-3", commit: "9".repeat(40) });
  });

  it("carries what keeps a path, and a package, through to the row", async () => {
    const { pathRows } = await import("./face");
    const kept = { kind: "pin" as const, pins: ["release"], via: null, until: 9 };
    const [row] = pathRows({
      paths: [{ ...path("zlib-1.3", "cccccccccccccccccccccccccccccccc"), keptBy: kept }],
    });
    expect(row?.keptBy).toEqual(kept);
    const [group] = pathRows({
      paths: [],
      groups: [
        {
          name: "zlib-1.3",
          versions: 2,
          bytes: 1,
          hits: 0,
          pushed: 1,
          wanted: 1,
          storePath: "/nix/store/cccccccccccccccccccccccccccccccc-zlib-1.3",
          keptBy: kept,
        },
      ],
    });
    expect(group?.keptBy).toEqual(kept);
  });

  it("splits a store path into the hash a person compares and the name they read", async () => {
    const { storePathParts } = await import("./surface");
    expect(storePathParts("/nix/store/abcd1234abcd1234abcd1234abcd1234-hello-2.12")).toEqual({
      hash: "abcd1234abcd1234abcd1234abcd1234",
      name: "hello-2.12",
    });
    expect(storePathParts("not-a-store-path")).toEqual({
      hash: "",
      name: "not-a-store-path",
    });
  });
});

describe("the kept by column says why a path stays, and until when", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 13);
  const own = { grouped: false, retentionDays: 90 };

  it("names one pin, counts the rest, and says what the clock under it does", async () => {
    const { keptByText } = await import("./face");
    const one = keptByText({ kind: "pin", pins: ["release"], via: null, until: NOW + 83 * DAY }, NOW, own);
    expect(one.cell).toBe("pin release");
    expect(one.title).toContain("until the pin is deleted or re-pointed");
    expect(one.title).toContain("after that: in 83d");
    const many = keptByText(
      { kind: "pin", pins: ["release", "nightly", "beta"], via: null, until: NOW - DAY },
      NOW,
      own,
    );
    expect(many.cell).toBe("pin release +2");
    expect(many.title).toContain("release, nightly, beta");
    expect(many.title).toContain("after that: the next collection");
  });

  it("says retention with the day it leaves, and the want that wound it", async () => {
    const { keptByText } = await import("./face");
    const said = keptByText(
      { kind: "retention", pins: [], via: null, until: NOW + 83 * DAY },
      NOW,
      own,
    );
    expect(said.cell).toBe("retention · in 83d");
    expect(said.title).toContain("wanted 7d ago");
    expect(said.title).toContain("90 days after the last want");
    expect(said.title).toContain("first collection after 2027-02-04");
  });

  it("names the path that still needs it", async () => {
    const { keptByText } = await import("./face");
    const via = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app";
    const said = keptByText({ kind: "reference", pins: [], via, until: NOW + 2 * DAY }, NOW, own);
    expect(said.cell).toBe("reference · in 2d");
    expect(said.title.startsWith(`${via} still needs it, and was wanted 88d ago`)).toBe(true);
  });

  it("says nothing holds an expired path, and the next collection takes it", async () => {
    const { keptByText } = await import("./face");
    const said = keptByText({ kind: "nothing", pins: [], via: null, until: NOW - 3 * DAY }, NOW, own);
    expect(said.cell).toBe("nothing · next collection");
    expect(said.title).toContain("expired 3d ago");
  });

  it("says a package's verdict is its version held longest", async () => {
    const { keptByText } = await import("./face");
    const said = keptByText(
      { kind: "retention", pins: [], via: null, until: NOW + DAY },
      NOW,
      { grouped: true, retentionDays: 90 },
    );
    expect(said.cell).toBe("retention · in 24h");
    expect(said.title).toContain("the version held longest; open the row for each");
  });
});
