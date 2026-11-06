/**
 * WHAT A RECIPE BUILT, PUT IN THE CACHE — the lane's half of PLAN 4.1.
 *
 * A repository that reads from an odu cache builds for it. The whole of what a
 * repository declares is the `extra-substituters` line already in its
 * `flake.nix`; the service resolved that to a bucket and minted a write token
 * for this run, and the three facts that follow from that — the origin the
 * push goes to, the bucket, and the token — arrive on the node's own task
 * environment (`ODU_CACHE_ORIGIN`, `ODU_CACHE_BUCKET`, `ODU_CACHE_TOKEN`),
 * which the runner reads and the recipe's child never sees. Nothing in any
 * recipe, no token in the tree, no second place a bucket name can go stale.
 *
 * ## `result*`, and nothing else
 *
 * `nix build` writes `./result`, `./result-doc`, `./result-2`. Those symlinks
 * are the one convention every Nix repository already keeps, and they are what
 * a recipe's outputs ARE — so the lane globs the directory the recipe RAN in
 * (`TaskSpec.workdir`: `just` runs a module's recipe in the module's own
 * directory, which the workspace root is not) after it exits 0, and pushes
 * the closure of whatever it finds. A recipe that builds nothing leaves no
 * link, and nothing is pushed and nothing is said.
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
 * sentence goes in the node's PUSH log and the node fails — the same shape as
 * any other failure, with no new state to learn.
 *
 * ## The push is its own STEP, so it narrates on its own stream
 *
 * What this module says splits three ways, which is why {@link LanePusher.push}
 * takes three sinks instead of one `say`. The push's output is the push step's
 * output and goes to the node's push log; the beginning of the step is a state
 * change (`begin`) rather than a line; and a refusal to push at all — a workdir
 * that cannot be read — has no step to belong to and goes on the recipe's log,
 * which is where somebody asking "why did this node warm nothing" is reading.
 * Interleaving the three cost the recipe's log the one promise it makes: that
 * what is in it is what the recipe printed.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pushToCache, type PushFailure, type PushSummary } from "@odu/cache/push";

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

/**
 * The task environment that carries a push to a lane — the WRITING half of
 * {@link pushConfigOf}, here beside it.
 *
 * Both halves of a wire belong to one module. The coordinator spelled these
 * three names itself, which made the strip that keeps the token out of a
 * recipe's own environment (`PUSH_TOKEN_ENV`, in the runner) correct only
 * while two files agreed about a literal — and a rename that moved one and
 * not the other would leak a live credential into every recipe's log in
 * silence. 4.2 adds a pin name to this same wire.
 */
export function pushEnvFor(
  config: PushConfig | null,
): Readonly<Record<string, string>> {
  return config === null
    ? {}
    : {
        [PUSH_ORIGIN_ENV]: config.origin,
        [PUSH_BUCKET_ENV]: config.bucket,
        [PUSH_TOKEN_ENV]: config.token,
      };
}

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
 *  there was nothing new to push, which is not the same as pushing zero.
 *
 *  NO DURATION. The push's own time is the RUNNER's to measure: it starts the
 *  clock when {@link LanePusher.push} announces the step (`begin`) and reads
 *  it on both endings, so the number a successful push reports and the number
 *  a failed one reports come from the same stopwatch. Timing it in here gave
 *  the success path a duration and the failure path — which leaves by `throw`
 *  — none, and the node's `failed` push state then had to invent one. */
export interface PushedFact {
  /** Store paths this node UPLOADED — `summary.pushed`, what the bucket did
   *  not have until this node sent it. */
  stored: number;
  /** Store paths of this node's closure the bucket ALREADY served —
   *  `summary.alreadyPresent`. Carried separately rather than folded into one
   *  served total, because the two are the answer to different questions and
   *  a reader shown only their sum reads every one of them as traffic. */
  present: number;
  /** NAR bytes this node's uploads stored — the size of `stored`. */
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
  // A DIRECTORY THAT IS NOT THERE IS A THROW, not an empty list. That was the
  // silent half of the module-workdir bug: a wrong answer about where a
  // recipe ran globbed a path that does not exist, found nothing, and left a
  // green run that pushed nothing with no line anywhere saying why. The lane
  // turns this into a line on the node.
  const entries = readdirSync(workspace);
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
   *
   * THREE SINKS, because a push is a STEP of its own and its narration has to
   * be separable from the recipe's. A recipe's log is worth exactly its
   * promise to hold the recipe's output and nothing else — the moment an
   * `[odu] pushing 4 result paths…` lands in it, a reader grepping a build's
   * own output is reading odu's. So the push's output goes to the node's PUSH
   * log (`say`), the node's push state is opened by `begin`, and the one
   * thing that belongs on the recipe's log — this module declining to push at
   * all, which has no push step to hang itself under — goes to `note`.
   */
  push(
    workdir: string,
    config: PushConfig,
    hooks: {
      /** The LANE's own explanation, on the node's recipe log: it did not even
       *  try. Not push output — there is no push step to hang it under. */
      note: (line: string) => void;
      /** There IS something to send: the push step begins now. Called at most
       *  once, before any `say`, so a runner can open the node's `pushing`
       *  state and start its clock knowing a fact or a throw must follow. */
      begin: () => void;
      /** The push's OWN output, for the node's push log. */
      say: (line: string) => void;
    },
  ): Promise<PushedFact | null>;
}

