/**
 * WHAT A RECIPE BUILT, PUT IN THE CACHE — the lane's half of PLAN 4.1.
 *
 * A repository that reads from an odu cache builds for it. The whole of what a
 * repository declares is the `extra-substituters` line already in its
 * `flake.nix`; the service resolved that to a bucket and minted a write token
 * for this run, and both arrive here as the node's own process environment
 * (`ODU_CACHE_SUBSTITUTER`, `ODU_CACHE_TOKEN`). Nothing in any recipe, no token
 * in the tree, no second place a bucket name can go stale.
 *
 * ## `result*`, and nothing else
 *
 * `nix build` writes `./result`, `./result-doc`, `./result-2`. Those symlinks
 * are the one convention every Nix repository already keeps, and they are what
 * a recipe's outputs ARE — so the lane globs the workspace root after a recipe
 * exits 0 and pushes the closure of whatever it finds. A recipe that builds
 * nothing leaves no link, and nothing is pushed and nothing is said.
 *
 * ## A target is pushed ONCE per run
 *
 * Every recipe in a DAG typically leaves the same `./result` behind, and the
 * later ones leave it pointing at the same store path. Pushing it per node
 * would be N closure queries and N narinfo writes for one set of bytes, and
 * would make every node after the first report a push it did not perform. The
 * runner remembers the store paths it has already sent and subtracts them; a
 * node whose links all resolve to paths an earlier node pushed reports
 * nothing, which is the honest answer.
 *
 * ## A failed push is a RED NODE
 *
 * Green means warmed. A recipe that built the right thing and could not store
 * it has not given the next run what this run promised, and reporting that as a
 * pass would make the cache's contents a matter of luck. The push client's own
 * sentence goes in the node's log, beside the recipe's output, and the node
 * fails — the same shape as any other failure, with no new state to learn.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pushToCache, type PushSummary } from "@odu/cache/push";

/** What a node's environment has to carry for this lane to push at all. */
export interface PushConfig {
  /** `Odu-Origin`: where the push goes. RESOLVED BY THE DAEMON from the
   *  bucket it serves — this lane asks no server what a URL is, because a
   *  server the repository named is exactly the thing that must not decide
   *  where a write token is sent. */
  readonly origin: string;
  /** The bucket at that origin. */
  readonly bucket: string;
  /** The run's write token, scoped to that one bucket and expiring with the
   *  run. */
  readonly token: string;
}

/** The three variables a coordinator puts on a task so this module can act. */
export const PUSH_ORIGIN_ENV = "ODU_CACHE_ORIGIN";
export const PUSH_BUCKET_ENV = "ODU_CACHE_BUCKET";
export const PUSH_TOKEN_ENV = "ODU_CACHE_TOKEN";

/** The push configuration a task's environment states, or `null` when it
 *  states none — which is every task of a run with no cache target. */
export function pushConfigOf(
  env: Readonly<Record<string, string>> | undefined,
): PushConfig | null {
  const origin = env?.[PUSH_ORIGIN_ENV];
  const bucket = env?.[PUSH_BUCKET_ENV];
  const token = env?.[PUSH_TOKEN_ENV];
  if (origin === undefined || origin === "") return null;
  if (bucket === undefined || bucket === "") return null;
  if (token === undefined || token === "") return null;
  return { origin, bucket, token };
}

/** What one node's push came to. `null` from {@link LanePusher.push} means
 *  there was nothing new to push, which is not the same as pushing zero. */
export interface PushedFact {
  /** Store paths the bucket serves as a result of this node. */
  paths: number;
  /** NAR bytes this node's uploads stored. */
  bytes: number;
  /** How long the push took. SEPARATE from the node's own duration, which
   *  stays the recipe's time. */
  durationMs: number;
}

/**
 * The `result*` symlinks in a workspace, resolved to store paths.
 *
 * `realpath` rather than `readlink`, because a chain (`result` →
 * `result-link` → the store) is a thing a justfile can leave behind and only
 * the final target is a store path. A link that resolves to nothing — a store
 * path garbage-collected between the build and here — is dropped: a push of a
 * path the store does not have would fail on `nix path-info` with a sentence
 * about the wrong thing.
 *
 * `storeDir` is a PARAMETER rather than the constant `/nix/store`, because a
 * lane host need not keep its store there: `$NIX_STORE_DIR` is how a chroot
 * store or a single-user install says where it is, and a hard-coded prefix
 * would quietly push nothing on one. The check exists at all because
 * `result*` is a glob — `results.md` matches it — and a path outside the
 * store is a file a recipe wrote, not an output.
 */
