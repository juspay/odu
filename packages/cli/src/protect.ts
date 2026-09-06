/**
 * `odu protect` — point a branch's required status checks at the
 * (recipe × platform) contexts the canonical DAG produces, justci's `protect`
 * equivalent. `--dry-run` prints the contexts without touching the API. The
 * bookkeeping `_ci-setup@<platform>` context is posted but never required,
 * matching the protection list observed under justci.
 *
 * The checks are written into the GitHub **ruleset** governing the branch
 * (rulesets.ts). This command used to PATCH classic branch protection, which
 * 404s on a ruleset-governed branch however protected that branch really is —
 * see rulesets.ts for why classic protection is not a fallback.
 */

import { spawnSync } from "node:child_process";
import { Result, Schema } from "effect";
import { fanId } from "@odu/run-client/nodeId";
import { loadHosts } from "@odu/execution/coordinator/hosts";
import { parseGithubRemote } from "@odu/execution/coordinator/statuses";
import { laneTasks, loadJustPipeline } from "@odu/execution/just/ingest";
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
  platforms: string[];
  /** Create the ruleset when no ruleset covers the branch, instead of refusing.
   *  Opt-in on purpose: protect is driven by agents and scripts here (the MCP
   *  face, the odu skill), and bringing merge-blocking policy into existence is
   *  not something a wrong `origin` should be able to do on the way past. */
  create: boolean;
}

/** The platform set protection covers, as pure data — the decision writes no
 *  output (its one effect is the hosts-config read on the unsliced path), and
 *  protectCommand owns the stderr/exit at its boundary (mirrors hosts.ts's
 *  pure-refusal factory). `explicit` names came straight from `--platform`;
 *  `derived` came from the hosts config and carries its `source` so the caller
 *  can warn that the set is machine-local, not a repo fact; `none` means
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

/** `gh api` output through an Effect Schema. GitHub answering something
 *  unmodelled is a real (if rare) outcome — an unhandled decode issue would
 *  reach the operator as a wall of path/expected noise, so it is named as the
 *  API surprise it is. `decodeUnknownResult` keeps that in the RETURN type: the
 *  refusal is a value here, never a throw. */
function decode<T>(
  schema: Schema.Codec<T, unknown>,
  raw: string,
  what: string,
): T | null {
  try {
    const decoded = Schema.decodeUnknownResult(schema)(
      JSON.parse(raw) as unknown,
    );
    if (Result.isSuccess(decoded)) return decoded.success;
  } catch {
    // fall through to the shared refusal — a non-JSON body and a JSON body of
    // the wrong shape are the same problem to the operator.
  }
  process.stderr.write(`odu: protect could not read ${what} from gh\n`);
  return null;
}