export function createLanePusher(
  deps: {
    push?: typeof pushToCache;
    /** Where this machine's Nix store is — a seam, so a suite can state a
     *  workspace with links into a store it made. */
    storeDir?: string;
  } = {},
): LanePusher {
  const send = deps.push ?? pushToCache;
  /** Store paths this lane has already put on the bucket. */
  const sent = new Set<string>();

  return {
    async push(workdir, config, hooks) {
      let found: string[];
      try {
        found = resultPathsIn(workdir, deps.storeDir);
      } catch (err) {
        // WHERE A RECIPE RAN IS DERIVED from the justfile's own dump, so it
        // can be derived wrongly — and the failure mode of a wrong answer is
        // a run that pushes nothing and says nothing, which is the one thing
        // 4.1 must never do. A line on the node rather than a red one: the
        // recipe did its job, and this is odu's reading of the dump failing.
        //
        // `note`, not `say`: this is the lane explaining itself about a push
        // that never started, and there is no push step for it to be the
        // output of. It belongs beside the recipe's own output, which is
        // where a reader asking "why did this node warm nothing" is looking.
        hooks.note(
          `[odu] not pushing: ${workdir} could not be read ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
      const fresh = found.filter((path) => !sent.has(path));
      if (fresh.length === 0) return null;
      // THE STEP EXISTS FROM HERE. `fresh` being non-empty is the first moment
      // it is certain this node has a push to show — everything above it can
      // still end in "there was nothing to send", which is not a step and must
      // not open one. Everything below it ends in a fact or a throw, so the
      // runner may start a clock on this call and know an ending is coming.
      hooks.begin();
      hooks.say(
        `[odu] pushing ${fresh.length} result path${fresh.length === 1 ? "" : "s"} ` +
          `to bucket ${config.bucket} at ${config.origin}`,
      );
      let summary: PushSummary;
      try {
        summary = await send({
          bucket: config.bucket,
          origin: config.origin,
          paths: fresh,
          // THE TOKEN, AS A TOKEN. Not through the client's discovery
          // environment: that describes a MACHINE (its `HOME`, its saved
          // logins), and a lane passing a one-key object would also be
          // asserting it has neither. This lane holds the credential outright
          // and says so.
          credential: config.token,
          env: {},
          onLine: (line) => hooks.say(`[odu] ${line}`),
        });
      } catch (err) {
        // A WHOLE-SEND REJECTION USED TO ARRIVE ANONYMOUS. The client's per
        // path failures name their path and their bucket, but a rejection of
        // the send ITSELF — a DNS answer that does not resolve, a refused
        // connection, a proxy that hangs up — is a `TypeError` from `fetch`
        // whose whole message is "Unable to connect. Is the computer able to
        // access the url?". It names no URL. It reached the node's push log
        // exactly like that and told a reader nothing at all: not which
        // bucket, not which origin, not which host failed to resolve.
        //
        // So the lane re-throws naming the two things only IT knows — the
        // bucket and the origin it dialled — and keeps the original as
        // `cause`, intact. Nothing is flattened into this sentence: the
        // runner walks the chain for the log, and a flattened string would
        // have destroyed the `code`/`errno`/`hostname` the bottom of that
        // chain carries.
        throw new Error(
          `odu: push of ${fresh.length} path${fresh.length === 1 ? "" : "s"} ` +
            `to bucket ${config.bucket} at ${config.origin} failed`,
          { cause: err },
        );
      }
      // RECORDED BEFORE THE REFUSAL IS RAISED: a path the bucket serves is one
      // the next node must not send again, whether or not a sibling path in the
      // same closure was refused.
      for (const path of summary.served) sent.add(path);
      if (summary.failed > 0) {
        throw new Error(
          `odu: ${summary.failed} path${summary.failed === 1 ? "" : "s"} could not be ` +
            `pushed to ${config.bucket} at ${config.origin} — ` +
            summary.failures.map(refusalLine).join("; "),
        );
      }
      return { stored: summary.pushed, present: summary.alreadyPresent, bytes: summary.bytes };
    },
  };
}

/**
 * ONE REFUSED PATH, SAID IN FULL.
 *
 * The client records every attempt as a {@link PushRefusal} — the URL it
 * dialled, the status it was answered with, the body that came back — and
 * this used to print `failure.message` alone. That sentence is true and it is
 * not enough: an operator reading `413 too large` cannot tell which endpoint
 * refused, and a 403 from a token that expired reads identically to a 403
 * from a bucket that does not exist. So the LAST attempt — the one that gave
 * up, and the only one whose outcome stands — contributes its URL, its status
 * and its body alongside the message.
 *
 * Each fact is omitted only when the client has none: a connection that never
 * got an answer has no status and no body, and printing `status=null` would
 * be noise standing in for a fact nobody has.
 */
function refusalLine(failure: PushFailure): string {
  const last = failure.attempts.at(-1);
  const facts =
    last === undefined
      ? []
      : [
          last.url === null ? null : `url=${last.url}`,
          last.status === null ? null : `status=${last.status}`,
          last.body === null || last.body === "" ? null : `body=${last.body}`,
        ].filter((fact): fact is string => fact !== null);
  return facts.length === 0
    ? `${failure.path}: ${failure.message}`
    : `${failure.path}: ${failure.message} (${facts.join(", ")})`;
}
