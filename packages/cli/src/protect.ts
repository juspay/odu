/**
 * `odu protect` — point a branch's required status checks at the
 * (recipe × platform) contexts the canonical DAG produces, justci's `protect`
 * equivalent. `--dry-run` reports the contexts without touching the API. The
 * bookkeeping `_ci-setup@<platform>` context is posted but never required,
 * matching the protection list observed under justci.
 *
 * The checks are written into the GitHub **ruleset** governing the branch
 * (rulesets.ts). This command used to PATCH classic branch protection, which
 * 404s on a ruleset-governed branch however protected that branch really is —
 * see rulesets.ts for why classic protection is not a fallback.
 *
 * **It RETURNS its outcome now**, and the daemon is what calls it. Two
 * consequences worth stating plainly:
 *
 *   - Every `stderr; return 1` below became a typed refusal. A face branches on
 *     `code`, so the four arms are the four different things an operator has to
 *     do about it — fix the checkout, fix the justfile, log in, or name a
 *     platform set — and none of them is "read the wall of text".
 *   - The service spends the operator's `gh` credential. That is NOT a new
 *     exposure: the coordinator the daemon launches has posted commit statuses
 *     with the same credential since odu had statuses, and `--no-post` is the
 *     opt-out for both. Keeping protect local on the grounds that "the daemon
 *     must not spend your credential" would have asserted something already
 *     false — and left a browser and an agent unable to protect a branch at
 *     all. What DID have to change is that `gh` must actually resolve inside
 *     the daemon; see `ODU_CHILD_ENV_KEYS` in coordinator/spawn.ts.
 */

import { spawnSync } from "node:child_process";
import { Result, Schema } from "effect";
import { fanId } from "@odu/run-client/nodeId";
import { loadHosts } from "@odu/execution/coordinator/hosts";
import { parseGithubRemote } from "@odu/execution/coordinator/statuses";
import type { PipelineSpec } from "@odu/execution/common/spec";
import { laneTasks, loadJustPipeline } from "@odu/execution/just/ingest";
import type { ProtectFacts, ProtectOutcome } from "@odu/service/ports";
import {
  BranchRulesSchema,
  chooseRuleset,
  createBody,
  CREATED_RULESET_NAME,
  RulesetSchema,
  rulesetId,
  updateBody,
} from "./rulesets";

export interface ProtectArgs {
  dryRun: boolean;
  branch?: string;
  platforms: readonly string[];
  /** Create the ruleset when no ruleset covers the branch, instead of refusing.
   *  Opt-in on purpose: protect is driven by agents and scripts here (the MCP
   *  face, the odu skill), and bringing merge-blocking policy into existence is
   *  not something a wrong `origin` should be able to do on the way past. */
  create: boolean;
  /** The checkout to protect. The daemon serves many, so this can no longer be
   *  "wherever the process happens to be standing". */
  checkout: string;
}

/** The platform set protection covers, as pure data — the decision writes no
 *  output (its one effect is the hosts-config read on the unsliced path).
 *  `explicit` names came straight from `--platform`; `derived` came from the
 *  hosts config and carries its `source`, which reaches the caller as
 *  `ProtectFacts.derivedFrom` rather than as a stderr warning — a fact about
 *  the answer belongs in the answer, where a browser can show it; `none` means
 *  neither produced a platform, with `source` so the refusal can name an
 *  empty-but-present file. */
type PlatformSet =
  | { kind: "explicit"; platforms: string[] }
  | { kind: "derived"; platforms: string[]; source: string }
  | { kind: "none"; source: string | null };

/** Unlike `run`, protect never dials a host — it only needs platform KEYS to
 *  fan out contexts — so explicit `--platform` flags stand on their own with no
 *  hosts config at all (juspay/odu#52; routing them through `run`'s lane
 *  resolver demanded a host per platform). With no flags the set derives from
 *  the hosts config, which is machine-local while protection is repo-global —
 *  that once silently halved a repo's required contexts, so the derivation
 *  names its source. */
