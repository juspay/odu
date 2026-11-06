/**
 * THE LANE'S PUSH (PLAN 4.1) — what it finds, what it sends ONCE, and what
 * happens when the bucket refuses.
 *
 * Four properties, and each would otherwise be discovered in production:
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
 *   - **Three sinks, and `begin` is a promise.** The push's own output goes to
 *     the push step's log, the lane explaining itself goes to the recipe's,
 *     and `begin` fires exactly when there is something to send — so a runner
 *     that saw it may rely on a fact or a throw arriving after, and a node
 *     with nothing fresh never opens a step at all.
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
import type { PushOptions, PushSummary } from "@odu/cache/push";
import {
  createLanePusher,
  type LanePusher,
  pushConfigOf,
  PUSH_FAILED_PREFIX,
  pushFailureSentenceIn,
  resultPathsIn,
} from "./pushResults";

const CONFIG = { origin: "https://odu.example.org", bucket: "main", token: "odu_run" };

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
  substituter: `${CONFIG.origin}/cache/${CONFIG.bucket}`,
  pinned: null,
  pageUrl: "https://odu.example.org/#/cache/main",
  ...over,
});

/** A pusher with a stated upload. No clock seam any more: the push's own
 *  duration is the RUNNER's measurement now, which is what lets the success
 *  and failure paths share one stopwatch — see `lanePush.test.ts` for the
 *  node-visible half. */
function laneWith(
  storeDir: string,
  push: (options: PushOptions) => Promise<PushSummary>,
): LanePusher {
  return createLanePusher({ storeDir, push });
}

/** The three sinks a push narrates through, each remembered apart — which is
 *  itself the property under test. `note` is the lane explaining itself on
 *  the RECIPE's log, `say` is the push step's own output, and `begin` is the
 *  step opening at all; a module that mixed them would put `[odu] pushing 4
 *  result paths` in the log whose whole promise is the recipe's bytes. */
function sinks(): {
  hooks: Parameters<LanePusher["push"]>[2];
  notes: string[];
  said: string[];
  begins: () => number;
} {
  const notes: string[] = [];
  const said: string[] = [];
  let begins = 0;
  return {
    hooks: {
      note: (line) => {
        notes.push(line);
      },
      begin: () => {
        begins += 1;
      },
      say: (line) => {
        said.push(line);
      },
    },
    notes,
    said,
    begins: () => begins,
  };
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

  it("THROWS for a directory that is not there, and the lane NOTES it on the recipe's log", async () => {
    // The silent half of the module-workdir bug. Where a recipe ran is
    // DERIVED from `just`'s dump, so it can be derived wrongly — and an empty
    // list made a wrong answer indistinguishable from a recipe that built
    // nothing: a green run that pushed nothing, with no line anywhere saying
    // which directory was looked in.
    expect(() => resultPathsIn("/nonexistent-workspace")).toThrow();

    const s = sinks();
    const lane = laneWith("/nix/store", async () => {
      throw new Error("the push client must never be reached");
    });
    expect(await lane.push("/nonexistent-workspace", CONFIG, s.hooks)).toBeNull();
    // ON THE RECIPE'S LOG, and nowhere else. There is no push step here —
    // `begin` never fired — so there is no push log for this sentence to land
    // in, and a reader asking why this node warmed nothing is reading the
    // recipe's output.
    expect(s.notes.join("\n")).toContain("not pushing: /nonexistent-workspace");
    expect(s.said).toEqual([]);
    expect(s.begins()).toBe(0);
  });

  it("reads the push configuration off a task's environment, and only a whole one", () => {
    expect(pushConfigOf(undefined)).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_ORIGIN: "https://a" })).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_ORIGIN: "https://a", ODU_CACHE_BUCKET: "m" })).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_TOKEN: "t" })).toBeNull();
    // A BLANK IS AN ABSENCE. An empty token would otherwise reach the push
    // client as a credential and fail there, naming the wrong thing.
    expect(
      pushConfigOf({
        ODU_CACHE_ORIGIN: "https://a",
        ODU_CACHE_BUCKET: "m",
        ODU_CACHE_TOKEN: "",
      }),
    ).toBeNull();
    expect(
      pushConfigOf({
        ODU_CACHE_ORIGIN: "https://a",
        ODU_CACHE_BUCKET: "m",
        ODU_CACHE_TOKEN: "t",
      }),
    ).toEqual({ origin: "https://a", bucket: "m", token: "t" });
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

      const s = sinks();
      const first = await lane.push(w.workspace, CONFIG, s.hooks);
      expect(first).toEqual({ paths: 1, bytes: 4096 });
      // THE STEP OPENED ONCE, and its narration is the PUSH's — not a line of
      // it on the recipe's log.
      expect(s.begins()).toBe(1);
      expect(s.said.join("\n")).toContain("pushing 1 result path to bucket main");
      expect(s.notes).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.paths).toEqual([one]);
      // WHERE THE DAEMON SAID, and nowhere else: the lane asks no server what
      // a URL is, because a server a repository named is exactly the thing
      // that must not decide where a write token goes.
      expect(sent[0]).toMatchObject({ bucket: CONFIG.bucket, origin: CONFIG.origin });
      // AND THE TOKEN AS A TOKEN. Not through the client's discovery
      // environment, which describes a MACHINE — its `HOME`, its saved logins
      // — and which a lane handing over a one-key object would also be
      // claiming to have none of.
      expect(sent[0]?.credential).toBe(CONFIG.token);
      expect(sent[0]?.env).toEqual({});

      // THE SECOND NODE leaves the same link. Nothing new, so nothing is sent,
      // nothing is claimed — and NO STEP IS OPENED: a node with nothing fresh
      // to push has no push step at all, which is what `begin` firing exactly
      // when `fresh` is non-empty buys the runner.
      const again = sinks();
      const second = await lane.push(w.workspace, CONFIG, again.hooks);
      expect(second).toBeNull();
      expect(sent).toHaveLength(1);
      expect(again.begins()).toBe(0);
      expect(again.said).toEqual([]);
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
      await lane.push(w.workspace, CONFIG, sinks().hooks);
      const second = w.build("result-doc", "bbb-doc");
      await lane.push(w.workspace, CONFIG, sinks().hooks);
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
      const s = sinks();
      const thrown = await lane
        .push(w.workspace, CONFIG, s.hooks)
        .then(() => null)
        .catch((err: unknown) => err);
      // THE STEP HAD ALREADY OPENED. A throw can only reach the runner after
      // `begin`, which is what lets it time the failure off one clock and
      // paint a `failed` push step rather than a node that never pushed.
      expect(s.begins()).toBe(1);
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
      await lane.push(w.workspace, CONFIG, sinks().hooks).catch(() => {});
      refuse = false;
      expect(await lane.push(w.workspace, CONFIG, sinks().hooks)).toBeNull();
      expect(sent).toHaveLength(1);
    } finally {
      w.dispose();
    }
  });
});