export async function protectCommand(args: ProtectArgs): Promise<number> {
  const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).stdout.trim();
  const spec = loadJustPipeline(repoRoot);
  const set = protectPlatforms(args.platforms);
  if (set.kind === "none") {
    // Mirror noHostsConfiguredError's why-branch: `source` names the file that
    // won, or is null when none existed, so an empty-but-present hosts file is
    // diagnosed as such rather than told to "configure" one it already has.
    const why =
      set.source === null
        ? "     to name the repo's CI platforms, or configure a hosts file\n"
        : `     to name the repo's CI platforms — ${set.source} configured no platform\n`;
    process.stderr.write(
      "odu: protect found no platforms — pass --platform PLAT (repeatable)\n" +
        why,
    );
    return 1;
  }
  if (set.kind === "derived") {
    process.stderr.write(
      `odu: protect: platform set (${set.platforms.join(", ")}) derives from\n` +
        `     ${set.source} — a machine-local hosts config, not a repo\n` +
        "     fact; pass --platform to pin the repo's platform set explicitly\n",
    );
  }
  // Require exactly the contexts `odu run` posts: each platform's lane after
  // OS-attribute filtering (a [linux]-only recipe is never posted on a darwin
  // lane, so it must not be required there or protection waits forever).
  const contexts = set.platforms.flatMap((platform) =>
    laneTasks(spec, platform, [], false).map((task) => fanId(task.id, platform)),
  );

  if (args.dryRun) {
    for (const context of contexts) process.stdout.write(`${context}\n`);
    return 0;
  }

  const origin = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).stdout.trim();
  const github = parseGithubRemote(origin);
  if (github === null) {
    process.stderr.write("odu: protect needs a github.com origin remote\n");
    return 1;
  }
  const slug = `${github.owner}/${github.repo}`;

  let branch = args.branch;
  if (branch === undefined) {
    const head = gh(["api", `repos/${slug}`, "--jq", ".default_branch"]);
    if (!head.ok) {
      process.stderr.write(
        `odu: protect could not resolve the default branch of ${slug}:\n${head.error}\n`,
      );
      return 1;
    }
    branch = head.stdout.trim();
    // An empty answer used to flow on into `branches//protection`, turning a
    // failed lookup into a confusing 404 about the wrong thing.
    if (branch === "") {
      process.stderr.write(
        `odu: protect could not resolve the default branch of ${slug} — pass --branch\n`,
      );
      return 1;
    }
  }

  const covering = gh(["api", `repos/${slug}/rules/branches/${branch}`]);
  if (!covering.ok) {
    process.stderr.write(
      `odu: protect could not read the rules on ${branch}:\n${covering.error}\n`,
    );
    return 1;
  }
  const branchRules = decode(
    BranchRulesSchema,
    covering.stdout,
    `the rules on ${branch}`,
  );
  if (branchRules === null) return 1;

  const choice = chooseRuleset(branchRules);
  const rulesetUrl = (id: number): string =>
    `https://github.com/${slug}/rules/${id}`;
  switch (choice.kind) {
    case "none": {
      if (!args.create) {
        process.stderr.write(
          `odu: protect found no ruleset covering ${branch} of ${slug}\n` +
            "     odu requires checks through a repository ruleset — re-run with\n" +
            "     --create to make one, or create it under Settings → Rules with\n" +
            `     ${branch} in its ref conditions\n`,
        );
        return 1;
      }
      const made = gh(
        ["api", "--method", "POST", `repos/${slug}/rulesets`, "--input", "-"],
        createBody({ branch, isDefault: args.branch === undefined, contexts }),
      );
      if (!made.ok) {
        process.stderr.write(
          `odu: protect could not create a ruleset on ${branch}:\n${made.error}\n`,
        );
        return 1;
      }
      const id = rulesetId(made.stdout);
      // Say what was brought into existence, not just that it worked: this is
      // the one path where protect leaves the repo with a merge gate it did not
      // have a moment ago, and the empty bypass list is the part that surprises.
      process.stdout.write(
        `odu: created ruleset "${CREATED_RULESET_NAME}"` +
          `${id === null ? "" : ` (#${id})`} on ${branch} — ` +
          `${contexts.length} contexts now required\n` +
          "     nobody bypasses it, admins included; add bypass actors under\n" +
          "     Settings → Rules if you need them\n",
      );
      return 0;
    }
    case "ambiguous":
      process.stderr.write(
        `odu: protect found ${choice.ids.length} rulesets requiring status checks on ${branch}:\n` +
          `${choice.ids.map((id) => `       ${rulesetUrl(id)}\n`).join("")}` +
          "     GitHub requires the union of them, so writing one would leave the\n" +
          "     others' contexts required and blocking — keep required_status_checks\n" +
          "     on exactly one ruleset\n",
      );
      return 1;
    case "foreign": {
      const owner = choice.source === "" ? choice.sourceType : choice.source;
      process.stderr.write(
        `odu: protect cannot edit the ${choice.sourceType.toLowerCase()} ruleset requiring\n` +
          `     status checks on ${branch} — ${owner} owns it, and a repository\n` +
          `     token cannot write it: ${rulesetUrl(choice.id)}\n`,
      );
      return 1;
    }
  }

  const read = gh(["api", `repos/${slug}/rulesets/${choice.id}`]);
  if (!read.ok) {
    process.stderr.write(
      `odu: protect could not read ruleset ${choice.id}:\n${read.error}\n`,
    );
    return 1;
  }
  const ruleset = decode(RulesetSchema, read.stdout, `ruleset ${choice.id}`);
  if (ruleset === null) return 1;

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
  if (!write.ok) {
    process.stderr.write(`odu: protect PUT failed:\n${write.error}\n`);
    return 1;
  }
  process.stdout.write(
    `odu: ruleset "${ruleset.name}" (#${ruleset.id}) now requires ` +
      `${contexts.length} contexts on ${branch}\n`,
  );
  return 0;
}