function protectPlatforms(explicit: readonly string[]): PlatformSet {
  if (explicit.length > 0) {
    // A blank value (`--platform=`) would fan out contexts like `alpha@` and,
    // un-dry-run, PATCH them into protection — the host lookup that used to
    // reject it incidentally is gone, so refuse it on purpose. Beyond
    // blankness the tuple is operator-trusted, the same trust hosts.json keys
    // and `--host` pins get: odu owns no vocabulary of valid Nix systems (Nix
    // does), so a local shape check would be a drifting partial guess — e.g.
    // it could never catch an arch typo. `--dry-run` is the preview for
    // catching a typo before it reaches protection.
    if (explicit.some((platform) => platform.trim() === "")) {
      throw new Error(
        "odu: --platform expects a Nix system tuple (e.g. x86_64-linux), got an empty value",
      );
    }
    return { kind: "explicit", platforms: [...new Set(explicit)].sort() };
  }
  const config = loadHosts();
  const platforms = Object.keys(config.hosts).sort();
  // A null source implies zero platforms, so `derived` always carries the real
  // file that won.
  if (config.source === null || platforms.length === 0) {
    return { kind: "none", source: config.source };
  }
  return { kind: "derived", platforms, source: config.source };
}

type GhResult = { ok: true; stdout: string } | { ok: false; error: string };

/** One `gh` call. Every GitHub read and write protect makes goes through here,
 *  so they share the `$ODU_GH_BIN` seam — the default-branch lookup used to
 *  spawn a hard-coded `gh` while only the write honoured the override, leaving
 *  the command half-fakeable and its worst path (the write) untested. */
function gh(args: string[], input?: string): GhResult {
  const res = spawnSync(process.env.ODU_GH_BIN ?? "gh", args, {
    input,
    encoding: "utf-8",
  });
  if (res.status === 0) return { ok: true, stdout: res.stdout };
  const error =
    res.stderr?.trim() ||
    res.error?.message ||
    `gh exited ${String(res.status)}`;
  return { ok: false, error };
}

/**
 * Is this `gh` failure one that `gh auth login` fixes — or, from the daemon's
 * side, one that having a `gh` at all fixes?
 *
 * The two are the same refusal on purpose. `no_credential` says "this process
 * cannot speak to GitHub as you", and a daemon with no `gh` on its PATH cannot,
 * for reasons the operator resolves in the same place. They are told apart by
 * the message, not by a fifth refusal code nobody would branch on differently.
 */
function isCredentialFailure(error: string): boolean {
  const lower = error.toLowerCase();
  return [
    "gh auth login",
    "not logged in",
    "no such host",
    "authentication",
    "bad credentials",
    "http 401",
    "http 403",
    "gh_token",
    "enoent",
    "command not found",
    "not found in $path",
  ].some((hint) => lower.includes(hint));
}

/** A `gh` failure as a refusal. Auth (and a missing binary) is the one arm with
 *  an argv-shaped recovery; everything else is a state of the repository that
 *  logging in again will not change. */
function ghRefusal(
  what: string,
  error: string,
): Extract<ProtectOutcome, { ok: false }> {
  const message = `odu: protect could not ${what}:\n${error}`;
  return isCredentialFailure(error)
    ? { ok: false, code: "no_credential", message, suggestion: ["gh", "auth", "login"] }
    : { ok: false, code: "bad_input", message };
}

/** `gh api` output through an Effect Schema. GitHub answering something
 *  unmodelled is a real (if rare) outcome, so it is named as the API surprise
 *  it is rather than reaching the operator as a wall of decode-path noise.
 *  `decodeUnknownResult` keeps that in the RETURN type: the refusal is a value
 *  here, never a throw. */
function decode<T>(schema: Schema.Codec<T, unknown>, raw: string): T | null {
  try {
    const decoded = Schema.decodeUnknownResult(schema)(
      JSON.parse(raw) as unknown,
    );
    if (Result.isSuccess(decoded)) return decoded.success;
  } catch {
    // fall through to the shared refusal — a non-JSON body and a JSON body of
    // the wrong shape are the same problem to the operator.
  }
  return null;
}

function unreadable(what: string): Extract<ProtectOutcome, { ok: false }> {
  return {
    ok: false,
    code: "bad_input",
    message: `odu: protect could not read ${what} from gh`,
  };
}