describe("the sentence a failed push leaves on the log", () => {
  // The marker is shared vocabulary between the lane that WRITES this line
  // and the coordinator that reads it back off its log tap to put the
  // client's own words in the journal's `push_failed` — rather than a
  // pointer at a log the reader of that record may not have. Two modules
  // agreeing about a literal is one wording change away from a reader that
  // silently never matches again, which is why both ends are here.
  it("recovers the client's own words from the line the lane writes", () => {
    expect(
      pushFailureSentenceIn(
        `\n${PUSH_FAILED_PREFIX}odu: 1 path could not be pushed to main — 413 too large\n`,
      ),
    ).toBe("odu: 1 path could not be pushed to main — 413 too large");
  });

  it("says NOTHING about a chunk that carries no failure", () => {
    // The ordinary case, and by far the commonest: every byte of every push
    // log passes this reader, and all it may do with a successful one is
    // decline to answer.
    expect(pushFailureSentenceIn("[odu] 3 paths in the closure: 1 to push\n")).toBeNull();
    expect(pushFailureSentenceIn("")).toBeNull();
    // A marker with nothing after it is not a sentence: an empty message in
    // the journal states less than the pointer it would replace.
    expect(pushFailureSentenceIn(`${PUSH_FAILED_PREFIX}\n`)).toBeNull();
  });

  it("takes the LAST failure in a chunk, and only its first line", () => {
    // A chunk can be a whole re-sent buffer — a lane's opening `snapshot`
    // replays everything it holds — and the newest line is the one that
    // describes the attempt a reader is looking at.
    expect(
      pushFailureSentenceIn(
        `${PUSH_FAILED_PREFIX}the first one\nmore output\n${PUSH_FAILED_PREFIX}the second one\n`,
      ),
    ).toBe("the second one");
    // ONE LINE of it. A client's message can run to several (a nix error with
    // a trace under it) and what this feeds is a journal field read as a
    // sentence beside a node id; the whole of it stays in the log.
    expect(
      pushFailureSentenceIn(`${PUSH_FAILED_PREFIX}refused by the bucket\n  at frobnicate\n`),
    ).toBe("refused by the bucket");
    // A chunk that ends mid-line still answers: a frame boundary is not a
    // fact about the sentence.
    expect(pushFailureSentenceIn(`${PUSH_FAILED_PREFIX}refused`)).toBe("refused");
  });
});
