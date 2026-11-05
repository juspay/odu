/**
 * THE LANE'S PUSH (PLAN 4.1) — what it finds, what it sends ONCE, and what
 * happens when the bucket refuses.
 *
 * Three properties, and each would otherwise be discovered in production:
 *
 *   - **`result*`, resolved.** A `nix build --out-link result` leaves a
 *     symlink, and the closure is of what it POINTS AT. A chain of links, a
 *     dangling one, and a `results.md` a recipe wrote are all things a
 *     workspace holds.
 *   - **Once per run.** Every recipe in a DAG typically leaves the same
 *     `./result`, so a push per node would be N closure queries for one set of
 *     bytes and would make every node after the first claim a push it did not
 *     perform.
 *   - **A refusal is a throw**, because the runner turns it into a red node:
 *     green means warmed, and a recipe whose outputs did not reach the bucket
 *     has not given the next run what this run promised.
 *
 * The store directory, the cache description and the push client are all
 * injected. This is about the lane's decisions; a suite that needed a Nix and
 * a bucket to assert "the second node pushes nothing" would assert it against
 * a bucket.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  describeCache,
  DescribedCache,
  PushOptions,
  PushSummary,
} from "@odu/cache/push";
import {
  createLanePusher,
  type LanePusher,
  pushConfigOf,
  resultPathsIn,
} from "./pushResults";

const CONFIG = { substituter: "https://cache.example/main", token: "odu_run" };

/** A workspace, and a store beside it that its links point into. */
interface World {
  workspace: string;
  storeDir: string;
  /** Put a store path there and link to it from the workspace. */
  build: (link: string, name: string) => string;
  /** A file in the workspace that is not a link at all. */
  write: (name: string) => void;
  dispose: () => void;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "odu-push-"));
  const storeDir = join(root, "store");
  const workspace = join(root, "work");
  mkdirSync(storeDir);
  mkdirSync(workspace);
  return {
    workspace,
    storeDir,
    build: (link, name) => {
      const target = join(storeDir, name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "bin"), "x");
      symlinkSync(target, join(workspace, link));
      return target;
    },
    write: (name) => writeFileSync(join(workspace, name), "notes"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const summary = (over: Partial<PushSummary> = {}): PushSummary => ({
  pushed: 1,
  bytes: 4096,
  skippedUpstream: 0,
  skippedDerivation: [],
  mode: "direct",
  alreadyPresent: 0,
  failed: 0,
  failures: [],
  served: [],
  substituter: CONFIG.substituter,
  pinned: null,
  pageUrl: "https://odu.example.org/#/cache/main",
  ...over,
});

const FACTS: DescribedCache = { origin: "https://odu.example.org", bucket: "main" };

/** A pusher whose cache description and upload are both stated. */
function laneWith(
  storeDir: string,
  push: (options: PushOptions) => Promise<PushSummary>,
): LanePusher {
  return createLanePusher({
    storeDir,
    describe: (async () => FACTS) as unknown as typeof describeCache,
    push,
  });
}

describe("what a lane finds to push", () => {
  it("resolves result* links to store paths, through a chain, and ignores the rest", () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      w.build("result-doc", "bbb-doc");
      // A FILE A RECIPE WROTE. `result*` is a glob, and `results.md` matches
      // it — the store-prefix check is what keeps a note out of a closure.
      w.write("results.md");
      // A CHAIN, which a justfile leaves behind: only the final target is a
      // store path, and `realpath` is what follows it.
      symlinkSync(join(w.workspace, "result"), join(w.workspace, "result-alias"));
      // AND A DANGLING ONE, from a store path collected since the build.
      symlinkSync(join(w.storeDir, "ccc-gone"), join(w.workspace, "result-gone"));

      const found = resultPathsIn(w.workspace, w.storeDir);
      // `result-alias` resolves to the SAME path as `result`, so it appears
      // once: a closure named twice is uploaded twice.
      expect(found).toEqual([one, join(w.storeDir, "bbb-doc")]);
    } finally {
      w.dispose();
    }
  });

  it("answers nothing for a workspace that is not there", () => {
    expect(resultPathsIn("/nonexistent-workspace")).toEqual([]);
  });

  it("reads the push configuration off a task's environment, and only a whole one", () => {
    expect(pushConfigOf(undefined)).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_SUBSTITUTER: "https://a" })).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_TOKEN: "t" })).toBeNull();
    // A BLANK IS AN ABSENCE. An empty token would otherwise reach the push
    // client as a credential and fail there, naming the wrong thing.
    expect(
      pushConfigOf({ ODU_CACHE_SUBSTITUTER: "https://a", ODU_CACHE_TOKEN: "" }),
    ).toBeNull();
    expect(
      pushConfigOf({ ODU_CACHE_SUBSTITUTER: "https://a", ODU_CACHE_TOKEN: "t" }),
    ).toEqual({ substituter: "https://a", token: "t" });
  });
});