/**
 * Set a branch's required status checks to exactly the contexts odu posts.
 *
 * The order below is deliberate and is the order in which an operator can fix
 * things: everything answerable from the checkout alone (is this a repo, does
 * its justfile parse, which platforms) is settled before a single byte reaches
 * GitHub, so the common mistakes cost no round trip and no credential.
 */
export async function applyProtection(
  args: ProtectArgs,
): Promise<ProtectOutcome> {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: args.checkout,
    encoding: "utf-8",
  });
  const repoRoot = top.status === 0 ? top.stdout.trim() : "";
  if (repoRoot === "") {
    return {
      ok: false,
      code: "checkout_refused",
      message: `odu: protect needs a git checkout — ${args.checkout} is not one`,
    };
  }

  let spec: PipelineSpec;
  try {
    spec = loadJustPipeline(repoRoot);
  } catch (err) {
    // The engine's own sentence: it knows which recipe is malformed, and a
    // branch cannot be protected against a DAG that does not resolve, because
    // the required contexts ARE the DAG.
    return {
      ok: false,
      code: "pipeline_refused",
      message: (err as Error).message,
    };
  }

  let set: PlatformSet;
  try {
    set = protectPlatforms(args.platforms);
  } catch (err) {
    return { ok: false, code: "bad_input", message: (err as Error).message };
  }
  if (set.kind === "none") {
    // Mirror noHostsConfiguredError's why-branch: `source` names the file that
    // won, or is null when none existed, so an empty-but-present hosts file is
    // diagnosed as such rather than told to "configure" one it already has.
    const why =
      set.source === null
        ? "to name the repo's CI platforms, or configure a hosts file"
        : `to name the repo's CI platforms — ${set.source} configured no platform`;
    return {
      ok: false,
      code: "bad_input",
      message:
        `odu: protect found no platforms — pass --platform PLAT (repeatable) ${why}`,
      suggestion: ["odu", "protect", "--platform", "x86_64-linux"],
    };
  }
  const derivedFrom = set.kind === "derived" ? set.source : null;

  // Require exactly the contexts `odu run` posts: each platform's lane after
  // OS-attribute filtering (a [linux]-only recipe is never posted on a darwin
  // lane, so it must not be required there or protection waits forever).
  const contexts = set.platforms.flatMap((platform) =>
    laneTasks(spec, platform, [], false).map((task) => fanId(task.id, platform)),
  );

  // A DRY RUN ANSWERS HERE, before the forge is consulted at all.
  //
  // The required contexts are the checkout's recipes crossed with a platform
  // set — knowable from the checkout alone. Resolving the origin and the
  // default branch first would make "show me what this would require" fail on
  // a repository with no GitHub remote, which is precisely the repository
  // somebody is most likely to be experimenting in, and would spend a network
  // round trip to print a list that does not depend on it. `repo` and `branch`
  // come back null, which is why the wire declares them nullable.
  if (args.dryRun) {
    return {
      ok: true,
      facts: {
        repo: null,
        branch: null,
        contexts,
        derivedFrom,
        rulesetId: null,
        applied: false,
        created: false,
        detail: "dry run — nothing was written, and the forge was not asked",
      },
    };
  }

  const origin = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).stdout.trim();
  const github = parseGithubRemote(origin);
  if (github === null) {
    return {
      ok: false,
      code: "checkout_refused",
      message: "odu: protect needs a github.com origin remote",
    };
  }
  const slug = `${github.owner}/${github.repo}`;

  let branch = args.branch;
  if (branch === undefined) {
    // The one `gh` call a `--dry-run` can still make. A preview that cannot
    // name the branch it would write is not a preview — and passing `--branch`
    // skips it, which is the offline path for anyone who wants one.
    const head = gh(["api", `repos/${slug}`, "--jq", ".default_branch"]);
    if (!head.ok) {
      return ghRefusal(`resolve the default branch of ${slug}`, head.error);
    }
    branch = head.stdout.trim();
    // An empty answer used to flow on into `branches//protection`, turning a
    // failed lookup into a confusing 404 about the wrong thing.
    if (branch === "") {
      return {
        ok: false,
        code: "bad_input",
        message: `odu: protect could not resolve the default branch of ${slug} — name one`,
        suggestion: ["odu", "protect", "--branch", "main"],
      };
    }
  }

  // Bound to a const because every `facts(...)` below is a closure, and TypeScript
  // does not carry a `let`'s narrowing into one.
  const onBranch = branch;
  const facts = (extra: {
    rulesetId: number | null;
    applied: boolean;
    created: boolean;
    detail: string | null;
  }): ProtectFacts => ({
    repo: slug,
    branch: onBranch,
    contexts,
    derivedFrom,
    ...extra,
  });

  const covering = gh(["api", `repos/${slug}/rules/branches/${branch}`]);
  if (!covering.ok) {
    return ghRefusal(`read the rules on ${branch}`, covering.error);
  }
  const branchRules = decode(BranchRulesSchema, covering.stdout);
  if (branchRules === null) return unreadable(`the rules on ${branch}`);

  const choice = chooseRuleset(branchRules);
  const rulesetUrl = (id: number): string =>
    `https://github.com/${slug}/rules/${id}`;
  switch (choice.kind) {
    case "none": {
      if (!args.create) {
        return {
          ok: false,
          code: "bad_input",
          message:
            `odu: protect found no ruleset covering ${branch} of ${slug} — ` +
            "odu requires checks through a repository ruleset; ask for one to " +
            `be created, or create it under Settings → Rules with ${branch} ` +
            "in its ref conditions",
          suggestion: ["odu", "protect", "--create"],
        };
      }
      const made = gh(
        ["api", "--method", "POST", `repos/${slug}/rulesets`, "--input", "-"],
        createBody({ branch, isDefault: args.branch === undefined, contexts }),
      );
      if (!made.ok) {
        return ghRefusal(`create a ruleset on ${branch}`, made.error);
      }
      const id = rulesetId(made.stdout);
      return {
        ok: true,
        facts: facts({
          rulesetId: id,
          applied: true,
          created: true,
          // Say what was brought into existence, not just that it worked: this
          // is the one path where protect leaves the repo with a merge gate it
          // did not have a moment ago, and the empty bypass list is the part
          // that surprises.
          detail:
            `created ruleset "${CREATED_RULESET_NAME}" — nobody bypasses it, ` +
            "admins included; add bypass actors under Settings → Rules if you " +
            "need them",
        }),
      };
    }
    case "ambiguous":
      return {
        ok: false,
        code: "bad_input",
        message:
          `odu: protect found ${choice.ids.length} rulesets requiring status checks on ${branch}:\n` +
          `${choice.ids.map((id) => `       ${rulesetUrl(id)}\n`).join("")}` +
          "     GitHub requires the union of them, so writing one would leave the\n" +
          "     others' contexts required and blocking — keep required_status_checks\n" +
          "     on exactly one ruleset",
      };
    case "foreign": {
      const owner = choice.source === "" ? choice.sourceType : choice.source;
      return {
        ok: false,
        // NOT `no_credential`: `gh auth login` cannot fix this. An organisation
        // or enterprise owns the ruleset, and no repository token writes one —
        // the fix is a different ruleset, or a different owner.
        code: "bad_input",
        message:
          `odu: protect cannot edit the ${choice.sourceType.toLowerCase()} ruleset requiring\n` +
          `     status checks on ${branch} — ${owner} owns it, and a repository\n` +
          `     token cannot write it: ${rulesetUrl(choice.id)}`,
      };
    }
  }

  const read = gh(["api", `repos/${slug}/rulesets/${choice.id}`]);
  if (!read.ok) return ghRefusal(`read ruleset ${choice.id}`, read.error);
  const ruleset = decode(RulesetSchema, read.stdout);
  if (ruleset === null) return unreadable(`ruleset ${choice.id}`);

  const write = gh(
    [
      "api",
      "--method",
      "PUT",
      `repos/${slug}/rulesets/${ruleset.id}`,
      "--input",
      "-",
    ],
    updateBody(ruleset, contexts),
  );
  if (!write.ok) return ghRefusal(`write ruleset ${ruleset.id}`, write.error);
  return {
    ok: true,
    facts: facts({
      rulesetId: ruleset.id,
      applied: true,
      created: false,
      detail: `ruleset "${ruleset.name}" (#${ruleset.id}) now requires ${contexts.length} contexts on ${branch}`,
    }),
  };
}

