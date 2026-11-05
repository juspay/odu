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
import {
  describeCache,
  type DescribedCache,
  pushToCache,
  type PushSummary,
} from "@odu/cache/push";

/** What a node's environment has to carry for this lane to push at all. */
export interface PushConfig {
  /** The URL the repository substitutes from. */
  readonly substituter: string;
  /** The run's write token, scoped to one bucket and expiring with the run. */
  readonly token: string;
}

/** The two variables a coordinator puts on a task so this module can act. */
export const PUSH_SUBSTITUTER_ENV = "ODU_CACHE_SUBSTITUTER";
export const PUSH_TOKEN_ENV = "ODU_CACHE_TOKEN";

/** The push configuration a task's environment states, or `null` when it
 *  states none — which is every task of a run with no cache target. */
export function pushConfigOf(
  env: Readonly<Record<string, string>> | undefined,
): PushConfig | null {
  const substituter = env?.[PUSH_SUBSTITUTER_ENV];
  const token = env?.[PUSH_TOKEN_ENV];
  if (substituter === undefined || substituter === "") return null;
  if (token === undefined || token === "") return null;
  return { substituter, token };
}

/** What one node's push came to. `null` from {@link pushNodeResults} means
 *  there was nothing new to push, which is not the same as pushing zero. */
export interface PushedFact {
  /** Store paths the bucket serves as a result of this node. */
  paths: number;
  /** NAR bytes this node's uploads stored. */
  bytes: number;
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
 * ONE RUNNER'S PUSHING — what it has already sent, and the bucket it learnt
 * once.
 *
 * Held per runner process rather than per node, because both facts are about
 * the LANE: a store path pushed by node A is on the bucket for node B too, and
 * the `nix-cache-info` that says which bucket a substituter is does not change
 * between nodes.
 */
export interface LanePusher {
  /**
   * Push whatever `result*` links this node left that have not been pushed
   * yet. `null` when there was nothing new; throws when the push failed, which
   * is what makes the node red.
   */
  push(
    workspace: string,
    config: PushConfig,
    say: (line: string) => void,
  ): Promise<PushedFact | null>;
}

export function createLanePusher(
  deps: {
    describe?: typeof describeCache;
    push?: typeof pushToCache;
    /** Where this machine's Nix store is — a seam, so a suite can state a
     *  workspace with links into a store it made. */
    storeDir?: string;
  } = {},
): LanePusher {
  const describe = deps.describe ?? describeCache;
  const send = deps.push ?? pushToCache;
  /** Store paths this lane has already put on the bucket. */
  const sent = new Set<string>();
  /** What the substituter said about itself, asked once. */
  let described: Promise<DescribedCache> | null = null;

  return {
    async push(workspace, config, say) {
      const found = resultPathsIn(workspace, deps.storeDir);
      const fresh = found.filter((path) => !sent.has(path));
      if (fresh.length === 0) return null;
      // ASKED ONCE PER LANE, and asked at all for the reason `odu cache push
      // --cache` asks: the push origin cannot be derived from the substituter,
      // because a substituter may be a store's own domain that takes no push.
      described ??= describe(config.substituter, fetch, config.token);
      const facts = await described;
      say(
        `[odu] pushing ${fresh.length} result path${fresh.length === 1 ? "" : "s"} ` +
          `to ${config.substituter} (bucket ${facts.bucket})`,
      );
      const summary: PushSummary = await send({
        bucket: facts.bucket,
        origin: facts.origin,
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
            `pushed to ${facts.bucket} — ` +
            summary.failures.map((failure) => `${failure.path}: ${failure.message}`).join("; "),
        );
      }
      return { paths: summary.served.length, bytes: summary.bytes };
    },
  };
}