describe("a lane that pushes", () => {
  it("sends a store path once, and the next node reports nothing", async () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const lane = laneWith(w.storeDir, async (options) => {
        sent.push(options);
        return summary({ served: [...options.paths] });
      });

      const first = await lane.push(w.workspace, CONFIG, () => {});
      expect(first).toEqual({ paths: 1, bytes: 4096 });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.paths).toEqual([one]);
      // THE BUCKET, NOT THE SUBSTITUTER: a substituter may be a store's own
      // domain that takes no push, so the push goes to the origin the cache
      // named about itself.
      expect(sent[0]).toMatchObject({ bucket: "main", origin: FACTS.origin });
      // AND THE TOKEN, AND ONLY THE TOKEN.
      expect(sent[0]?.env).toEqual({ ODU_CACHE_TOKEN: CONFIG.token });

      // THE SECOND NODE leaves the same link. Nothing new, so nothing is sent
      // and nothing is claimed.
      const second = await lane.push(w.workspace, CONFIG, () => {});
      expect(second).toBeNull();
      expect(sent).toHaveLength(1);
    } finally {
      w.dispose();
    }
  });

  it("pushes only what is NEW when a later node builds something more", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const lane = laneWith(w.storeDir, async (options) => {
        sent.push(options);
        return summary({ served: [...options.paths] });
      });
      await lane.push(w.workspace, CONFIG, () => {});
      const second = w.build("result-doc", "bbb-doc");
      await lane.push(w.workspace, CONFIG, () => {});
      expect(sent).toHaveLength(2);
      expect(sent[1]?.paths).toEqual([second]);
    } finally {
      w.dispose();
    }
  });

  it("throws when the bucket refused a path, naming it — which is what reddens the node", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const lane = laneWith(w.storeDir, async () =>
        summary({
          failed: 1,
          failures: [{ path: "/store/aaa-one", message: "413 too large" }],
          served: [],
        }),
      );
      const thrown = await lane
        .push(w.workspace, CONFIG, () => {})
        .then(() => null)
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("413 too large");
      expect((thrown as Error).message).toContain("main");
    } finally {
      w.dispose();
    }
  });

  it("does not re-send a path the bucket already serves, even when a sibling was refused", async () => {
    // A partial push still TAUGHT this lane something: the served paths are on
    // the bucket, and the next node must not upload them again to find out.
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      let refuse = true;
      const lane = laneWith(w.storeDir, async (options) => {
        sent.push(options);
        const answer = refuse
          ? summary({
              failed: 1,
              failures: [{ path: "/store/zzz-dep", message: "refused" }],
              served: [one],
            })
          : summary({ served: [...options.paths] });
        return answer;
      });
      await lane.push(w.workspace, CONFIG, () => {}).catch(() => {});
      refuse = false;
      expect(await lane.push(w.workspace, CONFIG, () => {})).toBeNull();
      expect(sent).toHaveLength(1);
    } finally {
      w.dispose();
    }
  });
});