export function resultPathsIn(workspace: string, storeDir: string = nixStoreDir()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(workspace);
  } catch {
    return [];
  }
  const prefix = storeDir.endsWith("/") ? storeDir : `${storeDir}/`;
  const resolved: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith("result")) continue;
    const link = join(workspace, entry);
    try {
      const target = realpathSync(link);
      if (!target.startsWith(prefix)) continue;
      if (!existsSync(target)) continue;
      if (!resolved.includes(target)) resolved.push(target);
    } catch {
      // A dangling link. The recipe's own output already said whatever there
      // is to say about it; a push is not the place to report a broken symlink.
    }
  }
  return resolved;
}

/** Where this machine keeps its Nix store. `$NIX_STORE_DIR` is Nix's own
 *  answer; the default is the one every ordinary install has. */
function nixStoreDir(): string {
  const declared = process.env.NIX_STORE_DIR?.trim();
  return declared === undefined || declared === "" ? "/nix/store" : declared;
}

/**
 * ONE RUNNER'S PUSHING — what it has already sent.
 *
 * Held per runner process rather than per node, because that is a fact about
 * the LANE: a store path pushed by node A is on the bucket for node B too.
 *
 * There is no discovery here any more. The first shape asked the substituter
 * for its `nix-cache-info` — sending the run's write token to a URL the
 * REPOSITORY named, and then pushing to whatever origin that body claimed —
 * and memoised the promise, so one transient blip reddened every later node on
 * the lane for good. The daemon resolved the origin and the bucket before the
 * lane existed; this uses them, and dials nothing it was not told to.
 */
export interface LanePusher {
  /**
   * Push whatever `result*` links this node left that have not been pushed
   * yet, looking in the directory the recipe actually RAN in. `null` when
   * there was nothing new; throws when the push failed, which is what makes
   * the node red.
   */
  push(
    workdir: string,
    config: PushConfig,
    say: (line: string) => void,
  ): Promise<PushedFact | null>;
}

export function createLanePusher(
  deps: {
    push?: typeof pushToCache;
    /** Where this machine's Nix store is — a seam, so a suite can state a
     *  workspace with links into a store it made. */
    storeDir?: string;
    now?: () => number;
  } = {},
): LanePusher {
  const send = deps.push ?? pushToCache;
  const now = deps.now ?? Date.now;
  /** Store paths this lane has already put on the bucket. */
  const sent = new Set<string>();

  return {
    async push(workdir, config, say) {
      const found = resultPathsIn(workdir, deps.storeDir);
      const fresh = found.filter((path) => !sent.has(path));
      if (fresh.length === 0) return null;
      const startedAt = now();
      say(
        `[odu] pushing ${fresh.length} result path${fresh.length === 1 ? "" : "s"} ` +
          `to bucket ${config.bucket} at ${config.origin}`,
      );
      const summary: PushSummary = await send({
        bucket: config.bucket,
        origin: config.origin,
        paths: fresh,
        // THE TOKEN, AND ONLY THE TOKEN. The push client reads an environment
        // slice rather than `process.env`, so the lane hands it exactly the one
        // variable it is entitled to and nothing else this process holds.
        env: { ODU_CACHE_TOKEN: config.token },
        onLine: (line) => say(`[odu] ${line}`),
      });
      // RECORDED BEFORE THE REFUSAL IS RAISED: a path the bucket serves is one
      // the next node must not send again, whether or not a sibling path in the
      // same closure was refused.
      for (const path of summary.served) sent.add(path);
      if (summary.failed > 0) {
        throw new Error(
          `odu: ${summary.failed} path${summary.failed === 1 ? "" : "s"} could not be ` +
            `pushed to ${config.bucket} — ` +
            summary.failures.map((failure) => `${failure.path}: ${failure.message}`).join("; "),
        );
      }
      return {
        paths: summary.served.length,
        bytes: summary.bytes,
        durationMs: now() - startedAt,
      };
    },
  };
}
